# Excalibash kernel bridge. Started by the agent as `python3 -u -I -c <this script>`.
# stdin/stdout speak JSON lines (one object per line, UTF-8, ASCII-escaped on output);
# stderr is captured by the agent and forwarded as {"ev":"log"} lines.
# The bridge runs one Jupyter kernel for the whole session and executes requests in order.
import atexit
import json
import os
import queue
import signal
import sys
import tempfile
import threading
import time

MAX_LINE = 2 << 20          # longest accepted input line
MAX_CODE = 1 << 20          # longest code / completion payload
MAX_MSG = 8 << 20           # longest single output message
MAX_EXEC_OUT = 32 << 20     # total output per execution
MAX_ID = 64

# Real stdout is kept for the protocol; fd 1 now points to stderr so that nothing a kernel
# (or a C library inside it) prints at the file-descriptor level can corrupt the stream.
_out = os.fdopen(os.dup(1), "wb", buffering=0)
os.dup2(2, 1)
_out_lock = threading.Lock()


# The running bridge, so that every exit path (including os._exit below) can kill its kernel.
_bridge = None


def hard_exit(code):
    """Leave now, never leaving the kernel behind."""
    if _bridge is not None:
        _bridge.kill_kernel()
    os._exit(code)


def emit_raw(line):
    with _out_lock:
        try:
            _out.write(line.encode("ascii") + b"\n")
        except (BrokenPipeError, OSError):
            hard_exit(0)


def emit(ev):
    emit_raw(json.dumps(ev, ensure_ascii=True, separators=(",", ":"), default=str))


def log(text):
    emit({"ev": "log", "text": str(text)})


def fatal(msg):
    emit({"ev": "fatal", "error": msg})
    hard_exit(1)


def _death_signal_hook():
    """A preexec_fn making the kernel receive SIGKILL when this bridge dies (Linux only).

    jupyter_client starts the kernel in a new session, so neither the agent's process-group kill
    nor the terminal reaches it: without this, a SIGKILLed bridge would leave its kernel running.
    Everything is resolved here, before any fork, so that the child only makes two system calls.
    Elsewhere ipykernel's own parent polling (JPY_PARENT_PID) is the fallback.
    """
    if not sys.platform.startswith("linux"):
        return None
    try:
        import ctypes

        prctl = ctypes.CDLL(None, use_errno=True).prctl
        prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    except (OSError, AttributeError):
        return None
    me = os.getpid()
    PR_SET_PDEATHSIG = 1

    def hook():
        prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)
        if os.getppid() != me:  # the bridge died before prctl took effect
            os._exit(1)

    return hook


# The user site is disabled by -I; keep the packages installed with `pip install --user` usable
# without ever putting the working directory on the path.
try:
    import site

    _usp = site.getusersitepackages()
    if isinstance(_usp, str) and os.path.isdir(_usp) and _usp not in sys.path:
        sys.path.append(_usp)
except Exception:
    pass

try:
    from jupyter_client import KernelManager
    from jupyter_client.kernelspec import NoSuchKernel
    import ipykernel  # noqa: F401
except ImportError:
    fatal("jupyter_client ou ipykernel absent : pip install ipykernel jupyter_client")


