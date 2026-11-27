// Shared notebook documents: schema, .ipynb import / export, cell operations and the way kernel
// events land in a cell. Pure (no DOM, no React, no Monaco): tested by notebook.test.ts and used
// by the notebook window and the e2e scenario.
//
// A notebook document is a Y.Doc with
//   Y.Map   "meta":  { path?, name, savedSha?, savedAt?, savedBy?, kernelTerm?, kernel?, language, nbformatMinor, nbMetadata? }
//   Y.Array "cells": Y.Map { id, type: "code"|"markdown"|"raw", source: Y.Text, outputs: Y.Array<output>,
//                            execution_count: number|null, metadata: object, running?: exec id }
//   Y.Array "order": the cell ids in display order
// "cells" is only the storage of the cells: a cell's Y.Map (and its Y.Text) is created once and never
// copied, so a move only touches "order" and cannot lose a keystroke typed in the moved cell at the
// same time. Documents written before "order" existed have none: their cells show in storage order,
// and the first structural edit by an editor writes the order down (see ensureOrder: idempotent, and
// two editors doing it at once leave repeated ids that readers ignore and removeDuplicates cleans).
// `outputs` hold nbformat v4 output objects (plain JSON). Anyone who can edit the board can write any
// of this: every reader below is defensive.
import * as Y from "yjs";
import type { KernelEvent } from "./kernelProtocol.ts";

export type CellType = "code" | "markdown" | "raw";
export type Cell = Y.Map<any>;
/** An nbformat v4 output object (stream, display_data, execute_result or error). */
export type NbOutput = Record<string, any>;
/** MIME bundle as the doc stores it: string values only (JSON payloads are serialized). */
export type Bundle = Record<string, string>;

export const MAX_CELLS = 500;
/** A cell's source, bytes (what the kernel bridge accepts). */
export const MAX_SOURCE = 1 << 20;
/** One output, serialized: bigger ones are replaced by a note (one document update must stay under 380 KiB). */
export const MAX_OUTPUT_BYTES = 256 * 1024;
/** All the outputs of one cell, serialized. */
export const MAX_CELL_OUTPUT = 3 * 1024 * 1024;
/** Text of the streams of one run. */
export const MAX_STREAM_TEXT = 1024 * 1024;
/** A stream output is cut here so that merging new text never rewrites a big string. */
export const STREAM_CHUNK = 32 * 1024;
export const NBFORMAT_MINOR = 5;
/** Largest .ipynb the window opens or writes (a document is limited to 8 MiB once sealed). */
export const MAX_NOTEBOOK_BYTES = 5 * 1024 * 1024; // its Yjs state must fit a sealed snapshot (8 MiB, server/src/docs.ts)

export class NotebookFormatError extends Error {}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TERM_RE = /^[A-Za-z0-9_-]{22}$/;
const KERNEL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export const isTermId = (v: unknown): v is string => typeof v === "string" && TERM_RE.test(v);
const jsonLen = (v: unknown) => JSON.stringify(v)?.length ?? 0;

/** A random UUID v4 (crypto.randomUUID needs a secure context). */
export function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---- metadata ----------------------------------------------------------------------------------------

export type NotebookMeta = {
  path?: string;
  name: string;
  savedSha?: string;
  savedAt?: number;
  savedBy?: string;
  /** Terminal id of the shared kernel session (one for everybody). */
  kernelTerm?: string;
  kernel?: string;
  language: string;
  nbformatMinor: number;
};

export const metaOf = (ydoc: Y.Doc) => ydoc.getMap<unknown>("meta");
/** The storage of the cells (not their display order, see orderOf). */
export const cellsOf = (ydoc: Y.Doc) => ydoc.getArray<Cell>("cells");
/** The display order: cell ids. May repeat an id (concurrent moves / migrations) or miss some (old documents). */
export const orderOf = (ydoc: Y.Doc) => ydoc.getArray<string>("order");

/** Document metadata, read defensively. */
export function readMeta(meta: { get(k: string): unknown }): NotebookMeta {
  const s = (v: unknown) => (typeof v === "string" && v.length <= 4096 ? v : undefined);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const path = s(meta.get("path"));
  const sha = meta.get("savedSha");
  const term = meta.get("kernelTerm");
  const kernel = meta.get("kernel");
  const minor = n(meta.get("nbformatMinor"));
  return {
    ...(path ? { path } : {}),
    name: s(meta.get("name")) || "sans-titre.ipynb",
    ...(typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha) ? { savedSha: sha } : {}),
    ...(n(meta.get("savedAt")) !== undefined ? { savedAt: n(meta.get("savedAt")) } : {}),
    ...(s(meta.get("savedBy")) ? { savedBy: s(meta.get("savedBy")) } : {}),
    ...(typeof term === "string" && TERM_RE.test(term) ? { kernelTerm: term } : {}),
    ...(typeof kernel === "string" && KERNEL_RE.test(kernel) ? { kernel } : {}),
    language: "python",
    nbformatMinor: minor !== undefined && Number.isInteger(minor) && minor >= 0 && minor <= 99 ? minor : NBFORMAT_MINOR,
  };
}

