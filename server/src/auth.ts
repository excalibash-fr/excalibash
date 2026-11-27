import { isIPv4, isIPv6 } from "node:net";
import { scrypt, scryptSync, randomBytes, timingSafeEqual, createHash, createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Request, Response, NextFunction } from "express";
import { db, serverSecret } from "./db.ts";
import { config } from "./config.ts";
import { tlsOn } from "./tls.ts";
import { dropMainSessionTunnels } from "./tunnelSessions.ts";

export type User = {
  id: string;
  email: string;
  name: string;
  isAdmin: boolean;
  color: string;
  publicKey: string;
  mfaEnabled: boolean;
};

export type UserRow = {
  id: string;
  email: string;
  name: string;
  auth_hash: string;
  kdf_salt: string;
  public_key: string;
  enc_private_key: string;
  recovery_enc_private_key: string;
  recovery_auth_hash: string;
  enc_vault: string | null;
  is_admin: number;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_step: number;
  totp_pending: string | null;
  color: string;
  findable_name: number;
  findable_email: number;
  created_at: number;
};

export const COOKIE = "eb_session";
/**
 * Over HTTPS the session cookie carries the __Host- prefix: the browser then only accepts it
 * Secure, for this exact host and path /. The tunnel origin (same host, another port, so
 * "same-site") can neither set one to log someone in as another account nor overwrite it.
 */
export const SECURE_COOKIE = "__Host-eb_session";

/** When HTTPS is certain, a cookie without the prefix (one any same-site page could set) is ignored. */
const strictCookies = () => config.cookieSecure || tlsOn();

function sessionToken(header: string | undefined): string | undefined {
  return readCookie(header, SECURE_COOKIE) ?? (strictCookies() ? undefined : readCookie(header, COOKIE));
}

const COLORS = ["#4f46e5", "#e11d48", "#059669", "#d97706", "#0891b2", "#7c3aed", "#db2777", "#65a30d"];

export function pickColor(n: number): string {
  return COLORS[n % COLORS.length];
}

export function toUser(r: UserRow): User {
  return { id: r.id, email: r.email, name: r.name, isAdmin: !!r.is_admin, color: r.color, publicKey: r.public_key, mfaEnabled: !!r.totp_enabled };
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Hashes a client-derived key (never a password: the browser only ever sends
 * Argon2id-derived material). scrypt on top means a stolen database is still costly to use.
 */
export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

const DUMMY_HASH = hashSecret("excalibash-dummy");

/** Same cost as a real check, so unknown emails cannot be told apart by timing. */
export function burnVerify(secret: string): false {
  verifySecret(secret, DUMMY_HASH);
  return false;
}

// The same, off the main thread (libuv pool), for routes anyone can call: a burst of logins must not
// stall every board and terminal. At most a few at once; the others wait their turn.
const SCRYPT_SLOTS = 4;
let scryptBusy = 0;
const scryptQueue: (() => void)[] = [];

async function scryptAsync(secret: string, salt: Buffer, len: number): Promise<Buffer> {
  if (scryptBusy >= SCRYPT_SLOTS) await new Promise<void>((r) => scryptQueue.push(r));
  scryptBusy++;
  try {
    return await new Promise<Buffer>((resolve, reject) => scrypt(secret, salt, len, (e, k) => (e ? reject(e) : resolve(k))));
  } finally {
    scryptBusy--;
    scryptQueue.shift()?.();
  }
}

export async function hashSecretAsync(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifySecretAsync(secret: string, stored: string): Promise<boolean> {
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  return timingSafeEqual(expected, await scryptAsync(secret, Buffer.from(salt, "base64"), expected.length));
}

export async function burnVerifyAsync(secret: string): Promise<false> {
  await verifySecretAsync(secret, DUMMY_HASH);
  return false;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(secret, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

/** Same answer shape for unknown emails, so prelogin does not reveal who has an account. */
export function fakeSalt(email: string): string {
  return createHmac("sha256", serverSecret()).update(email.trim().toLowerCase()).digest().subarray(0, 16).toString("base64url");
}

export function userCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export function findUserByEmail(email: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim()) as UserRow | undefined;
}

export function getUserRow(id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

/** Coarse "Browser · OS" label from a User-Agent; the raw string is never stored. */
export function uaLabel(ua: string | undefined): string {
  const s = ua ?? "";
  const browser =
    /Edg(e|A|iOS)?\//.test(s) ? "Edge"
    : /OPR\/|Opera/.test(s) ? "Opera"
    : /Firefox\/|FxiOS/.test(s) ? "Firefox"
    : /Chrome\/|CriOS/.test(s) ? "Chrome"
    : /Safari\//.test(s) ? "Safari"
    : /curl\//i.test(s) ? "curl"
    : "";
  const os =
    /Windows/.test(s) ? "Windows"
    : /Android/.test(s) ? "Android"
    : /iPhone|iPad|iPod/.test(s) ? "iOS"
    : /Mac OS X|Macintosh/.test(s) ? "macOS"
    : /CrOS/.test(s) ? "ChromeOS"
    : /Linux|X11/.test(s) ? "Linux"
    : "";
  const label = [browser || "Navigateur inconnu", os].filter(Boolean).join(" · ");
  return label.slice(0, 40);
}

/** Coarse network prefix: IPv4 /24 ("1.2.3.x"), IPv6 /48 ("2001:db8:1::/48"). */
export function ipPrefix(ip: string | undefined): string {
  let a = (ip ?? "").trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1];
  if (isIPv4(a)) return a.split(".").slice(0, 3).join(".") + ".x";
  if (isIPv6(a)) {
    const [head, tail = ""] = a.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    const groups = a.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
    return groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, "").toLowerCase()).join(":") + "::/48";
  }
  return "";
}

const used = new Map<string, number>();

export function createSession(req: Request, res: Response, userId: string): void {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expires = now + config.sessionDays * 86400_000;
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, public_id, created_at, last_used_at, user_agent_label, ip_prefix) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(sha256(token), userId, expires, randomBytes(8).toString("hex"), now, now, uaLabel(req.headers["user-agent"]), ipPrefix(req.ip));
  used.set(sha256(token), now);
  const secure = config.cookieSecure || req.secure;
  res.cookie(secure ? SECURE_COOKIE : COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    expires: new Date(expires),
    path: "/",
  });
}

