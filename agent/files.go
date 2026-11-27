package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// File transfer and packet capture. Every operation rides on an existing LOCAL shell terminal and
// is authorised by its terminal key K_t: whoever holds K_t can already type in that shell, so this
// grants no extra power. Requests are box(K_t, op, "eb:file-req:<term>:<rid>:<ts>"), answers are
// box(K_t, body, "eb:file-res:<term>:<rid>:<n>"). The server only relays opaque frames; file
// names, paths, contents, interface names and filters are all inside the boxes.

const (
	maxFileSize  = 200 << 20
	fileChunk    = 192 << 10
	maxLsEntries = 500
	lsScanLimit  = 5000
	maxXfers     = 4
	xferIdle     = 60 * time.Second
	streamWindow = 8 // chunks sent ahead of the client's acknowledgements
	maxNameBytes = 255
)

var (
	xferIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	errLocal = errors.New("transfert disponible seulement sur un shell local")
)

// cwder is implemented by sources that are a local shell with a working directory we can ask for.
type cwder interface{ cwd() (string, error) }

// cwd is the working directory of the shell. On Linux it is read from /proc; elsewhere (macOS) the
// agent cannot ask the kernel cheaply, so the home directory the shell started in is used.
func (l *localPTY) cwd() (string, error) {
	if runtime.GOOS == "linux" {
		if p, err := os.Readlink("/proc/" + strconv.Itoa(l.pid()) + "/cwd"); err == nil && filepath.IsAbs(p) {
			return p, nil
		}
	}
	return pickCwd(), nil
}