/** The shared kernel session of the notebook, or null (the terminal id is validated). */
export const kernelTermOf = (ydoc: Y.Doc): string | null => readMeta(metaOf(ydoc)).kernelTerm ?? null;

export function setKernelTerm(ydoc: Y.Doc, term: string | null) {
  const meta = metaOf(ydoc);
  ydoc.transact(() => {
    if (term) meta.set("kernelTerm", term);
    else meta.delete("kernelTerm");
  });
}

// ---- cells -------------------------------------------------------------------------------------------

export type CellView = {
  index: number;
  id: string;
  type: CellType;
  source: Y.Text;
  outputs: NbOutput[];
  executionCount: number | null;
  metadata: Record<string, unknown>;
  running?: string;
  map: Cell;
};

export const validOutput = (o: unknown): o is NbOutput =>
  isObj(o) && (o.output_type === "stream" || o.output_type === "display_data" || o.output_type === "execute_result" || o.output_type === "error");

/** One cell of the document, or null when it is not well formed. */
export function readCell(m: unknown, index = -1): CellView | null {
  if (!(m instanceof Y.Map)) return null;
  const id = m.get("id");
  const type = m.get("type");
  const source = m.get("source");
  if (typeof id !== "string" || !ID_RE.test(id) || (type !== "code" && type !== "markdown" && type !== "raw") || !(source instanceof Y.Text)) return null;
  const outs = m.get("outputs");
  const count = m.get("execution_count");
  const meta = m.get("metadata");
  const running = m.get("running");
  return {
    index,
    id,
    type,
    source,
    outputs: outs instanceof Y.Array ? (outs.toArray() as unknown[]).filter(validOutput) : [],
    executionCount: typeof count === "number" && Number.isFinite(count) ? count : null,
    metadata: isObj(meta) ? meta : {},
    ...(typeof running === "string" && running.length > 0 && running.length <= 64 ? { running } : {}),
    map: m,
  };
}

/**
 * The well-formed cells in display order: the ids of `order` first (a repeated id keeps its first place,
 * an id without a cell is skipped), then the cells `order` does not mention, in storage order. A repeated
 * id in the storage keeps its first cell only.
 */
export function cellViews(ydoc: Y.Doc): CellView[] {
  const byId = new Map<string, CellView>();
  cellsOf(ydoc).forEach((m, i) => {
    const v = readCell(m, i);
    if (v && !byId.has(v.id)) byId.set(v.id, v);
  });
  const out: CellView[] = [];
  const seen = new Set<string>();
  for (const id of orderOf(ydoc).toArray()) {
    const v = typeof id === "string" ? byId.get(id) : undefined;
    if (!v || seen.has(id)) continue;
    seen.add(id);
    out.push(v);
  }
  for (const v of byId.values()) if (!seen.has(v.id)) out.push(v);
  return out.map((v, i) => ({ ...v, index: i }));
}

export const findCell = (ydoc: Y.Doc, id: string): CellView | undefined => cellViews(ydoc).find((c) => c.id === id);

/** Positions of an id in a Y.Array<Cell> / Y.Array<string>. */
function indexesOf(arr: Y.Array<any>, id: string, of: (v: any) => unknown): number[] {
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) if (of(arr.get(i)) === id) out.push(i);
  return out;
}
const cellIdOf = (m: unknown) => (m instanceof Y.Map ? m.get("id") : undefined);
const same = (v: unknown) => v;

/**
 * Writes the display order down for the cells it does not mention yet (every cell of an old document).
 * Call it inside the transaction of a structural edit. Idempotent; when two editors do it at once the
 * order repeats ids, which readers ignore and removeDuplicates removes. Returns whether it wrote.
 */
export function ensureOrder(ydoc: Y.Doc): boolean {
  const order = orderOf(ydoc);
  const known = new Set<string>();
  for (const id of order.toArray()) if (typeof id === "string") known.add(id);
  const missing = cellViews(ydoc)
    .filter((c) => !known.has(c.id))
    .map((c) => c.id);
  if (!missing.length) return false;
  ydoc.transact(() => order.push(missing));
  return true;
}

