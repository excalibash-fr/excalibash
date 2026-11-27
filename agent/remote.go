package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

// Remote sessions: the owner seals a target (telnet, ssh or raw TCP) with the terminal key, and
// this agent connects to it. The session stays the same encrypted stream as a local shell;
// only its source changes.

const (
	dialTimeout   = 10 * time.Second
	maxHops       = 8
	maxInputQueue = 1 << 20
	maxLineLen    = 1024
)

var (
	errTarget  = errors.New("cible distante invalide")
	errAborted = errors.New("saisie annulée")

	targetHost = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,253}$`) // mirrors web/src/validators.ts
	targetUser = regexp.MustCompile(`^[A-Za-z0-9._@\-]{0,64}$`) // mirrors web/src/validators.ts
)

type target struct {
	Kind          string `json:"kind"`
	Host          string `json:"host"`
	Port          int    `json:"port"`
	User          string `json:"user"`
	LegacyKex     bool   `json:"legacyKex"`
	LegacyHostKey bool   `json:"legacyHostKey"`
	LegacyCiphers bool   `json:"legacyCiphers"`
	HostKeyCheck  string `json:"hostKeyCheck"`
	// Jupyter only: working directory of the kernel (absolute or ~/…) and kernel name.
	Cwd    string `json:"cwd,omitempty"`
	Kernel string `json:"kernel,omitempty"`
	// Via: SSH jump hosts, first one reached from this machine (like ssh -J). The target is
	// reached from the last one, whatever its kind.
	Via []target `json:"via"`
}

func badTarget(why string) error { return fmt.Errorf("%w : %s", errTarget, why) }

func parseTarget(raw json.RawMessage) (*target, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, badTarget("cible absente")
	}
	var t target
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, badTarget("format incorrect")
	}
	if err := t.validate(); err != nil {
		return nil, err
	}
	if len(t.Via) > maxHops {
		return nil, badTarget("trop de rebonds")
	}
	for i := range t.Via {
		h := &t.Via[i]
		if h.Kind == "" {
			h.Kind = "ssh"
		}
		if h.Kind != "ssh" {
			return nil, badTarget("un rebond se fait en SSH")
		}
		if len(h.Via) > 0 {
			return nil, badTarget("rebond imbriqué")
		}
		if err := h.validate(); err != nil {
			return nil, err
		}
		// A jump host always checks its key: the hop is where an interception would sit unseen.
		if h.HostKeyCheck == "off" {
			return nil, badTarget("la vérification de clé d'hôte ne se désactive pas sur un rebond")
		}
	}
	return &t, nil
}

// validate checks and completes one hop or target.
func (t *target) validate() error {
	switch t.Kind {
	case "jupyter":
		return t.validateJupyter()
	case "telnet", "ssh", "raw":
	default:
		return badTarget("type de connexion inconnu")
	}
	if !targetHost.MatchString(t.Host) {
		return badTarget("adresse d'hôte incorrecte")
	}
	if t.Port == 0 && t.Kind != "raw" {
		t.Port = map[string]int{"telnet": 23, "ssh": 22}[t.Kind]
	}
	if t.Port < 1 || t.Port > 65535 {
		return badTarget("port hors de 1 à 65535")
	}
	if !targetUser.MatchString(t.User) {
		return badTarget("nom d'utilisateur incorrect")
	}
	switch t.HostKeyCheck {
	case "":
		t.HostKeyCheck = "tofu"
	case "tofu", "off":
	default:
		return badTarget("vérification de clé d'hôte inconnue")
	}
	return nil
}

func (t target) addr() string { return net.JoinHostPort(t.Host, strconv.Itoa(t.Port)) }

// remote runs a connection in its own goroutine. Its output goes through a pipe read by the
// session pump; keystrokes are queued for the connection or for an interactive prompt.
type remote struct {
	t      target
	out    *io.PipeReader
	outW   *io.PipeWriter
	in     *inputQueue
	ctx    context.Context
	cancel context.CancelFunc
	ended  chan struct{}
	code   int

	mu       sync.Mutex
	cols     uint16
	rows     uint16
	onResize func(cols, rows uint16)
}

func startRemote(t target, cols, rows uint16) *remote {
	ctx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	r := &remote{
		t: t, out: pr, outW: pw, in: newInputQueue(), ctx: ctx, cancel: cancel,
		ended: make(chan struct{}), cols: cols, rows: rows,
	}
	go func() {
		if t.Kind != "jupyter" { // a Jupyter stream carries protocol lines only
			hostname, _ := os.Hostname()
			r.printf("\x1b[90mConnexion à %s (%s) depuis %s%s…\x1b[0m\r\n", t.addr(), t.Kind, hostname, t.viaText())
		}
		var code int
		switch t.Kind {
		case "telnet":
			code = r.runTelnet()
		case "ssh":
			code = r.runSSH()
		case "jupyter":
			code = r.runJupyter()
		default:
			code = r.runRaw()
		}
		if ctx.Err() != nil {
			code = 128 + int(syscall.SIGHUP) // what a killed local shell reports
		}
		r.code = code
		cancel()
		r.in.close()
		pw.Close()
		close(r.ended)
	}()
	return r
}

func (r *remote) Read(p []byte) (int, error) { return r.out.Read(p) }

func (r *remote) Write(p []byte) (int, error) {
	if err := r.in.push(p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (r *remote) kill()     { r.cancel(); r.in.close() }
func (r *remote) wait() int { <-r.ended; return r.code }
func (r *remote) close()    { r.out.Close() }
func (r *remote) pid() int  { return 0 }

func (t target) userAddr() string {
	if t.User != "" {
		return t.User + "@" + t.addr()
	}
	return t.addr()
}

// viaText lists the jump hosts (" par a, b"), or nothing.
func (t target) viaText() string {
	if len(t.Via) == 0 {
		return ""
	}
	hops := make([]string, len(t.Via))
	for i, h := range t.Via {
		hops[i] = h.userAddr()
	}
	return " par " + strings.Join(hops, ", ")
}

func (r *remote) describe() string {
	if r.t.Kind == "jupyter" {
		return r.t.describeJupyter()
	}
	return r.t.Kind + " " + r.t.userAddr() + r.t.viaText()
}

func (r *remote) resize(cols, rows uint16) {
	r.mu.Lock()
	r.cols, r.rows = cols, rows
	fn := r.onResize
	r.mu.Unlock()
	if fn != nil {
		fn(cols, rows)
	}
}

func (r *remote) size() (cols, rows uint16) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cols, r.rows
}

// setResize installs the handler for later resizes once the connection can carry them.
func (r *remote) setResize(fn func(cols, rows uint16)) {
	r.mu.Lock()
	r.onResize = fn
	r.mu.Unlock()
}

func (r *remote) printf(format string, args ...any) {
	fmt.Fprintf(r.outW, format, args...)
}

// dial opens the connection to the target, through the jump hosts if any. Everything it opens
// is closed as soon as the session ends or is killed.
func (r *remote) dial() (net.Conn, bool) {
	if len(r.t.Via) == 0 {
		return r.dialTCP(r.t.addr())
	}
	conn, ok := r.dialTCP(r.t.Via[0].addr())
	if !ok {
		return nil, false
	}
	for i, h := range r.t.Via {
		r.printf("\x1b[90mRebond %d/%d : %s\x1b[0m\r\n", i+1, len(r.t.Via), h.userAddr())
		client, ok := r.sshClient(conn, h)
		if !ok {
			return nil, false
		}
		context.AfterFunc(r.ctx, func() { client.Close() })
		next := r.t.addr()
		if i+1 < len(r.t.Via) {
			next = r.t.Via[i+1].addr()
		}
		ctx, cancel := context.WithTimeout(r.ctx, dialTimeout)
		c, err := client.DialContext(ctx, "tcp", next)
		cancel()
		if err != nil {
			if r.ctx.Err() == nil {
				r.printf("%s ne peut pas joindre %s : %v\r\n", h.Host, next, err)
			}
			return nil, false
		}
		context.AfterFunc(r.ctx, func() { c.Close() })
		conn = c
	}
	return conn, true
}

// dialTCP opens a TCP connection from this machine.
func (r *remote) dialTCP(addr string) (net.Conn, bool) {
	d := net.Dialer{Timeout: dialTimeout}
	conn, err := d.DialContext(r.ctx, "tcp", addr)
	if err != nil {
		if r.ctx.Err() == nil {
			var op *net.OpError
			if errors.As(err, &op) {
				err = op.Err
			}
			r.printf("Impossible de joindre %s : %v\r\n", addr, err)
		}
		return nil, false
	}
	context.AfterFunc(r.ctx, func() { conn.Close() })
	return conn, true
}

// closedBy reports the end of the connection, unless the session itself was closed.
func (r *remote) closedBy() {
	if r.ctx.Err() == nil {
		r.printf("\r\nConnexion fermée par %s.\r\n", r.t.Host)
	}
}

// pumpInput forwards keystrokes to w until the session ends.
func (r *remote) pumpInput(w io.Writer) {
	buf := make([]byte, readChunk)
	for {
		n, err := r.in.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (r *remote) runRaw() int {
	conn, ok := r.dial()
	if !ok {
		return 1
	}
	defer conn.Close()
	go r.pumpInput(conn)
	_, _ = io.Copy(r.outW, conn)
	r.closedBy()
	return 0
}

// readLine reads one line typed in the terminal, for login prompts. Without echo nothing is
// shown (passwords). Ctrl+C aborts with errAborted.
func (r *remote) readLine(echo bool) (string, error) {
	var line []byte
	b := make([]byte, 1)
	esc := 0 // 1 after ESC, 2 inside a CSI/SS3 sequence (arrow keys…), which is skipped
	for {
		if _, err := r.in.Read(b); err != nil {
			return "", err
		}
		c := b[0]
		switch {
		case esc == 1:
			esc = 0
			if c == '[' || c == 'O' {
				esc = 2
			}
		case esc == 2:
			if c >= 0x40 && c <= 0x7e {
				esc = 0
			}
		case c == '\r' || c == '\n':
			if c == '\r' {
				r.in.dropNext('\n')
			}
			r.printf("\r\n")
			return string(line), nil
		case c == 0x03:
			r.printf("^C\r\n")
			return "", errAborted
		case c == 0x7f || c == 0x08:
			if len(line) > 0 {
				_, n := utf8.DecodeLastRune(line)
				line = line[:len(line)-n]
				if echo {
					r.printf("\b \b")
				}
			}
		case c == 0x1b:
			esc = 1
		case c < 0x20:
		default:
			if len(line) < maxLineLen {
				line = append(line, c)
				if echo {
					_, _ = r.outW.Write(b)
				}
			}
		}
	}
}

// inputQueue buffers keystrokes so that a slow remote never blocks the agent's connection.
type inputQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	buf    []byte
	closed bool
}

func newInputQueue() *inputQueue {
	q := &inputQueue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

func (q *inputQueue) push(p []byte) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return os.ErrClosed
	}
	if len(q.buf)+len(p) > maxInputQueue {
		debugf("remote input queue full, dropping %d bytes", len(p))
		return nil
	}
	q.buf = append(q.buf, p...)
	q.cond.Signal()
	return nil
}

func (q *inputQueue) Read(p []byte) (int, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.buf) == 0 && !q.closed {
		q.cond.Wait()
	}
	if len(q.buf) == 0 {
		return 0, io.EOF
	}
	n := copy(p, q.buf)
	q.buf = q.buf[n:]
	return n, nil
}

// dropNext discards c if it is the next byte already queued (the LF of a pasted CR LF).
func (q *inputQueue) dropNext(c byte) {
	q.mu.Lock()
	if len(q.buf) > 0 && q.buf[0] == c {
		q.buf = q.buf[1:]
	}
	q.mu.Unlock()
}

func (q *inputQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.cond.Broadcast()
	q.mu.Unlock()
}
