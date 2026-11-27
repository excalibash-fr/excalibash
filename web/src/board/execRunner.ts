// The executor side shared by everything that runs code on a kernel session and writes the outputs into a
// shared document: a notebook (outputs of a cell, notebookRunner.ts) and a code window (its output list,
// codeRunner.ts). One run has exactly one executor, the client whose user clicked "run":
//   - it sends {"op":"exec","id","code"} and, in the same Y transaction, marks the run in the document and
//     clears the old outputs (`begin`);
//   - only it (the id is in its local `execs` map) writes the events of that id into the document, batched every
//     80 ms and in pieces small enough for one document update, and ends the run on `done`;
//   - it advertises its in-flight ids in its awareness state (`execs`).
// If the executor leaves mid-run, any editor that sees a run marked in the document under an id that is in
// nobody's awareness for 5 s finalizes it once the kernel is idle (or the `done` of that id went by).
// Output events produced after the executor left are not recorded.
//
// The stream is replayed (the server's scrollback) on every subscription, reconnections included. The executor
// rebuilds the outputs of its in-flight runs from the replay when it holds their first event, and only takes
// their `done` from it otherwise (the scrollback lost the start: what was written stays).
// An own run never stays marked forever: leaving the session ends it (attach to another one or to none), and
// a run with no event for 15 s while the kernel has been idle for 15 s ends with an `ExecutionLost` error.
import type * as Y from "yjs";
import { encodeOp, type KernelEvent } from "./kernelProtocol.ts";
import { KernelSession, type TermPort } from "./kernelSession.ts";
import { cutAt, eventWeight, newWriteState, type WriteState } from "./notebookDoc.ts";

export type AwarenessLike = {
  getStates(): Map<number, any>;
  setLocalStateField(field: string, value: unknown): void;
};

export type RunResult = { ok: true; execId: string } | { ok: false; reason: string };

const FLUSH_MS = 80;
/** Serialized size of the events written in one transaction: one document update must stay under 380 KiB. */
const BATCH_BUDGET = 160 * 1024;
const ORPHAN_MS = 5000;
const SWEEP_MS = 1500;
/** An own run with no event for this long while the kernel is idle was lost (request never reached it). */
const LOST_MS = 15_000;

type Exec = {
  slot: string;
  st: WriteState;
  queue: KernelEvent[];
  timer?: ReturnType<typeof setTimeout>;
  /** When the run was sent or last got an event. */
  last: number;
  /** Its first event line, to know whether a replay holds the whole run. */
  first?: string;
};

export abstract class ExecRunner extends KernelSession {
  protected ydoc: Y.Doc;
  private awareness: AwarenessLike | undefined;
  private execs = new Map<string, Exec>();
  private foreignDone = new Map<string, number | null>();
  private orphanSince = new Map<string, number>();
  private sweeper: ReturnType<typeof setInterval> | undefined;
  /** Own runs whose start is missing from the scrollback being replayed: only their `done` is taken. */
  private doneOnly = new Set<string>();

  constructor(ydoc: Y.Doc, port: TermPort, o: { awareness?: AwarenessLike; canEdit: boolean }) {
    super(port, o.canEdit);
    this.ydoc = ydoc;
    this.awareness = o.awareness;
    if (o.canEdit) this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
  }

  /** The ids of the runs this client executes. */
  get localRuns(): string[] {
    return [...this.execs.keys()];
  }

  // What a subclass knows about its document ------------------------------------------------------------------------

  /** Writes events into the output list of `slot` (a cell id, or the code window). True when a `done` was applied. */
  protected abstract applyEvents(slot: string, execId: string, events: KernelEvent[], st: WriteState): boolean;
  /** The run `execId` is still marked as running in the document. */
  protected abstract stillRunning(slot: string, execId: string): boolean;
  /** Every exec id the document marks as running. */
  protected abstract runningIds(): string[];
  /** Ends a run whose executor is gone; the count when its `done` was seen. */
  protected abstract finishOrphan(execId: string, count: number | null | undefined): void;
  /** Empties the outputs of the run `execId` if it is still marked in the document (rebuilt from a replay). */
  protected abstract resetOutputs(slot: string, execId: string): void;

