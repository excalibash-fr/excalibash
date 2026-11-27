// The client side of ONE kernel session (a "jupyter" terminal): the shared stream of events, the status,
// the requests (interrupt, restart, complete, inspect). What an exec's events mean (cell outputs of a
// notebook, the output list of a code window) is the business of the subclass.
//
// Every client of the session parses the same stream (LineSplitter / parseEvent); requests carry an id,
// answers come back in the stream with the same id. Pure TypeScript: no DOM, no React.
import { LineSplitter, encodeOp, parseEvent, type KernelEvent, type KernelState } from "./kernelProtocol.ts";
import { docMarkdown, mapComplete, utf16ToCodePoints, type CompleteReply } from "./pyComplete.ts";

/** What a session needs from the board: the sealed terminal stream of the kernel. */
export type TermPort = {
  subscribe(term: string, l: { onReplay(data: Uint8Array): void; onData(data: Uint8Array): void }): () => void;
  input(term: string, data: Uint8Array): void;
};

export type KernelStatus = KernelState | "absent";

/** Longest wait for a completion or a docstring (ms). */
export const QUERY_TIMEOUT_MS = 3000;
const INPUT_CHUNK = 48 * 1024;
const enc = new TextEncoder();

type Pending = { resolve: (ev: KernelEvent | null) => void; timer: ReturnType<typeof setTimeout>; code: string; pos: number };

export abstract class KernelSession {
  status: KernelStatus = "absent";
  /** The bridge's last fatal message (kernel missing, ipykernel not installed…). */
  fatal: string | null = null;
  term: string | null = null;
  protected port: TermPort;
  protected canEdit: boolean;
  protected destroyed = false;
  /** When `status` last changed. */
  protected statusSince = Date.now();
  private splitter = new LineSplitter();
  private off: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private queries = new Map<string, Pending>();

  constructor(port: TermPort, canEdit: boolean) {
    this.port = port;
    this.canEdit = canEdit;
  }

  /** Called when the status or the pending runs change. */
  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  protected emit() {
    for (const fn of this.listeners) fn();
  }

  /**
   * An event of the stream that this base class does not consume (exec results, display, done…). `line` is its
   * raw line; `replayed` is true while the scrollback is replayed (it may repeat events already seen).
   */
  protected abstract onEvent(ev: KernelEvent, line: string, replayed: boolean): void;
  /** The scrollback is about to be replayed (first subscription or reconnection): its raw lines. */
  protected beforeReplay(_lines: ReadonlySet<string>): void {}
  /** This client stops following the session `term` (another one, or none). */
  protected leaveSession(_term: string): void {}

  protected setStatus(s: KernelStatus) {
    if (s !== this.status) this.statusSince = Date.now();
    this.status = s;
  }

  /** True while a subscription to the kernel session is live. */
  protected get subscribed(): boolean {
    return !!this.off;
  }

  /**
   * Follows the kernel session `term` (or none). The stream is replayed first: every client sees the same
   * events. Leaving a session ends this client's runs on it (leaveSession).
   */
  attach(term: string | null) {
    if (this.destroyed || term === this.term) return;
    if (this.term) this.leaveSession(this.term);
    this.off?.();
    this.off = null;
    this.term = term;
    this.splitter = new LineSplitter();
    this.dropQueries();
    if (term) this.fatal = null;
    // "starting" until the kernel says otherwise (replayed status, or the answer to the ping below).
    this.setStatus(term ? "starting" : "absent");
    if (term) {
      this.off = this.port.subscribe(term, {
        onReplay: (d) => this.replay(d),
        onData: (d) => this.consume(d),
      });
      // The bridge answers a ping once its kernel is up: a scrollback without any status is no longer "starting".
      if (this.canEdit) this.send(encodeOp({ op: "ping" }));
    }
    this.emit();
  }

  private replay(data: Uint8Array) {
    this.splitter = new LineSplitter();
    const lines = this.splitter.push(data);
    this.beforeReplay(new Set(lines));
    for (const line of lines) {
      const ev = parseEvent(line);
      if (ev) this.handle(ev, line, true);
    }
  }

  private consume(data: Uint8Array) {
    for (const line of this.splitter.push(data)) {
      const ev = parseEvent(line);
      if (ev) this.handle(ev, line, false);
    }
  }