type fileOp struct {
	Op        string `json:"op"`
	Xfer      string `json:"xfer"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	Dir       string `json:"dir"`
	Overwrite bool   `json:"overwrite"`
	N         int    `json:"n"`
	Data      string `json:"data"`
	SHA256    string `json:"sha256"`
	Path      string `json:"path"`
	Iface     string `json:"iface"`
	Filter    string `json:"filter"`
	Seconds   int    `json:"seconds"`
	MaxBytes  int64  `json:"maxBytes"`
}

type fileHub struct {
	m *manager

	nonces *nonceSet

	mu     sync.Mutex
	xfers  map[string]*xfer
	active int
}

func newFileHub(m *manager) *fileHub {
	return &fileHub{m: m, nonces: newNonceSet(maxFileNonces), xfers: map[string]*xfer{}}
}

// xfer is one running transfer (upload, download or capture) of a terminal.
type xfer struct {
	h      *fileHub
	term   string
	id     string
	rid    string // request that started it: the answer stream of get and capture
	ctx    context.Context
	cancel context.CancelFunc
	idle   *time.Timer
	jobs   chan fileJob // put only: ordered operations
	acked  atomic.Int64
	credit chan struct{}
	// stop ends a capture gracefully (the file so far is delivered); set once the capture runs.
	stop atomic.Pointer[context.CancelFunc]
}

type fileJob struct {
	rid string
	op  fileOp
}

func (x *xfer) touch() { x.idle.Reset(xferIdle) }

// handle authenticates one "file" frame and dispatches it. The cheap, ordering-sensitive part
// runs on the read loop; the work runs in goroutines.
func (h *fileHub) handle(msg message, out *outbox) {
	ts, ok := parseTs(msg.Ts)
	if !ok || msg.ID == "" || msg.Rid == "" || len(msg.Rid) > 64 {
		return
	}
	if !tsInWindow(ts) {
		debugf("file %s: timestamp out of window", msg.ID)
		return
	}
	data, err := b64.DecodeString(msg.D)
	if err != nil {
		return
	}
	key, src := h.sessionKey(msg.ID)
	if key == nil {
		return
	}
	pt, err := unbox(key, data, "eb:file-req:"+msg.ID+":"+msg.Rid+":"+strconv.FormatInt(ts, 10))
	if err != nil {
		debugf("file %s: authentication failed", msg.ID)
		return
	}
	// Authoritative anti-replay: check and record atomically, only for authenticated frames.
	if !h.nonces.claim(msg.ID + "/" + msg.Rid) {
		return
	}
	var op fileOp
	if json.Unmarshal(pt, &op) != nil {
		return
	}
	fail := func(text string) { go h.replyOnce(msg.ID, msg.Rid, map[string]any{"error": text}) }
	c, local := src.(cwder)
	if !local {
		fail(errLocal.Error())
		return
	}
	switch op.Op {
	case "ack":
		if x := h.find(msg.ID, op.Xfer); x != nil {
			x.acked.Store(int64(op.N))
			x.touch()
			select {
			case x.credit <- struct{}{}:
			default:
			}
		}
	case "stop":
		if x := h.find(msg.ID, op.Xfer); x != nil {
			if f := x.stop.Load(); f != nil {
				(*f)()
			}
		}
	case "cancel":
		if x := h.find(msg.ID, op.Xfer); x != nil {
			x.cancel()
		}
	case "ls":
		go h.ls(msg.ID, msg.Rid, c, op)
	case "ifaces":
		// The capture panel offers the machine's real interfaces. Names and addresses only, from the
		// kernel's list (net.Interfaces): nothing is executed, and the answer is sealed like the rest.
		go h.replyOnce(msg.ID, msg.Rid, map[string]any{"ifaces": listIfaces(systemIfaces)})
	case "put":
		x, text := h.register(msg.ID, op.Xfer, msg.Rid, true)
		if x == nil {
			fail(text)
			return
		}
		go h.putWorker(x, c)
		x.jobs <- fileJob{msg.Rid, op}
	case "chunk", "end":
		x := h.find(msg.ID, op.Xfer)
		if x == nil || x.jobs == nil {
			fail("transfert inconnu ou expiré")
			return
		}
		select {
		case x.jobs <- fileJob{msg.Rid, op}:
		default:
			x.cancel()
		}
	case "get":
		x, text := h.register(msg.ID, op.Xfer, msg.Rid, false)
		if x == nil {
			fail(text)
			return
		}
		go h.get(x, c, op)
	case "capture":
		x, text := h.register(msg.ID, op.Xfer, msg.Rid, false)
		if x == nil {
			fail(text)
			return
		}
		go h.capture(x, op)
	default:
		fail("opération inconnue")
	}
}

// sessionKey returns the CURRENT terminal key (it changes on rekey) and the session's source.
func (h *fileHub) sessionKey(id string) ([]byte, source) {
	h.m.mu.Lock()
	defer h.m.mu.Unlock()
	s := h.m.sessions[id]
	if s == nil || s.key == nil || s.exited {
		return nil, nil
	}
	return append([]byte(nil), s.key...), s.src
}

func (h *fileHub) find(term, id string) *xfer {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.xfers[term+"/"+id]
}

// register creates the bookkeeping of a transfer, within the global concurrency cap.
func (h *fileHub) register(term, id, rid string, ordered bool) (*xfer, string) {
	if !xferIDRe.MatchString(id) {
		return nil, "identifiant de transfert invalide"
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.xfers[term+"/"+id] != nil {
		return nil, "identifiant de transfert déjà utilisé"
	}
	if h.active >= maxXfers {
		return nil, "trop de transferts simultanés sur cette machine"
	}
	ctx, cancel := context.WithCancel(context.Background())
	x := &xfer{h: h, term: term, id: id, rid: rid, ctx: ctx, cancel: cancel, credit: make(chan struct{}, 1)}
	x.idle = time.AfterFunc(xferIdle, cancel)
	if ordered {
		x.jobs = make(chan fileJob, 4*streamWindow)
	}
	h.xfers[term+"/"+id] = x
	h.active++
	return x, ""
}

func (h *fileHub) release(x *xfer) {
	x.cancel()
	x.idle.Stop()
	h.mu.Lock()
	if h.xfers[x.term+"/"+x.id] == x {
		delete(h.xfers, x.term+"/"+x.id)
		h.active--
	}
	h.mu.Unlock()
}

// reply seals one answer frame under the current terminal key; false means nobody can receive it.
func (h *fileHub) reply(term, rid string, n int, body any, end bool) bool {
	key, _ := h.sessionKey(term)
	if key == nil {
		return false
	}
	plain, err := json.Marshal(body)
	if err != nil {
		return false
	}
	boxed, err := box(key, plain, "eb:file-res:"+term+":"+rid+":"+strconv.Itoa(n))
	if err != nil {
		return false
	}
	h.m.mu.Lock()
	out := h.m.out
	h.m.mu.Unlock()
	if out == nil {
		return false
	}
	return out.send(message{T: "file.res", ID: term, Rid: rid, N: &n, D: b64.EncodeToString(boxed), End: end})
}

func (h *fileHub) replyOnce(term, rid string, body any) { h.reply(term, rid, 0, body, true) }

func fileError(text string) map[string]any { return map[string]any{"error": text} }

// ---- paths ------------------------------------------------------------------------

// validFileName refuses anything that is not a single plain path component.
func validFileName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > maxNameBytes || !utf8.ValidString(name) {
		return false
	}
	return !strings.ContainsAny(name, "/\\\x00")
}

// resolvePath is p made absolute against the shell's working directory.
func resolvePath(cwd, p string) (string, error) {
	if strings.ContainsRune(p, 0) || len(p) > 4096 {
		return "", errors.New("chemin invalide")
	}
	if p == "" {
		return cwd, nil
	}
	if filepath.IsAbs(p) {
		return filepath.Clean(p), nil
	}
	return filepath.Join(cwd, p), nil
}

// ---- ls ---------------------------------------------------------------------------

type lsEntry struct {
	Name  string `json:"name"`
	Dir   bool   `json:"dir"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

func (h *fileHub) ls(term, rid string, c cwder, op fileOp) {
	cwd, err := c.cwd()
	if err != nil {
		h.replyOnce(term, rid, fileError("répertoire courant introuvable"))
		return
	}
	dir, err := resolvePath(cwd, op.Path)
	if err != nil {
		h.replyOnce(term, rid, fileError(err.Error()))
		return
	}
	f, err := os.Open(dir)
	if err != nil {
		h.replyOnce(term, rid, fileError("dossier illisible : "+errText(err)))
		return
	}
	defer f.Close()
	des, err := f.ReadDir(lsScanLimit)
	if err != nil && !errors.Is(err, io.EOF) {
		h.replyOnce(term, rid, fileError("dossier illisible : "+errText(err)))
		return
	}
	entries := make([]lsEntry, 0, len(des))
	for _, de := range des {
		e := lsEntry{Name: de.Name()}
		if info, err := os.Stat(filepath.Join(dir, de.Name())); err == nil { // follows symlinks
			e.Dir, e.Size, e.Mtime = info.IsDir(), info.Size(), info.ModTime().UnixMilli()
		} else if info, err := de.Info(); err == nil {
			e.Size, e.Mtime = info.Size(), info.ModTime().UnixMilli()
		}
		if e.Dir {
			e.Size = 0
		}
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Dir != entries[j].Dir {
			return entries[i].Dir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	truncated := len(des) >= lsScanLimit
	if len(entries) > maxLsEntries {
		entries, truncated = entries[:maxLsEntries], true
	}
	h.replyOnce(term, rid, map[string]any{"cwd": dir, "entries": entries, "truncated": truncated})
}

// errText is a short, path-free description of a filesystem error.
func errText(err error) string {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return "introuvable"
	case errors.Is(err, os.ErrPermission):
		return "permission refusée"
	}
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err.Error()
	}
	return "erreur"
}

// ---- put --------------------------------------------------------------------------

type putState struct {
	file    *os.File
	part    string
	final   string
	size    int64
	written int64
	next    int
	hash    hash.Hash
	over    bool
	done    bool
}

func (p *putState) discard() {
	if p.file != nil {
		p.file.Close()
	}
	if p.part != "" && !p.done {
		os.Remove(p.part)
	}
}

// partName is the hidden temporary name used until the upload completes.
func partName(name string) string {
	base := name
	for len(base) > 200 {
		_, sz := utf8.DecodeLastRuneInString(base)
		base = base[:len(base)-sz]
	}
	return "." + base + ".excalibash-part-" + randomID(6)
}

// putWorker runs the ordered operations of one upload.
func (h *fileHub) putWorker(x *xfer, c cwder) {
	defer h.release(x)
	var st putState
	defer st.discard()
	for {
		var job fileJob
		select {
		case job = <-x.jobs:
		case <-x.ctx.Done():
			return
		}
		x.touch()
		body, end, ok := h.putStep(&st, c, job.op)
		if !h.reply(x.term, job.rid, 0, body, true) || !ok || end {
			return
		}
	}
}

// putStep applies one operation; ok=false aborts the upload, end=true means it completed.
func (h *fileHub) putStep(st *putState, c cwder, op fileOp) (body any, end, ok bool) {
	bad := func(text string) (any, bool, bool) { return fileError(text), false, false }
	switch op.Op {
	case "put":
		if st.file != nil {
			return bad("transfert déjà démarré")
		}
		if !validFileName(op.Name) {
			return bad("nom de fichier invalide")
		}
		if op.Size < 0 || op.Size > maxFileSize {
			return bad("fichier trop volumineux (200 Mio au maximum)")
		}
		cwd, err := c.cwd()
		if err != nil {
			return bad("répertoire courant introuvable")
		}
		dir, err := resolvePath(cwd, op.Dir)
		if err != nil {
			return bad(err.Error())
		}
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			return bad("dossier de destination introuvable")
		}
		final := filepath.Join(dir, op.Name)
		if info, err := os.Lstat(final); err == nil {
			if !op.Overwrite {
				return map[string]any{"error": "le fichier existe déjà", "code": "exists"}, false, false
			}
			if info.IsDir() {
				return bad("la destination est un dossier")
			}
		}
		part := filepath.Join(dir, partName(op.Name))
		f, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return bad("création impossible : " + errText(err))
		}
		*st = putState{file: f, part: part, final: final, size: op.Size, hash: sha256.New(), over: op.Overwrite}
		return map[string]any{"ok": true}, false, true
	case "chunk":
		if st.file == nil {
			return bad("transfert non démarré")
		}
		raw, err := b64.DecodeString(op.Data)
		if err != nil || len(raw) == 0 || len(raw) > fileChunk {
			return bad("morceau invalide")
		}
		if op.N != st.next || st.written+int64(len(raw)) > st.size {
			return bad("morceau hors séquence")
		}
		if _, err := st.file.Write(raw); err != nil {
			return bad("écriture impossible : " + errText(err))
		}
		st.hash.Write(raw)
		st.written += int64(len(raw))
		st.next++
		return map[string]any{"ok": true, "n": op.N}, false, true
	case "end":
		if st.file == nil {
			return bad("transfert non démarré")
		}
		if st.written != st.size {
			return bad("taille reçue différente de la taille annoncée")
		}
		if !strings.EqualFold(op.SHA256, hex.EncodeToString(st.hash.Sum(nil))) {
			return bad("empreinte SHA-256 incorrecte")
		}
		if err := st.file.Sync(); err != nil {
			return bad("écriture impossible : " + errText(err))
		}
		if err := st.file.Close(); err != nil {
			return bad("écriture impossible : " + errText(err))
		}
		st.file = nil
		if err := installPart(st.part, st.final, st.over); err != nil {
			os.Remove(st.part)
			st.part = ""
			if errors.Is(err, os.ErrExist) {
				return map[string]any{"error": "le fichier existe déjà", "code": "exists"}, false, false
			}
			return bad("finalisation impossible : " + errText(err))
		}
		st.done = true
		return map[string]any{"ok": true, "path": st.final}, true, true
	}
	return bad("opération inconnue")
}

