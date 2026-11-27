// End-to-end encryption primitives — byte formats are specified in docs/SECURITY.md
// and shared with the Go agent. Runs in browsers and in Node (WebCrypto only).
import { argon2id } from "hash-wasm";

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export type Bytes = Uint8Array<ArrayBuffer>;

// ---- Encoding ----------------------------------------------------------------------

export function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64(s: string): Bytes {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const utf8 = (s: string): Bytes => enc.encode(s) as Bytes;
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

/** Lowercase hex of the bytes. */
export const hex = (buf: ArrayBuffer | Uint8Array): string => Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");

/** SHA-256 as lowercase hex; a string is hashed as UTF-8. */
export const sha256Hex = async (data: BufferSource | string): Promise<string> => hex(await subtle.digest("SHA-256", typeof data === "string" ? utf8(data) : data));

export function randomBytes(n: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** Ids generated client-side and bound into AADs. */
export const randomId = (): string => toB64(randomBytes(16));

/** Tunnel id: 128 random bits as lowercase base32 without padding (26 characters), valid as a hostname label. */
export function randomTunnelId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = randomBytes(16);
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---- Symmetric ---------------------------------------------------------------------

/** A 32-byte symmetric key, kept as an AES-GCM CryptoKey alongside its raw bytes (needed to wrap it). */
export type SymKey = { raw: Bytes; key: CryptoKey };

export async function symKey(raw: Uint8Array): Promise<SymKey> {
  if (raw.length !== 32) throw new Error("clé symétrique invalide");
  const copy = new Uint8Array(raw) as Bytes;
  return { raw: copy, key: await subtle.importKey("raw", copy, "AES-GCM", false, ["encrypt", "decrypt"]) };
}

export const newSymKey = () => symKey(randomBytes(32));

export async function hkdf(ikm: Uint8Array, info: string, salt: Uint8Array = new Uint8Array(), length = 32): Promise<Bytes> {
  const base = await subtle.importKey("raw", ikm as Bytes, "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as Bytes, info: utf8(info) }, base, length * 8);
  return new Uint8Array(bits);
}

/** box = 0x01 ‖ iv(12) ‖ AES-256-GCM(pt, aad) */
export async function box(k: SymKey, pt: Uint8Array, aad: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, k.key, pt as Bytes));
  return toB64(concat(Uint8Array.of(1), iv, ct));
}

export async function unbox(k: SymKey, data: string, aad: string): Promise<Bytes> {
  const b = fromB64(data);
  if (b[0] !== 1 || b.length < 29) throw new Error("chiffré invalide");
  try {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: b.subarray(1, 13), additionalData: utf8(aad) }, k.key, b.subarray(13)));
  } catch {
    throw new Error("déchiffrement impossible (clé ou données altérées)");
  }
}

export const boxText = (k: SymKey, s: string, aad: string) => box(k, utf8(s), aad);
export const unboxText = async (k: SymKey, data: string, aad: string) => fromUtf8(await unbox(k, data, aad));
export const boxJson = (k: SymKey, v: unknown, aad: string) => box(k, utf8(JSON.stringify(v)), aad);
export const unboxJson = async <T = any>(k: SymKey, data: string, aad: string): Promise<T> => JSON.parse(fromUtf8(await unbox(k, data, aad)));

/** Wraps a symmetric key under another one. */
export const wrapKey = (parent: SymKey, child: SymKey, aad: string) => box(parent, child.raw, aad);
export const unwrapKey = async (parent: SymKey, data: string, aad: string) => symKey(await unbox(parent, data, aad));

// ---- Asymmetric (X25519) -----------------------------------------------------------

export type KeyPair = { priv: CryptoKey; pub: Bytes };

const X25519 = { name: "X25519" } as const;

export async function generateKeyPair(): Promise<KeyPair & { pkcs8: Bytes; rawPriv: Bytes }> {
  const kp = (await subtle.generateKey(X25519, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", kp.privateKey));
  const jwk = await subtle.exportKey("jwk", kp.privateKey);
  return { priv: kp.privateKey, pub, pkcs8, rawPriv: fromB64(jwk.d!) };
}

/** Imports a private key as non-extractable: script can use it, never read it out. */
export async function importPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey("pkcs8", pkcs8 as Bytes, X25519, false, ["deriveBits"]);
}

export async function importRawPrivateKey(raw: Uint8Array, pub: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey("jwk", { kty: "OKP", crv: "X25519", d: toB64(raw), x: toB64(pub) }, X25519, false, ["deriveBits"]);
}

async function dh(priv: CryptoKey, pub: Uint8Array): Promise<Bytes> {
  const pubKey = await subtle.importKey("raw", pub as Bytes, X25519, true, []);
  return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: pubKey }, priv, 256));
}

