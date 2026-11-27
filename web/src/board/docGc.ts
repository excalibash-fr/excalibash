// Garbage collection of shared documents: when a code or notebook window is removed for good (its
// icon deleted, or the window closed, not merely hidden), the editor who did it asks the server to
// delete the document (`doc.del`). A notebook also ends its kernel session. Deletion is permanent,
// so it is delayed (undo must still find the document) and skipped while anything in the scene
// still points at the document (a duplicated or pasted node shares the docIds of the original).
import { DOC_ID_RE } from "./nodeData.ts";
import { kernelTermOf } from "./notebookDoc.ts";
import { openSharedDoc, type DocHost } from "./sharedDoc.ts";

export type DocRef = { doc: string; notebook: boolean };

/** The document ids of a node's `codes` / `notebooks` list (board data: read defensively). */
export function docIds(list: unknown, notebook: boolean): DocRef[] {
  if (!Array.isArray(list)) return [];
  const out: DocRef[] = [];
  for (const r of list) {
    const doc = r && typeof r === "object" ? (r as { docId?: unknown }).docId : undefined;
    if (typeof doc === "string" && DOC_ID_RE.test(doc) && !out.some((o) => o.doc === doc)) out.push({ doc, notebook });
  }
  return out;
}

/** What discarding needs from the board session (BoardSession implements it). */
export type GcHost = DocHost & {
  docDelete(doc: string): boolean;
  /** True while a live (non-deleted) element of the scene refers to the document, or when unsure. */
  docReferenced(doc: string): boolean;
  closeTerminal(id: string): void;
  terminals: Map<string, { label: string }>;
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Long enough for an undo (or a peer's paste of a copy) to bring a reference back. */
export const DISCARD_DELAY = 45_000;

/**
 * Deletes the documents on the server, after `graceMs`, unless the scene refers to them again by
 * then. A notebook's kernel session (named by its metadata) is closed first, only if it really is a
 * kernel session. The deletion then waits a moment so that the window that was showing the document
 * has let go of it and sends nothing more.
 */
export async function discardDocs(host: GcHost, refs: DocRef[], graceMs = DISCARD_DELAY, delayMs = 1000): Promise<void> {
  if (!host.canEdit || !refs.length) return;
  await wait(graceMs);
  refs = refs.filter((r) => !host.docReferenced(r.doc));
  for (const ref of refs) {
    try {
      // A notebook and a code window run on a kernel session kept in their metadata: end it with the document.
      const d = openSharedDoc(host, ref.doc);
      try {
        const synced = await Promise.race([d.synced.then(() => true), wait(4000).then(() => false)]);
        const term = synced ? kernelTermOf(d.ydoc) : null;
        if (term && host.terminals.get(term)?.label.startsWith("Noyau Jupyter ")) host.closeTerminal(term);
      } finally {
        d.destroy();
      }
    } catch (e) {
      console.error("[excalibash]", e);
    }
  }
  if (!refs.length) return;
  await wait(delayMs);
  // Checked again: the kernel lookup above took time.
  for (const ref of refs) if (!host.docReferenced(ref.doc)) host.docDelete(ref.doc);
}