export function currentSessionHash(req: IncomingMessage): string | undefined {
  const token = sessionToken(req.headers.cookie);
  return token ? sha256(token) : undefined;
}

export function destroySession(req: Request, res: Response): void {
  const hash = currentSessionHash(req);
  if (hash) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
    dropMainSessionTunnels(hash);
  }
  res.clearCookie(COOKIE, { path: "/" });
  res.clearCookie(SECURE_COOKIE, { path: "/", secure: true });
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined; // malformed escape: no session rather than a throw
      }
    }
  }
  return undefined;
}

/** Resolves the user from the session cookie of an HTTP request or WebSocket upgrade. */
export function userFromRequest(req: IncomingMessage): User | undefined {
  const hash = currentSessionHash(req);
  if (!hash) return undefined;
  const row = db
    .prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.suspended = 0")
    .get(hash, Date.now()) as UserRow | undefined;
  if (!row) return undefined;
  touchSession(hash);
  touchUser(row.id);
  return toUser(row);
}

/** Records session use at most once every 5 minutes per session. */
function touchSession(hash: string): void {
  const now = Date.now();
  if ((used.get(hash) ?? 0) > now - 300_000) return;
  used.set(hash, now);
  db.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?").run(now, hash);
}

const seen = new Map<string, number>();

/** Records activity at most once every 5 minutes per user. */
function touchUser(id: string): void {
  const now = Date.now();
  if ((seen.get(id) ?? 0) > now - 300_000) return;
  seen.set(id, now);
  db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now, id);
}

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  const user = userFromRequest(req);
  if (!user) {
    res.status(401).json({ error: "Non connecté" });
    return;
  }
  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: "Réservé aux administrateurs" });
    return;
  }
  next();
}

export function pruneSessions(): void {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  const live = new Set((db.prepare("SELECT token_hash FROM sessions").all() as { token_hash: string }[]).map((r) => r.token_hash));
  for (const k of used.keys()) if (!live.has(k)) used.delete(k);
}

// ---- Rate limiting for credential endpoints ---------------------------------------

const buckets = new Map<string, { count: number; reset: number }>();

/** Allows `limit` attempts per `windowMs` for a key (IP, or IP + email). */
export function rateLimit(key: string, limit = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();
