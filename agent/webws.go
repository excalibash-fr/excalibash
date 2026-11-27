package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// WebSockets of a tunnelled site. The browser-side shim opens one virtual socket per site socket;
// the server only relays opaque frames. Every message is sealed with the tunnel key, and its AAD
// carries the direction and a per-direction counter, so the server can neither replay, reorder,
// drop nor inject a message undetected. Closes are sealed too: an unsealed close reads as an
// abnormal one (1006) on the browser side.

const (
	maxSocksPerTunnel = 32
	maxSocksTotal     = 256
	maxWSMessage      = 16 << 20
	wsQueueSize       = 256
	wsDialTimeout     = 15 * time.Second
	wsWriteTimeout    = 30 * time.Second
)

var (
	validSid      = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
	validProtocol = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$")
)

type wsSock struct {
	id, sid string
	key     []byte
	ready   chan struct{} // closed once the target accepted the upgrade
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	queue   chan wsItem
	out     *outbox
	recvN   uint64 // browser → target messages seen; only touched by the agent's read loop
}

type wsItem struct {
	typ  websocket.MessageType
	data []byte
}

func wsMsgAAD(id, sid, dir string, n uint64) string {
	return "eb:ws-msg:" + id + ":" + sid + ":" + dir + ":" + strconv.FormatUint(n, 10)
}

func wsCloseAAD(id, sid, dir string, n uint64) string {
	return "eb:ws-close:" + id + ":" + sid + ":" + dir + ":" + strconv.FormatUint(n, 10)
}

type wsOpenSpec struct {
	P      string   `json:"p"`
	Protos []string `json:"protos"`
	Cookie string   `json:"cookie"`
}

type wsAck struct {
	OK    bool   `json:"ok"`
	S     int    `json:"s,omitempty"`
	Proto string `json:"proto,omitempty"`
}

type wsCloseBody struct {
	Code   int    `json:"code"`
	Reason string `json:"reason"`
}

// closeSockets ends the sockets of one tunnel, or all of them when id is empty.
func (w *webHub) closeSockets(id string) {
	w.mu.Lock()
	var victims []*wsSock
	for k, s := range w.socks {
		if id == "" || s.id == id {
			victims = append(victims, s)
			delete(w.socks, k)
		}
	}
	w.mu.Unlock()
	for _, s := range victims {
		s.cancel()
	}
}

func (w *webHub) sock(id, sid string) *wsSock {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.socks[id+"/"+sid]
}

func (w *webHub) drop(s *wsSock) {
	w.mu.Lock()
	if w.socks[s.id+"/"+s.sid] == s {
		delete(w.socks, s.id+"/"+s.sid)
	}
	w.mu.Unlock()
	s.cancel()
}

// abort ends a socket after a protocol or integrity failure; the unsealed close tells the browser.
func (w *webHub) abort(s *wsSock) {
	s.out.send(message{T: "ws.close", ID: s.id, Sid: s.sid})
	w.drop(s)
}

