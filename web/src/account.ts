// Account key management: the password never leaves the browser, the private key is only
// ever stored encrypted on the server and as a non-extractable CryptoKey in IndexedDB.
import { api, type User } from "./api.ts";
import { solveChallenge, type Challenge } from "./pow.ts";
import {
  AAD,
  box,
  deriveAccountKeys,
  formatRecoveryKey,
  generateKeyPair,
  importPrivateKey,
  parseRecoveryKey,
  publicKeyOf,
  randomBytes,
  randomId,
  recoveryKeys,
  toB64,
  unbox,
  type KeyPair,
} from "./crypto.ts";

const DB = "excalibash";
const STORE = "keys";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbOp<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function storeKeys(userId: string, kp: KeyPair): Promise<void> {
  await idbOp("readwrite", (s) => s.put({ priv: kp.priv, pub: kp.pub }, userId));
}

export async function loadKeys(userId: string): Promise<KeyPair | null> {
  try {
    const v = (await idbOp("readonly", (s) => s.get(userId))) as { priv: CryptoKey; pub: Uint8Array } | undefined;
    return v ? { priv: v.priv, pub: new Uint8Array(v.pub) } : null;
  } catch {
    return null;
  }
}

export async function forgetKeys(): Promise<void> {
  try {
    await idbOp("readwrite", (s) => s.clear());
  } catch {
    /* nothing stored */
  }
}

/**
 * Decrypts the private key and derives its public key locally. A public key supplied by the
 * server is never trusted: a substituted one would make us seal our own keys for someone else.
 */
async function openKeyPair(pkcs8: Uint8Array, claimedPublicKey: string): Promise<KeyPair> {
  const pub = await publicKeyOf(pkcs8);
  if (toB64(pub) !== claimedPublicKey) throw new Error("La clé publique fournie par le serveur ne correspond pas à ta clé privée : connexion refusée.");
  return { priv: await importPrivateKey(pkcs8), pub };
}

async function openPrivateKey(encPrivateKey: string, key: Parameters<typeof unbox>[0], userId: string, publicKey: string): Promise<KeyPair> {
  return openKeyPair(await unbox(key, encPrivateKey, AAD.priv(userId)), publicKey);
}

export type Session = { user: User; keys: KeyPair };

export type Registered = Session & { recoveryKey: string };
/** Account created but the email is not verified yet: keys stay in memory until the code is accepted. */
export type PendingRegistration = { needsVerification: true; email: string; keys: KeyPair; recoveryKey: string };

export async function register(o: {
  email: string;
  name: string;
  password: string;
  invite?: string | null;
  setupCode?: string;
}): Promise<Registered | PendingRegistration> {
  const id = randomId();
  const salt = toB64(randomBytes(16));
  const { authKey, masterKey } = await deriveAccountKeys(o.password, salt);
  const kp = await generateKeyPair();
  const recoveryRaw = randomBytes(32);
  const rec = await recoveryKeys(recoveryRaw);
  const pow = await solveChallenge(await api.get<Challenge>("/auth/challenge"));
  const r = await api.post<{ user?: User; needsVerification?: boolean }>("/auth/register", {
    pow,
    website: "",
    id,
    email: o.email,
    name: o.name,
    invite: o.invite || undefined,
    setupCode: o.setupCode || undefined,
    salt,
    authKey,
    publicKey: toB64(kp.pub),
    encPrivateKey: await box(masterKey, kp.pkcs8, AAD.priv(id)),
    recoveryEncPrivateKey: await box(rec.recoveryEnc, kp.pkcs8, AAD.priv(id)),
    recoveryAuth: rec.recoveryAuth,
  });
  const keys = { priv: await importPrivateKey(kp.pkcs8), pub: kp.pub };
  if (r.needsVerification || !r.user) return { needsVerification: true, email: o.email, keys, recoveryKey: formatRecoveryKey(recoveryRaw) };
  await storeKeys(r.user.id, keys);
  return { user: r.user, keys, recoveryKey: formatRecoveryKey(recoveryRaw) };
}

/** Checks the emailed code, then keeps the keys on this device. */
export async function verifyEmail(email: string, code: string, keys: KeyPair): Promise<Session> {
  const r = await api.post<{ user: User }>("/auth/verify", { email, code });
  await storeKeys(r.user.id, keys);
  return { user: r.user, keys };
}

/** Verification for an account whose keys are not in memory (login path): the caller then logs in. */
export async function checkCode(email: string, code: string): Promise<void> {
  await api.post("/auth/verify", { email, code });
}

