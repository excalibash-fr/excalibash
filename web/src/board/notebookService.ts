// The execution side of a notebook (and of a code window run in a kernel), owned by the board session instead of
// the window.
//
// A cell's outputs are written by the client that started the run (see notebookRunner.ts). When the
// runner lived in the React window, hiding the window in the middle of a run dropped the rest of the
// outputs. Here one service per (board, notebook document) holds the shared document handle, the
// NotebookRunner and its kernel subscription for as long as it is useful:
//   - windows `acquire` it (reference counted, like sharedDoc) and `release` it when they unmount;
//   - with no window left it stays alive while a run of this client is in flight, and for `idleMs`
//     more after the last run ended (a window that is shown again right away finds it warm);
//   - it is disposed when the document is deleted, when the board session closes, or when it has
//     been idle with no window for `idleMs`.
// The rules of the runner are unchanged: only the executor writes the outputs of its runs, and any
// editor takes over a run whose executor vanished (sweep). Pure TypeScript, no DOM, no React.
import type { BoardSession } from "./collab.ts";
import { kernelTermOf as codeKernelTermOf } from "./codeDoc.ts";
import { CodeRunner } from "./codeRunner.ts";
import type { ExecRunner } from "./execRunner.ts";
import type { TermPort } from "./kernelSession.ts";
import { kernelTermOf, metaOf } from "./notebookDoc.ts";
import { NotebookRunner } from "./notebookRunner.ts";
import { openSharedDoc, type DocHost, type SharedDoc } from "./sharedDoc.ts";

/** What the service needs from the board connection besides the document transport. */
export type ServiceEnv = {
  port: TermPort;
  /** Calls `fn` whenever a terminal may have appeared, changed state or vanished. */
  watchTerminals(fn: () => void): () => void;
  /** True when the kernel session `term` is known to be over (exited, or removed from an online board). */
  terminalOver(term: string): boolean;
  /** True when `term` is known and is not a Jupyter kernel session (a shell, ssh…). */
  notKernel?(term: string): boolean;
  /** Calls `fn` once when the board session is closed. */
  onClose(fn: () => void): () => void;
};

/** The environment of a real board session. */
export function sessionEnv(s: BoardSession): ServiceEnv {
  return {
    port: { subscribe: (t, l) => s.subscribeTerminal(t, l), input: (t, d) => s.terminalInput(t, d) },
    watchTerminals(fn) {
      const a = s.on("terminals", fn);
      const b = s.on("state", fn);
      return () => (a(), b());
    },
    terminalOver(term) {
      const t = s.terminals.get(term);
      return t ? !(t.status === "running" || t.status === "starting") : s.state === "online";
    },
    notKernel(term) {
      const t = s.terminals.get(term);
      return !!t && !t.label.startsWith("Noyau Jupyter ");
    },
    onClose: (fn) => s.onDispose(fn),
  };
}

/** How long an unused service stays alive once nothing runs (ms). */
export const IDLE_MS = 60_000;

export type ServiceHandle<R extends ExecRunner = NotebookRunner> = {
  readonly doc: SharedDoc;
  readonly runner: R;
  /** True once the service was torn down (document deleted, board closed or idle). */
  readonly disposed: boolean;
  release(): void;
};

export type NotebookHandle = ServiceHandle<NotebookRunner>;
export type CodeHandle = ServiceHandle<CodeRunner>;

/** What differs between a notebook and a code window: the runner and where the kernel session id is kept. */
type Kind<R extends ExecRunner> = {
  make(doc: SharedDoc, port: TermPort, canEdit: boolean): R;
  termOf(ydoc: SharedDoc["ydoc"]): string | null;
};
const notebookKind: Kind<NotebookRunner> = {
  make: (doc, port, canEdit) => new NotebookRunner(doc.ydoc, port, { awareness: doc.awareness, canEdit }),
  termOf: kernelTermOf,
};
const codeKind: Kind<CodeRunner> = {
  make: (doc, port, canEdit) => new CodeRunner(doc.ydoc, port, { awareness: doc.awareness, canEdit }),
  termOf: codeKernelTermOf,
};

