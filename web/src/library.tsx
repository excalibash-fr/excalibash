// The user's decrypted view of folders and boards, and every operation that has to
// (re)encrypt something: create, rename, move, share, revoke (key rotation), duplicate.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Entry, type RawGrant, type RawItem, type Role, type User } from "./api.ts";
import { useKeys, useUser } from "./auth.tsx";
import {
  AAD,
  boxText,
  fromB64,
  newSymKey,
  randomId,
  sealKey,
  unboxText,
  unsealKey,
  unwrapKey,
  wrapKey,
  box,
  boxJson,
  toB64,
  unboxJson,
  type KeyPair,
  type SymKey,
} from "./crypto.ts";
import { checkContact, listMachines, loadPlacements, pinContact, setPlacement as savePlacement } from "./vault.ts";
import { decryptEntry, decryptFile, encryptEntry, encryptPreview, reencryptFile } from "./board/boardCrypto.ts";
import { copyDocState, reencryptDoc, sceneDocIds, sealDoc, type StoredDoc } from "./board/docCrypto.ts";

export type Node = Omit<RawItem, "encName" | "keyWrap"> & {
  name: string;
  key: SymKey | null;
  role: Role;
  /** Reached through a grant on this very item. */
  direct: boolean;
  /** Its parent is not visible to us: a top-level entry (own root or shared with us). */
  root: boolean;
  grantedBy: string | null;
};

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export async function decryptTree(user: User, keys: KeyPair, items: RawItem[], grants: RawGrant[]): Promise<Map<string, Node>> {
  const raw = new Map(items.map((i) => [i.id, i]));
  const grantOf = new Map(grants.map((g) => [g.itemId, g]));
  const out = new Map<string, Node>();
  const pending = new Map<string, Promise<Node>>();

  const resolve = (id: string): Promise<Node> => {
    let p = pending.get(id);
    if (p) return p;
    p = (async () => {
      const it = raw.get(id)!;
      const grant = grantOf.get(id);
      const parent = it.parentId && raw.has(it.parentId) ? await resolve(it.parentId) : null;
      let key: SymKey | null = null;
      try {
        // An editor can move an item and write its wrap: a bad one must not hide a valid grant.
        const wrapped = parent?.key && it.keyWrap ? await unwrapKey(parent.key, it.keyWrap, AAD.wrap(id, it.parentId!)).catch(() => null) : null;
        // A grant is sealed anonymously: the server could add one under a key of its own. When the
        // parent's wrap (which the server can't forge) also gives the key, both must agree.
        const granted = grant ? await unsealKey(keys, grant.wrappedKey, AAD.grant(id, user.id)).catch(() => null) : null;
        if (granted && wrapped && !sameBytes(granted.raw, wrapped.raw)) {
          console.warn("[excalibash] clé d'accès contredite par celle du dossier parent : ignorée", id);
          key = wrapped;
        } else key = wrapped ?? granted;
      } catch {
        key = null;
      }
      let name = "⚠ illisible";
      if (key) name = await unboxText(key, it.encName, AAD.name(id)).catch(() => "⚠ illisible");
      let role: Role = grant?.role ?? parent?.role ?? "viewer";
      if (grant && parent && RANK[parent.role] > RANK[grant.role]) role = parent.role;
      const { encName: _n, keyWrap: _k, ...rest } = it;
      const node: Node = { ...rest, name, key, role, direct: !!grant, root: !parent, grantedBy: grant?.grantedBy ?? null };
      out.set(id, node);
      return node;
    })();
    pending.set(id, p);
    return p;
  };

  await Promise.all(items.map((i) => resolve(i.id)));
  return out;
}

// ---- Context ---------------------------------------------------------------------------

type Library = {
  nodes: Map<string, Node>;
  loading: boolean;
  refresh: () => Promise<void>;
  /** My private filing of shared items into my own folders (see vault.ts). */
  placements: Record<string, string | null>;
  place: (itemId: string, folderId: string | null) => Promise<void>;
};

const LibraryContext = createContext<Library>({ nodes: new Map(), loading: true, refresh: async () => {}, placements: {}, place: async () => {} });

