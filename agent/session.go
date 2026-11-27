package main

import (
	"crypto/ecdh"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

const (
	readChunk     = 32 * 1024
	offlineBuffer = 256 * 1024
	// Inputs older (or further in the future) than this are refused.
	inputMaxSkew = 5 * time.Minute
	// Replay-protection state kept per session, oldest sender evicted first.
	maxSenders = 1000
)

// manager owns every terminal session. Sessions outlive websocket connections:
// while no connection is attached, output is kept in a per-session ring buffer
// and exits are remembered until they can be reported.
type manager struct {
	mu sync.Mutex
	// auth is shared only with the machine's owner (derived from the key they generated):
	// a terminal key that is not boxed under it cannot have been issued by them.
	auth     []byte
	sessions map[string]*session
	web      *webHub
	probe    *probeHub
	files    *fileHub
	update   *updater
	out      *outbox // nil while disconnected
}

// source is what a session runs: a local shell in a PTY or a connection to a remote host.
// Output is read until the source ends; wait then returns its exit code and close releases
// the output side.
type source interface {
	io.ReadWriter
	resize(cols, rows uint16)
	kill()
	wait() int
	close()
	pid() int
	describe() string
}

// session state below src is guarded by manager.mu.
type session struct {
	id      string
	src     source
	pending []byte // plaintext output produced while disconnected
	exited  bool
	code    int

	key     []byte // terminal key K_t
	gen     string // changes on every launch and rekey
	seq     uint64 // last output sequence number used in gen
	senders map[string]*sender
	order   uint64
}

// sender tracks the highest input counter accepted from one browser tab.
type sender struct {
	k     uint64
	order uint64
}

func newManager(priv *ecdh.PrivateKey) *manager {
	return newManagerWithAuth(machineAuthKey(priv))
}

// newManagerWithAuth runs with a machine auth key received at pairing time.
func newManagerWithAuth(auth []byte) *manager {
	m := &manager{auth: auth, sessions: map[string]*session{}, web: newWebHub(auth), probe: newProbeHub(auth)}
	m.files = newFileHub(m)
	m.update = newUpdater(auth)
	m.update.beforeExec = m.closeAll
	return m
}

// openKey decrypts a terminal key issued by the machine's owner: either the raw key (local
// shell) or {k, target} for a remote session. The target is sealed with the key, so the
// server can neither read nor change it.
func (m *manager) openKey(id, boxed string) ([]byte, *target, error) {
	data, err := b64.DecodeString(boxed)
	if err != nil {
		return nil, nil, errCrypto
	}
	pt, err := unbox(m.auth, data, "eb:term:"+id)
	if err != nil {
		return nil, nil, errCrypto
	}
	if len(pt) == keyLen {
		return pt, nil, nil
	}
	var spec struct {
		K      string          `json:"k"`
		Target json.RawMessage `json:"target"`
	}
	if json.Unmarshal(pt, &spec) != nil {
		return nil, nil, errCrypto
	}
	key, err := b64.DecodeString(spec.K)
	if err != nil || len(key) != keyLen {
		return nil, nil, errCrypto
	}
	t, err := parseTarget(spec.Target)
	if err != nil {
		return nil, nil, err
	}
	return key, t, nil
}

// outputFrame encrypts data as the next output chunk. Caller holds m.mu.
func (s *session) outputFrame(data []byte) (message, error) {
	s.seq++
	aad := "eb:term-out:" + s.id + ":" + s.gen + ":" + strconv.FormatUint(s.seq, 10)
	d, err := box(s.key, data, aad)
	if err != nil {
		return message{}, err
	}
	return message{T: "output", ID: s.id, Gen: s.gen, Seq: s.seq, D: b64.EncodeToString(d)}, nil
}

// sendOutput encrypts and queues data; false means it must be buffered. Caller holds m.mu.
func (m *manager) sendOutput(s *session, data []byte) bool {
	if m.out == nil {
		return false
	}
	frame, err := s.outputFrame(data)
	if err != nil {
		log.Printf("encrypt %s: %v", s.id, err)
		return true // drop: retrying would fail the same way
	}
	return m.out.send(frame)
}

// attach starts routing output to out. Buffered output and unreported exits
// are flushed first so the server sees them in order.
func (m *manager) attach(out *outbox) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, s := range m.sessions {
		if len(s.pending) > 0 {
			if frame, err := s.outputFrame(s.pending); err == nil {
				out.send(frame)
			}
			s.pending = nil
		}
		if s.exited {
			out.send(message{T: "exit", ID: id, Code: intPtr(s.code)})
			delete(m.sessions, id)
			continue
		}
		// The server may have lost its scrollback: re-announce the current gen.
		if frame, err := s.outputFrame(nil); err == nil {
			out.send(frame)
		}
	}
	m.out = out
}

