// Runs the buffer of a code window on a kernel session of its machine, for every participant: same rules as a
// notebook cell (execRunner.ts), the outputs go to the "outputs" list of the code document.
import type * as Y from "yjs";
import type { KernelEvent } from "./kernelProtocol.ts";
import { ExecRunner, type AwarenessLike, type RunResult } from "./execRunner.ts";
import { applyEventsTo, type WriteState } from "./notebookDoc.ts";
import { beginCodeRun, codeSink, finishCodeRun, outputsOf, readMeta } from "./codeDoc.ts";
import type { TermPort } from "./kernelSession.ts";

export class CodeRunner extends ExecRunner {
  constructor(ydoc: Y.Doc, port: TermPort, o: { awareness?: AwarenessLike; canEdit: boolean }) {
    super(ydoc, port, o);
  }

  protected applyEvents(_slot: string, execId: string, events: KernelEvent[], st: WriteState): boolean {
    return applyEventsTo(this.ydoc, codeSink(this.ydoc, execId), events, st);
  }
  protected stillRunning(_slot: string, execId: string): boolean {
    return readMeta(this.ydoc.getMap("meta")).running === execId;
  }
  protected runningIds(): string[] {
    const r = readMeta(this.ydoc.getMap("meta")).running;
    return r ? [r] : [];
  }
  protected finishOrphan(execId: string, count: number | null | undefined) {
    finishCodeRun(this.ydoc, execId, count);
  }
  protected resetOutputs(_slot: string, execId: string) {
    const outs = outputsOf(this.ydoc);
    if (readMeta(this.ydoc.getMap("meta")).running === execId && outs.length) this.ydoc.transact(() => outs.delete(0, outs.length));
  }

  /** Runs `code` (the current content of the window) on the shared kernel; this client becomes the executor. */
  run(code: string): RunResult {
    return this.launch("code", "code", () => ({ code }), (execId) => beginCodeRun(this.ydoc, execId));
  }
}
