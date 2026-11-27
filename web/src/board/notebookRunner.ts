// Runs the cells of a shared notebook on the kernel session of its machine, for every participant.
//
// The kernel is a "jupyter" terminal: ONE session, ONE kernel, shared by everybody who has the key of
// the terminal. Every client parses the same output stream (LineSplitter / parseEvent), but a run has
// exactly one executor, the client whose user clicked "run":
//   - it sends {"op":"exec","id":"<cellId>:<random>","code"} and, in the same Y transaction, sets
//     cell.running = id and clears the outputs (beginRun);
//   - only it (the id is in its local `execs` map) writes the events of that id into the cell's
//     outputs, batched every 80 ms and in pieces small enough for one document update, and ends the
//     run on `done` (execution_count, running removed);
//   - it advertises its in-flight ids in its awareness state (`execs`).
// If the executor leaves mid-run, any editor that sees a cell `running` under an id that is in nobody's
// awareness for 5 s finalizes it once the kernel is idle (or the `done` of that id went by): the count is
// recorded and `running` removed. Output events produced after the executor left are not recorded.
// Pure TypeScript (timers only): the same code runs in the window and in the e2e scenario.
import type * as Y from "yjs";
import type { KernelEvent } from "./kernelProtocol.ts";
import { ExecRunner, type AwarenessLike, type RunResult } from "./execRunner.ts";
import type { KernelStatus, TermPort } from "./kernelSession.ts";
import { applyKernelEvents, beginRun, cellViews, findCell, finishRun, resetRunOutputs, type WriteState } from "./notebookDoc.ts";

export type { AwarenessLike, KernelStatus, RunResult, TermPort };

export class NotebookRunner extends ExecRunner {
  constructor(ydoc: Y.Doc, port: TermPort, o: { awareness?: AwarenessLike; canEdit: boolean }) {
    super(ydoc, port, o);
  }

  protected applyEvents(cellId: string, execId: string, events: KernelEvent[], st: WriteState): boolean {
    return applyKernelEvents(this.ydoc, cellId, execId, events, st);
  }
  protected stillRunning(cellId: string, execId: string): boolean {
    return findCell(this.ydoc, cellId)?.running === execId;
  }
  protected runningIds(): string[] {
    return cellViews(this.ydoc).flatMap((c) => (c.running ? [c.running] : []));
  }
  protected finishOrphan(execId: string, count: number | null | undefined) {
    finishRun(this.ydoc, execId, count);
  }
  protected resetOutputs(cellId: string, execId: string) {
    resetRunOutputs(this.ydoc, cellId, execId);
  }

  /** Runs a cell on the shared kernel; this client becomes its executor. */
  run(cellId: string): RunResult {
    return this.launch(
      cellId,
      cellId,
      () => {
        const cell = findCell(this.ydoc, cellId);
        return cell ? { code: cell.source.toString() } : { reason: "Cellule introuvable" };
      },
      (execId) => beginRun(this.ydoc, cellId, execId),
    );
  }

  /** Runs the given cells one after the other (the kernel queues them); returns how many were sent. */
  runMany(cellIds: string[]): number {
    let n = 0;
    for (const id of cellIds) {
      const r = this.run(id);
      if (r.ok) n++;
      else if (!/déjà en cours|Seules les cellules/.test(r.reason)) break;
    }
    return n;
  }
}