export function newCellMap(o: { type: CellType; source?: string; id?: string; outputs?: NbOutput[]; executionCount?: number | null; metadata?: Record<string, unknown> }): Cell {
  const m: Cell = new Y.Map();
  m.set("id", o.id ?? uuid());
  m.set("type", o.type);
  m.set("source", new Y.Text(o.source ?? ""));
  const outs = new Y.Array<NbOutput>();
  if (o.outputs?.length) outs.push(o.outputs);
  m.set("outputs", outs);
  m.set("execution_count", o.type === "code" ? (o.executionCount ?? null) : null);
  m.set("metadata", o.metadata ?? {});
  return m;
}

export type InsertAt = "start" | "end" | { before: string } | { after: string };

/** Inserts a new cell in one transaction and returns its id. Throws a French message when the notebook is full. */
export function insertCell(ydoc: Y.Doc, o: { type: CellType; source?: string; at: InsertAt }): string {
  if (cellViews(ydoc).length >= MAX_CELLS) throw new Error(`Un notebook ne peut pas dépasser ${MAX_CELLS} cellules`);
  const id = uuid();
  const cell = newCellMap({ type: o.type, source: o.source, id });
  ydoc.transact(() => {
    ensureOrder(ydoc);
    const order = orderOf(ydoc);
    let at = order.length;
    if (o.at === "start") at = 0;
    else if (typeof o.at === "object") {
      const i = order.toArray().indexOf("before" in o.at ? o.at.before : o.at.after);
      if (i >= 0) at = "before" in o.at ? i : i + 1;
    }
    cellsOf(ydoc).push([cell]);
    order.insert(at, [id]);
  });
  return id;
}

export function deleteCell(ydoc: Y.Doc, id: string): boolean {
  let done = false;
  ydoc.transact(() => {
    const cells = cellsOf(ydoc);
    const hits = indexesOf(cells, id, cellIdOf);
    if (!hits.length) return;
    ensureOrder(ydoc);
    for (const i of hits.reverse()) cells.delete(i, 1);
    const order = orderOf(ydoc);
    for (const i of indexesOf(order, id, same).reverse()) order.delete(i, 1);
    done = true;
  });
  return done;
}

/**
 * Moves a cell one step. Only the order changes: the cell (its Y.Map, its Y.Text) is untouched, so what
 * somebody types in it at that very moment is kept. Two people moving the same cell at once leave its id
 * twice in the order: readers keep the first place, removeDuplicates cleans up.
 */
