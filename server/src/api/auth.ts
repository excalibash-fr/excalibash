import { Router, type NextFunction, type Request, type Response } from "express";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { db, getSetting, isClientId } from "../db.ts";
import {
  createSession,
  currentSessionHash,
  destroySession,
  fakeSalt,
  findUserByEmail,
  getUserRow,
  hashSecret,
  pickColor,
  type UserRow,
  rateLimit,
  requireUser,
  sha256,
  toUser,
  userCount,
  userFromRequest,
  verifySecret,
  verifySecretAsync,
  burnVerifyAsync,
  hashSecretAsync,
} from "../auth.ts";
import { HttpError, blob, mailLink, str } from "../http.ts";
import { config } from "../config.ts";
import { emailEnabled, sendVerificationCode, verificationRequired } from "../mailer.ts";
import { notify } from "../notify.ts";
import { createChallenge, verifyPow } from "../pow.ts";
import { kickUser } from "../rooms.ts";
import { dropUserTunnelSessions } from "../tunnelSessions.ts";
import { isEmail } from "../validate.ts";

export const authApi = Router();

// First account: whoever registers first becomes admin, so a fresh instance asks for a code
// printed in the server log. A stranger who finds the instance before its owner can't take it.
const SETUP_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
let setupCode: string | null = null;

const normalizeCode = (code: unknown) =>
  String(code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

/** Prints the setup code while the instance has no account (called at startup). */
export function announceSetup() {
  if (userCount() > 0) return;
  setupCode ??= normalizeCode(config.setupCode) || Array.from({ length: 8 }, () => SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)]).join("");
  console.log(`Code d'installation (création du compte administrateur) : ${setupCode.slice(0, 4)}-${setupCode.slice(4)}`);
}

function checkSetupCode(code: unknown) {
  if (!setupCode) announceSetup();
  const given = Buffer.from(normalizeCode(code));
  const want = Buffer.from(setupCode ?? "");
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new HttpError(403, "Code d'installation invalide : il est affiché dans les logs du serveur");
  }
}

function registrationOpen(): boolean {
  return userCount() === 0 || getSetting("registration_open", "false") === "true";
}

function limit(key: string, max = 10, windowMs = 60_000) {
  if (!rateLimit(key, max, windowMs)) throw new HttpError(429, "Trop de tentatives, réessaie dans une minute");
}

type Flags = { email_verified: number; suspended: number; verify_code_hash: string | null; verify_expires: number | null; verify_attempts: number };
const flags = (id: string) => db.prepare("SELECT email_verified, suspended, verify_code_hash, verify_expires, verify_attempts FROM users WHERE id = ?").get(id) as Flags;

function coded(status: number, error: string, code: string): never {
  throw Object.assign(new HttpError(status, error), { code });
}

function checkSuspended(id: string) {
  if (flags(id).suspended) coded(403, "Ce compte est suspendu.", "SUSPENDED");
}

const CODE_TTL = 15 * 60_000;

async function issueCode(id: string, email: string) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  db.prepare("UPDATE users SET verify_code_hash = ?, verify_expires = ?, verify_attempts = 0 WHERE id = ?").run(sha256(code), Date.now() + CODE_TTL, id);
  await sendVerificationCode(email, code);
}

// Unverified accounts are not kept for more than a day.
setInterval(() => {
  const old = Date.now() - 24 * 3600_000;
  db.prepare("UPDATE invites SET used_by = NULL WHERE used_by IN (SELECT id FROM users WHERE email_verified = 0 AND created_at < ?)").run(old);
  db.prepare("DELETE FROM users WHERE email_verified = 0 AND created_at < ?").run(old);
}, 3600_000).unref();

authApi.get("/challenge", (req, res) => {
  limit(`chal:${req.ip}`, 30);
  res.json(createChallenge());
});

authApi.get("/status", (_req, res) => {
  res.json({ needsSetup: userCount() === 0, registrationOpen: registrationOpen() });
});

/** KDF salt for an email; unknown emails get a stable fake one. */
authApi.post("/prelogin", (req, res) => {
  limit(`pre:${req.ip}`, 30);
  const email = str(req.body.email);
  const row = findUserByEmail(email);
  res.json({ salt: row ? row.kdf_salt : fakeSalt(email) });
});

type InviteRow = { token_hash: string; expires_at: number; used_by: string | null };