// installPart moves the finished part file to its final name. Without overwrite a hard link is
// used so that a file created meanwhile is never replaced.
func installPart(part, final string, overwrite bool) error {
	if overwrite {
		// Lstat: a symlink planted at that name must not lend its target's mode (0666…) to our file.
		if info, err := os.Lstat(final); err == nil && info.Mode().IsRegular() {
			_ = os.Chmod(part, info.Mode().Perm())
		}
		return os.Rename(part, final)
	}
	if err := os.Link(part, final); err == nil {
		return os.Remove(part)
	} else if errors.Is(err, os.ErrExist) {
		return err
	}
	// File systems without hard links: best effort.
	if _, err := os.Lstat(final); err == nil {
		return os.ErrExist
	}
	return os.Rename(part, final)
}

// ---- streaming (get, capture) -------------------------------------------------------

// stream sends the answer of get and capture as numbered frames, within the client's window.
type stream struct {
	x    *xfer
	n    int
	hash hash.Hash
	size int64
}

func newStream(x *xfer) *stream { return &stream{x: x, hash: sha256.New()} }

// waitWindow blocks until the client acknowledged enough chunks to keep sending.
func (s *stream) waitWindow() bool {
	for int64(s.n)-s.x.acked.Load() >= streamWindow {
		select {
		case <-s.x.credit:
		case <-s.x.ctx.Done():
			return false
		case <-time.After(xferIdle):
			return false
		}
	}
	return s.x.ctx.Err() == nil
}