func (m *manager) detach(out *outbox) {
	m.mu.Lock()
	detached := m.out == out
	if detached {
		m.out = nil
	}
	m.mu.Unlock()
	if detached {
		m.web.closeSockets("")
	}
}

// ids lists sessions the server should know about (alive or with an unreported exit).
func (m *manager) ids() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	return ids
}

func (m *manager) emitOutput(s *session, data []byte) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sendOutput(s, data) {
		return
	}
	s.pending = append(s.pending, data...)
	if over := len(s.pending) - offlineBuffer; over > 0 {
		s.pending = append([]byte(nil), s.pending[over:]...)
	}
}

func (m *manager) emitExit(s *session, code int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.out != nil && m.out.send(message{T: "exit", ID: s.id, Code: intPtr(code)}) {
		delete(m.sessions, s.id)
		return
	}
	s.exited, s.code = true, code
}

func (m *manager) get(id string) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

func (m *manager) open(msg message, out *outbox) {
	if s := m.get(msg.ID); s != nil {
		out.send(message{T: "opened", ID: msg.ID, Pid: s.src.pid()})
		return
	}
	key, t, err := m.openKey(msg.ID, msg.Key)
	if err != nil {
		log.Printf("open %s: %v", msg.ID, err)
		text := "clé de terminal invalide"
		if errors.Is(err, errTarget) {
			text = err.Error()
		}
		out.send(message{T: "exit", ID: msg.ID, Code: intPtr(-1), Error: text})
		return
	}

	cols, rows := orDefault(msg.Cols, 80), orDefault(msg.Rows, 24)
	var src source
	if t != nil {
		src = startRemote(*t, cols, rows)
	} else if src, err = startLocal(cols, rows); err != nil {
		log.Printf("open %s: %v", msg.ID, err)
		out.send(message{T: "exit", ID: msg.ID, Code: intPtr(-1), Error: err.Error()})
		return
	}

	s := &session{id: msg.ID, src: src, key: key, gen: randomID(6), senders: map[string]*sender{}}
	log.Printf("session %s started (%s)", s.id, src.describe())
	out.send(message{T: "opened", ID: s.id, Pid: src.pid()})
	m.mu.Lock()
	m.sessions[s.id] = s
	// Browsers bind their keystrokes to the gen: announce it even if the shell stays silent.
	m.sendOutput(s, nil)
	m.mu.Unlock()

	go m.pump(s)
}

// pump forwards output until the source ends, then reports the exit code.
func (m *manager) pump(s *session) {
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buf := make([]byte, readChunk)
		for {
			n, err := s.src.Read(buf)
			if n > 0 {
				m.emitOutput(s, append([]byte(nil), buf[:n]...))
			}
			if err != nil {
				return
			}
		}
	}()

	code := s.src.wait()
	// Background jobs may keep the PTY open; give the reader a moment to drain.
	select {
	case <-readDone:
	case <-time.After(200 * time.Millisecond):
	}
	s.src.close()
	<-readDone

	log.Printf("session %s exited (%d)", s.id, code)
	m.emitExit(s, code)
}

