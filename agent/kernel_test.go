package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestParseTargetJupyter(t *testing.T) {
	ok := map[string]target{
		`{"kind":"jupyter"}`: {Kind: "jupyter", Kernel: "python3"},
		`{"kind":"jupyter","cwd":"/srv/nb","kernel":"ir"}`:    {Kind: "jupyter", Kernel: "ir", Cwd: "/srv/nb"},
		`{"kind":"jupyter","cwd":"~/work","kernel":"py3.11"}`: {Kind: "jupyter", Kernel: "py3.11", Cwd: "~/work"},
		`{"kind":"jupyter","cwd":"~"}`:                        {Kind: "jupyter", Kernel: "python3", Cwd: "~"},
		`{"kind":"jupyter","kernel":"a_b-C.1"}`:               {Kind: "jupyter", Kernel: "a_b-C.1"},
	}
	for in, want := range ok {
		got, err := parseTarget(json.RawMessage(in))
		if err != nil || !reflect.DeepEqual(*got, want) {
			t.Errorf("parseTarget(%s) = %+v, %v; want %+v", in, got, err, want)
		}
	}
	bad := []string{
		`{"kind":"jupyter","cwd":"relative/dir"}`,
		`{"kind":"jupyter","cwd":"~root/x"}`,
		`{"kind":"jupyter","cwd":"/a\nb"}`,
		`{"kind":"jupyter","cwd":"/a\u0000b"}`,
		`{"kind":"jupyter","cwd":"/` + strings.Repeat("a", 512) + `"}`,
		`{"kind":"jupyter","kernel":"python3; rm -rf /"}`,
		`{"kind":"jupyter","kernel":"$(id)"}`,
		`{"kind":"jupyter","kernel":"a b"}`,
		`{"kind":"jupyter","kernel":"../x"}`,
		`{"kind":"jupyter","kernel":"` + strings.Repeat("k", 65) + `"}`,
		`{"kind":"jupyter","host":"h"}`,
		`{"kind":"jupyter","port":22}`,
		`{"kind":"jupyter","via":[{"host":"r1"}]}`,
		`{"kind":"ssh","host":"h","via":[{"kind":"jupyter"}]}`,
	}
	for _, in := range bad {
		if got, err := parseTarget(json.RawMessage(in)); err == nil {
			t.Errorf("parseTarget(%s) accepted: %+v", in, got)
		}
	}
	// A cwd of exactly 512 bytes is fine.
	if _, err := parseTarget(json.RawMessage(`{"kind":"jupyter","cwd":"/` + strings.Repeat("a", 511) + `"}`)); err != nil {
		t.Errorf("512-byte cwd refused: %v", err)
	}
}