export async function resendCode(email: string): Promise<void> {
  await api.post("/auth/resend", { email });
}

/** Password accepted but the account has a second factor: the code finishes the login (or the recovery). */
export type MfaStep = { mfaRequired: true; finish: (code: string) => Promise<Session> };

export async function login(email: string, password: string): Promise<Session | MfaStep> {
  const { salt } = await api.post<{ salt: string }>("/auth/prelogin", { email });
  const { authKey, masterKey } = await deriveAccountKeys(password, salt);
  const r = await api.post<{ user?: User; keys?: { publicKey: string; encPrivateKey: string }; mfaRequired?: boolean; mfaToken?: string }>("/auth/login", { email, authKey });
  const open = async (r: { user: User; keys: { publicKey: string; encPrivateKey: string } }): Promise<Session> => {
    const keys = await openPrivateKey(r.keys.encPrivateKey, masterKey, r.user.id, r.keys.publicKey);
    await storeKeys(r.user.id, keys);
    return { user: r.user, keys };
  };
  if (r.mfaRequired) {
    return { mfaRequired: true, finish: async (code) => open(await api.post("/auth/mfa", { mfaToken: r.mfaToken, code })) };
  }
  return open(r as { user: User; keys: { publicKey: string; encPrivateKey: string } });
}

/** The password as the server wants it proven (for the actions that ask for it again). */
export async function authKeyFor(email: string, password: string): Promise<string> {
  const { salt } = await api.post<{ salt: string }>("/auth/prelogin", { email });
  return (await deriveAccountKeys(password, salt)).authKey;
}

/** A session cookie without keys on this device (cleared storage, new browser profile…). */
export async function unlock(user: User, password: string): Promise<KeyPair> {
  const k = await api.get<{ salt: string; publicKey: string; encPrivateKey: string }>("/auth/keys");
  const { masterKey } = await deriveAccountKeys(password, k.salt);
  let pkcs8: Uint8Array;
  try {
    pkcs8 = await unbox(masterKey, k.encPrivateKey, AAD.priv(user.id));
  } catch {
    throw new Error("Mot de passe incorrect");
  }
  const keys = await openKeyPair(pkcs8, k.publicKey);
  await storeKeys(user.id, keys);
  return keys;
}

export async function recover(email: string, recoveryKey: string, newPassword: string): Promise<Session | MfaStep> {
  const rec = await recoveryKeys(parseRecoveryKey(recoveryKey));
  const r = await api.post<{ userId: string; publicKey: string; recoveryEncPrivateKey: string; mfaRequired?: boolean }>("/auth/recover", { email, recoveryAuth: rec.recoveryAuth });
  const pkcs8 = await unbox(rec.recoveryEnc, r.recoveryEncPrivateKey, AAD.priv(r.userId));
  await openKeyPair(pkcs8, r.publicKey); // refuse before touching the account if the server lies
  const salt = toB64(randomBytes(16));
  const { authKey, masterKey } = await deriveAccountKeys(newPassword, salt);
  const finish = async (mfaCode?: string): Promise<Session> => {
    const done = await api.post<{ user: User }>("/auth/recover/finish", {
      email,
      recoveryAuth: rec.recoveryAuth,
      mfaCode,
      salt,
      authKey,
      encPrivateKey: await box(masterKey, pkcs8, AAD.priv(r.userId)),
    });
    const keys = await openKeyPair(pkcs8, r.publicKey);
    await storeKeys(done.user.id, keys);
    return { user: done.user, keys };
  };
  // With a second factor the recovery key is not enough: the code is asked before the password is replaced.
  return r.mfaRequired ? { mfaRequired: true, finish } : finish();
}

export async function changePassword(user: User, current: string, next: string): Promise<void> {
  const k = await api.get<{ salt: string; encPrivateKey: string }>("/auth/keys");
  const old = await deriveAccountKeys(current, k.salt);
  let pkcs8: Uint8Array;
  try {
    pkcs8 = await unbox(old.masterKey, k.encPrivateKey, AAD.priv(user.id));
  } catch {
    throw new Error("Mot de passe actuel incorrect");
  }
  const newSalt = toB64(randomBytes(16));
  const fresh = await deriveAccountKeys(next, newSalt);
  await api.post("/auth/password", {
    authKey: old.authKey,
    newSalt,
    newAuthKey: fresh.authKey,
    newEncPrivateKey: await box(fresh.masterKey, pkcs8, AAD.priv(user.id)),
  });
}