  protected beforeReplay(lines: ReadonlySet<string>) {
    this.doneOnly.clear();
    for (const [id, ex] of this.execs) {
      if (ex.first !== undefined && !lines.has(ex.first)) {
        // The start of the run is no longer in the scrollback: keep what was written, only take its end.
        this.doneOnly.add(id);
        continue;
      }
      // The replay holds the whole run: rebuild its outputs from scratch (no event is applied twice).
      if (ex.timer) clearTimeout(ex.timer);
      ex.timer = undefined;
      ex.queue = [];
      ex.st = newWriteState();
      try {
        this.resetOutputs(ex.slot, id);
      } catch (e) {
        console.error("[excalibash]", e);
      }
    }
  }

  protected onEvent(ev: KernelEvent, line: string, replayed: boolean) {
    const id = (ev as { id?: unknown }).id;
    if (typeof id !== "string") return;
    const ex = this.execs.get(id);
    if (ex) {
      ex.last = Date.now();
      if (ex.first === undefined) ex.first = line;
      if (replayed && this.doneOnly.has(id) && ev.ev !== "done") return;
      ex.queue.push(ev);
      this.schedule(id, ex);
    } else if (ev.ev === "done") {
      this.foreignDone.set(id, typeof ev.count === "number" ? ev.count : null);
      if (this.foreignDone.size > 500) this.foreignDone.delete(this.foreignDone.keys().next().value!);
    }
  }

  // ---- executor side ---------------------------------------------------------------------------------------------

  private schedule(id: string, ex: Exec) {
    if (ex.timer) return;
    ex.timer = setTimeout(() => {
      ex.timer = undefined;
      this.flush(id, ex);
    }, FLUSH_MS);
  }

  /** The next events, as many as fit the budget; a big stream text is cut and its rest stays queued. */
  private take(ex: Exec): KernelEvent[] {
    const batch: KernelEvent[] = [];
    let used = 0;
    while (ex.queue.length) {
      const ev = ex.queue[0];
      const w = eventWeight(ev);
      if (used + w > BATCH_BUDGET && batch.length) break;
      if (ev.ev === "stream" && used + w > BATCH_BUDGET) {
        const n = cutAt(ev.text, Math.max(1, BATCH_BUDGET - used - 64));
        if (n < ev.text.length) {
          batch.push({ ...ev, text: ev.text.slice(0, n) });
          ex.queue[0] = { ...ev, text: ev.text.slice(n) };
          break;
        }
      }
      batch.push(ex.queue.shift()!);
      used += w;
    }
    return batch;
  }

  private flush(id: string, ex: Exec) {
    if (!this.execs.has(id)) return;
    const batch = this.take(ex);
    let finished = false;
    try {
      finished = this.applyEvents(ex.slot, id, batch, ex.st);
    } catch (e) {
      console.error("[excalibash]", e);
    }
    const still = this.stillRunning(ex.slot, id);
    if (finished || !still) return this.forget(id);
    if (ex.queue.length) this.schedule(id, ex);
  }

  private forget(id: string) {
    const ex = this.execs.get(id);
    if (ex?.timer) clearTimeout(ex.timer);
    this.execs.delete(id);
    this.publish();
    this.emit();
  }

  private publish() {
    this.awareness?.setLocalStateField("execs", [...this.execs.keys()]);
  }