class Service<R extends ExecRunner = ExecRunner> {
  readonly doc: SharedDoc;
  readonly runner: R;
  refs = 0;
  disposed = false;
  private offs: (() => void)[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  // Plain fields, not parameter properties: the tests run this file with Node's type stripping, which refuses them.
  private owner: Map<string, Service<any>>;
  private docId: string;
  private idleMs: number;

  constructor(owner: Map<string, Service<any>>, docId: string, kind: Kind<R>, host: DocHost, env: ServiceEnv, idleMs: number) {
    this.owner = owner;
    this.docId = docId;
    this.idleMs = idleMs;
    this.doc = openSharedDoc(host, docId);
    this.runner = kind.make(this.doc, env.port, host.canEdit && !this.doc.readOnly);
    const meta = metaOf(this.doc.ydoc);
    const follow = () => {
      if (this.disposed) return;
      // Any editor can write the kernel id in the document: never follow one that is a shell (cells
      // would be typed into it as JSON lines, and the shell would expand $(…) in them).
      const named = kind.termOf(this.doc.ydoc);
      const term = named && env.notKernel?.(named) ? null : named;
      this.runner.attach(term);
      if (term && env.terminalOver(term)) this.runner.terminalGone();
    };
    meta.observe(follow);
    this.offs.push(() => meta.unobserve(follow), env.watchTerminals(follow), env.onClose(() => this.dispose()));
    this.offs.push(this.doc.onGone(() => this.dispose()));
    void this.doc.synced.then(follow);
    // Whoever lets go of the last window while a run is in flight keeps the service alive until it ends.
    this.offs.push(this.runner.on(() => this.arm(true)));
  }

  acquire() {
    this.refs++;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  release() {
    if (--this.refs > 0) return;
    this.refs = 0;
    this.arm(true);
  }

  /** Starts (or restarts) the idle countdown when no window shows the notebook. */
  private arm(restart = false) {
    if (this.disposed || this.refs > 0) return;
    if (this.idleTimer && !restart) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.refs > 0) return;
      // A run in flight keeps it alive: look again after another period.
      if (this.runner.localRuns.length) return this.arm(true);
      this.dispose();
    }, this.idleMs);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.idleTimer);
    if (this.owner.get(this.docId) === this) this.owner.delete(this.docId);
    for (const off of this.offs.splice(0)) off();
    this.runner.destroy();
    this.doc.destroy();
  }
}

const registry = new WeakMap<object, Map<string, Service<any>>>();

/** True when a service of this notebook is alive on the board (tests, diagnostics). */
export const hasNotebookService = (host: object, docId: string): boolean => registry.get(host)?.has(docId) ?? false;

/** The runner of a live service among `docIds` that follows a kernel session, if any (does not keep it alive). */
export function peekNotebookRunner(host: object, docIds: readonly string[]): NotebookRunner | undefined {
  const map = registry.get(host);
  for (const id of docIds) {
    const s = map?.get(id);
    if (s && !s.disposed && s.runner instanceof NotebookRunner && s.runner.term && s.runner.status !== "dead") return s.runner;
  }
  return undefined;
}

function acquire<R extends ExecRunner>(kind: Kind<R>, host: DocHost, env: ServiceEnv, docId: string, o: { idleMs?: number }): ServiceHandle<R> {
  let map = registry.get(host);
  if (!map) registry.set(host, (map = new Map()));
  let s = map.get(docId) as Service<R> | undefined;
  if (!s || s.disposed) map.set(docId, (s = new Service<R>(map, docId, kind, host, env, o.idleMs ?? IDLE_MS)));
  s.acquire();
  const svc = s;
  let released = false;
  return {
    doc: svc.doc,
    runner: svc.runner,
    get disposed() {
      return svc.disposed;
    },
    release() {
      if (released) return;
      released = true;
      svc.release();
    },
  };
}

/**
 * Joins (or creates) the service of a notebook of the board. The runner and the document handle
 * outlive the window: call `release()` when the window goes away.
 */
export const acquireNotebook = (host: DocHost, env: ServiceEnv, docId: string, o: { idleMs?: number } = {}): NotebookHandle => acquire(notebookKind, host, env, docId, o);

/** The same for a code window: its runner runs the file on the kernel session kept in the code document. */
export const acquireCode = (host: DocHost, env: ServiceEnv, docId: string, o: { idleMs?: number } = {}): CodeHandle => acquire(codeKind, host, env, docId, o);
