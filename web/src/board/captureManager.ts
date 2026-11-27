// Packet captures of a board, owned by the board session instead of the cable-end window: closing
// the window leaves the capture running, and the pcap is delivered when it ends. One manager per
// session (like the notebook service); no DOM and no React, so it can be tested on its own.
import type { BoardSession } from "./collab.ts";
import type { FileClient, Signal } from "./fileTransfer.ts";
import { splitDetails } from "./errorDetails.ts";
import { fmtBytes } from "../format.ts";

export { splitDetails };
export type CaptureSpec = { iface: string; filter?: string; seconds: number; maxBytes: number };

export type CaptureEntry =
  | { key: string; phase: "running"; iface: string; spec: CaptureSpec; startedAt: number; bytes: number; stopping: boolean }
  | { key: string; phase: "done"; iface: string; spec: CaptureSpec; bytes: number; file: string }
  | { key: string; phase: "error"; iface: string; spec: CaptureSpec; message: string; details?: string; outdated?: boolean };

/** The part of a FileClient the manager uses. */
export type CaptureRunner = Pick<FileClient, "capture">;

/** What happens with the finished pcap (the app saves it; tests record it). */
export type Deliver = (blob: Blob, name: string) => void;

export class CaptureManager {
  private entries = new Map<string, CaptureEntry>();
  private signals = new Map<string, Signal>();
  private listeners = new Set<() => void>();
  private snapshot: readonly CaptureEntry[] = [];

  private deliver: Deliver;
  private notify: (text: string, error?: boolean) => void;

  constructor(deliver: Deliver, notify: (text: string, error?: boolean) => void = () => {}) {
    this.deliver = deliver;
    this.notify = notify;
  }

  /** For useSyncExternalStore: a new array identity at each change. */
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.snapshot;

  get(key: string): CaptureEntry | undefined {
    return this.entries.get(key);
  }

  private set(e: CaptureEntry) {
    this.entries.set(e.key, e);
    this.changed();
  }

  private changed() {
    this.snapshot = [...this.entries.values()];
    for (const fn of [...this.listeners]) fn();
  }

  /** Starts a capture; false if one already runs under this key. */
  start(key: string, client: CaptureRunner, spec: CaptureSpec, saveAs: (name: string) => string = (n) => n): boolean {
    if (this.entries.get(key)?.phase === "running") return false;
    const signal: Signal = { aborted: false };
    this.signals.set(key, signal);
    const entry: CaptureEntry = { key, phase: "running", iface: spec.iface, spec, startedAt: Date.now(), bytes: 0, stopping: false };
    this.set(entry);
    const progress = (bytes: number) => {
      const cur = this.entries.get(key);
      if (cur?.phase !== "running" || this.signals.get(key) !== signal) return;
      this.set({ ...cur, bytes, stopping: !!signal.stop });
    };
    client.capture(spec, { signal, onProgress: progress }).then(
      ({ name, blob }) => {
        if (this.signals.get(key) !== signal) return;
        this.signals.delete(key);
        const file = saveAs(name);
        this.deliver(blob, file);
        this.set({ key, phase: "done", iface: spec.iface, spec, bytes: blob.size, file });
        this.notify(`Capture sur ${spec.iface} terminée : ${fmtBytes(blob.size)} téléchargés`);
      },
      (e: unknown) => {
        if (this.signals.get(key) !== signal) return;
        this.signals.delete(key);
        if (signal.aborted) {
          this.entries.delete(key);
          this.changed();
          return;
        }
        const { message, details } = splitDetails(e instanceof Error ? e.message : String(e));
        this.set({ key, phase: "error", iface: spec.iface, spec, message, ...(details ? { details } : {}), ...((e as { code?: string })?.code === "outdated" ? { outdated: true } : {}) });
        this.notify(`Capture sur ${spec.iface} : ${message}`, true);
      },
    );
    return true;
  }

  /** Ends a running capture cleanly: what was captured so far is delivered. */
  stop(key: string) {
    const s = this.signals.get(key);
    const e = this.entries.get(key);
    if (!s || e?.phase !== "running") return;
    s.stop = true;
    this.set({ ...e, stopping: true });
  }

  /** Gives up a running capture: nothing is delivered. */
  cancel(key: string) {
    const s = this.signals.get(key);
    if (s) s.aborted = true;
  }

  /** Forgets a finished capture (its result or error was seen). */
  dismiss(key: string) {
    if (this.entries.get(key)?.phase === "running") return;
    if (this.entries.delete(key)) this.changed();
  }

  /** The board session is closed: nobody is left to receive the file. */
  dispose() {
    for (const s of this.signals.values()) s.aborted = true;
    this.signals.clear();
    this.entries.clear();
    this.listeners.clear();
    this.snapshot = [];
  }
}

const managers = new WeakMap<BoardSession, CaptureManager>();

/** The capture manager of a board session (created on first use, disposed with the session). */
export function capturesOf(session: BoardSession, deliver: Deliver, notify?: (text: string, error?: boolean) => void): CaptureManager {
  let m = managers.get(session);
  if (!m) {
    m = new CaptureManager(deliver, notify);
    managers.set(session, m);
    session.onDispose(() => {
      m!.dispose();
      managers.delete(session);
    });
  }
  return m;
}