const SEAL_INFO = "excalibash/seal/v1";

/** seal = 0x02 ‖ ephPub(32) ‖ iv(12) ‖ AES-256-GCM(k, pt, aad), k = HKDF(X25519(eph, pub), ephPub ‖ pub) */
export async function seal(pub: Uint8Array, pt: Uint8Array, aad: string): Promise<string> {
  const eph = (await subtle.generateKey(X25519, true, ["deriveBits"])) as CryptoKeyPair;
  const ephPub = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
  const k = await symKey(await hkdf(await dh(eph.privateKey, pub), SEAL_INFO, concat(ephPub, pub)));
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, k.key, pt as Bytes));
  return toB64(concat(Uint8Array.of(2), ephPub, iv, ct));
}

export async function unseal(kp: KeyPair, data: string, aad: string): Promise<Bytes> {
  const b = fromB64(data);
  if (b[0] !== 2 || b.length < 61) throw new Error("chiffré scellé invalide");
  const ephPub = b.subarray(1, 33);
  const k = await symKey(await hkdf(await dh(kp.priv, ephPub), SEAL_INFO, concat(ephPub, kp.pub)));
  try {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: b.subarray(33, 45), additionalData: utf8(aad) }, k.key, b.subarray(45)));
  } catch {
    throw new Error("déchiffrement impossible (clé ou données altérées)");
  }
}

export const sealKey = (pub: Uint8Array, k: SymKey, aad: string) => seal(pub, k.raw, aad);
export const unsealKey = async (kp: KeyPair, data: string, aad: string) => symKey(await unseal(kp, data, aad));

/** Key only the holder of the private key can compute: protects their own small records. */
export async function vaultKey(kp: KeyPair): Promise<SymKey> {
  return symKey(await hkdf(await dh(kp.priv, kp.pub), "excalibash/vault"));
}

/** Key the owner uses to issue terminal keys to a machine; the agent derives it from its private key. */
export async function machineAuthKey(rawPriv: Uint8Array): Promise<SymKey> {
  return symKey(await hkdf(rawPriv, "excalibash/machine-auth"));
}

/** Public key of a private key we can briefly export (pkcs8), so we never trust one supplied by the server. */
export async function publicKeyOf(pkcs8: Uint8Array): Promise<Bytes> {
  const k = await subtle.importKey("pkcs8", pkcs8 as Bytes, X25519, true, ["deriveBits"]);
  return fromB64((await subtle.exportKey("jwk", k)).x!);
}

/** The confirmation code an agent shows while pairing, as typed: "abcd-2345" → "ABCD2345". */
export const normalizeConfirm = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
const CONFIRM_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/**
 * Whether a normalized confirmation code is well formed: 7 letters and a check letter,
 * Σ (i+1)·index(c_i) mod 31 (same formula as the agent's confirmCheck). Catches a typo before
 * the approval, which would otherwise leave a machine the agent refused.
 */
export function confirmValid(code: string): boolean {
  if (code.length !== 8 || [...code].some((ch) => !CONFIRM_ALPHABET.includes(ch))) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += (i + 1) * CONFIRM_ALPHABET.indexOf(code[i]!);
  return CONFIRM_ALPHABET[sum % 31] === code[7];
}

/**
 * Pairing tag: HMAC-SHA256(Argon2id(confirmation code, agentPub), auth ‖ agentPub). The code goes from the machine's
 * screen to this browser by hand, so the server cannot make an auth key the agent would accept.
 */
export async function pairTag(confirm: string, auth: Uint8Array, agentPub: Uint8Array): Promise<Bytes> {
  // Stretched first (salt: the agent's key): a tag obtained with a substituted key can't be used to
  // search the code offline. Same parameters as the agent (agent/pair.go).
  const stretched = await argon2id({ password: normalizeConfirm(confirm), salt: agentPub, ...KDF, hashLength: 32, outputType: "binary" });
  const k = await subtle.importKey("raw", stretched as Bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = new Uint8Array(auth.length + agentPub.length);
  msg.set(auth);
  msg.set(agentPub, auth.length);
  return new Uint8Array(await subtle.sign("HMAC", k, msg)) as Bytes;
}

export async function fingerprint(pub: Uint8Array): Promise<string> {
  const h = new Uint8Array(await subtle.digest("SHA-256", pub as Bytes)).subarray(0, 20);
  return hex(h).toUpperCase().match(/.{4}/g)!.join(" ");
}

// ---- Accounts ------------------------------------------------------------------------

export const KDF = { memorySize: 64 * 1024, iterations: 3, parallelism: 1 };

/** Password → (authKey sent to the server, masterKey that never leaves the browser). */
export async function deriveAccountKeys(password: string, salt: string): Promise<{ authKey: string; masterKey: SymKey }> {
  const root = await argon2id({ password: password.normalize("NFKC"), salt: fromB64(salt), ...KDF, hashLength: 32, outputType: "binary" });
  const [auth, master] = await Promise.all([hkdf(root, "excalibash/auth"), hkdf(root, "excalibash/master")]);
  return { authKey: toB64(auth), masterKey: await symKey(master) };
}

const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I

/** 32 random bytes shown as 52 base32 characters in groups of 4. */
export function formatRecoveryKey(raw: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of raw) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}