export function moveCell(ydoc: Y.Doc, id: string, delta: -1 | 1): boolean {
  const list = cellViews(ydoc);
  const i = list.findIndex((c) => c.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return false;
  const neighbour = list[j].id;
  ydoc.transact(() => {
    ensureOrder(ydoc);
    const order = orderOf(ydoc);
    const from = order.toArray().indexOf(id);
    if (from >= 0) order.delete(from, 1);
    const n = order.toArray().indexOf(neighbour);
    order.insert(n >= 0 ? (delta < 0 ? n : n + 1) : order.length, [id]);
  });
  return true;
}

/**
 * Deletes the later repeats of an id, in the order (concurrent moves, concurrent migrations) and in the
 * storage. Idempotent across clients. Returns how many entries went.
 */
export function removeDuplicates(ydoc: Y.Doc): number {
  const dups = (arr: Y.Array<any>, of: (v: any) => unknown) => {
    const seen = new Set<unknown>();
    const out: number[] = [];
    arr.forEach((v, i) => {
      const id = of(v);
      if (typeof id !== "string") return;
      if (seen.has(id)) out.push(i);
      else seen.add(id);
    });
    return out;
  };
  const cells = cellsOf(ydoc);
  const order = orderOf(ydoc);
  const dc = dups(cells, cellIdOf);
  const dord = dups(order, same);
  if (!dc.length && !dord.length) return 0;
  ydoc.transact(() => {
    for (const i of dc.reverse()) cells.delete(i, 1);
    for (const i of dord.reverse()) order.delete(i, 1);
  });
  return dc.length + dord.length;
}

/** Changes a cell's type; outputs and the execution count only make sense for code. */
export function setCellType(ydoc: Y.Doc, id: string, type: CellType): boolean {
  const c = findCell(ydoc, id);
  if (!c || c.type === type) return false;
  ydoc.transact(() => {
    c.map.set("type", type);
    if (type !== "code") {
      const outs = c.map.get("outputs");
      if (outs instanceof Y.Array && outs.length) outs.delete(0, outs.length);
      c.map.set("execution_count", null);
      c.map.delete("running");
    }
  });
  return true;
}

export function clearOutputs(ydoc: Y.Doc, id: string): boolean {
  const c = findCell(ydoc, id);
  if (!c || c.running) return false;
  ydoc.transact(() => {
    const outs = c.map.get("outputs");
    if (outs instanceof Y.Array && outs.length) outs.delete(0, outs.length);
    c.map.set("execution_count", null);
  });
  return true;
}

// ---- running a cell ------------------------------------------------------------------------------------

export type BeginRun = { ok: true; code: string } | { ok: false; reason: string };

/** Marks a code cell as running under `execId` and clears its outputs, in ONE transaction. */
export function beginRun(ydoc: Y.Doc, cellId: string, execId: string): BeginRun {
  const c = findCell(ydoc, cellId);
  if (!c) return { ok: false, reason: "Cellule introuvable" };
  if (c.type !== "code") return { ok: false, reason: "Seules les cellules de code s'exécutent" };
  if (c.running) return { ok: false, reason: "Cette cellule est déjà en cours d'exécution" };
  const code = c.source.toString();
  ydoc.transact(() => {
    const outs = c.map.get("outputs");
    if (outs instanceof Y.Array && outs.length) outs.delete(0, outs.length);
    c.map.set("running", execId);
  });
  return { ok: true, code };
}

/** Ends a run (or an abandoned one): running goes away, the count is recorded when known. */
export function finishRun(ydoc: Y.Doc, execId: string, count?: number | null): boolean {
  const c = cellViews(ydoc).find((x) => x.running === execId);
  if (!c) return false;
  ydoc.transact(() => {
    if (count !== undefined) c.map.set("execution_count", count);
    c.map.delete("running");
  });
  return true;
}

/** Empties the outputs of the cell running under `execId` (its run is about to be rebuilt from a replay). */
export function resetRunOutputs(ydoc: Y.Doc, cellId: string, execId: string): boolean {
  const c = findCell(ydoc, cellId);
  const outs = c?.running === execId ? c.map.get("outputs") : undefined;
  if (!(outs instanceof Y.Array)) return false;
  if (outs.length) ydoc.transact(() => outs.delete(0, outs.length));
  return true;
}

/** What the executor remembers while it writes the outputs of one run. */
export type WriteState = { clearPending: boolean; bytes: number; textBytes: number; truncated: boolean };
export const newWriteState = (): WriteState => ({ clearPending: false, bytes: 0, textBytes: 0, truncated: false });

/** Cuts a string at most at `n` UTF-16 units, never inside a surrogate pair. */
export function cutAt(s: string, n: number): number {
  if (n >= s.length) return s.length;
  const c = s.charCodeAt(n - 1);
  return c >= 0xd800 && c <= 0xdbff ? n - 1 : n;
}

function cleanBundle(data: unknown): Bundle {
  const out: Bundle = {};
  if (!isObj(data)) return out;
  for (const [k, v] of Object.entries(data)) if (MIME_RE.test(k) && typeof v === "string") out[k] = v;
  return out;
}

/** Keeps an output under MAX_OUTPUT_BYTES: the biggest representations go, a note replaces them. */
export function shrinkOutput(o: NbOutput): NbOutput {
  if (jsonLen(o) <= MAX_OUTPUT_BYTES) return o;
  if (o.output_type === "stream") return { ...o, text: String(o.text).slice(0, cutAt(String(o.text), MAX_OUTPUT_BYTES / 2)) };
  if (o.output_type === "error") {
    const tb = Array.isArray(o.traceback) ? o.traceback.map((l: unknown) => String(l).slice(0, 4000)).slice(0, 60) : [];
    return { ...o, evalue: String(o.evalue).slice(0, 4000), traceback: tb };
  }
  const data: Bundle = { ...cleanBundle(o.data) };
  const dropped: string[] = [];
  const keys = Object.keys(data).sort((a, b) => data[b].length - data[a].length);
  const probe = () => jsonLen({ ...o, data });
  for (const k of keys) {
    if (probe() <= MAX_OUTPUT_BYTES) break;
    if (k === "text/plain" && data[k].length < MAX_OUTPUT_BYTES / 4) continue;
    dropped.push(`${k} (${Math.ceil(data[k].length / 1024)} Kio)`);
    delete data[k];
  }
  if (dropped.length) {
    const note = `[sortie trop volumineuse, non partagée : ${dropped.join(", ")}]`;
    data["text/plain"] = data["text/plain"] ? `${data["text/plain"]}\n${note}` : note;
  }
  return { ...o, data };
}

/** The nbformat output a kernel event stands for (stream and control events have none here). */
export function outputFromEvent(ev: KernelEvent): NbOutput | null {
  switch (ev.ev) {
    case "display":
      return shrinkOutput({
        output_type: "display_data",
        data: cleanBundle(ev.data),
        metadata: isObj(ev.metadata) ? ev.metadata : {},
        ...(typeof ev.display_id === "string" && ev.display_id ? { transient: { display_id: ev.display_id.slice(0, 200) } } : {}),
      });
    case "result":
      return shrinkOutput({ output_type: "execute_result", execution_count: typeof ev.count === "number" ? ev.count : null, data: cleanBundle(ev.data), metadata: {} });
    case "error":
      return shrinkOutput({
        output_type: "error",
        ename: String(ev.ename ?? "").slice(0, 400),
        evalue: String(ev.evalue ?? "").slice(0, 20000),
        traceback: Array.isArray(ev.traceback) ? ev.traceback.map((l) => String(l).slice(0, 20000)).slice(0, 200) : [],
      });
    default:
      return null;
  }
}

/** Appends stream text to the outputs like Jupyter does: same stream, same output item (up to STREAM_CHUNK). */
function appendStream(outs: Y.Array<NbOutput>, name: "stdout" | "stderr", text: string) {
  while (text.length) {
    const lastIdx = outs.length - 1;
    const last = lastIdx >= 0 ? outs.get(lastIdx) : undefined;
    if (last && last.output_type === "stream" && last.name === name && typeof last.text === "string" && last.text.length < STREAM_CHUNK) {
      const room = cutAt(text, STREAM_CHUNK - last.text.length);
      if (room <= 0) break;
      outs.delete(lastIdx, 1);
      outs.insert(lastIdx, [{ ...last, text: last.text + text.slice(0, room) }]);
      text = text.slice(room);
    } else {
      const n = cutAt(text, STREAM_CHUNK);
      outs.push([{ output_type: "stream", name, text: text.slice(0, n) }]);
      text = text.slice(n);
    }
  }
}

/** Serialized size one event adds to the document (for batching: one update must stay small). */
export const eventWeight = (ev: KernelEvent): number =>
  ev.ev === "stream" ? ev.text.length + 64 : ev.ev === "display" || ev.ev === "result" || ev.ev === "update" ? jsonLen(ev.data) + 128 : ev.ev === "error" ? jsonLen(ev.traceback) + 256 : 32;

/** Where a run's events land: an output list and the marks of the run. A notebook cell and a code window each give one. */
export type RunSink = {
  outs: Y.Array<NbOutput>;
  /** The run is still the current one (not cancelled, not finalized by somebody else). */
  active(): boolean;
  /** `done`: record the count and end the run. */
  finish(count: number | null | undefined): void;
};

/**
 * Writes kernel events into a sink, in one transaction. Events for a run that is no longer the current one are
 * dropped. `done` records the count and ends the run. Returns true when a `done` was applied.
 */
export function applyEventsTo(ydoc: Y.Doc, sink: RunSink, events: KernelEvent[], st: WriteState): boolean {
  if (!sink.active()) return false;
  const outs = sink.outs;
  let finished = false;
  ydoc.transact(() => {
    const clear = () => {
      if (outs.length) outs.delete(0, outs.length);
      st.bytes = 0;
      st.textBytes = 0;
      st.truncated = false;
    };
    const note = "[sortie tronquée : limite atteinte pour cette cellule]\n";
    const room = (size: number) => {
      if (st.truncated) return false;
      if (st.bytes + size <= MAX_CELL_OUTPUT) return true;
      st.truncated = true;
      appendStream(outs, "stderr", note);
      return false;
    };
    for (const ev of events) {
      switch (ev.ev) {
        case "clear":
          if (ev.wait) st.clearPending = true;
          else clear();
          break;
        case "stream": {
          if (typeof ev.text !== "string" || !ev.text) break;
          if (st.clearPending) (st.clearPending = false), clear();
          if (st.truncated) break;
          const left = Math.max(0, Math.min(MAX_STREAM_TEXT - st.textBytes, MAX_CELL_OUTPUT - st.bytes));
          const text = ev.text.length > left ? ev.text.slice(0, cutAt(ev.text, left)) : ev.text;
          if (text) {
            st.textBytes += text.length;
            st.bytes += text.length;
            appendStream(outs, ev.name === "stderr" ? "stderr" : "stdout", text);
          }
          if (text.length < ev.text.length) {
            st.truncated = true;
            appendStream(outs, "stderr", note);
          }
          break;
        }
        case "display":
        case "result":
        case "error": {
          const o = outputFromEvent(ev);
          if (!o) break;
          if (st.clearPending) (st.clearPending = false), clear();
          const size = jsonLen(o);
          if (!room(size)) break;
          st.bytes += size;
          outs.push([o]);
          break;
        }
        case "update": {
          const o = outputFromEvent({ ev: "display", id: ev.id, data: ev.data, metadata: ev.metadata, display_id: ev.display_id });
          if (!o) break;
          for (let i = 0; i < outs.length; i++) {
            const cur = outs.get(i);
            if (cur?.transient?.display_id === ev.display_id) {
              outs.delete(i, 1);
              outs.insert(i, [o]);
            }
          }
          break;
        }
        case "done":
          sink.finish(typeof ev.count === "number" ? ev.count : undefined);
          finished = true;
          break;
      }
      if (finished) break;
    }
  });
  return finished;
}

/**
 * Writes kernel events into the cell running under `execId`, in one transaction. Events for a cell
 * that is not (or no longer) running under this id are dropped. `done` records the count and ends the
 * run. Returns true when a `done` was applied.
 */
export function applyKernelEvents(ydoc: Y.Doc, cellId: string, execId: string, events: KernelEvent[], st: WriteState): boolean {
  const c = findCell(ydoc, cellId);
  if (!c || c.running !== execId) return false;
  const outs = c.map.get("outputs") as Y.Array<NbOutput> | undefined;
  if (!(outs instanceof Y.Array)) return false;
  return applyEventsTo(
    ydoc,
    {
      outs,
      active: () => true,
      finish(count) {
        c.map.set("execution_count", count !== undefined ? count : (c.executionCount ?? null));
        c.map.delete("running");
      },
    },
    events,
    st,
  );
}

// ---- .ipynb import ---------------------------------------------------------------------------------------

export type ParsedCell = { id: string; type: CellType; source: string; outputs: NbOutput[]; executionCount: number | null; metadata: Record<string, unknown> };
export type ParsedNotebook = { cells: ParsedCell[]; metadata: Record<string, unknown>; minor: number; kernel?: string; warnings: string[] };

const joinText = (v: unknown): string | null => (typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join("") : null);
const isJsonMime = (k: string) => k === "application/json" || /\+json$/.test(k);

/** A MIME bundle from nbformat (string | string[] | JSON values) to the doc's string-only bundle. */
function importBundle(data: unknown): Bundle {
  const out: Bundle = {};
  if (!isObj(data)) return out;
  for (const [k, v] of Object.entries(data)) {
    if (!MIME_RE.test(k)) continue;
    const t = joinText(v);
    out[k] = t !== null ? t : JSON.stringify(v);
  }
  return out;
}

function importOutput(o: unknown, warnings: string[]): NbOutput | null {
  if (!isObj(o)) return null;
  switch (o.output_type) {
    case "stream": {
      const text = joinText(o.text);
      if (text === null) return null;
      return shrinkOutput({ output_type: "stream", name: o.name === "stderr" ? "stderr" : "stdout", text });
    }
    case "display_data":
      return shrinkOutput({ output_type: "display_data", data: importBundle(o.data), metadata: isObj(o.metadata) ? o.metadata : {} });
    case "execute_result":
      return shrinkOutput({
        output_type: "execute_result",
        execution_count: typeof o.execution_count === "number" ? o.execution_count : null,
        data: importBundle(o.data),
        metadata: isObj(o.metadata) ? o.metadata : {},
      });
    case "error":
      return shrinkOutput({
        output_type: "error",
        ename: typeof o.ename === "string" ? o.ename : "",
        evalue: typeof o.evalue === "string" ? o.evalue : "",
        traceback: Array.isArray(o.traceback) ? o.traceback.filter((l: unknown): l is string => typeof l === "string") : [],
      });
    default:
      warnings.push(`sortie de type inconnu ignorée (${String(o.output_type).slice(0, 40)})`);
      return null;
  }
}

/** Reads the text of an .ipynb (nbformat 4). Throws NotebookFormatError (French message) when it is not one. */
export function parseIpynb(text: string): ParsedNotebook {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new NotebookFormatError("Ce fichier n'est pas un notebook : JSON invalide");
  }
  if (!isObj(raw) || !Array.isArray(raw.cells)) throw new NotebookFormatError("Ce fichier n'est pas un notebook Jupyter (pas de liste de cellules)");
  if (raw.nbformat !== 4) throw new NotebookFormatError(`Seul le format nbformat 4 est pris en charge (ici : ${String(raw.nbformat ?? "inconnu")})`);
  if (raw.cells.length > MAX_CELLS) throw new NotebookFormatError(`Notebook trop grand : ${raw.cells.length} cellules (${MAX_CELLS} au maximum)`);
  const warnings: string[] = [];
  const used = new Set<string>();
  const cells: ParsedCell[] = [];
  let attachments = 0;
  raw.cells.forEach((c: unknown, i: number) => {
    if (!isObj(c) || (c.cell_type !== "code" && c.cell_type !== "markdown" && c.cell_type !== "raw")) {
      warnings.push(`cellule ${i + 1} ignorée (type inconnu)`);
      return;
    }
    const source = joinText(c.source);
    if (source === null) {
      warnings.push(`cellule ${i + 1} ignorée (source illisible)`);
      return;
    }
    if (isObj(c.attachments) && Object.keys(c.attachments).length) attachments++;
    const id = typeof c.id === "string" && ID_RE.test(c.id) && !used.has(c.id) ? c.id : uuid();
    used.add(id);
    const type: CellType = c.cell_type;
    const outputs = type === "code" && Array.isArray(c.outputs) ? c.outputs.map((o: unknown) => importOutput(o, warnings)).filter((o): o is NbOutput => !!o) : [];
    cells.push({
      id,
      type,
      source,
      outputs,
      executionCount: type === "code" && typeof c.execution_count === "number" ? c.execution_count : null,
      metadata: isObj(c.metadata) ? c.metadata : {},
    });
  });
  if (attachments) warnings.push(`${attachments} cellule${attachments > 1 ? "s" : ""} avec des pièces jointes : elles sont ignorées`);
  const metadata = isObj(raw.metadata) ? raw.metadata : {};
  const kernelName = isObj(metadata.kernelspec) && typeof metadata.kernelspec.name === "string" && KERNEL_RE.test(metadata.kernelspec.name) ? metadata.kernelspec.name : undefined;
  return {
    cells,
    metadata,
    minor: typeof raw.nbformat_minor === "number" && Number.isInteger(raw.nbformat_minor) && raw.nbformat_minor >= 0 ? raw.nbformat_minor : 0,
    ...(kernelName ? { kernel: kernelName } : {}),
    warnings,
  };
}

