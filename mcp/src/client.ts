// REST side of the MCP client. The web app's own `api` object is reused: it calls fetch with
// relative paths ("/api/..."), so fetch is wrapped to target the instance and carry the session cookie.
import { api, ApiError, type User } from "../../web/src/api.ts";
import { AAD, deriveAccountKeys, fromB64, importPrivateKey, publicKeyOf, toB64, unbox, type KeyPair } from "../../web/src/crypto.ts";
import type { McpConfig } from "./config.ts";

export { api, ApiError };

const realFetch = globalThis.fetch;
let base = "";
const jar = new Map<string, string>();

/** Points relative fetches at `url` and (re)sets the session cookie ("name=value"). */
export function useServer(url: string, cookie = "") {
  base = url.replace(/\/+$/, "");
  jar.clear();
  for (const part of cookie.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
  globalThis.fetch = (async (input: any, init: any = {}) => {
    if (typeof input !== "string" || !input.startsWith("/")) return realFetch(input, init);
    const headers = { ...(init.headers ?? {}), ...(jar.size ? { cookie: cookieHeader() } : {}) };
    const r = await realFetch(base + input, { ...init, headers, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(30_000) });
    for (const sc of r.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return r;
  }) as typeof fetch;
}

export const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
export const serverUrl = () => base;

/** Normalizes what the user typed: https by default, no trailing slash, no path. */
export function normalizeUrl(input: string): string {
  let s = input.trim();
  if (!s) throw new Error("Adresse du serveur manquante.");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`Adresse invalide : ${input}`);
  }
  return u.origin;
}

/**
 * Same flow as the web app's login: prelogin, derive the keys locally, authenticate with the
 * authKey only, open the private key, and refuse a public key the server made up.
 */
export async function login(url: string, email: string, password: string, askCode?: () => Promise<string>): Promise<McpConfig> {
  useServer(url);
  const { salt } = await api.post<{ salt: string }>("/auth/prelogin", { email });
  const { authKey, masterKey } = await deriveAccountKeys(password, salt);
  let r: { user: User; keys: { publicKey: string; encPrivateKey: string }; mfaRequired?: boolean; mfaToken?: string };
  try {
    r = await api.post("/auth/login", { email, authKey });
    // Second factor: no session and no keys until the code is given.
    if (r.mfaRequired) {
      if (!askCode) throw new Error("Ce compte a la double authentification : le code est nécessaire.");
      const code = (await askCode()).trim();
      if (!code) throw new Error("Code à deux facteurs manquant.");
      r = await api.post("/auth/mfa", { mfaToken: r.mfaToken, code });
    }
  } catch (e) {
    if (e instanceof ApiError && e.code === "EMAIL_NOT_VERIFIED") {
      throw new Error(`L'email de ${email} n'est pas encore vérifié : termine la vérification dans le navigateur (${url}), puis relance « login ».`);
    }
    throw e;
  }
  let pkcs8: Uint8Array;
  try {
    pkcs8 = await unbox(masterKey, r.keys.encPrivateKey, AAD.priv(r.user.id));
  } catch {
    throw new Error("Impossible de déchiffrer la clé privée : connexion refusée.");
  }
  // A public key supplied by the server is never trusted: derive it from the private key.
  if (toB64(await publicKeyOf(pkcs8)) !== r.keys.publicKey) {
    throw new Error("La clé publique fournie par le serveur ne correspond pas à ta clé privée : connexion refusée.");
  }
  return { url, cookie: cookieHeader(), userId: r.user.id, email: r.user.email, publicKey: r.keys.publicKey, pkcs8: toB64(pkcs8) };
}

/** Private key of a saved config, checked against its public key. */
export async function keysOf(cfg: McpConfig): Promise<KeyPair> {
  const pkcs8 = fromB64(cfg.pkcs8);
  const pub = await publicKeyOf(pkcs8);
  if (toB64(pub) !== cfg.publicKey) throw new Error("La clé privée enregistrée ne correspond pas à la clé publique du compte : relance « login ».");
  return { priv: await importPrivateKey(pkcs8), pub };
}

export const SESSION_EXPIRED = "Session expirée ou révoquée : relance « node excalibash-mcp.mjs login ».";
