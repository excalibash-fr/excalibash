package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

// Jupyter sessions: the agent runs a small Python bridge that drives a Jupyter kernel on this
// machine and speaks a JSON-lines protocol (see docs/SECURITY.md). The lines travel in the
// same encrypted terminal stream as any other session; the server only sees their size and timing.
//
// Authority: this executes code as the agent's user, exactly like a local shell. The target is
// only accepted inside a terminal key sealed under machineAuth (see openKey), never from anything
// the server or a board editor can write.

//go:embed kernel_bridge.py
var kernelBridge string

const (
	kernelStderrCap = 64 << 10 // total bridge stderr forwarded as log lines
	kernelStopGrace = 3 * time.Second
	maxCwdLen       = 512
	maxKernels      = 8 // concurrent Jupyter sessions per agent
)

// kernelSlots caps the number of bridges (each with its kernel) running at once: a kernel holds
// a whole interpreter, so a burst of sessions from a compromised board cannot exhaust the machine.
var kernelSlots = make(chan struct{}, maxKernels)

// setParentDeathSignal asks the kernel (Linux, FreeBSD) to SIGKILL the bridge when the agent
// dies, so a crashed or SIGKILLed agent leaves no bridge (and, through the bridge, no kernel)
// behind. The field only exists on some systems, hence reflection rather than build tags.
func setParentDeathSignal(attr *syscall.SysProcAttr) {
	if f := reflect.ValueOf(attr).Elem().FieldByName("Pdeathsig"); f.IsValid() && f.CanSet() {
		f.Set(reflect.ValueOf(syscall.SIGKILL).Convert(f.Type()))
	}
}

var kernelName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// validateJupyter checks and completes a jupyter target. It has no host, port or user.
func (t *target) validateJupyter() error {
	if t.Host != "" || t.Port != 0 || t.User != "" || len(t.Via) > 0 {
		return badTarget("un noyau Jupyter n'a ni hôte, ni port, ni utilisateur, ni rebond")
	}
	if t.Kernel == "" {
		t.Kernel = "python3"
	}
	if !kernelName.MatchString(t.Kernel) {
		return badTarget("nom de noyau incorrect")
	}
	if t.Cwd != "" {
		if len(t.Cwd) > maxCwdLen || !utf8.ValidString(t.Cwd) || strings.ContainsAny(t.Cwd, "\x00\r\n") {
			return badTarget("répertoire de travail incorrect")
		}
		if !strings.HasPrefix(t.Cwd, "/") && t.Cwd != "~" && !strings.HasPrefix(t.Cwd, "~/") {
			return badTarget("le répertoire de travail doit être absolu ou commencer par ~/")
		}
	}
	return nil
}

func (t target) describeJupyter() string {
	cwd := t.Cwd
	if cwd == "" {
		cwd = "~"
	}
	return "jupyter " + t.Kernel + " " + cwd
}

func findPython() (string, error) {
	for _, name := range []string{"python3", "python"} {
		if p, err := exec.LookPath(name); err == nil {
			return p, nil
		}
	}
	return "", errors.New("python3 introuvable sur cette machine")
}

// kernelEvent writes one protocol line.
func kernelEvent(w io.Writer, ev map[string]any) {
	b, _ := json.Marshal(ev)
	_, _ = w.Write(append(b, '\n'))
}

// lineMux interleaves log lines (from the bridge's stderr) with the bridge's stdout without ever
// cutting a protocol line in two: logs wait for the next line boundary.
type lineMux struct {
	mu      sync.Mutex
	w       io.Writer
	midLine bool
	queued  []string
	logged  int
	capped  bool
}

func (m *lineMux) stdout(p []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.w.Write(p); err != nil {
		return err
	}
	if len(p) > 0 {
		m.midLine = p[len(p)-1] != '\n'
	}
	if !m.midLine {
		m.flushLocked()
	}
	return nil
}

func (m *lineMux) log(text string) {
	text = strings.ToValidUTF8(text, "�")
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.capped {
		return
	}
	if m.logged+len(text) > kernelStderrCap {
		text = text[:max(0, kernelStderrCap-m.logged)]
		text = strings.ToValidUTF8(text, "") + "\n[journal tronqué]"
		m.capped = true
	}
	m.logged += len(text)
	m.queued = append(m.queued, text)
	if !m.midLine {
		m.flushLocked()
	}
}

func (m *lineMux) flushLocked() {
	for _, t := range m.queued {
		kernelEvent(m.w, map[string]any{"ev": "log", "text": t})
	}
	m.queued = nil
}

// flush emits whatever logs are still queued (the bridge has ended: no line can be open).
func (m *lineMux) flush() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.midLine {
		_, _ = m.w.Write([]byte("\n"))
		m.midLine = false
	}
	m.flushLocked()
}

type muxWriter struct{ m *lineMux }

func (w muxWriter) Write(p []byte) (int, error) { w.m.log(string(p)); return len(p), nil }

func (r *remote) runJupyter() int {
	mux := &lineMux{w: r.outW}
	select {
	case kernelSlots <- struct{}{}:
		defer func() { <-kernelSlots }()
	default:
		kernelEvent(r.outW, map[string]any{"ev": "fatal", "error": fmt.Sprintf("trop de noyaux Jupyter ouverts sur cette machine (%d au maximum) : fermez-en un", maxKernels)})
		return 1
	}
	py, err := findPython()
	if err != nil {
		kernelEvent(r.outW, map[string]any{"ev": "fatal", "error": err.Error() + " : installez Python 3 avec ipykernel et jupyter_client"})
		return 1
	}
	cmd := exec.CommandContext(r.ctx, py, "-u", "-I", "-c", kernelBridge, r.t.Kernel, r.t.Cwd)
	cmd.Dir = pickCwd()
	cmd.Env = shellEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	setParentDeathSignal(cmd.SysProcAttr)
	// Cancellation: ask the bridge to stop (it shuts the kernel down), then Go kills it.
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = kernelStopGrace
	cmd.Stderr = muxWriter{mux}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		kernelEvent(r.outW, map[string]any{"ev": "fatal", "error": "lancement impossible : " + errText(err)})
		return 1
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		kernelEvent(r.outW, map[string]any{"ev": "fatal", "error": "lancement impossible : " + errText(err)})
		return 1
	}
	if err := cmd.Start(); err != nil {
		kernelEvent(r.outW, map[string]any{"ev": "fatal", "error": "lancement de Python impossible : " + errText(err)})
		return 1
	}
	pgid := cmd.Process.Pid
	defer func() { _ = syscall.Kill(-pgid, syscall.SIGKILL) }() // nothing outlives the session

	go func() {
		r.pumpInput(stdin)
		stdin.Close() // EOF: the bridge shuts the kernel down
	}()
	buf := make([]byte, readChunk)
	for {
		n, err := stdout.Read(buf)
		if n > 0 && mux.stdout(buf[:n]) != nil {
			break
		}
		if err != nil {
			break
		}
	}
	werr := cmd.Wait()
	mux.flush()
	if r.ctx.Err() != nil {
		return 0
	}
	return exitCode(cmd, werr)
}