export function LibraryProvider({ children }: { children: ReactNode }) {
  const user = useUser();
  const keys = useKeys();
  const [nodes, setNodes] = useState<Map<string, Node>>(new Map());
  const [placements, setPlacements] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const r = await api.get<{ items: RawItem[]; grants: RawGrant[] }>("/tree");
    setNodes(await decryptTree(user, keys, r.items, r.grants));
    setPlacements(await loadPlacements(user, keys).catch(() => ({})));
    setLoading(false);
  }, [user, keys]);

  const place = useCallback(
    async (itemId: string, folderId: string | null) => {
      await savePlacement(user, keys, itemId, folderId);
      setPlacements(await loadPlacements(user, keys));
    },
    [user, keys],
  );

  useEffect(() => {
    refresh().catch((e) => {
      console.error(e);
      setLoading(false);
    });
  }, [refresh]);

  const value = useMemo(() => ({ nodes, loading, refresh, placements, place }), [nodes, loading, refresh, placements, place]);
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export const useLibrary = () => useContext(LibraryContext);

/** Children of a folder (or top-level own items for null), trash excluded. */
export function childrenOf(nodes: Map<string, Node>, parentId: string | null, userId: string): Node[] {
  return [...nodes.values()].filter((n) =>
    parentId === null ? n.root && n.ownerId === userId && n.role === "owner" && !n.deletedAt : n.parentId === parentId && !n.deletedAt,
  );
}

/** Something shared with me (a share or anything inside one): I can only link it into my own folders. */
export const isShared = (n: Node, userId: string) => n.ownerId !== userId;

/** Placement value for the top of "Mes fichiers". */
export const MY_ROOT = "~";

/**
 * Links to shared items I filed in my own folders, by item id -> folder id (null: top of "Mes fichiers").
 * A link whose folder is gone or trashed, or whose item is no longer reachable, is ignored.
 */
export function placedShares(nodes: Map<string, Node>, placements: Record<string, string | null>, userId: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const [id, folderId] of Object.entries(placements)) {
    const n = nodes.get(id);
    if (!n || !isShared(n, userId) || isInTrash(nodes, n)) continue;
    if (folderId === MY_ROOT) {
      out.set(id, null);
      continue;
    }
    const f = folderId ? nodes.get(folderId) : undefined;
    if (!f || f.kind !== "folder" || f.ownerId !== userId || isInTrash(nodes, f)) continue;
    out.set(id, f.id);
  }
  return out;
}

export function isInTrash(nodes: Map<string, Node>, n: Node): boolean {
  for (let cur: Node | undefined = n, d = 0; cur && d < 128; cur = cur.parentId ? nodes.get(cur.parentId) : undefined, d++) {
    if (cur.deletedAt) return true;
  }
  return false;
}

export function pathOf(nodes: Map<string, Node>, id: string): Node[] {
  const path: Node[] = [];
  for (let cur = nodes.get(id), d = 0; cur && d < 128; cur = cur.parentId ? nodes.get(cur.parentId) : undefined, d++) path.unshift(cur);
  return path;
}

export const sortNodes = (list: Node[], sort: string) =>
  [...list].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    if (sort === "name") return a.name.localeCompare(b.name, "fr", { sensitivity: "base" });
    if (sort === "created") return b.createdAt - a.createdAt;
    return b.updatedAt - a.updatedAt;
  });

// ---- Operations ------------------------------------------------------------------------

type Ctx = { user: User; keys: KeyPair; nodes: Map<string, Node> };

function keyOf(ctx: Ctx, id: string): SymKey {
  const k = ctx.nodes.get(id)?.key;
  if (!k) throw new Error("Clé indisponible pour cet élément");
  return k;
}

/** Placement of a new/moved item under `parentId`, or at the user's root. */
async function placement(ctx: Ctx, id: string, key: SymKey, parentId: string | null) {
  if (parentId) return { parentId, keyWrap: await wrapKey(keyOf(ctx, parentId), key, AAD.wrap(id, parentId)) };
  return { parentId: null, ownerKey: await sealKey(ctx.keys.pub, key, AAD.grant(id, ctx.user.id)) };
}

/** `docs`: shared documents (code, notebooks) as plaintext Yjs states, sealed under the new board's key at creation. */
export type BoardContent = { elements: any[]; files: Record<string, any>; preview?: string | null; docs?: { doc: string; state: Uint8Array }[] };

