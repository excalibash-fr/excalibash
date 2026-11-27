// Public read-only links: `https://<instance>/v/<token>#<linkKey>`. The token is the server-side lookup id;
// the link key K_l only ever exists in the URL fragment, which browsers never send. The server stores
// the board key wrapped under K_l, so a holder of the whole URL can decrypt the board (and only that).
import { api, type Entry } from "./api.ts";
import { decryptEntry, decryptFile } from "./board/boardCrypto.ts";
import { AAD, box, boxText, fromB64, hex, newSymKey, randomBytes, symKey, toB64, unboxText, unwrapKey, type SymKey } from "./crypto.ts";

export type LinkInfo = { publicId: string; encLabel: string | null; createdAt: number; expiresAt: number | null; epoch: number; createdBy: string | null };
export type LinkView = Omit<LinkInfo, "encLabel"> & { label: string };

/** Offered lifetimes, in days (null: no expiration). */
export const LINK_LIFETIMES: { days: number | null; label: string }[] = [
  { days: 1, label: "1 jour" },
  { days: 7, label: "7 jours" },
  { days: 30, label: "30 jours" },
  { days: null, label: "Sans expiration" },
];

/** Creates a link for a board and returns its full URL (the only time the token is known). */
export async function createPublicLink(board: { id: string; key: SymKey; epoch: number; name: string }, label: string, days: number | null): Promise<string> {
  const linkKey = await newSymKey();
  const publicId = hex(randomBytes(8));
  const body = {
    publicId,
    epoch: board.epoch,
    wrappedKey: await box(linkKey, board.key.raw, AAD.link(board.id, board.epoch)),
    encLabel: label.trim() ? await boxText(board.key, label.trim(), AAD.linkLabel(board.id, publicId)) : undefined,
    encTitle: await boxText(board.key, board.name, AAD.linkTitle(board.id, publicId)),
    expiresAt: days === null ? undefined : Date.now() + days * 86_400_000,
  };
  const r = await api.post<{ publicId: string; token: string }>(`/items/${board.id}/links`, body);
  return `${location.origin}/v/${r.token}#${toB64(linkKey.raw)}`;
}

export async function listPublicLinks(boardId: string, key: SymKey): Promise<LinkView[]> {
  const rows = await api.get<LinkInfo[]>(`/items/${boardId}/links`);
  return Promise.all(
    rows.map(async ({ encLabel, ...r }) => ({
      ...r,
      label: encLabel ? await unboxText(key, encLabel, AAD.linkLabel(boardId, r.publicId)).catch(() => "⚠ illisible") : "",
    })),
  );
}

export const deletePublicLink = (boardId: string, publicId: string) => api.del(`/items/${boardId}/links/${publicId}`);

/** The link key from a URL fragment (without the #), or null when absent or malformed. */
export function linkKeyFromFragment(fragment: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(fragment)) return null;
  try {
    return fromB64(fragment);
  } catch {
    return null;
  }
}

// ---- Reading a public link (no account, no session) -----------------------------------

/** What GET /api/public/:token returns. */
export type PublicResponse = {
  boardId: string;
  publicId: string;
  epoch: number;
  wrappedKey: string;
  encTitle: string | null;
  updatedAt: number;
  elements: Entry[];
  files: Record<string, string>;
};

export type PublicScene = { title: string | null; elements: any[]; files: Record<string, any> };

/** Decrypted elements and files already seen, so a poll that changed one element decrypts only that one. */
export type PublicCache = { elements: Map<string, any>; files: Map<string, { c: string; file: any }> };
export const newPublicCache = (): PublicCache => ({ elements: new Map(), files: new Map() });

/** Terminal and site windows never appear in a public view, and node tiles lose their shells, sites and machine links. */
function publicElement(el: any): any | null {
  const cd = el?.customData;
  if (el?.isDeleted || cd?.terminalId || cd?.webId || cd?.codeId || cd?.notebookId) return null;
  if (cd?.node) {
    const { shells: _s, webs: _w, codes: _c, notebooks: _nb, machineId: _m, machineName: _n, remote: _r, ...rest } = cd;
    return { ...el, customData: rest };
  }
  return el;
}

/** Unwraps the board key with the link key from the URL fragment and decrypts the board for display. */
export async function decryptPublic(r: PublicResponse, linkKey: Uint8Array, cache: PublicCache = newPublicCache()): Promise<PublicScene> {
  const boardKey = await unwrapKey(await symKey(linkKey), r.wrappedKey, AAD.link(r.boardId, r.epoch));
  const title = r.encTitle ? await unboxText(boardKey, r.encTitle, AAD.linkTitle(r.boardId, r.publicId)).catch(() => null) : null;
  const seen = new Map<string, any>();
  const elements: any[] = [];
  for (const e of r.elements) {
    const k = `${e.id}:${e.v}:${e.n}:${e.c.length}:${e.c.slice(-16)}`;
    let el = cache.elements.get(k);
    if (!el) el = await decryptEntry(boardKey, r.boardId, e);
    seen.set(k, el);
    const shown = publicElement(el);
    if (shown) elements.push(shown);
  }
  cache.elements = seen;
  const files: Record<string, any> = {};
  const seenFiles = new Map<string, { c: string; file: any }>();
  for (const [fid, c] of Object.entries(r.files)) {
    const hit = cache.files.get(fid);
    const file = hit && hit.c === c ? hit.file : await decryptFile(boardKey, r.boardId, fid, c);
    seenFiles.set(fid, { c, file });
    files[fid] = file;
  }
  cache.files = seenFiles;
  return { title, elements, files };
}