// ---- .ipynb export -----------------------------------------------------------------------------------------

/** Lines with their line ending, like Jupyter writes `source` and text outputs. */
export function splitLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** A copy with every object's keys sorted: Jupyter writes notebooks with sort_keys. */
export function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

const splitMime = (k: string) => k.startsWith("text/") || k === "application/javascript" || k === "image/svg+xml";

function exportBundle(data: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cleanBundle(data))) {
    if (isJsonMime(k)) {
      try {
        out[k] = JSON.parse(v);
        continue;
      } catch {
        /* not JSON after all: keep the text */
      }
    }
    out[k] = splitMime(k) ? splitLines(v) : v;
  }
  return out;
}

/** The outputs as nbformat wants them: transient dropped, consecutive streams of one name merged. */
function exportOutputs(outputs: NbOutput[]): NbOutput[] {
  const out: NbOutput[] = [];
  for (const o of outputs) {
    if (o.output_type === "stream") {
      const name = o.name === "stderr" ? "stderr" : "stdout";
      const prev = out[out.length - 1];
      if (prev && prev.output_type === "stream" && prev.name === name) prev.text += String(o.text ?? "");
      else out.push({ output_type: "stream", name, text: String(o.text ?? "") });
    } else if (o.output_type === "display_data") out.push({ output_type: "display_data", data: exportBundle(o.data), metadata: isObj(o.metadata) ? o.metadata : {} });
    else if (o.output_type === "execute_result")
      out.push({ output_type: "execute_result", execution_count: typeof o.execution_count === "number" ? o.execution_count : null, data: exportBundle(o.data), metadata: isObj(o.metadata) ? o.metadata : {} });
    else if (o.output_type === "error")
      out.push({ output_type: "error", ename: String(o.ename ?? ""), evalue: String(o.evalue ?? ""), traceback: Array.isArray(o.traceback) ? o.traceback.map(String) : [] });
  }
  return out.map((o) => (o.output_type === "stream" ? { ...o, text: splitLines(o.text) } : o));
}