export async function createItem(ctx: Ctx, kind: "folder" | "board", parentId: string | null, name: string, content?: BoardContent): Promise<string> {
  const id = randomId();
  const key = await newSymKey();
  const board = content
    ? {
        elements: await Promise.all(content.elements.filter((e) => !e.customData?.terminalId).map((e) => encryptEntry(key, id, e))),
        files: Object.fromEntries(
          await Promise.all(Object.entries(content.files ?? {}).map(async ([fid, f]) => [fid, await reencryptFile(null, key, id, fid, f)])),
        ),
        preview: content.preview ? await encryptPreview(key, id, content.preview) : undefined,
        // Epoch 0: the key of a new board is its first generation.
        docs: content.docs?.length ? await Promise.all(content.docs.map((d) => sealDoc(d.doc, d.state, { boardId: id, key, epoch: 0 }))) : undefined,
      }
    : undefined;
  await api.post("/items", { id, kind, encName: await boxText(key, name, AAD.name(id)), ...(await placement(ctx, id, key, parentId)), board });
  return id;
}

export async function renameItem(ctx: Ctx, id: string, name: string) {
  const key = keyOf(ctx, id);
  await api.patch(`/items/${id}`, { encName: await boxText(key, name, AAD.name(id)) });
}

export async function moveItem(ctx: Ctx, id: string, parentId: string | null) {
  await api.post(`/items/${id}/move`, await placement(ctx, id, keyOf(ctx, id), parentId));
}

export async function fetchBoardContent(key: SymKey, boardId: string): Promise<BoardContent> {
  const c = await api.get<{ elements: Entry[]; files: Record<string, string> }>(`/items/${boardId}/content`);
  const elements = await Promise.all(c.elements.map((e) => decryptEntry(key, boardId, e)));
  const files: Record<string, any> = {};
  for (const [fid, data] of Object.entries(c.files)) files[fid] = await decryptFile(key, boardId, fid, data);
  return { elements, files };
}

export type VersionInfo = { id: number; createdAt: number; count: number; epoch: number };

export const fetchVersions = (boardId: string) => api.get<VersionInfo[]>(`/items/${boardId}/versions`);

/** One history version, decrypted here. Only the images the scene actually shows are decrypted. */
export async function fetchVersionContent(key: SymKey, boardId: string, versionId: number): Promise<BoardContent> {
  const c = await api.get<{ elements: Entry[]; files: Record<string, string> }>(`/items/${boardId}/versions/${versionId}`);
  const elements = await Promise.all(c.elements.map((e) => decryptEntry(key, boardId, e)));
  const files: Record<string, any> = {};
  for (const el of elements) {
    const fid = el.type === "image" && !el.isDeleted ? el.fileId : null;
    if (fid && c.files[fid] && !files[fid]) files[fid] = await decryptFile(key, boardId, fid, c.files[fid]);
  }
  return { elements, files };
}

/**
 * The shared documents (code, notebooks) the scene of a board refers to, decrypted with its key and cleaned of
 * live kernel references, ready to be sealed under another board's key.
 */
export async function fetchBoardDocs(key: SymKey, boardId: string, elements: any[]): Promise<{ doc: string; state: Uint8Array }[]> {
  const wanted = new Set(sceneDocIds(elements));
  if (!wanted.size) return [];
  const stored = await api.get<StoredDoc[]>(`/items/${boardId}/docs`);
  return Promise.all(stored.filter((d) => wanted.has(d.doc)).map((d) => copyDocState(d, { boardId, key })));
}

export async function duplicateBoard(ctx: Ctx, id: string): Promise<string> {
  const node = ctx.nodes.get(id)!;
  const content = await fetchBoardContent(keyOf(ctx, id), id);
  content.preview = await fetchPreview(keyOf(ctx, id), id).catch(() => null);
  // The copy gets its own documents: same ids, re-sealed under its own key (the old key can't read them).
  content.docs = await fetchBoardDocs(keyOf(ctx, id), id, content.elements);
  const parent = node.parentId && ctx.nodes.get(node.parentId);
  const target = parent && RANK[parent.role] >= RANK.editor ? parent.id : null;
  return createItem(ctx, "board", target, `${node.name} (copie)`, content);
}

export async function fetchPreview(key: SymKey, boardId: string): Promise<string | null> {
  const r = await api.get<{ preview: string | null }>(`/items/${boardId}/preview`);
  return r.preview ? unboxText(key, r.preview, AAD.preview(boardId)) : null;
}

// ---- Sharing ---------------------------------------------------------------------------

export type Member = { userId: string; role: Role; name: string; email: string; publicKey: string; color: string };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Seals the item key for someone. A key that differs from the one pinned for that person
 * (or that email) is refused unless the user explicitly verified the new fingerprint.
 * `existing`: the person already has access (role change), so their key must already be pinned.
 */