  private handle(ev: KernelEvent, line: string, replayed: boolean) {
    switch (ev.ev) {
      case "status":
        this.setStatus(ev.state);
        this.emit();
        return;
      case "fatal":
        this.setStatus("dead");
        this.fatal = typeof ev.error === "string" ? ev.error.slice(0, 500) : "Noyau arrêté";
        this.emit();
        return;
      case "pong":
        if (this.status === "starting") {
          this.setStatus("idle");
          this.emit();
        }
        return;
      case "ready":
      case "log":
        return;
      case "complete":
      case "inspect": {
        const q = typeof ev.id === "string" ? this.queries.get(ev.id) : undefined;
        if (q) {
          clearTimeout(q.timer);
          this.queries.delete(ev.id);
          q.resolve(ev);
        }
        return;
      }
    }
    this.onEvent(ev, line, replayed);
  }

  /** Sends one request line to the kernel session, in pieces (a terminal frame is limited). */
  protected send(line: string) {
    if (!this.term) return;
    const bytes = enc.encode(line);
    for (let i = 0; i < bytes.length; i += INPUT_CHUNK) this.port.input(this.term, bytes.subarray(i, i + INPUT_CHUNK));
  }

  interrupt(): boolean {
    if (!this.canEdit || !this.term) return false;
    this.send(encodeOp({ op: "interrupt" }));
    return true;
  }

  restart(): boolean {
    if (!this.canEdit || !this.term) return false;
    this.send(encodeOp({ op: "restart" }));
    return true;
  }

  // ---- completion and docstrings ---------------------------------------------------------------------------------

  /** True when a request would be answered soon: somebody who may type, a live session, a kernel that is not busy. */
  get canQuery(): boolean {
    return this.canEdit && !!this.term && !this.destroyed && this.status === "idle";
  }

  private ask(kind: "complete" | "inspect", code: string, pos: number, o: { timeoutMs?: number; signal?: { aborted: boolean; addEventListener(t: "abort", f: () => void, o?: { once: boolean }): void } }): Promise<KernelEvent | null> {
    // Only the people who may type into the session can send a request (the server refuses a viewer's input); and a
    // busy kernel would queue it behind the running cell (the bridge answers in order): skip rather than pile up.
    if (!this.canQuery || o.signal?.aborted) return Promise.resolve(null);
    const id = `q${kind[0]}:${Math.random().toString(36).slice(2, 12).padEnd(10, "0")}`;
    let line: string;
    try {
      line = encodeOp({ op: kind, id, code, pos: utf16ToCodePoints(code, pos) });
    } catch {
      return Promise.resolve(null);
    }
    return new Promise<KernelEvent | null>((resolve) => {
      const done = (ev: KernelEvent | null) => {
        const q = this.queries.get(id);
        if (!q) return;
        clearTimeout(q.timer);
        this.queries.delete(id);
        resolve(ev);
      };
      const timer = setTimeout(() => done(null), o.timeoutMs ?? QUERY_TIMEOUT_MS);
      this.queries.set(id, { resolve, timer, code, pos });
      o.signal?.addEventListener("abort", () => done(null), { once: true });
      this.send(line);
    });
  }

  /** Completions at the UTF-16 offset `pos` of `code`, or null (no kernel, busy, viewer, timeout, nothing found). */
  async complete(code: string, pos: number, o: { timeoutMs?: number; signal?: { aborted: boolean; addEventListener(t: "abort", f: () => void, o?: { once: boolean }): void } } = {}): Promise<CompleteReply | null> {
    const ev = await this.ask("complete", code, pos, o);
    if (!ev || ev.ev !== "complete") return null;
    return mapComplete(code, pos, { matches: ev.matches, start: ev.start, end: ev.end });
  }

  /** The docstring at the UTF-16 offset `pos`, as the Markdown of a hover, or null. */
  async inspect(code: string, pos: number, o: { timeoutMs?: number; signal?: { aborted: boolean; addEventListener(t: "abort", f: () => void, o?: { once: boolean }): void } } = {}): Promise<string | null> {
    const ev = await this.ask("inspect", code, pos, o);
    if (!ev || ev.ev !== "inspect" || !ev.found) return null;
    const data = ev.data && typeof ev.data === "object" ? ev.data : {};
    return docMarkdown((data as Record<string, unknown>)["text/plain"]);
  }

  private dropQueries() {
    for (const [id, q] of [...this.queries]) {
      clearTimeout(q.timer);
      this.queries.delete(id);
      q.resolve(null);
    }
  }

  protected closeSession() {
    this.destroyed = true;
    this.off?.();
    this.off = null;
    this.dropQueries();
    this.listeners.clear();
  }
}