// rekey switches a session to a new terminal key; output restarts in a new gen.
func (m *manager) rekey(msg message) {
	// A remote session keeps its target: only the key is taken from the new payload.
	key, _, err := m.openKey(msg.ID, msg.Key)
	if err != nil {
		log.Printf("rekey %s: invalid terminal key", msg.ID)
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[msg.ID]; s != nil {
		s.key, s.gen, s.seq = key, randomID(6), 0
		s.senders = map[string]*sender{}
		m.sendOutput(s, nil)
	}
}

// input decrypts keystrokes and writes them to the session's source. Frames that are stale,
// replayed or fail authentication are dropped.
func (m *manager) input(msg message) {
	ts, ok := parseTs(msg.Ts)
	if !ok || msg.S == "" || msg.K == 0 {
		debugf("input %s: malformed frame", msg.ID)
		return
	}
	if !tsInWindow(ts) {
		debugf("input %s: timestamp out of window", msg.ID)
		return
	}
	data, err := b64.DecodeString(msg.D)
	if err != nil {
		return
	}

	m.mu.Lock()
	s := m.sessions[msg.ID]
	if s == nil || s.key == nil {
		m.mu.Unlock()
		return
	}
	if last := s.senders[msg.S]; last != nil && msg.K <= last.k {
		m.mu.Unlock()
		debugf("input %s: replayed counter %d from %s", msg.ID, msg.K, msg.S)
		return
	}
	// Binding the gen means frames captured before a restart or rekey can never be replayed into the new shell.
	aad := "eb:term-in:" + msg.ID + ":" + s.gen + ":" + msg.S + ":" + strconv.FormatUint(msg.K, 10) + ":" + strconv.FormatInt(ts, 10)
	pt, err := unbox(s.key, data, aad)
	if err != nil {
		m.mu.Unlock()
		debugf("input %s: authentication failed", msg.ID)
		return
	}
	s.remember(msg.S, msg.K)
	src := s.src
	m.mu.Unlock()

	if _, err := src.Write(pt); err != nil && !errors.Is(err, os.ErrClosed) {
		log.Printf("input %s: %v", msg.ID, err)
	}
}

// remember records the latest counter for a sender. Caller holds m.mu.
func (s *session) remember(id string, k uint64) {
	s.order++
	if st := s.senders[id]; st != nil {
		st.k, st.order = k, s.order
		return
	}
	if len(s.senders) >= maxSenders {
		var oldest string
		var min uint64
		for sid, st := range s.senders {
			if oldest == "" || st.order < min {
				oldest, min = sid, st.order
			}
		}
		delete(s.senders, oldest)
	}
	s.senders[id] = &sender{k: k, order: s.order}
}

func (m *manager) resize(id string, cols, rows uint16) {
	if s := m.get(id); s != nil && cols > 0 && rows > 0 {
		s.src.resize(cols, rows)
	}
}

func (m *manager) kill(id string) {
	if s := m.get(id); s != nil {
		s.src.kill()
	}
}

func (m *manager) closeAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.kill(id)
	}
}

// localPTY is the machine's own login shell.
type localPTY struct {
	cmd    *exec.Cmd
	ptmx   *os.File
	exited chan struct{}
}

func startLocal(cols, rows uint16) (*localPTY, error) {
	// The shell and directory are the machine's own defaults: the server has no say in what runs here.
	cmd := exec.Command(pickShell(), "-l")
	cmd.Dir = pickCwd()
	cmd.Env = shellEnv()
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}
	return &localPTY{cmd: cmd, ptmx: ptmx, exited: make(chan struct{})}, nil
}

func (l *localPTY) Read(p []byte) (int, error)  { return l.ptmx.Read(p) }
func (l *localPTY) Write(p []byte) (int, error) { return l.ptmx.Write(p) }
func (l *localPTY) close()                      { l.ptmx.Close() }
func (l *localPTY) pid() int                    { return l.cmd.Process.Pid }

func (l *localPTY) describe() string {
	return l.cmd.Path + ", pid " + strconv.Itoa(l.pid())
}

func (l *localPTY) resize(cols, rows uint16) {
	_ = pty.Setsize(l.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

func (l *localPTY) wait() int {
	err := l.cmd.Wait()
	close(l.exited)
	return exitCode(l.cmd, err)
}

// kill sends SIGHUP to the shell's process group, then SIGKILL after 2s.
func (l *localPTY) kill() {
	pgid := l.cmd.Process.Pid
	_ = syscall.Kill(-pgid, syscall.SIGHUP)
	go func() {
		select {
		case <-l.exited:
		case <-time.After(2 * time.Second):
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}()
}

func pickShell() string {
	for _, sh := range []string{os.Getenv("SHELL"), "/bin/bash", "/bin/sh"} {
		if sh == "" {
			continue
		}
		if path, err := exec.LookPath(sh); err == nil {
			return path
		}
	}
	return "/bin/sh"
}

func pickCwd() string {
	for _, dir := range []string{os.Getenv("HOME"), "/"} {
		if dir == "" {
			continue
		}
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			return dir
		}
	}
	return "/"
}

func shellEnv() []string {
	env := make([]string, 0, len(os.Environ())+3)
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "TERM=") || strings.HasPrefix(kv, "COLORTERM=") ||
			strings.HasPrefix(kv, "EXCALIBASH_TOKEN=") || strings.HasPrefix(kv, "EXCALIBASH_KEY=") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "TERM=xterm-256color", "COLORTERM=truecolor", "EXCALIBASH=1")
}

func exitCode(cmd *exec.Cmd, err error) int {
	if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok {
		if ws.Signaled() {
			return 128 + int(ws.Signal())
		}
		return ws.ExitStatus()
	}
	if err != nil {
		return -1
	}
	return 0
}

func orDefault(v, def uint16) uint16 {
	if v == 0 {
		return def
	}
	return v
}

func intPtr(v int) *int { return &v }

var debug = os.Getenv("EXCALIBASH_DEBUG") != ""

func debugf(format string, args ...any) {
	if debug {
		log.Printf(format, args...)
	}
}