export async function shareItem(ctx: Ctx, id: string, target: { id: string; email: string; publicKey: string }, role: Role, verifiedChange = false, existing = false) {
  const check = verifiedChange ? "match" : await checkContact(ctx.user, ctx.keys, target.id, target.email, target.publicKey);
  if (check === "changed" || (existing && check === "new")) {
    throw new Error(`La clé de ${target.email} a changé ou n'est pas connue de ce navigateur : vérifie son empreinte avant de continuer.`);
  }
  const wrappedKey = await sealKey(fromB64(target.publicKey), keyOf(ctx, id), AAD.grant(id, target.id));
  await api.put(`/items/${id}/grants/${target.id}`, { role, wrappedKey });
  await pinContact(ctx.user, ctx.keys, target.id, target.email, target.publicKey);
}

export { checkContact };

type RotationSnapshot = {
  snapshotAt: number;
  items: { id: string; kind: string; parentId: string | null; encName: string; keyWrap: string | null; epoch: number }[];
  boards: { id: string; elements: Entry[]; files: Record<string, string>; preview: string | null }[];
  terminals: { id: string; boardId: string; machineId: string; machineOwnerId: string | null; keyForBoard: string; encLabel: string }[];
  webs?: { id: string; boardId: string; machineId: string; machineOwnerId: string | null; keyForBoard: string; encLabel: string }[];
  grants: { itemId: string; userId: string; role: Role; email: string; publicKey: string }[];
};

/**
 * Revokes access and rotates every key below `rootId`: names, wraps, elements, files,
 * previews, grants and terminal keys are all re-encrypted under fresh keys. Resolves to the number
 * of shared-document parts that could not be read and were left out (see reencryptDoc).
 */