  /**
   * Sends one exec to the kernel session; this client becomes its executor. `source` gives the code (or the
   * reason it cannot run), `begin` marks the run in the document (and clears the outputs) in one transaction.
   */
  protected launch(
    idPrefix: string,
    slot: string,
    source: () => { code: string } | { reason: string },
    begin: (execId: string) => { ok: true } | { ok: false; reason: string },
  ): RunResult {
    if (!this.canEdit) return { ok: false, reason: "Lecture seule" };
    if (!this.term || !this.subscribed || this.status === "absent") return { ok: false, reason: "Aucun noyau : démarre-le d'abord" };
    if (this.status === "dead") return { ok: false, reason: "Le noyau est arrêté : redémarre-le" };
    const src = source();
    if ("reason" in src) return { ok: false, reason: src.reason };
    const execId = `${idPrefix.slice(0, 36)}:${Math.random().toString(36).slice(2, 12).padEnd(10, "0")}`;
    let line: string;
    try {
      line = encodeOp({ op: "exec", id: execId, code: src.code });
    } catch (e: any) {
      return { ok: false, reason: e?.message ?? "Requête refusée" };
    }
    // The state of a run is registered before anything goes out: its first events can't be missed.
    this.execs.set(execId, { slot, st: newWriteState(), queue: [], last: Date.now() });
    const begun = begin(execId);
    if (!begun.ok) {
      this.execs.delete(execId);
      return begun;
    }
    this.publish();
    this.send(line);
    this.emit();
    return { ok: true, execId };
  }

  /** The kernel session ended (terminal exited or removed): this client's runs end with an error. */
  terminalGone() {
    if (this.status !== "dead") {
      this.setStatus("dead");
      this.emit();
    }
    this.abandonRuns("le noyau s'est arrêté");
  }

  /** Following another kernel session (or none): this client's runs on the old one end with an error. */
  protected leaveSession() {
    this.abandonRuns("le noyau a été arrêté ou remplacé");
  }

  /** Ends this client's runs with an error (what was queued is written first). */
  private abandonRuns(evalue: string) {
    for (const id of [...this.execs.keys()]) this.endRun(id, "KernelStopped", evalue);
  }

  private endRun(id: string, ename: string, evalue: string) {
    const ex = this.execs.get(id);
    if (!ex) return;
    if (ex.timer) clearTimeout(ex.timer);
    ex.timer = undefined;
    // A `done` already received but not yet written ends the run normally.
    const evs: KernelEvent[] = ex.queue.some((e) => e.ev === "done")
      ? ex.queue
      : [...ex.queue, { ev: "error", id, ename, evalue, traceback: [] }, { ev: "done", id, count: null, status: "error" }];
    ex.queue = [];
    try {
      this.applyEvents(ex.slot, id, evs, ex.st);
    } catch (e) {
      console.error("[excalibash]", e);
    }
    this.forget(id);
  }

  // ---- everybody: finalize the runs whose executor is gone ----------------------------------------------------------

  private hasAwareExec(id: string): boolean {
    for (const [, s] of this.awareness?.getStates() ?? []) if (Array.isArray(s?.execs) && s.execs.includes(id)) return true;
    return false;
  }

  /** One pass of the orphan check (also called by tests). */
  sweep(now = Date.now()) {
    if (this.destroyed || !this.canEdit) return;
    const live = new Set<string>();
    for (const id of this.runningIds()) {
      if (this.execs.has(id)) continue;
      live.add(id);
      const since = this.orphanSince.get(id) ?? now;
      this.orphanSince.set(id, since);
      if (now - since < ORPHAN_MS || this.hasAwareExec(id)) continue;
      const done = this.foreignDone.has(id);
      // Without a `done` the run only counts as lost when the kernel has nothing left to do.
      if (done || this.status !== "busy") {
        this.finishOrphan(id, done ? this.foreignDone.get(id) : undefined);
        this.orphanSince.delete(id);
      }
    }
    for (const id of [...this.orphanSince.keys()]) if (!live.has(id)) this.orphanSince.delete(id);
    // Own runs whose request was lost (socket down, terminal not running yet): the kernel has been idle for a
    // while and nothing ever came back for them.
    if ((this.status === "idle" || this.status === "dead") && now - this.statusSince >= LOST_MS) {
      for (const [id, ex] of [...this.execs]) {
        if (now - ex.last >= LOST_MS && !ex.queue.length) this.endRun(id, "ExecutionLost", "aucune réponse du noyau pour cette exécution : la requête a dû se perdre, relance-la");
      }
    }
  }

  destroy() {
    this.closeSession();
    clearInterval(this.sweeper);
    for (const ex of this.execs.values()) if (ex.timer) clearTimeout(ex.timer);
    this.execs.clear();
    try {
      this.awareness?.setLocalStateField("execs", []);
    } catch {
      /* the awareness is already gone */
    }
  }
}
