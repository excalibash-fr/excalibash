// Unit tests of the capture manager (pure, no framework):
//   node --experimental-strip-types web/src/board/captureManager.test.ts
import { CaptureManager, splitDetails, type CaptureRunner, type CaptureSpec } from "./captureManager.ts";
import type { Signal } from "./fileTransfer.ts";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};
const tick = () => new Promise((r) => setTimeout(r, 5));

const spec: CaptureSpec = { iface: "lo", seconds: 3, maxBytes: 1 << 20 };

/** A client whose capture the test finishes by hand. */
function fake() {
  let progress: (n: number) => void = () => {};
  let signal!: Signal;
  let finish!: (r: { name: string; blob: Blob } | Error) => void;
  const runner: CaptureRunner = {
    capture: (_s, o) => {
      progress = o?.onProgress ?? (() => {});
      signal = o!.signal!;
      return new Promise((resolve, reject) => {
        finish = (r) => (r instanceof Error ? reject(r) : resolve(r));
      });
    },
  };
  return { runner, progress: (n: number) => progress(n), signal: () => signal, finish: (r: { name: string; blob: Blob } | Error) => finish(r) };
}

// A capture keeps running with nobody looking, then is delivered once at the end.
{
  const delivered: [number, string][] = [];
  const toasts: string[] = [];
  const m = new CaptureManager((b, n) => delivered.push([b.size, n]), (t) => toasts.push(t));
  let changes = 0;
  const unsub = m.subscribe(() => changes++);
  const f = fake();
  ok(m.start("c1:a", f.runner, spec, (n) => `x-${n}`), "start");
  ok(!m.start("c1:a", f.runner, spec), "a second capture under the same key is refused while one runs");
  f.progress(4096);
  const e = m.get("c1:a");
  ok(e?.phase === "running" && e.bytes === 4096 && m.getSnapshot().length === 1, "progress is visible to whoever reopens the window");
  m.stop("c1:a");
  ok(f.signal().stop === true && (m.get("c1:a") as any).stopping, "stop asks the agent to end cleanly");
  f.finish({ name: "capture-lo.pcap", blob: new Blob([new Uint8Array(100)]) });
  await tick();
  ok(delivered.length === 1 && delivered[0][0] === 100 && delivered[0][1] === "x-capture-lo.pcap", "the pcap is delivered once, at the end");
  ok(m.get("c1:a")?.phase === "done" && toasts[0].includes("terminée : 100 o"), "done entry and notice");
  ok(changes >= 4, "subscribers are told of each change");
  m.dismiss("c1:a");
  ok(!m.get("c1:a") && m.getSnapshot().length === 0, "dismiss forgets a finished capture");
  unsub();
}

// An error stays (inline in the window and in the indicator), with tcpdump's line as details.
{
  const toasts: [string, boolean | undefined][] = [];
  const m = new CaptureManager(() => {}, (t, err) => toasts.push([t, err]));
  const f = fake();
  m.start("k", f.runner, spec);
  f.finish(new Error("Capture refusée : pas le droit.\nDétail : tcpdump: lo: You don't have permission / (socket: Operation not permitted)"));
  await tick();
  const e = m.get("k");
  ok(e?.phase === "error" && e.message === "Capture refusée : pas le droit." && !!e.details?.includes("Operation not permitted"), "error with message and details");
  ok(toasts[0][1] === true, "and a toast, not only that");
  ok(m.start("k", f.runner, spec) && m.get("k")?.phase === "running", "a new capture replaces the error");
}

// Cancel delivers nothing and leaves no entry; dispose cancels everything.
{
  const delivered: string[] = [];
  const m = new CaptureManager((_b, n) => delivered.push(n));
  const f = fake();
  m.start("a", f.runner, spec);
  m.cancel("a");
  f.finish(new Error("Transfert annulé"));
  await tick();
  ok(!m.get("a") && delivered.length === 0, "cancel: nothing delivered, no error shown");
  const g = fake();
  m.start("b", g.runner, spec);
  m.dispose();
  g.finish({ name: "x.pcap", blob: new Blob([new Uint8Array(1)]) });
  await tick();
  ok(g.signal().aborted && delivered.length === 0 && m.getSnapshot().length === 0, "dispose: aborted, nothing delivered");
}

ok(JSON.stringify(splitDetails("a\nDétail : b")) === '{"message":"a","details":"b"}' && splitDetails("seul").details === undefined, "splitDetails");

if (failures) {
  console.error(`${failures} échec(s)`);
  process.exit(1);
}
