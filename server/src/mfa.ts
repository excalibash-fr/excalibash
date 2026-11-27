import { createHmac, randomBytes, randomInt } from "node:crypto";
import { db, getSetting, serverSecret, tx } from "./db.ts";
import { sha256, type UserRow } from "./auth.ts";
import { base32Encode, newSecret, open, otpauthUri, seal, verifyTotp } from "./totp.ts";

// Second factor: storage of the TOTP secret and backup codes, and the short-lived token between the password
// and the code of a login. The routes live in api/auth.ts (login), api/account.ts (management), api/admin.ts.

let sealKey: Buffer | undefined;
/** AES key for the TOTP secrets, derived from server_secret: the server must read them back to check a code. */
const key = (): Buffer => (sealKey ??= createHmac("sha256", serverSecret()).update("excalibash totp secret v1").digest());

// ---- Enrolment --------------------------------------------------------------------------

/** A new secret, kept (sealed) as the pending one until a first code proves the app has it. */
export function beginSetup(userId: string, email: string): { secret: string; uri: string } {
  const secret = newSecret();
  db.prepare("UPDATE users SET totp_pending = ? WHERE id = ?").run(seal(key(), userId, secret), userId);
  const b32 = base32Encode(secret);
  return { secret: b32, uri: otpauthUri(email, b32) };
}

/** Activates the pending secret if `code` is right for it; returns the backup codes (shown once), or null. */
export function finishSetup(row: UserRow, code: string): string[] | null {
  const secret = row.totp_pending ? open(key(), row.id, row.totp_pending) : null;
  if (!secret) return null;
  const step = verifyTotp(secret, code.replace(/\s/g, ""), Date.now(), 0);
  if (step === null) return null;
  return tx(() => {
    db.prepare("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1, totp_last_step = ? WHERE id = ?").run(step, row.id);
    return writeBackupCodes(row.id);
  });
}

/** Turns the second factor off: secret, pending secret, replay memory and backup codes all go. */
export function clearMfa(userId: string): void {
  tx(() => {
    db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_last_step = 0 WHERE id = ?").run(userId);
    db.prepare("DELETE FROM mfa_backup_codes WHERE user_id = ?").run(userId);
  });
}

// ---- Backup codes -----------------------------------------------------------------------

const BACKUP_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/1/I/L/O: readable on paper
/** Backup codes are kept as HMAC-SHA256 under a key derived from server_secret (not a bare hash of a 50-bit code). */
let backupKey: Buffer | undefined;
const backupHash = (code: string): string =>
  createHmac("sha256", (backupKey ??= createHmac("sha256", serverSecret()).update("excalibash backup code v1").digest())).update(code).digest("hex");
const normalizeBackup = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Replaces the user's backup codes by 10 new ones ("XXXXX-XXXXX"); only their hashes are kept. Inside a transaction. */
function writeBackupCodes(userId: string): string[] {
  const codes = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)]).join(""));
  db.prepare("DELETE FROM mfa_backup_codes WHERE user_id = ?").run(userId);
  for (const c of codes) db.prepare("INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES (?, ?)").run(userId, backupHash(c));
  return codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`);
}

export const newBackupCodes = (userId: string): string[] => tx(() => writeBackupCodes(userId));

export const backupRemaining = (userId: string): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM mfa_backup_codes WHERE user_id = ?").get(userId) as { n: number }).n;

/**
 * Checks a TOTP code or a backup code of an account with the second factor on, and uses it up (the TOTP step is
 * remembered, a backup code is deleted). Counting failures and answering is up to the caller.
 */
export function checkSecondFactor(row: UserRow, code: string): "totp" | "backup" | null {
  if (!row.totp_enabled || !row.totp_secret) return null;
  const digits = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits)) {
    const secret = open(key(), row.id, row.totp_secret);
    const step = secret && verifyTotp(secret, digits, Date.now(), row.totp_last_step);
    if (step == null) return null;
    // Guarded: of two requests carrying the same code, only one moves the step forward.
    return db.prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?").run(step, row.id, step).changes === 1 ? "totp" : null;
  }
  const norm = normalizeBackup(code);
  if (norm.length !== 10) return null;
  return db.prepare("DELETE FROM mfa_backup_codes WHERE user_id = ? AND code_hash = ?").run(row.id, backupHash(norm)).changes === 1 ? "backup" : null;
}

// ---- Admins -----------------------------------------------------------------------------

export const mfaRequiredForAdmins = (): boolean => getSetting("mfa_required_admins", "false") === "true";

// ---- Login token: password accepted, code still to give ----------------------------------

const TOKEN_TTL = 5 * 60_000;
const TOKEN_TRIES = 5;
const MAX_TOKENS = 10_000;
type Kind = "login" | "recover"; // a token of one flow never works in the other
type Pending = { userId: string; kind: Kind; expires: number; tries: number };
const tokens = new Map<string, Pending>(); // by sha256 of the token: a memory dump does not yield usable tokens

export function issueMfaToken(userId: string, kind: Kind = "login"): string {
  const now = Date.now();
  if (tokens.size >= MAX_TOKENS) {
    for (const [k, t] of tokens) if (t.expires <= now) tokens.delete(k);
    if (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value!);
  }
  const token = randomBytes(32).toString("base64url");
  tokens.set(sha256(token), { userId, kind, expires: now + TOKEN_TTL, tries: 0 });
  return token;
}

/** The user a live token belongs to. */
export function mfaTokenUser(token: unknown, kind: Kind = "login"): string | undefined {
  if (typeof token !== "string") return undefined;
  const t = tokens.get(sha256(token));
  return t && t.kind === kind && t.expires > Date.now() ? t.userId : undefined;
}

/** A wrong code: the token is destroyed at its 5th. */
export function strikeMfaToken(token: string): void {
  const k = sha256(token);
  const t = tokens.get(k);
  if (t && ++t.tries >= TOKEN_TRIES) tokens.delete(k);
}

export const dropMfaToken = (token: string): void => void tokens.delete(sha256(token));

/** Tokens do not outlive a password or an MFA change. */
export function dropMfaTokensOf(userId: string): void {
  for (const [k, t] of tokens) if (t.userId === userId) tokens.delete(k);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of tokens) if (t.expires <= now) tokens.delete(k);
}, 60_000).unref();

