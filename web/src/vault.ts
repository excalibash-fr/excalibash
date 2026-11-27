// Per-user encrypted records the server cannot forge: pinned contact keys (TOFU) and
// the public keys of the user's own machines.
import { api, type RawMachine, type RawSharedMachine, type User } from "./api.ts";
import {
  AAD,
  box,
  boxText,
  fingerprint,
  fromB64,
  fromUtf8,
  generateKeyPair,
  machineAuthKey,
  pairTag,
  randomBytes,
  randomId,
  seal,
  symKey,
  toB64,
  unbox,
  unboxJson,
  unboxText,
  unseal,
  utf8,
  boxJson,
  vaultKey,
  type KeyPair,
  type SymKey,
} from "./crypto.ts";
import { readJson, removeStorage, writeStorage } from "./storage.ts";

/** Pinned public keys of the people we shared with, by account id and by email. */
type VaultData = { contacts: Record<string, string>; emails?: Record<string, string>; placements?: Record<string, string | null> };

let cache: { userId: string; data: VaultData } | null = null;

async function load(user: User, keys: KeyPair): Promise<VaultData> {
  if (cache?.userId === user.id) return cache.data;
  const r = await api.get<{ encVault: string | null }>("/auth/me");
  let data: VaultData = { contacts: {}, emails: {} };
  if (r.encVault) data = await unboxJson<VaultData>(await vaultKey(keys), r.encVault, AAD.vault(user.id));
  cache = { userId: user.id, data };
  return data;
}

async function save(user: User, keys: KeyPair, data: VaultData) {
  await api.put("/auth/vault", { encVault: await boxJson(await vaultKey(keys), data, AAD.vault(user.id)) });
  cache = { userId: user.id, data };
}

export type KeyCheck = "new" | "match" | "changed";

/**
 * Compares a contact's public key with the one pinned the first time we shared with them.
 * Pinning by email too catches an account deleted and re-created under the same address.
 */
export async function checkContact(user: User, keys: KeyPair, contactId: string, email: string | undefined, publicKey: string): Promise<KeyCheck> {
  const data = await load(user, keys);
  const byId = data.contacts[contactId];
  // The email is optional (a person found by name may not show it): then only the account id is checked.
  const byEmail = email ? data.emails?.[email.toLowerCase()] : undefined;
  if ((byId && byId !== publicKey) || (byEmail && byEmail !== publicKey)) return "changed";
  return byId || byEmail ? "match" : "new";
}

export async function pinContact(user: User, keys: KeyPair, contactId: string, email: string | undefined, publicKey: string) {
  const data = await load(user, keys);
  const e = email?.toLowerCase();
  if (data.contacts[contactId] === publicKey && (!e || data.emails?.[e] === publicKey)) return;
  await save(user, keys, { ...data, contacts: { ...data.contacts, [contactId]: publicKey }, emails: e ? { ...data.emails, [e]: publicKey } : data.emails });
}

// ---- Machines ----------------------------------------------------------------------

/**
 * A machine the user can open shells and sites on. `access`: "owner" (theirs), "shared" (shared
 * with them directly), "board" (linked by its owner to the board being viewed).
 */
export type Machine = Omit<RawMachine, "encName" | "encPub" | "encAuth" | "shareBoards"> & {
  name: string;
  pub: Uint8Array;
  auth: SymKey;
  fingerprint: string;
  access: "owner" | "shared" | "board";
  /** Owner only: editors of the boards it is used on can use it too. */
  shareBoards?: boolean;
  /** Someone else's machine: whose. */
  ownerId?: string;
  ownerName?: string;
};

const machineNameAad = AAD.machineName;

/** What a share or a board link carries: everything needed to use the machine. */
type MachineKeys = { auth: string; name: string; pub: string };
const machineKeys = (m: Machine): MachineKeys => ({ auth: toB64(m.auth.raw), name: m.name, pub: toB64(m.pub) });

async function fromKeys(raw: RawSharedMachine, k: MachineKeys, access: "shared" | "board"): Promise<Machine> {
  const pub = fromB64(k.pub);
  const auth = await symKey(fromB64(k.auth));
  if (pub.length !== 32 || auth.raw.length !== 32 || typeof k.name !== "string") throw new Error("clés de machine invalides");
  const { key: _k, ...rest } = raw;
  return { ...rest, name: k.name.slice(0, 200), pub, auth, fingerprint: await fingerprint(pub), access };
}

/** The board being viewed, whose linked machines are offered too (set by the board page). */
let currentBoard: { id: string; key: SymKey } | null = null;
export const setMachineBoard = (b: { id: string; key: SymKey } | null) => void (currentBoard = b);