func (s *stream) send(body map[string]any, data []byte, end bool) bool {
	if !s.waitWindow() {
		return false
	}
	s.x.touch()
	if data != nil {
		s.hash.Write(data)
		s.size += int64(len(data))
		body["data"] = b64.EncodeToString(data)
	}
	if end {
		body["end"] = true
		body["sha256"] = hex.EncodeToString(s.hash.Sum(nil))
		if _, ok := body["size"]; !ok {
			body["size"] = s.size
		}
	}
	ok := s.x.h.reply(s.x.term, s.x.rid, s.n, body, end)
	s.n++
	return ok
}

// finish reports a failure (best effort) on the transfer's answer stream.
func (s *stream) fail(text string) {
	s.x.h.reply(s.x.term, s.x.rid, s.n, fileError(text), true)
}

func (h *fileHub) get(x *xfer, c cwder, op fileOp) {
	defer h.release(x)
	s := newStream(x)
	cwd, err := c.cwd()
	if err != nil {
		s.fail("répertoire courant introuvable")
		return
	}
	path, err := resolvePath(cwd, op.Path)
	if err != nil || op.Path == "" {
		s.fail("chemin invalide")
		return
	}
	f, err := os.Open(path)
	if err != nil {
		s.fail("ouverture impossible : " + errText(err))
		return
	}
	defer f.Close()
	info, err := f.Stat()
	switch {
	case err != nil:
		s.fail("lecture impossible")
		return
	case !info.Mode().IsRegular():
		s.fail("seuls les fichiers ordinaires peuvent être téléchargés")
		return
	case info.Size() > maxFileSize:
		s.fail("fichier trop volumineux (200 Mio au maximum)")
		return
	}
	total := info.Size()
	rd := io.LimitReader(f, total)
	buf, next := make([]byte, fileChunk), make([]byte, fileChunk)
	n, err := io.ReadFull(rd, buf)
	first := true
	for {
		if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
			s.fail("lecture impossible")
			return
		}
		last := err != nil // short or empty read: nothing follows
		var nn int
		var nerr error
		if !last {
			nn, nerr = io.ReadFull(rd, next)
			if nn == 0 && nerr == io.EOF {
				last = true
			}
		}
		body := map[string]any{}
		if first {
			body["name"], body["size"] = filepath.Base(path), total
			first = false
		}
		if !s.send(body, buf[:n], last) {
			return
		}
		if last {
			if s.size != total {
				debugf("get %s: file changed while reading", x.term)
			}
			return
		}
		buf, next = next, buf
		n, err = nn, nerr
	}
}
