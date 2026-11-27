package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Web tunnels: the owner's browser issues a tunnel key bound to a fixed target (for example
// http://127.0.0.1:80). Requests and responses are end-to-end encrypted between the viewer's
// browser (service worker) and this agent; the server only relays opaque frames, and cannot
// point the agent at another host or port since the target is sealed with the key.

const (
	maxHTTPBody = 48 << 20
	httpTimeout = 60 * time.Second
	// maxInflight bounds concurrent forwarded requests per agent (goroutines and buffered bodies).
	maxInflight = 32
)

type tunnel struct {
	key      []byte
	target   *url.URL
	insecure bool
	// hostHeader replaces the Host header and the TLS server name (virtual hosts).
	hostHeader string
	// legacyTLS accepts TLS 1.0/1.1 and weak cipher suites (old switches, UPS cards…).
	legacyTLS bool
	// transport is shared by all requests of this tunnel (keep-alive reuse) and closed with it.
	transport *http.Transport
}

var validHostHeader = regexp.MustCompile(`^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$`) // mirrors web/src/validators.ts

func hostHeaderOK(h string) bool {
	if h == "" {
		return true
	}
	if !validHostHeader.MatchString(h) {
		return false
	}
	if _, port, err := net.SplitHostPort(h); err == nil {
		n, err := strconv.Atoi(port)
		return err == nil && n >= 1 && n <= 65535
	}
	return true
}

func (t *tunnel) tlsConfig() *tls.Config {
	cfg := &tls.Config{InsecureSkipVerify: t.insecure}
	if t.hostHeader != "" {
		cfg.ServerName = t.hostHeader
		if host, _, err := net.SplitHostPort(t.hostHeader); err == nil {
			cfg.ServerName = host
		}
	}
	if t.legacyTLS {
		cfg.MinVersion = tls.VersionTLS10
		for _, list := range [][]*tls.CipherSuite{tls.CipherSuites(), tls.InsecureCipherSuites()} {
			for _, cs := range list {
				cfg.CipherSuites = append(cfg.CipherSuites, cs.ID)
			}
		}
	}
	return cfg
}

type webHub struct {
	mu      sync.Mutex
	auth    []byte
	tunnels map[string]*tunnel
	// nonces holds the ids of HTTP requests and WebSocket opens seen recently, against replays.
	nonces   *nonceSet
	inflight chan struct{}
	socks    map[string]*wsSock // tunnel id + "/" + socket id
}

func newWebHub(auth []byte) *webHub {
	return &webHub{auth: auth, tunnels: map[string]*tunnel{}, nonces: newNonceSet(maxWebNonces), inflight: make(chan struct{}, maxInflight), socks: map[string]*wsSock{}}
}

// open installs a tunnel from its owner-issued blob:
// box(machineAuth, {k, url, insecure, hostHeader, legacyTls}, "eb:web:<id>").
func (w *webHub) open(msg message) {
	data, err := b64.DecodeString(msg.Key)
	if err != nil {
		return
	}
	pt, err := unbox(w.auth, data, "eb:web:"+msg.ID)
	if err != nil {
		log.Printf("web %s: invalid tunnel key", msg.ID)
		return
	}
	var spec struct {
		K          string `json:"k"`
		URL        string `json:"url"`
		Insecure   bool   `json:"insecure"`
		HostHeader string `json:"hostHeader"`
		LegacyTLS  bool   `json:"legacyTls"`
	}
	if json.Unmarshal(pt, &spec) != nil {
		return
	}
	key, err := b64.DecodeString(spec.K)
	target, err2 := url.Parse(spec.URL)
	if err != nil || err2 != nil || len(key) != keyLen || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" ||
		!hostHeaderOK(spec.HostHeader) {
		log.Printf("web %s: invalid tunnel spec", msg.ID)
		return
	}
	t := &tunnel{key: key, target: target, insecure: spec.Insecure, hostHeader: spec.HostHeader, legacyTLS: spec.LegacyTLS}
	t.transport = &http.Transport{
		TLSClientConfig:     t.tlsConfig(),
		DisableCompression:  true,
		IdleConnTimeout:     30 * time.Second,
		MaxIdleConnsPerHost: 4,
	}
	// A new key (rotation) or a re-announcement ends the sockets opened with the old one.
	w.closeSockets(msg.ID)
	w.mu.Lock()
	old := w.tunnels[msg.ID]
	w.tunnels[msg.ID] = t
	w.mu.Unlock()
	if old != nil {
		old.transport.CloseIdleConnections()
	}
	log.Printf("web %s: tunnel to %s", msg.ID, target.Redacted())
}

func (w *webHub) close(id string) {
	w.closeSockets(id)
	w.mu.Lock()
	old := w.tunnels[id]
	delete(w.tunnels, id)
	w.mu.Unlock()
	if old != nil && old.transport != nil {
		old.transport.CloseIdleConnections()
	}
}

type httpReq struct {
	M string              `json:"m"`
	P string              `json:"p"`
	H map[string][]string `json:"h"`
	B string              `json:"b"`
}

type httpRes struct {
	S int                 `json:"s"`
	H map[string][]string `json:"h"`
	B string              `json:"b"`
}

var hopHeaders = map[string]bool{
	"Connection": true, "Keep-Alive": true, "Proxy-Authenticate": true, "Proxy-Authorization": true,
	"Te": true, "Trailer": true, "Transfer-Encoding": true, "Upgrade": true, "Host": true, "Content-Length": true,
}