/**
 * The user's machines, then those shared with them, then (on a board) those linked to it by an
 * editor who owns them. A machine reachable several ways is listed once, under the first.
 */
export async function listMachines(keys: KeyPair): Promise<Machine[]> {
  const vk = await vaultKey(keys);
  const board = currentBoard;
  const [{ machines, shared }, links] = await Promise.all([
    api.get<{ machines: RawMachine[]; shared?: RawSharedMachine[] }>("/machines"),
    board ? api.get<{ links: RawSharedMachine[] }>(`/machines/links?board=${encodeURIComponent(board.id)}`).then((r) => r.links, () => []) : Promise.resolve([]),
  ]);
  const out: Machine[] = [];
  for (const m of machines) {
    try {
      const pub = await unbox(vk, m.encPub, AAD.machine(m.id));
      const auth = await symKey(await unbox(vk, m.encAuth, AAD.machineAuth(m.id)));
      const { encName: _n, encPub: _p, encAuth: _a, ...rest } = m;
      out.push({ ...rest, name: await unboxText(vk, m.encName, machineNameAad(m.id)), pub, auth, fingerprint: await fingerprint(pub), access: "owner" });
    } catch {
      // Not signed by our vault key: refuse to use it rather than trust the server.
      console.warn("[excalibash] machine ignorée : enregistrement non authentique", m.id);
    }
  }
  for (const m of shared ?? []) {
    if (out.some((x) => x.id === m.id)) continue;
    try {
      out.push(await fromKeys(m, JSON.parse(fromUtf8(await unseal(keys, m.key, AAD.machineShare(m.id)))), "shared"));
    } catch {
      console.warn("[excalibash] machine partagée ignorée : clés illisibles", m.id);
    }
  }
  for (const m of links) {
    if (out.some((x) => x.id === m.id) || !board) continue;
    try {
      out.push(await fromKeys(m, await unboxJson<MachineKeys>(board.key, m.key, AAD.machineLink(board.id, m.id)), "board"));
    } catch {
      console.warn("[excalibash] machine du tableau ignorée : clés illisibles", m.id);
    }
  }
  return out;
}

export async function createMachine(keys: KeyPair, name: string, shareBoards = true) {
  const vk = await vaultKey(keys);
  const id = randomId();
  const kp = await generateKeyPair();
  const r = await api.post<{ token: string; server: string }>("/machines", {
    id,
    shareBoards,
    encName: await boxText(vk, name, machineNameAad(id)),
    encPub: await box(vk, kp.pub, AAD.machine(id)),
    encAuth: await box(vk, (await machineAuthKey(kp.rawPriv)).raw, AAD.machineAuth(id)),
  });
  return { id, token: r.token, server: r.server, privateKey: toB64(kp.rawPriv), fingerprint: await fingerprint(kp.pub) };
}

export async function renameMachine(keys: KeyPair, id: string, name: string) {
  await api.patch(`/machines/${id}`, { encName: await boxText(await vaultKey(keys), name, machineNameAad(id)) });
}


/**
 * Approves a machine paired with a short code, once the owner has checked its fingerprint: a
 * fresh machine auth key is sealed to the key the agent generated on the machine itself, with a
 * tag under the confirmation code shown on the machine (the agent rejects an auth key without it).
 */
export async function approvePairing(keys: KeyPair, code: string, agentPubB64: string, confirm: string, name: string, shareBoards = true) {
  const vk = await vaultKey(keys);
  const id = randomId();
  const pub = fromB64(agentPubB64);
  const auth = randomBytes(32);
  const tag = await pairTag(confirm, auth, pub);
  const payload = new Uint8Array(auth.length + tag.length);
  payload.set(auth);
  payload.set(tag, auth.length);
  await api.post(`/machines/pairings/${encodeURIComponent(code)}/approve`, {
    id,
    agentPub: agentPubB64,
    shareBoards,
    encName: await boxText(vk, name, machineNameAad(id)),
    encPub: await box(vk, pub, AAD.machine(id)),
    encAuth: await box(vk, auth, AAD.machineAuth(id)),
    sealedAuth: await seal(pub, payload, `eb:pair:${code.toUpperCase().replace(/[^A-Z0-9]/g, "")}`),
  });
  return id;
}

// ---- Sharing machines ---------------------------------------------------------------

export type MachineShare = { userId: string; name: string; email: string; color: string; publicKey: string };

export async function machineShares(id: string) {
  return api.get<{ shares: MachineShare[]; boards: string[] }>(`/machines/${id}/shares`);
}