authApi.get("/invite/:token", (req, res) => {
  const inv = db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(sha256(String(req.params.token))) as InviteRow | undefined;
  res.json({ valid: !!inv && !inv.used_by && inv.expires_at > Date.now() });
});

authApi.post("/register", async (req, res) => {
  const b = req.body;
  if (b.website) throw new HttpError(400, "Requête invalide");
  if (!verifyPow(b.pow)) throw new HttpError(400, "Vérification anti-robot échouée, réessaie");
  let invite: InviteRow | undefined;
  if (userCount() === 0) {
    limit(`setup:${req.ip}`, 10, 600_000);
    checkSetupCode(b.setupCode);
  } else if (b.invite) {
    invite = db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(sha256(String(b.invite))) as InviteRow | undefined;
    if (!invite || invite.used_by || invite.expires_at < Date.now()) throw new HttpError(403, "Invitation invalide ou expirée");
  } else if (!registrationOpen()) {
    throw new HttpError(403, "Les inscriptions sont fermées : il faut une invitation");
  }
  // Counted only for sign-ups that are allowed: refused attempts can't use up these caps.
  limit(`reg:${req.ip}`, 5);
  if (!rateLimit("reg:global", config.registrationsPerHour, 3600_000)) throw new HttpError(429, "Trop d'inscriptions en ce moment, réessaie plus tard");
  const email = str(b.email);
  const name = str(b.name, 60);
  if (!isEmail(email)) throw new HttpError(400, "Email invalide");
  if (!name) throw new HttpError(400, "Nom requis");
  if (!isClientId(b.id)) throw new HttpError(400, "Identifiant invalide");
  // Hashed first (off the main thread): from the checks to the insert, nothing awaits, so two
  // registrations can't both pass them (nor both become the first, admin, account).
  const authHash = await hashSecretAsync(blob(b.authKey, 100));
  const recoveryHash = await hashSecretAsync(blob(b.recoveryAuth, 100));
  const existing = findUserByEmail(email);
  if (existing && emailEnabled() && !flags(existing.id).email_verified) {
    throw new HttpError(409, "Un compte attend déjà la vérification de cet email : utilise « Renvoyer le code » ou réessaie dans 24 h");
  }
  if (existing || getUserRow(b.id)) throw new HttpError(409, "Cet email est déjà utilisé");
  const verify = verificationRequired();
  const first = userCount() === 0;
  db.prepare(
    `INSERT INTO users (id, email, name, auth_hash, kdf_salt, public_key, enc_private_key, recovery_enc_private_key, recovery_auth_hash, is_admin, color, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    b.id,
    email,
    name,
    authHash,
    blob(b.salt, 64),
    blob(b.publicKey, 100),
    blob(b.encPrivateKey, 400),
    blob(b.recoveryEncPrivateKey, 400),
    recoveryHash,
    first ? 1 : 0,
    pickColor(userCount()),
    Date.now(),
  );
  if (first) setupCode = null;
  if (invite) db.prepare("UPDATE invites SET used_by = ? WHERE token_hash = ?").run(b.id, invite.token_hash);
  if (verify) {
    db.prepare("UPDATE users SET email_verified = 0 WHERE id = ?").run(b.id);
    try {
      await issueCode(b.id, email);
    } catch (e) {
      console.error(e);
      db.prepare("UPDATE invites SET used_by = NULL WHERE used_by = ?").run(b.id);
      db.prepare("DELETE FROM users WHERE id = ?").run(b.id);
      throw new HttpError(502, "Impossible d'envoyer l'email de vérification, réessaie plus tard");
    }
    res.json({ needsVerification: true });
    return;
  }
  createSession(req, res, b.id);
  res.json({ user: toUser(getUserRow(b.id)!) });
});

authApi.post("/verify", (req, res) => {
  const email = str(req.body.email);
  const code = str(req.body.code, 12);
  limit(`verify:${req.ip}`, 20);
  limit(`verify:${email.toLowerCase()}`, 10);
  const bad = () => new HttpError(400, "Code incorrect ou expiré");
  const row = findUserByEmail(email);
  if (!row) throw bad();
  const f = flags(row.id);
  if (f.email_verified || !f.verify_code_hash || !f.verify_expires || f.verify_expires < Date.now()) throw bad();
  if (f.verify_attempts >= 5) {
    db.prepare("UPDATE users SET verify_code_hash = NULL, verify_expires = NULL WHERE id = ?").run(row.id);
    throw bad();
  }
  db.prepare("UPDATE users SET verify_attempts = verify_attempts + 1 WHERE id = ?").run(row.id);
  const a = Buffer.from(sha256(code));
  const b = Buffer.from(f.verify_code_hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw bad();
  db.prepare("UPDATE users SET email_verified = 1, verify_code_hash = NULL, verify_expires = NULL, verify_attempts = 0 WHERE id = ?").run(row.id);
  checkSuspended(row.id);
  createSession(req, res, row.id);
  res.json({ user: toUser(row) });
});

authApi.post("/resend", async (req, res) => {
  const email = str(req.body.email);
  limit(`resend:${req.ip}`, 10);
  limit(`resend:${email.toLowerCase()}`, 3, 600_000);
  const row = emailEnabled() ? findUserByEmail(email) : undefined;
  if (row && !flags(row.id).email_verified) {
    try {
      await issueCode(row.id, row.email);
    } catch (e) {
      console.error(e);
    }
  }
  res.json({ ok: true });
});

authApi.post("/login", async (req, res) => {
  const email = str(req.body.email);
  limit(`login:${req.ip}`, 20);
  limit(`login:${email.toLowerCase()}`, 8);
  const row = findUserByEmail(email);
  const authKey = String(req.body.authKey ?? "");
  if (!row || !(await verifySecretAsync(authKey, row.auth_hash))) {
    if (!row) await burnVerifyAsync(authKey);
    throw new HttpError(401, "Email ou mot de passe incorrect");
  }
  if (!flags(row.id).email_verified) coded(403, "Vérifie ton email pour te connecter.", "EMAIL_NOT_VERIFIED");
  checkSuspended(row.id);
  createSession(req, res, row.id);
  const when = new Date().toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "short" });
  notify(req, [row.id], "newLogin", "Excalibash : nouvelle connexion à ton compte", () => ({
    title: "Nouvelle connexion à ton compte",
    lines: [`Quelqu'un vient de se connecter à ton compte Excalibash le **${when}**, depuis l'adresse **${req.ip}**.`],
    button: mailLink(req, "/account", "Changer mon mot de passe"),
    note: "Si c'est toi, tu n'as rien à faire. Sinon, change ton mot de passe tout de suite : les autres appareils seront déconnectés.",
  }));
  res.json({ user: toUser(row), keys: { publicKey: row.public_key, encPrivateKey: row.enc_private_key } });
});

/** Step 1 of account recovery: prove the recovery key, receive the private key encrypted under it. */
authApi.post("/recover", async (req, res) => {
  const email = str(req.body.email);
  limit(`recover:${req.ip}`, 5);
  const row = findUserByEmail(email);
  const proof = String(req.body.recoveryAuth ?? "");
  if (!row || !(await verifySecretAsync(proof, row.recovery_auth_hash))) {
    if (!row) await burnVerifyAsync(proof);
    throw new HttpError(401, "Email ou clé de récupération incorrecte");
  }
  checkSuspended(row.id);
  res.json({ userId: row.id, publicKey: row.public_key, recoveryEncPrivateKey: row.recovery_enc_private_key });
});

/** Step 2: set a new password (re-encrypted private key), logging out every other session. */
authApi.post("/recover/finish", async (req, res) => {
  const email = str(req.body.email);
  limit(`recover:${req.ip}`, 5);
  const row = findUserByEmail(email);
  const proof = String(req.body.recoveryAuth ?? "");
  if (!row || !(await verifySecretAsync(proof, row.recovery_auth_hash))) {
    if (!row) await burnVerifyAsync(proof);
    throw new HttpError(401, "Email ou clé de récupération incorrecte");
  }
  checkSuspended(row.id);
  db.prepare("UPDATE users SET auth_hash = ?, kdf_salt = ?, enc_private_key = ? WHERE id = ?").run(
    await hashSecretAsync(blob(req.body.authKey, 100)),
    blob(req.body.salt, 64),
    blob(req.body.encPrivateKey, 400),
    row.id,
  );
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id);
  dropUserTunnelSessions(row.id);
  // Live boards opened with the old sessions are cut too (the client reconnects if it still can).
  kickUser(row.id, 4001, "session terminée");
  createSession(req, res, row.id);
  res.json({ user: toUser(row), keys: { publicKey: row.public_key, encPrivateKey: blob(req.body.encPrivateKey, 400) } });
});

authApi.post("/logout", (req, res) => {
  const user = userFromRequest(req);
  destroySession(req, res);
  if (user) kickUser(user.id, 4001, "session terminée");
  res.json({ ok: true });
});

authApi.use(requireUser);

authApi.get("/me", (req, res) => {
  const row = getUserRow(req.user!.id)!;
  res.json({ user: req.user, encVault: row.enc_vault });
});

/** Material needed to unlock the private key on a device that has a session but no key yet. */
authApi.get("/keys", (req, res) => {
  const row = getUserRow(req.user!.id)!;
  res.json({ salt: row.kdf_salt, publicKey: row.public_key, encPrivateKey: row.enc_private_key });
});

authApi.patch("/me", (req, res) => {
  const name = str(req.body.name, 60);
  if (name) db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, req.user!.id);
  res.json({ user: { ...req.user, name: name || req.user!.name } });
});

authApi.put("/vault", (req, res) => {
  db.prepare("UPDATE users SET enc_vault = ? WHERE id = ?").run(blob(req.body.encVault, 2_000_000), req.user!.id);
  res.json({ ok: true });
});

authApi.post("/password", (req, res) => {
  limit(`pw:${req.user!.id}`, 5);
  const row = getUserRow(req.user!.id)!;
  if (!verifySecret(String(req.body.authKey ?? ""), row.auth_hash)) throw new HttpError(400, "Mot de passe actuel incorrect");
  db.prepare("UPDATE users SET auth_hash = ?, kdf_salt = ?, enc_private_key = ? WHERE id = ?").run(
    hashSecret(blob(req.body.newAuthKey, 100)),
    blob(req.body.newSalt, 64),
    blob(req.body.newEncPrivateKey, 400),
    row.id,
  );
  // Every other device must log in again with the new password.
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(row.id, currentSessionHash(req) ?? "");
  dropUserTunnelSessions(row.id, currentSessionHash(req) ?? "");
  kickUser(row.id, 4001, "session terminée");
  res.json({ ok: true });
});

/** Whether `a` and `b` already share an item (either way): a hidden account stays findable by its collaborators. */
function shareSomething(a: string, b: string): boolean {
  return !!db.prepare("SELECT 1 FROM grants g1 JOIN grants g2 ON g2.item_id = g1.item_id WHERE g1.user_id = ? AND g2.user_id = ? LIMIT 1").get(a, b);
}

/**
 * Public key lookup for sharing. With an "@": exact email, found only if the owner allows it (or we already share
 * something). Otherwise: name search (exact or prefix) among accounts findable by name. Misses all look alike, and an
 * email is only returned to people allowed to know it.
 */
authApi.get("/lookup", (req, res) => {
  const me = req.user!.id;
  limit(`lookup:${me}`, 30);
  const q = str(req.query.q ?? req.query.email, 100);
  const out = (r: UserRow) => ({
    id: r.id,
    name: r.name,
    publicKey: r.public_key,
    color: r.color,
    ...(r.id === me || r.findable_email || shareSomething(me, r.id) ? { email: r.email } : {}),
  });
  if (q.includes("@")) {
    const row = findUserByEmail(q);
    // An unverified account may use someone else's address; a suspended one can't receive anything.
    const usable = row && (row.id === me || (flags(row.id).email_verified && !flags(row.id).suspended));
    if (!row || !usable || (row.id !== me && !row.findable_email && !shareSomething(me, row.id))) throw new HttpError(404, "Aucun compte trouvé");
    res.json({ users: [out(row)] });
    return;
  }
  if (q.length < 2) {
    res.json({ users: [] });
    return;
  }
  const like = q.toLowerCase().replace(/[\\%_]/g, "\\$&") + "%";
  const rows = db
    .prepare(
      `SELECT * FROM users u WHERE u.id != ? AND u.suspended = 0 AND u.email_verified = 1 AND lower(u.name) LIKE ? ESCAPE '\\'
         AND (u.findable_name = 1 OR EXISTS (SELECT 1 FROM grants g1 JOIN grants g2 ON g2.item_id = g1.item_id WHERE g1.user_id = ? AND g2.user_id = u.id))
       ORDER BY (lower(u.name) = ?) DESC, lower(u.name) LIMIT 8`,
    )
    .all(me, like, me, q.toLowerCase()) as UserRow[];
  res.json({ users: rows.map(out) });
});

export function newInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

// Keeps the machine-readable `code` of errors thrown by `coded` (the global handler only sends the message).
authApi.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof HttpError && typeof (err as any).code === "string") {
    res.status(err.status).json({ error: err.message, code: (err as any).code });
    return;
  }
  next(err);
});