class Bridge:
    def __init__(self, kernel, cwd):
        self.kernel = kernel
        self.cwd = cwd
        self.km = None
        self.kc = None
        self.q = queue.Queue()
        self.qlock = threading.Lock()
        self.abort = threading.Event()
        self.busy = False
        self.closing = False
        self.rundir = tempfile.mkdtemp(prefix="excalibash-kernel-")
        os.chmod(self.rundir, 0o700)

    # ---- kernel lifecycle -------------------------------------------------------------
    def start(self):
        emit({"ev": "status", "state": "starting"})
        # ipykernel exits by itself when its parent (this process) disappears.
        os.environ["JPY_PARENT_PID"] = str(os.getpid())
        cf = os.path.join(self.rundir, "kernel.json")
        try:
            self.km = KernelManager(kernel_name=self.kernel, connection_file=cf)
            kw = {"cwd": self.cwd}
            hook = _death_signal_hook()
            if hook is not None:
                kw["preexec_fn"] = hook  # forwarded to Popen by jupyter_client's launcher
            self.km.start_kernel(**kw)
        except NoSuchKernel:
            fatal("noyau Jupyter introuvable : « %s » (jupyter kernelspec list)" % self.kernel)
        except Exception as e:  # noqa: BLE001
            fatal("démarrage du noyau impossible : %s" % e)
        self.kc = self.km.client()
        self.kc.start_channels()
        try:
            self.kc.wait_for_ready(timeout=60)
        except Exception as e:  # noqa: BLE001
            self.shutdown()
            fatal("le noyau ne répond pas : %s" % e)
        language, version = "", ""
        try:
            mid = self.kc.kernel_info()
            deadline = time.time() + 10
            while time.time() < deadline:
                try:
                    m = self.kc.get_shell_msg(timeout=1)
                except queue.Empty:
                    continue
                if m["parent_header"].get("msg_id") == mid:
                    li = m["content"].get("language_info", {})
                    language, version = li.get("name", ""), li.get("version", "")
                    break
        except Exception:  # noqa: BLE001
            pass
        emit({"ev": "ready", "kernel": self.kernel, "language": language, "version": version})
        emit({"ev": "status", "state": "idle"})

    def kernel_pid(self):
        try:
            pid = self.km.provisioner.pid if self.km is not None and self.km.provisioner else None
        except Exception:  # noqa: BLE001
            return None
        return pid if isinstance(pid, int) and pid > 1 else None

    def kill_kernel(self):
        """SIGKILL the kernel's whole process group (it leads its own session): fast and safe to
        call from any thread, a signal handler or several times."""
        pid = self.kernel_pid()
        if pid is None:
            return
        for kill in (os.killpg, os.kill):
            try:
                kill(pid, signal.SIGKILL)
                return
            except (ProcessLookupError, PermissionError):
                continue
            except OSError:
                continue

    def shutdown(self):
        if self.closing:
            return
        self.closing = True
        try:
            if self.kc is not None:
                self.kc.stop_channels()
        except Exception:  # noqa: BLE001
            pass
        # Kill the kernel's process group first (it takes the kernel's own children with it), then
        # let jupyter_client reap it and remove its files.
        self.kill_kernel()
        try:
            if self.km is not None:
                self.km.shutdown_kernel(now=True)
        except Exception:  # noqa: BLE001
            pass
        try:
            for name in os.listdir(self.rundir):
                os.unlink(os.path.join(self.rundir, name))
            os.rmdir(self.rundir)
        except OSError:
            pass

    def drain_channels(self):
        for get in (self.kc.get_iopub_msg, self.kc.get_shell_msg):
            while True:
                try:
                    get(timeout=0)
                except queue.Empty:
                    break
                except Exception:  # noqa: BLE001
                    break

    def do_restart(self):
        emit({"ev": "status", "state": "restarting"})
        try:
            self.km.restart_kernel(now=True)
            self.drain_channels()
            self.kc.wait_for_ready(timeout=60)
            self.drain_channels()
        except Exception as e:  # noqa: BLE001
            log("redémarrage du noyau impossible : %s" % e)
            emit({"ev": "status", "state": "dead"})
            return
        finally:
            self.abort.clear()
        emit({"ev": "status", "state": "idle"})

    # ---- input side -------------------------------------------------------------------
    def handle(self, req):
        op = req.get("op")
        if op == "ping":
            emit({"ev": "pong"})
        elif op == "interrupt":
            if self.busy:
                try:
                    self.km.interrupt_kernel()
                except Exception as e:  # noqa: BLE001
                    log("interruption impossible : %s" % e)
        elif op == "restart":
            with self.qlock:
                while True:
                    try:
                        item = self.q.get_nowait()
                    except queue.Empty:
                        break
                    if item[0] == "exec":
                        emit({"ev": "done", "id": item[1], "count": None, "status": "aborted"})
                self.abort.set()
                self.q.put(("restart",))
        elif op in ("exec", "complete", "inspect"):
            rid, code = req.get("id"), req.get("code")
            if not isinstance(rid, str) or not rid or len(rid) > MAX_ID:
                return log("requête ignorée : identifiant incorrect")
            if not isinstance(code, str) or len(code) > MAX_CODE:
                emit({"ev": "error", "id": rid, "ename": "InvalidRequest",
                      "evalue": "code absent ou trop long (1 Mio au maximum)", "traceback": []})
                if op == "exec":
                    emit({"ev": "done", "id": rid, "count": None, "status": "error"})
                return
            if op == "exec":
                self.q.put(("exec", rid, code))
            else:
                pos = req.get("pos")
                if not isinstance(pos, int) or isinstance(pos, bool) or pos < 0:
                    pos = len(code)
                self.q.put((op, rid, code, min(pos, len(code))))
        else:
            log("opération inconnue : %r" % (op,))

    # ---- worker -----------------------------------------------------------------------
    def worker(self):
        while True:
            item = self.q.get()
            try:
                kind = item[0]
                if kind == "exec":
                    self.run_exec(item[1], item[2])
                elif kind == "restart":
                    self.do_restart()
                elif kind == "complete":
                    self.run_complete(*item[1:])
                elif kind == "inspect":
                    self.run_inspect(*item[1:])
            except Exception as e:  # noqa: BLE001
                log("erreur interne : %r" % (e,))
                self.busy = False

    def wait_reply(self, mid, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline and not self.abort.is_set():
            try:
                m = self.kc.get_shell_msg(timeout=0.25)
            except queue.Empty:
                continue
            if m["parent_header"].get("msg_id") == mid:
                return m
        return None

    def run_complete(self, rid, code, pos):
        mid = self.kc.complete(code, pos)
        m = self.wait_reply(mid, 10)
        c = m["content"] if m else {}
        emit({"ev": "complete", "id": rid, "matches": c.get("matches", []),
              "start": c.get("cursor_start", pos), "end": c.get("cursor_end", pos)})

    def run_inspect(self, rid, code, pos):
        mid = self.kc.inspect(code, pos, detail_level=0)
        m = self.wait_reply(mid, 10)
        c = m["content"] if m else {}
        emit({"ev": "inspect", "id": rid, "found": bool(c.get("found")), "data": strdata(c.get("data"))})

    def run_exec(self, rid, code):
        total = [0]
        capped = [False]

        def out(ev):
            line = json.dumps(ev, ensure_ascii=True, separators=(",", ":"), default=str)
            if len(line) > MAX_MSG:
                line = json.dumps({"ev": "stream", "id": rid, "name": "stderr",
                                   "text": "[sortie trop volumineuse, tronquée]"})
            if total[0] + len(line) > MAX_EXEC_OUT:
                if not capped[0]:
                    capped[0] = True
                    emit({"ev": "stream", "id": rid, "name": "stderr",
                          "text": "[sortie totale trop volumineuse, suite ignorée]"})
                return
            total[0] += len(line)
            emit_raw(line)

        self.busy = True
        emit({"ev": "status", "state": "busy"})
        status, count = "error", None
        try:
            mid = self.kc.execute(code, store_history=True, allow_stdin=False, stop_on_error=False)
            idle, reply, last_check, reply_at = False, None, time.time(), None
            while not (idle and reply is not None):
                if self.abort.is_set():
                    status = "aborted"
                    break
                if time.time() - last_check > 1:
                    last_check = time.time()
                    if not self.km.is_alive():
                        out({"ev": "error", "id": rid, "ename": "KernelDied",
                             "evalue": "le noyau s'est arrêté", "traceback": []})
                        emit({"ev": "status", "state": "dead"})
                        status = "error"
                        self.busy = False
                        emit({"ev": "done", "id": rid, "count": None, "status": status})
                        self.do_restart()
                        return
                try:
                    m = self.kc.get_iopub_msg(timeout=0.2)
                    if m["parent_header"].get("msg_id") == mid:
                        if self.on_iopub(rid, m, out):
                            idle = True
                except queue.Empty:
                    pass
                if reply is None:
                    try:
                        r = self.kc.get_shell_msg(timeout=0)
                        if r["parent_header"].get("msg_id") == mid:
                            reply = r
                            reply_at = time.time()
                    except queue.Empty:
                        pass
                if reply is not None and not idle and time.time() - reply_at > 5:
                    break  # the idle status was lost: the reply is enough
            if reply is not None:
                c = reply["content"]
                status = c.get("status", "error")
                count = c.get("execution_count")
        finally:
            self.busy = False
        emit({"ev": "done", "id": rid, "count": count, "status": status})
        if not self.abort.is_set():
            emit({"ev": "status", "state": "idle"})

    def on_iopub(self, rid, m, out):
        t, c = m["msg_type"], m["content"]
        if t == "status":
            return c.get("execution_state") == "idle"
        if t == "stream":
            out({"ev": "stream", "id": rid, "name": c.get("name", "stdout"), "text": c.get("text", "")})
        elif t == "display_data":
            ev = {"ev": "display", "id": rid, "data": strdata(c.get("data")), "metadata": c.get("metadata", {})}
            did = (c.get("transient") or {}).get("display_id")
            if did:
                ev["display_id"] = did
            out(ev)
        elif t == "update_display_data":
            did = (c.get("transient") or {}).get("display_id")
            if did:
                out({"ev": "update", "id": rid, "display_id": did, "data": strdata(c.get("data")),
                     "metadata": c.get("metadata", {})})
        elif t == "execute_result":
            out({"ev": "result", "id": rid, "count": c.get("execution_count"), "data": strdata(c.get("data"))})
        elif t == "error":
            out({"ev": "error", "id": rid, "ename": c.get("ename", ""), "evalue": c.get("evalue", ""),
                 "traceback": c.get("traceback", [])})
        elif t == "clear_output":
            out({"ev": "clear", "id": rid, "wait": bool(c.get("wait"))})
        return False


def strdata(d):
    """A MIME bundle with string values only (JSON payloads are serialized)."""
    res = {}
    for k, v in (d or {}).items():
        res[k] = v if isinstance(v, str) else json.dumps(v, default=str)
    return res


def expand_cwd(cwd):
    if not cwd:
        return os.path.expanduser("~")
    cwd = os.path.expanduser(cwd)
    if not os.path.isdir(cwd):
        fatal("répertoire de travail introuvable : %s" % cwd)
    return cwd


def main():
    # argv: kernel name, working directory ("" = home); both validated by the agent.
    global _bridge
    kernel = (sys.argv[1] if len(sys.argv) > 1 else "") or "python3"
    b = Bridge(kernel, expand_cwd(sys.argv[2] if len(sys.argv) > 2 else ""))
    _bridge = b

    def stop(*_):
        b.kill_kernel()
        b.shutdown()
        os._exit(0)

    # Every way out kills the kernel: end of stdin and these signals call stop(), an uncaught
    # exception runs atexit, os._exit goes through hard_exit(), and SIGKILL of the bridge is
    # covered by the kernel's parent-death signal (Linux) or ipykernel's parent polling.
    atexit.register(b.kill_kernel)
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGQUIT):
        signal.signal(sig, stop)
    b.start()
    threading.Thread(target=b.worker, daemon=True).start()

    stdin = sys.stdin.buffer
    while True:
        line = stdin.readline(MAX_LINE + 1)
        if not line:
            break
        if len(line) > MAX_LINE and not line.endswith(b"\n"):
            while True:  # skip the rest of the oversized line
                rest = stdin.readline(MAX_LINE)
                if not rest or rest.endswith(b"\n"):
                    break
            log("ligne ignorée : plus de 2 Mio")
            continue
        try:
            req = json.loads(line.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            log("ligne ignorée : JSON invalide")
            continue
        if not isinstance(req, dict):
            log("ligne ignorée : objet JSON attendu")
            continue
        try:
            b.handle(req)
        except Exception as e:  # noqa: BLE001
            log("requête ignorée : %r" % (e,))
    stop()


try:
    main()
finally:
    if _bridge is not None:
        _bridge.kill_kernel()
