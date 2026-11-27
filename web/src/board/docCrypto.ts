// Shared documents at rest: what the server stores is ciphertext of Yjs updates and snapshots,
// boxed under the board key. This module re-encrypts a document for a key rotation.
import * as Y from "yjs";
import { AAD, box, fromB64, toB64, unbox, type SymKey } from "../crypto.ts";

/** A document as GET /items/:id/docs returns it. */
export type StoredDoc = { doc: string; epoch: number; snap: string | null; snapSeq: number; seq: number; ups: { seq: number; d: string }[] };
/** A document as the rotation sends it back: one fresh snapshot, valid up to `upto` (the last seq read). */
export type RotatedDoc = { doc: string; upto: number; d: string };

/**
 * Decrypts the snapshot and every update with the old key, merges them into one Yjs state and
 * boxes it as a snapshot under the new key and epoch. A part that fails to authenticate or to apply
 * is skipped and counted in `skipped`: aborting instead would let any editor (or the server) block
 * a revocation for good by posting one bad frame. Such parts are unreadable by every client anyway.
 */
export async function reencryptDoc(
  boardId: string,
  d: StoredDoc,
  oldKey: SymKey,
  newKey: SymKey,
  newEpoch: number,
): Promise<RotatedDoc & { skipped: number }> {
  const aad = AAD.doc(boardId, d.doc, d.epoch);
  const ydoc = new Y.Doc();
  let skipped = 0;
  const apply = async (c: string) => {
    try {
      Y.applyUpdate(ydoc, await unbox(oldKey, c, aad));
    } catch {
      skipped++;
    }
  };
  try {
    if (d.snap) await apply(d.snap);
    for (const u of d.ups) await apply(u.d);
    return { doc: d.doc, upto: d.seq, d: await box(newKey, Y.encodeStateAsUpdate(ydoc), AAD.doc(boardId, d.doc, newEpoch)), skipped };
  } finally {
    ydoc.destroy();
  }
}

/**
 * What a duplicate must not inherit from the source: the kernel session of the notebook (a terminal of the
 * source board, whose key the copy does not have) and the "running" marks of cells and code runs, whose
 * executors do not exist in the copy. Pure edits of a merged state.
 */
export function clearLiveState(ydoc: Y.Doc) {
  ydoc.transact(() => {
    const meta = ydoc.getMap("meta");
    meta.delete("kernelTerm");
    meta.delete("running");
    const cells = ydoc.getArray("cells");
    cells.forEach((c) => {
      if (c instanceof Y.Map && c.has("running")) c.delete("running");
    });
  });
}

/**
 * A document of another board, for a duplicate: decrypts it with the source board's key, merges snapshot and
 * updates, drops the live kernel references and returns the plaintext Yjs state. The document id stays the
 * same (the scene of the copy refers to it): ids are only unique per board. An update that fails to
 * authenticate aborts the copy rather than silently dropping part of a document.
 */
export async function copyDocState(d: StoredDoc, from: { boardId: string; key: SymKey }): Promise<{ doc: string; state: Uint8Array }> {
  const aad = AAD.doc(from.boardId, d.doc, d.epoch);
  const ydoc = new Y.Doc();
  try {
    if (d.snap) Y.applyUpdate(ydoc, await unbox(from.key, d.snap, aad));
    for (const u of d.ups) Y.applyUpdate(ydoc, await unbox(from.key, u.d, aad));
    clearLiveState(ydoc);
    return { doc: d.doc, state: Y.encodeStateAsUpdate(ydoc) };
  } finally {
    ydoc.destroy();
  }
}

/** Boxes a document state as the first snapshot of a (new) board: its key, its id, its epoch. */
export const sealDoc = async (doc: string, state: Uint8Array, to: { boardId: string; key: SymKey; epoch: number }): Promise<{ doc: string; d: string }> => ({
  doc,
  d: await box(to.key, state, AAD.doc(to.boardId, doc, to.epoch)),
});

/** The ids of the code and notebook documents a scene refers to (node entries, read defensively). */
export function sceneDocIds(elements: { isDeleted?: boolean; customData?: any }[]): string[] {
  const ids = new Set<string>();
  for (const el of elements) {
    const cd = el?.customData;
    if (el?.isDeleted || !cd?.node) continue;
    for (const list of [cd.codes, cd.notebooks]) {
      if (!Array.isArray(list)) continue;
      for (const r of list) if (r && typeof r.docId === "string" && /^[A-Za-z0-9_-]{22}$/.test(r.docId)) ids.add(r.docId);
    }
  }
  return [...ids];
}

/** Base64url helpers re-exported for callers that handle raw updates (tests, tools). */
export { fromB64, toB64 };