func TestKernelBridgeCompiles(t *testing.T) {
	py, err := findPython()
	if err != nil {
		t.Skip("no python")
	}
	dir := t.TempDir()
	f := filepath.Join(dir, "kernel_bridge.py")
	if err := os.WriteFile(f, []byte(kernelBridge), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(py, "-I", "-c", "import py_compile,sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)", f, filepath.Join(dir, "out.pyc"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("bridge does not compile: %v\n%s", err, out)
	}
}

func TestJupyterTargetRejectedWithoutMachineAuth(t *testing.T) {
	// A raw key (no target) never starts a kernel, and a sealed target needs machineAuth like
	// every remote kind: a key sealed under another secret is refused.
	h := newHarness(t)
	m := newManagerWithAuth(machineAuthKey(h.priv))
	other := make([]byte, 32)
	pt, _ := json.Marshal(map[string]any{"k": b64.EncodeToString(make([]byte, 32)), "target": map[string]any{"kind": "jupyter"}})
	sealed, err := box(other, pt, "eb:term:x")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.openKey("x", b64.EncodeToString(sealed)); err == nil {
		t.Fatal("jupyter target sealed without machineAuth accepted")
	}
}

// ---- integration with a real kernel ------------------------------------------------------

func haveJupyter() bool {
	py, err := findPython()
	if err != nil {
		return false
	}
	return exec.Command(py, "-I", "-c", "import jupyter_client, ipykernel").Run() == nil
}

type kev = map[string]any

func (tm *term) events() []kev {
	var evs []kev
	for _, l := range strings.Split(tm.output(), "\n") {
		if l == "" {
			continue
		}
		var e kev
		if json.Unmarshal([]byte(l), &e) == nil {
			evs = append(evs, e)
		}
	}
	return evs
}

// await waits for an event after position from (index into events()) matching pred.
func (tm *term) await(t *testing.T, from int, d time.Duration, desc string, pred func(kev) bool) (kev, int) {
	t.Helper()
	deadline := time.Now().Add(d)
	for {
		evs := tm.events()
		for i := from; i < len(evs); i++ {
			if pred(evs[i]) {
				return evs[i], i + 1
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for %s; output %q", desc, tm.output())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (tm *term) op(o kev) {
	b, _ := json.Marshal(o)
	tm.send(string(b) + "\n")
}

func is(ev string, kv ...any) func(kev) bool {
	return func(e kev) bool {
		if e["ev"] != ev {
			return false
		}
		for i := 0; i+1 < len(kv); i += 2 {
			if e[kv[i].(string)] != kv[i+1] {
				return false
			}
		}
		return true
	}
}

// procsMentioning lists live (non-zombie) processes whose command line or cwd mentions s.
func procsMentioning(s string) []int {
	var pids []int
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		stat, _ := os.ReadFile("/proc/" + e.Name() + "/stat")
		if i := strings.LastIndexByte(string(stat), ')'); i < 0 || len(stat) < i+3 || stat[i+2] == 'Z' {
			continue
		}
		cl, _ := os.ReadFile("/proc/" + e.Name() + "/cmdline")
		cwd, _ := os.Readlink("/proc/" + e.Name() + "/cwd")
		if strings.Contains(string(cl), s) || cwd == s {
			pids = append(pids, pid)
		}
	}
	return pids
}

func TestJupyterKernelSession(t *testing.T) {
	if !haveJupyter() {
		t.Skip("python3 with jupyter_client and ipykernel not available")
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	tm := startTerm(t, target{Kind: "jupyter", Kernel: "python3", Cwd: dir})
	long := 90 * time.Second
	step := 20 * time.Second

	if strings.Contains(tm.output(), "Connexion") {
		t.Fatal("banner written into a protocol stream")
	}
	ready, pos := tm.await(t, 0, long, "ready", is("ready"))
	if ready["kernel"] != "python3" || ready["language"] != "python" {
		t.Fatalf("bad ready: %v", ready)
	}

	// Output, then done ok.
	tm.op(kev{"op": "exec", "id": "a", "code": "print(1+1)"})
	s, pos := tm.await(t, pos, step, "stream", is("stream", "id", "a"))
	if s["text"] != "2\n" || s["name"] != "stdout" {
		t.Fatalf("bad stream: %v", s)
	}
	d, pos := tm.await(t, pos, step, "done a", is("done", "id", "a"))
	if d["status"] != "ok" {
		t.Fatalf("done: %v", d)
	}

	// Errors.
	tm.op(kev{"op": "exec", "id": "b", "code": "1/0"})
	e, pos := tm.await(t, pos, step, "error", is("error", "id", "b"))
	if e["ename"] != "ZeroDivisionError" {
		t.Fatalf("error: %v", e)
	}
	d, pos = tm.await(t, pos, step, "done b", is("done", "id", "b"))
	if d["status"] != "error" {
		t.Fatalf("done: %v", d)
	}

	// Shared state, results, working directory and ordered queue (two requests at once).
	tm.op(kev{"op": "exec", "id": "c", "code": "x=41"})
	tm.op(kev{"op": "exec", "id": "d", "code": "x+1"})
	r, pos := tm.await(t, pos, step, "result", is("result", "id", "d"))
	if r["data"].(kev)["text/plain"] != "42" {
		t.Fatalf("result: %v", r)
	}
	tm.await(t, pos, step, "done d", is("done", "id", "d", "status", "ok"))
	var order []string
	for _, ev := range tm.events() {
		if ev["ev"] == "done" {
			order = append(order, ev["id"].(string))
		}
	}
	if strings.Join(order, "") != "abcd" {
		t.Fatalf("done order %v", order)
	}
	tm.op(kev{"op": "exec", "id": "pid", "code": "import os; print(os.getpid(), os.getcwd())"})
	s, pos = tm.await(t, pos, step, "pid", is("stream", "id", "pid"))
	f := strings.Fields(s["text"].(string))
	if len(f) != 2 || f[1] != dir {
		t.Fatalf("kernel cwd %q, want %q", s["text"], dir)
	}
	tm.await(t, pos, step, "done pid", is("done", "id", "pid"))

	// Rich display.
	tm.op(kev{"op": "exec", "id": "h", "code": "from IPython.display import HTML, display; display(HTML('<b>x</b>'))"})
	disp, _ := tm.await(t, 0, step, "display", is("display", "id", "h"))
	if disp["data"].(kev)["text/html"] != "<b>x</b>" {
		t.Fatalf("display: %v", disp)
	}
	pos = len(tm.events())

	// Completion.
	tm.op(kev{"op": "complete", "id": "k", "code": "pri", "pos": 3})
	c, pos := tm.await(t, pos, step, "complete", is("complete", "id", "k"))
	found := false
	for _, m := range c["matches"].([]any) {
		found = found || m == "print"
	}
	if !found {
		t.Fatalf("complete: %v", c)
	}

	// Interrupt.
	tm.op(kev{"op": "exec", "id": "s", "code": "import time; time.sleep(30)"})
	tm.await(t, pos, step, "busy", is("status", "state", "busy"))
	time.Sleep(500 * time.Millisecond)
	start := time.Now()
	tm.op(kev{"op": "interrupt"})
	d, pos = tm.await(t, pos, 10*time.Second, "done s", is("done", "id", "s"))
	if d["status"] != "error" && d["status"] != "aborted" || time.Since(start) > 8*time.Second {
		t.Fatalf("interrupt: %v after %v", d, time.Since(start))
	}

	// Ping, bad input lines.
	tm.send("not json\n")
	tm.op(kev{"op": "ping"})
	tm.await(t, pos, step, "log", is("log"))
	_, pos = tm.await(t, pos, step, "pong", is("pong"))

	// Restart: state is gone, pending requests are dropped.
	tm.op(kev{"op": "restart"})
	_, pos = tm.await(t, pos, long, "restarting", is("status", "state", "restarting"))
	_, pos = tm.await(t, pos, long, "idle", is("status", "state", "idle"))
	tm.op(kev{"op": "exec", "id": "g", "code": "x"})
	tm.await(t, pos, step, "NameError", is("error", "id", "g", "ename", "NameError"))

	// A single output above 8 MiB is replaced by a notice.
	tm.op(kev{"op": "exec", "id": "big", "code": "print('x' * (9 << 20))"})
	big, pos := tm.await(t, pos, step, "truncation notice", is("stream", "id", "big"))
	if big["name"] != "stderr" || !strings.Contains(big["text"].(string), "tronquée") {
		t.Fatalf("big output not truncated: %.80v", big)
	}
	tm.await(t, pos, step, "done big", is("done", "id", "big"))

	// Closing the session leaves no process behind.
	if len(procsMentioning(dir)) == 0 {
		t.Fatal("expected a running bridge and kernel before close")
	}
	tm.r.kill()
	tm.exit(t)
	deadline := time.Now().Add(15 * time.Second)
	for len(procsMentioning(dir)) > 0 {
		if time.Now().After(deadline) {
			t.Fatalf("orphan processes after close: %v", procsMentioning(dir))
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestJupyterUnknownKernel(t *testing.T) {
	if !haveJupyter() {
		t.Skip("python3 with jupyter_client and ipykernel not available")
	}
	tm := startTerm(t, target{Kind: "jupyter", Kernel: "nope-xyz"})
	f, _ := tm.await(t, 0, 60*time.Second, "fatal", is("fatal"))
	if !strings.Contains(f["error"].(string), "nope-xyz") {
		t.Fatalf("fatal: %v", f)
	}
	if code := tm.exit(t); code != 1 {
		t.Fatalf("exit code %d", code)
	}
}

func TestJupyterSessionCap(t *testing.T) {
	// With every slot taken, a new session is refused before anything is started.
	for i := 0; i < maxKernels; i++ {
		kernelSlots <- struct{}{}
	}
	defer func() {
		for i := 0; i < maxKernels; i++ {
			<-kernelSlots
		}
	}()
	tm := startTerm(t, target{Kind: "jupyter", Kernel: "python3"})
	f, _ := tm.await(t, 0, 10*time.Second, "fatal", is("fatal"))
	if !strings.Contains(f["error"].(string), "trop de noyaux") {
		t.Fatalf("fatal: %v", f)
	}
	if code := tm.exit(t); code != 1 {
		t.Fatalf("exit code %d", code)
	}
}

func TestJupyterKernelDiesWithBridge(t *testing.T) {
	// jupyter_client puts the kernel in its own session: SIGKILL the bridge alone (not its group)
	// and check that the kernel follows, through its parent-death signal or ipykernel's polling.
	if !haveJupyter() {
		t.Skip("python3 with jupyter_client and ipykernel not available")
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	tm := startTerm(t, target{Kind: "jupyter", Kernel: "python3", Cwd: dir})
	_, pos := tm.await(t, 0, 90*time.Second, "ready", is("ready"))
	tm.op(kev{"op": "exec", "id": "pid", "code": "import os; print(os.getpid())"})
	s, _ := tm.await(t, pos, 20*time.Second, "pid", is("stream", "id", "pid"))
	kernel, err := strconv.Atoi(strings.TrimSpace(s["text"].(string)))
	if err != nil {
		t.Fatalf("kernel pid %q", s["text"])
	}
	bridge := 0
	for _, pid := range procsMentioning(dir) {
		if cl, _ := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline"); strings.Contains(string(cl), "Excalibash kernel bridge") {
			bridge = pid
		}
	}
	if bridge == 0 {
		t.Fatal("bridge process not found")
	}
	if err := syscall.Kill(bridge, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	tm.exit(t)
	deadline := time.Now().Add(10 * time.Second)
	for {
		alive := false
		for _, pid := range procsMentioning(dir) {
			alive = alive || pid == kernel
		}
		if !alive {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("kernel %d outlived its SIGKILLed bridge", kernel)
		}
		time.Sleep(100 * time.Millisecond)
	}
}