/**
 * Shares one of our machines with someone: its auth key (what lets a browser open sessions on
 * it), name and public key, sealed to their public key. Their key is checked against the one
 * pinned at earlier shares, as for boards.
 */
/** `existing`: already shared with them (rename), so their key must already be pinned. */
export async function shareMachine(user: User, keys: KeyPair, m: Machine, target: { id: string; email?: string; publicKey: string }, verifiedChange = false, existing = false) {
  const check = verifiedChange ? "match" : await checkContact(user, keys, target.id, target.email, target.publicKey);
  if (check === "changed" || (existing && check === "new")) {
    throw new Error("La clé de cette personne a changé ou n'est pas connue de ce navigateur : vérifie son empreinte avant de continuer.");
  }
  const sealed = await seal(fromB64(target.publicKey), utf8(JSON.stringify(machineKeys(m))), AAD.machineShare(m.id));
  await api.put(`/machines/${m.id}/shares/${target.id}`, { sealed });
  await pinContact(user, keys, target.id, target.email, target.publicKey);
}

export async function unshareMachine(id: string, userId: string) {
  await api.del(`/machines/${id}/shares/${userId}`);
}

export async function setShareBoards(id: string, on: boolean) {
  await api.patch(`/machines/${id}`, { shareBoards: on });
}

// The links this browser created on purpose (the owner opened a shell or a site): only those are
// ever re-created. The session lists come from the server, which must not decide on its own to
// have our machine handed to a board's editors.
const LINKED = (boardId: string) => `eb-machine-links:${boardId}`;
function linkedHere(boardId: string): Set<string> {
  const v = readJson<unknown>(LINKED(boardId));
  return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
}
function setLinkedHere(boardId: string, ids: Set<string>) {
  // In private mode the links are just not restored after a key rotation.
  if (ids.size) writeStorage(LINKED(boardId), JSON.stringify([...ids]));
  else removeStorage(LINKED(boardId));
}

const putLink = async (board: { id: string; key: SymKey }, m: Machine) =>
  api.put(`/machines/${m.id}/links/${board.id}`, { wrapped: await boxJson(board.key, machineKeys(m), AAD.machineLink(board.id, m.id)) });

/** The owner just opened a shell or a site on one of their machines here: link it to the board if it shares through boards. */
export async function linkMachine(board: { id: string; key: SymKey }, m: Machine) {
  if (m.access !== "owner" || !m.shareBoards) return;
  await putLink(board, m);
  setLinkedHere(board.id, linkedHere(board.id).add(m.id));
}

/**
 * Keeps the board links of our machines in step with a board we can edit. A link is removed once
 * its machine has no shell or site here any more (`used`), refreshed when the machine was renamed,
 * and re-created (after a key rotation dropped it) only if this browser had linked it itself.
 */
export async function syncBoardLinks(keys: KeyPair, board: { id: string; key: SymKey }, used: Set<string>) {
  const mine = (await listMachines(keys)).filter((m) => m.access === "owner");
  const { links } = await api.get<{ links: RawSharedMachine[] }>(`/machines/links?board=${encodeURIComponent(board.id)}`);
  const linked = linkedHere(board.id);
  for (const m of mine) {
    const link = links.find((l) => l.id === m.id);
    if (link && !used.has(m.id)) {
      await api.del(`/machines/${m.id}/links/${board.id}`);
      linked.delete(m.id);
    } else if (link && m.shareBoards) {
      const cur = await unboxJson<MachineKeys>(board.key, link.key, AAD.machineLink(board.id, m.id)).catch(() => null);
      if (cur?.name !== m.name || cur.auth !== toB64(m.auth.raw)) await putLink(board, m);
    } else if (!link && m.shareBoards && used.has(m.id) && linked.has(m.id)) {
      await putLink(board, m);
    } else if (!link && !used.has(m.id)) {
      linked.delete(m.id);
    }
  }
  setLinkedHere(board.id, linked);
}

// ---- Personal placement of shared items -----------------------------------------------

/** Shared item id -> id of one of my own folders where I filed it (private to me). */
export async function loadPlacements(user: User, keys: KeyPair): Promise<Record<string, string | null>> {
  return (await load(user, keys)).placements ?? {};
}

export async function setPlacement(user: User, keys: KeyPair, itemId: string, folderId: string | null) {
  const data = await load(user, keys);
  const placements = { ...data.placements };
  if (folderId) placements[itemId] = folderId;
  else delete placements[itemId];
  await save(user, keys, { ...data, placements });
}