/** The notebook as an .ipynb text: nbformat 4.5, sorted keys, one-space indent, trailing newline (like Jupyter). */
export function exportIpynb(ydoc: Y.Doc): string {
  const meta = metaOf(ydoc);
  const info = readMeta(meta);
  const stored = meta.get("nbMetadata");
  const metadata: Record<string, unknown> = isObj(stored) ? { ...stored } : {};
  const kernel = info.kernel ?? "python3";
  if (!isObj(metadata.kernelspec)) metadata.kernelspec = { display_name: kernel === "python3" ? "Python 3" : kernel, language: "python", name: kernel };
  if (!isObj(metadata.language_info)) metadata.language_info = { name: "python" };
  const cells = cellViews(ydoc).map((c) => {
    const base = { cell_type: c.type, id: c.id, metadata: c.metadata, source: splitLines(c.source.toString()) };
    return c.type === "code" ? { ...base, execution_count: c.executionCount, outputs: exportOutputs(c.outputs) } : base;
  });
  const nb = { cells, metadata, nbformat: 4, nbformat_minor: Math.max(info.nbformatMinor, NBFORMAT_MINOR) };
  return JSON.stringify(sortKeys(nb), null, 1) + "\n";
}

// ---- creating and filling documents ---------------------------------------------------------------------------