// request handles one encrypted HTTP request; it runs in its own goroutine.
func (w *webHub) request(msg message, out *outbox) {
	ts, ok := parseTs(msg.Ts)
	if !ok || msg.Rid == "" || len(msg.Rid) > 64 {
		return
	}
	if !tsInWindow(ts) {
		debugf("http %s: timestamp out of window", msg.ID)
		return
	}
	nonce := msg.ID + "/" + msg.Rid
	w.mu.Lock()
	t := w.tunnels[msg.ID]
	w.mu.Unlock()
	if t == nil || w.nonces.seen(nonce) {
		return
	}
	data, err := b64.DecodeString(msg.D)
	if err != nil {
		return
	}
	pt, err := unbox(t.key, data, "eb:http-req:"+msg.ID+":"+msg.Rid+":"+strconv.FormatInt(ts, 10))
	if err != nil {
		debugf("http %s: authentication failed", msg.ID)
		return
	}
	// Authoritative anti-replay: check and record in one critical section, only once the frame
	// is authenticated (a forged frame must not burn a nonce). The pre-check above is only an
	// optimisation, since concurrent identical frames can all pass it.
	if !w.nonces.claim(nonce) {
		return
	}
	select {
	case w.inflight <- struct{}{}:
		defer func() { <-w.inflight }()
	default:
		// Too many requests in flight: answer with an authenticated 503 instead of queueing.
		w.reply(t, msg, out, httpRes{S: 503, H: map[string][]string{"Content-Type": {"text/plain; charset=utf-8"}}, B: b64.EncodeToString([]byte("Excalibash : trop de requêtes simultanées"))})
		return
	}

	var req httpReq
	if json.Unmarshal(pt, &req) != nil {
		return
	}
	w.reply(t, msg, out, w.forward(t, req))
}

// underTarget joins a request path to the tunnel's target path. ".." segments are resolved
// first, so "/../admin" stays under the target ("/app/admin") instead of leaving it. Nothing else
// changes: sites may rely on "//" or "/./" in their URLs.
func underTarget(prefix, p string) string {
	in := strings.Split(strings.TrimPrefix(p, "/"), "/")
	out := make([]string, 0, len(in))
	for _, seg := range in {
		if seg == ".." {
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			continue
		}
		out = append(out, seg)
	}
	// A trailing ".." still names a directory.
	if len(in) > 0 && in[len(in)-1] == ".." {
		out = append(out, "")
	}
	return strings.TrimSuffix(prefix, "/") + "/" + strings.Join(out, "/")
}

// reply seals a response under the tunnel key and queues it.
func (w *webHub) reply(t *tunnel, msg message, out *outbox, res httpRes) {
	plain, _ := json.Marshal(res)
	boxed, err := box(t.key, plain, "eb:http-res:"+msg.ID+":"+msg.Rid)
	if err != nil {
		return
	}
	out.send(message{T: "http.res", ID: msg.ID, Rid: msg.Rid, D: b64.EncodeToString(boxed)})
}

func (w *webHub) forward(t *tunnel, r httpReq) httpRes {
	fail := func(status int, text string) httpRes {
		return httpRes{S: status, H: map[string][]string{"Content-Type": {"text/plain; charset=utf-8"}}, B: b64.EncodeToString([]byte(text))}
	}
	// Only a path (and query) is accepted: the host comes from the sealed target.
	if !strings.HasPrefix(r.P, "/") || strings.HasPrefix(r.P, "//") {
		return fail(400, "chemin invalide")
	}
	body, err := b64.DecodeString(r.B)
	if err != nil {
		return fail(400, "corps invalide")
	}
	dest := *t.target
	ref, err := url.Parse(r.P)
	if err != nil {
		return fail(400, "chemin invalide")
	}
	dest.Path = underTarget(t.target.Path, ref.Path)
	dest.RawQuery = ref.RawQuery
	method := strings.ToUpper(r.M)
	if method == "" {
		method = http.MethodGet
	}
	req, err := http.NewRequest(method, dest.String(), bytes.NewReader(body))
	if err != nil {
		return fail(400, err.Error())
	}
	if t.hostHeader != "" {
		req.Host = t.hostHeader
	}
	for k, vs := range r.H {
		if hopHeaders[http.CanonicalHeaderKey(k)] {
			continue
		}
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	transport := t.transport
	if transport == nil { // tunnels built without open() (tests)
		transport = &http.Transport{TLSClientConfig: t.tlsConfig(), DisableCompression: true, DisableKeepAlives: true}
	}
	client := &http.Client{
		Timeout: httpTimeout,
		// Redirects are handed back to the browser, which rewrites them into the tunnel.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport:     transport,
	}
	resp, err := client.Do(req)
	if err != nil {
		return fail(502, "Excalibash : impossible de joindre "+t.target.String()+" depuis la machine ("+err.Error()+")")
	}
	defer resp.Body.Close()
	buf, err := io.ReadAll(io.LimitReader(resp.Body, maxHTTPBody+1))
	if err != nil {
		return fail(502, err.Error())
	}
	if len(buf) > maxHTTPBody {
		return fail(502, "réponse trop volumineuse pour le tunnel")
	}
	h := map[string][]string{}
	for k, vs := range resp.Header {
		if !hopHeaders[k] {
			h[k] = vs
		}
	}
	return httpRes{S: resp.StatusCode, H: h, B: b64.EncodeToString(buf)}
}