export function parseRecoveryKey(s: string): Bytes {
  const clean = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("Clé de récupération invalide");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (out.length !== 32) throw new Error("Clé de récupération invalide");
  return Uint8Array.from(out);
}

export async function recoveryKeys(raw: Uint8Array): Promise<{ recoveryAuth: string; recoveryEnc: SymKey }> {
  return {
    recoveryAuth: toB64(await hkdf(raw, "excalibash/recovery-auth")),
    recoveryEnc: await symKey(await hkdf(raw, "excalibash/recovery-enc")),
  };
}

export const AAD = {
  priv: (userId: string) => `eb:priv:${userId}`,
  name: (id: string) => `eb:name:${id}`,
  wrap: (id: string, parentId: string) => `eb:wrap:${id}:${parentId}`,
  grant: (id: string, userId: string) => `eb:grant:${id}:${userId}`,
  element: (boardId: string, id: string, v: number, n: number) => `eb:el:${boardId}:${id}:${v}:${n}`,
  file: (boardId: string, fileId: string) => `eb:file:${boardId}:${fileId}`,
  preview: (boardId: string) => `eb:preview:${boardId}`,
  pointer: (boardId: string) => `eb:ptr:${boardId}`,
  /** Shared document (Yjs) updates and snapshots; the epoch binds them to the current key generation. */
  doc: (boardId: string, docId: string, epoch: number) => `eb:doc:${boardId}:${docId}:${epoch}`,
  /** Awareness (cursors, names, selections) of a shared document: relayed by the server, never stored. */
  docAwareness: (boardId: string, docId: string, epoch: number) => `eb:doc-aw:${boardId}:${docId}:${epoch}`,
  /** Board key wrapped under a public link key (epoch binds it to the current key generation). */
  link: (boardId: string, epoch: number) => `eb:link:${boardId}:${epoch}`,
  linkLabel: (boardId: string, publicId: string) => `eb:link-label:${boardId}:${publicId}`,
  linkTitle: (boardId: string, publicId: string) => `eb:link-title:${boardId}:${publicId}`,
  termKey: (boardId: string, termId: string) => `eb:termkey:${boardId}:${termId}`,
  termLabel: (boardId: string, termId: string) => `eb:termlabel:${boardId}:${termId}`,
  termAgent: (termId: string) => `eb:term:${termId}`,
  termOut: (termId: string, gen: string, seq: number) => `eb:term-out:${termId}:${gen}:${seq}`,
  termIn: (termId: string, gen: string, s: string, k: number, ts: number) => `eb:term-in:${termId}:${gen}:${s}:${k}:${ts}`,
  webKey: (boardId: string, webId: string) => `eb:webkey:${boardId}:${webId}`,
  webLabel: (boardId: string, webId: string) => `eb:weblabel:${boardId}:${webId}`,
  webAgent: (webId: string) => `eb:web:${webId}`,
  /** Reachability probe asked of an agent by its owner, and its answer (agent/probe.go). */
  probe: (rid: string, ts: number) => `eb:probe:${rid}:${ts}`,
  probeRes: (rid: string) => `eb:probe-res:${rid}`,
  /** Self-update request asked of an agent, and its progress frames (agent/update.go). */
  update: (rid: string, ts: number) => `eb:update:${rid}:${ts}`,
  updateRes: (rid: string) => `eb:update-res:${rid}`,
  /** File transfer and capture requests ridden on a local shell (agent/files.go), and their answers. */
  fileReq: (termId: string, rid: string, ts: number) => `eb:file-req:${termId}:${rid}:${ts}`,
  fileRes: (termId: string, rid: string, n: number) => `eb:file-res:${termId}:${rid}:${n}`,
  machine: (machineId: string) => `eb:machine:${machineId}`,
  machineName: (machineId: string) => `eb:machine:${machineId}:name`,
  machineAuth: (machineId: string) => `eb:machine-auth:${machineId}`,
  /** A machine shared with one person: sealed to their public key (which the seal already binds). */
  machineShare: (machineId: string) => `eb:machine-share:${machineId}`,
  /** A machine linked to a board: boxed under the board key, for its editors. */
  machineLink: (boardId: string, machineId: string) => `eb:machine-link:${boardId}:${machineId}`,
  vault: (userId: string) => `eb:vault:${userId}`,
};