export type NotebookInit = { path?: string; name: string; text: string; sha: string; by?: string };

/** An empty document that was never initialised (two people opening the same new window can't both fill it). */
const isBlankDoc = (ydoc: Y.Doc) => cellsOf(ydoc).length === 0 && !metaOf(ydoc).has("name");

/** A new notebook: a name and one empty code cell. Same emptiness rule as initFromNotebook. */
export function initBlankNotebook(ydoc: Y.Doc, name = "sans-titre.ipynb"): boolean {
  if (!isBlankDoc(ydoc)) return false;
  const meta = metaOf(ydoc);
  ydoc.transact(() => {
    meta.set("name", name);
    meta.set("language", "python");
    meta.set("kernel", "python3");
    meta.set("nbformatMinor", NBFORMAT_MINOR);
    const id = uuid();
    cellsOf(ydoc).push([newCellMap({ type: "code", id })]);
    orderOf(ydoc).push([id]);
  });
  return true;
}

const cellWeight = (c: ParsedCell) => c.source.length + jsonLen(c.outputs) + 200;
const pause = () => new Promise<void>((r) => setTimeout(r, 70));

/**
 * Puts the content of a parsed notebook into the document. The cells go in batches of about 160 KiB
 * with a short pause between them: a shared document sends one update per pause, and an update
 * must stay under 380 KiB. `replace` empties the document first (reload from the machine).
 */