export async function revokeAccess(ctx: Ctx, rootId: string, userId: string, onProgress?: (msg: string) => void): Promise<{ skippedDocParts: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let skipped = 0;
    onProgress?.("Récupération du contenu chiffré…");
    const snap = await api.get<RotationSnapshot>(`/items/${rootId}/rotation`);
    const root = snap.items.find((i) => i.id === rootId)!;

    // Old keys, re-derived from the snapshot itself (not from a possibly stale cache).
    const oldKeys = new Map<string, SymKey>([[rootId, keyOf(ctx, rootId)]]);
    const children = new Map<string, typeof snap.items>();
    for (const i of snap.items) if (i.parentId) children.set(i.parentId, [...(children.get(i.parentId) ?? []), i]);
    const queue = [rootId];
    while (queue.length) {
      const pid = queue.shift()!;
      for (const c of children.get(pid) ?? []) {
        if (!oldKeys.has(c.id)) oldKeys.set(c.id, await unwrapKey(oldKeys.get(pid)!, c.keyWrap!, AAD.wrap(c.id, pid)));
        queue.push(c.id);
      }
    }
    const newKeys = new Map<string, SymKey>();
    for (const id of oldKeys.keys()) newKeys.set(id, await newSymKey());

    onProgress?.("Re-chiffrement des noms et des clés…");
    const items = await Promise.all(
      snap.items.map(async (i) => {
        const name = await unboxText(oldKeys.get(i.id)!, i.encName, AAD.name(i.id));
        let keyWrap: string | null = null;
        if (i.id === rootId) {
          if (root.parentId) keyWrap = await wrapKey(keyOf(ctx, root.parentId), newKeys.get(i.id)!, AAD.wrap(i.id, root.parentId));
        } else {
          keyWrap = await wrapKey(newKeys.get(i.parentId!)!, newKeys.get(i.id)!, AAD.wrap(i.id, i.parentId!));
        }
        return { id: i.id, encName: await boxText(newKeys.get(i.id)!, name, AAD.name(i.id)), keyWrap };
      }),
    );

    onProgress?.(`Re-chiffrement de ${snap.boards.length} tableau(x)…`);
    const boards = await Promise.all(
      snap.boards.map(async (b) => {
        const ok = oldKeys.get(b.id)!;
        const nk = newKeys.get(b.id)!;
        const elements = await Promise.all(b.elements.map(async (e) => encryptEntry(nk, b.id, await decryptEntry(ok, b.id, e))));
        const files: Record<string, string> = {};
        for (const [fid, c] of Object.entries(b.files)) files[fid] = await reencryptFile(ok, nk, b.id, fid, c);
        const preview = b.preview ? await boxText(nk, await unboxText(ok, b.preview, AAD.preview(b.id)), AAD.preview(b.id)) : null;
        // Shared documents (code, notebooks) are merged and re-encrypted as one snapshot each, never dropped.
        // The server refuses the rotation if one of them was written since (409: we start over).
        const stored = await api.get<StoredDoc[]>(`/items/${b.id}/docs`);
        const epoch = snap.items.find((i) => i.id === b.id)!.epoch + 1;
        // Unreadable parts are left out rather than blocking the revocation (counted, reported below).
        const docs = await Promise.all(
          stored.map(async (d) => {
            const { skipped: n, ...r } = await reencryptDoc(b.id, d, ok, nk, epoch);
            skipped += n;
            return r;
          }),
        );
        return { id: b.id, elements, files, preview, docs };
      }),
    );

    if (skipped) {
      console.warn("[excalibash] rotation: parts of shared documents could not be read and were left out", skipped);
      onProgress?.(`${skipped} fragment(s) de document illisible(s) ignoré(s)…`);
    }
    onProgress?.("Nouvelles clés pour les membres restants…");
    const grants = [];
    for (const g of snap.grants) {
      if (g.itemId === rootId && g.userId === userId) continue;
      // New keys only go to keys we pinned when sharing: a member (or key) slipped in by the server gets nothing.
      if (g.userId !== ctx.user.id && (await checkContact(ctx.user, ctx.keys, g.userId, g.email, g.publicKey)) !== "match") {
        throw new Error(`Clé non vérifiée pour ${g.email} : rotation annulée par sécurité.`);
      }
      const pub = g.userId === ctx.user.id ? ctx.keys.pub : fromB64(g.publicKey);
      grants.push({ itemId: g.itemId, userId: g.userId, wrappedKey: await sealKey(pub, newKeys.get(g.itemId)!, AAD.grant(g.itemId, g.userId)) });
    }

    // Terminals on machines whose auth key we hold (ours, or shared with us directly) get a fresh
    // key; the others are closed by the server.
    const machines = new Map((await listMachines(ctx.keys)).filter((m) => m.access !== "board").map((m) => [m.id, m]));
    const terminals = [];
    for (const t of snap.terminals) {
      const m = machines.get(t.machineId);
      if (!m) continue;
      const label = await unboxText(oldKeys.get(t.boardId)!, t.encLabel, AAD.termLabel(t.boardId, t.id)).catch(() => m.name);
      const kt = await newSymKey();
      const nk = newKeys.get(t.boardId)!;
      terminals.push({
        id: t.id,
        keyForBoard: await wrapKey(nk, kt, AAD.termKey(t.boardId, t.id)),
        keyForAgent: await box(m.auth, kt.raw, AAD.termAgent(t.id)),
        encLabel: await boxText(nk, label, AAD.termLabel(t.boardId, t.id)),
      });
    }

    // Web tunnels on our machines too (their target is in the board-encrypted label).
    const webs = [];
    for (const w of snap.webs ?? []) {
      const m = machines.get(w.machineId);
      if (!m) continue;
      const target = await unboxJson<{ url: string; insecure: boolean; machine: string }>(oldKeys.get(w.boardId)!, w.encLabel, AAD.webLabel(w.boardId, w.id)).catch(() => null);
      if (!target) continue;
      const kw = await newSymKey();
      const nk = newKeys.get(w.boardId)!;
      webs.push({
        id: w.id,
        keyForBoard: await wrapKey(nk, kw, AAD.webKey(w.boardId, w.id)),
        keyForAgent: await boxJson(m.auth, { k: toB64(kw.raw), url: target.url, insecure: target.insecure }, AAD.webAgent(w.id)),
        encLabel: await boxJson(nk, target, AAD.webLabel(w.boardId, w.id)),
      });
    }

    onProgress?.("Envoi…");
    try {
      await api.post(`/items/${rootId}/revoke`, { userId, snapshotAt: snap.snapshotAt, items, boards, grants, terminals, webs });
      return { skippedDocParts: skipped };
    } catch (e: any) {
      if (e?.status !== 409 || attempt === 2) throw e;
    }
  }
  throw new Error("Rotation impossible");
}

export function useLibraryCtx(): Ctx {
  const user = useUser();
  const keys = useKeys();
  const { nodes } = useLibrary();
  return { user, keys, nodes };
}