// wsOpen handles a sealed open request; it runs in its own goroutine.
func (w *webHub) wsOpen(msg message, out *outbox) {
	ts, ok := parseTs(msg.Ts)
	if !ok || !validSid.MatchString(msg.Sid) {
		return
	}
	if !tsInWindow(ts) {
		debugf("ws %s: timestamp out of window", msg.ID)
		return
	}
	data, err := b64.DecodeString(msg.D)
	if err != nil {
		return
	}

	nonce := "ws/" + msg.ID + "/" + msg.Sid
	w.mu.Lock()
	t := w.tunnels[msg.ID]
	w.mu.Unlock()
	if t == nil || w.nonces.seen(nonce) {
		return
	}
	pt, err := unbox(t.key, data, "eb:ws-open:"+msg.ID+":"+msg.Sid+":"+strconv.FormatInt(ts, 10))
	if err != nil {
		debugf("ws %s: authentication failed", msg.ID)
		return
	}
	// Authoritative anti-replay, once the frame is authenticated (a forged frame must not burn a nonce).
	if !w.nonces.claim(nonce) {
		return
	}

	fail := func(status int) {
		ack, err := box(t.key, mustJSON(wsAck{S: status}), "eb:ws-ack:"+msg.ID+":"+msg.Sid)
		if err == nil {
			out.send(message{T: "ws.ack", ID: msg.ID, Sid: msg.Sid, D: b64.EncodeToString(ack)})
		}
	}

	var spec wsOpenSpec
	if json.Unmarshal(pt, &spec) != nil || !strings.HasPrefix(spec.P, "/") || strings.HasPrefix(spec.P, "//") ||
		len(spec.Protos) > 8 || len(spec.Cookie) > 16<<10 || strings.ContainsAny(spec.Cookie, "\r\n\x00") {
		fail(400)
		return
	}
	for _, p := range spec.Protos {
		if !validProtocol.MatchString(p) {
			fail(400)
			return
		}
	}
	ref, err := url.Parse(spec.P)
	if err != nil {
		fail(400)
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	s := &wsSock{id: msg.ID, sid: msg.Sid, key: t.key, ready: make(chan struct{}), ctx: ctx, cancel: cancel, queue: make(chan wsItem, wsQueueSize), out: out}
	w.mu.Lock()
	n := 0
	for _, o := range w.socks {
		if o.id == msg.ID {
			n++
		}
	}
	if w.tunnels[msg.ID] != t || n >= maxSocksPerTunnel || len(w.socks) >= maxSocksTotal {
		w.mu.Unlock()
		cancel()
		fail(429)
		return
	}
	w.socks[msg.ID+"/"+msg.Sid] = s
	w.mu.Unlock()

	dest := *t.target
	dest.Path = underTarget(t.target.Path, ref.Path)
	dest.RawQuery = ref.RawQuery
	header := http.Header{"Origin": {t.target.Scheme + "://" + t.target.Host}}
	if spec.Cookie != "" {
		header.Set("Cookie", spec.Cookie)
	}
	dctx, dcancel := context.WithTimeout(ctx, wsDialTimeout)
	conn, resp, err := websocket.Dial(dctx, dest.String(), &websocket.DialOptions{
		HTTPClient:      &http.Client{Transport: t.wsTransport()},
		HTTPHeader:      header,
		Host:            t.hostHeader,
		Subprotocols:    spec.Protos,
		CompressionMode: websocket.CompressionDisabled,
	})
	dcancel()
	if err != nil {
		w.drop(s)
		status := 502
		if resp != nil {
			status = resp.StatusCode
		}
		fail(status)
		return
	}
	conn.SetReadLimit(maxWSMessage)
	s.conn = conn
	close(s.ready)
	defer func() {
		w.drop(s)
		conn.CloseNow()
	}()

	ack, err := box(s.key, mustJSON(wsAck{OK: true, Proto: conn.Subprotocol()}), "eb:ws-ack:"+s.id+":"+s.sid)
	if err != nil || !out.send(message{T: "ws.ack", ID: s.id, Sid: s.sid, D: b64.EncodeToString(ack)}) {
		return
	}
	go s.writer(w)

	var sent uint64
	var closeErr error
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			closeErr = err
			break
		}
		kind := byte(0)
		if typ == websocket.MessageBinary {
			kind = 1
		}
		boxed, err := box(s.key, append([]byte{kind}, data...), wsMsgAAD(s.id, s.sid, "a2c", sent))
		if err != nil || !out.send(message{T: "ws.data", ID: s.id, Sid: s.sid, D: b64.EncodeToString(boxed)}) {
			return
		}
		sent++
	}
	if ctx.Err() != nil {
		return // we were told to stop: the other side already knows
	}
	body := wsCloseBody{Code: 1006}
	var ce websocket.CloseError
	if errors.As(closeErr, &ce) {
		body = wsCloseBody{Code: int(ce.Code), Reason: ce.Reason}
	}
	if boxed, err := box(s.key, mustJSON(body), wsCloseAAD(s.id, s.sid, "a2c", sent)); err == nil {
		out.send(message{T: "ws.close", ID: s.id, Sid: s.sid, D: b64.EncodeToString(boxed)})
	}
}

// writer sends the browser's messages to the target, in order.
func (s *wsSock) writer(w *webHub) {
	for {
		select {
		case <-s.ctx.Done():
			return
		case it := <-s.queue:
			wctx, cancel := context.WithTimeout(s.ctx, wsWriteTimeout)
			err := s.conn.Write(wctx, it.typ, it.data)
			cancel()
			if err != nil {
				w.abort(s)
				return
			}
		}
	}
}

// wsData decrypts one browser message and queues it for the target.
func (w *webHub) wsData(msg message) {
	s := w.sock(msg.ID, msg.Sid)
	if s == nil {
		return
	}
	select {
	case <-s.ready:
	default:
		w.abort(s) // data before the ack: the peer does not follow the protocol
		return
	}
	data, err := b64.DecodeString(msg.D)
	if err != nil {
		w.abort(s)
		return
	}
	pt, err := unbox(s.key, data, wsMsgAAD(s.id, s.sid, "c2a", s.recvN))
	if err != nil || len(pt) == 0 || pt[0] > 1 {
		debugf("ws %s: bad message", s.id)
		w.abort(s)
		return
	}
	s.recvN++
	typ := websocket.MessageText
	if pt[0] == 1 {
		typ = websocket.MessageBinary
	}
	select {
	case s.queue <- wsItem{typ: typ, data: pt[1:]}:
	default:
		w.abort(s) // the target does not keep up
	}
}

// wsClose ends a socket. A sealed close carries the code the site asked for.
func (w *webHub) wsClose(msg message) {
	s := w.sock(msg.ID, msg.Sid)
	if s == nil {
		return
	}
	code, reason := websocket.StatusGoingAway, ""
	if data, err := b64.DecodeString(msg.D); err == nil && msg.D != "" {
		if pt, err := unbox(s.key, data, wsCloseAAD(s.id, s.sid, "c2a", s.recvN)); err == nil {
			var b wsCloseBody
			if json.Unmarshal(pt, &b) == nil {
				code, reason = websocket.StatusCode(b.Code), b.Reason
			}
		}
	}
	switch {
	case code == 1000, code >= 1001 && code <= 1003, code >= 1007 && code <= 1011, code >= 3000 && code <= 4999:
	default:
		code = websocket.StatusNormalClosure
	}
	if len(reason) > 123 {
		reason = ""
	}
	select {
	case <-s.ready:
		// Closing politely lets the target see the code; the read loop then cleans up.
		go s.conn.Close(code, reason)
	default:
		w.drop(s)
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// wsTransport is the tunnel's shared transport (upgraded connections leave its pool), or a fresh one
// for tunnels built without open() (tests).
func (t *tunnel) wsTransport() http.RoundTripper {
	if t.transport != nil {
		return t.transport
	}
	return &http.Transport{TLSClientConfig: t.tlsConfig(), DisableCompression: true}
}