export async function fillNotebook(ydoc: Y.Doc, nb: ParsedNotebook, o: { name: string; path?: string; sha: string; by?: string; replace?: boolean; pause?: () => Promise<void> }): Promise<void> {
  const cells = cellsOf(ydoc);
  const order = orderOf(ydoc);
  const meta = metaOf(ydoc);
  const batches: ParsedCell[][] = [[]];
  let weight = 0;
  for (const c of nb.cells) {
    if (weight + cellWeight(c) > 160 * 1024 && batches[batches.length - 1].length) (batches.push([]), (weight = 0));
    batches[batches.length - 1].push(c);
    weight += cellWeight(c);
  }
  const wait = o.pause ?? pause;
  for (let b = 0; b < batches.length; b++) {
    ydoc.transact(() => {
      if (b === 0) {
        if (o.replace && cells.length) cells.delete(0, cells.length);
        if (o.replace && order.length) order.delete(0, order.length);
        if (o.path) meta.set("path", o.path);
        meta.set("name", o.name);
        meta.set("language", "python");
        meta.set("kernel", nb.kernel ?? "python3");
        meta.set("nbformatMinor", Math.max(nb.minor, NBFORMAT_MINOR));
        meta.set("nbMetadata", nb.metadata);
        meta.set("savedSha", o.sha);
        meta.set("savedAt", Date.now());
        if (o.by) meta.set("savedBy", o.by);
      }
      cells.push(batches[b].map((c) => newCellMap({ type: c.type, source: c.source, id: c.id, outputs: c.outputs, executionCount: c.executionCount, metadata: c.metadata })));
      order.push(batches[b].map((c) => c.id));
    });
    if (b < batches.length - 1) await wait();
  }
}

/** Fills a freshly opened, never initialised document with an .ipynb read from a machine. Returns whether it wrote. */
export async function initFromNotebook(ydoc: Y.Doc, init: NotebookInit): Promise<{ wrote: boolean; warnings: string[] }> {
  if (!isBlankDoc(ydoc)) return { wrote: false, warnings: [] };
  const nb = parseIpynb(init.text);
  await fillNotebook(ydoc, nb, { name: init.name, path: init.path, sha: init.sha, by: init.by });
  return { wrote: true, warnings: nb.warnings };
}

/** Records a successful write to the machine (and the path it landed on). */
export function markSaved(ydoc: Y.Doc, o: { path: string; sha: string; by?: string }) {
  const meta = metaOf(ydoc);
  ydoc.transact(() => {
    const name = o.path.slice(o.path.lastIndexOf("/") + 1);
    if (meta.get("path") !== o.path) meta.set("path", o.path);
    if (meta.get("name") !== name) meta.set("name", name);
    meta.set("savedSha", o.sha);
    meta.set("savedAt", Date.now());
    if (o.by) meta.set("savedBy", o.by);
  });
}

/** Documents about to be filled by a window that mounts a moment later. */
const pendingInit = new Map<string, NotebookInit | "blank">();
export const queueNotebookInit = (docId: string, init: NotebookInit | "blank") => void pendingInit.set(docId, init);
export function takeNotebookInit(docId: string): NotebookInit | "blank" | undefined {
  const v = pendingInit.get(docId);
  pendingInit.delete(docId);
  return v;
}

/** The folder of a notebook's path (for the kernel's working directory), or undefined when it is not absolute. */
export function kernelCwd(path: string | undefined): string | undefined {
  if (!path || !path.startsWith("/")) return undefined;
  const i = path.lastIndexOf("/");
  const dir = i <= 0 ? "/" : path.slice(0, i);
  return dir.length <= 512 && !/[\0\r\n]/.test(dir) ? dir : undefined;
}
