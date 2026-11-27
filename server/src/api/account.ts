import { Router } from "express";
import { db } from "../db.ts";
import { currentSessionHash, destroySession, rateLimit, requireUser, verifySecret, getUserRow } from "../auth.ts";
import { assertNotLocked, failed, succeeded } from "../lockout.ts";
import { kickSession } from "../rooms.ts";
import { dropMainSessionTunnels, dropUserTunnelSessions } from "../tunnelSessions.ts";
import { HttpError, blob } from "../http.ts";
import { purgeUser } from "./admin.ts";
import { emailEnabled } from "../mailer.ts";
import { NOTIFY_EVENTS, getPrefs, setPrefs, type NotifyPrefs } from "../notify.ts";

/** The signed-in user's own account: onboarding state, self-service deletion. */
export const accountApi = Router();
accountApi.use(requireUser);

accountApi.get("/", (req, res) => {
  const row = db.prepare("SELECT onboarded, findable_name, findable_email FROM users WHERE id = ?").get(req.user!.id) as {
    onboarded: number;
    findable_name: number;
    findable_email: number;
  };
  res.json({
    onboarded: !!row.onboarded,
    findableName: !!row.findable_name,
    findableEmail: !!row.findable_email,
    notifications: getPrefs(req.user!.id),
    emailEnabled: emailEnabled(),
  });
});

accountApi.put("/notifications", (req, res) => {
  const body = req.body ?? {};
  if (!NOTIFY_EVENTS.every((e) => typeof body[e] === "boolean")) throw new HttpError(400, "Valeur invalide");
  const prefs = Object.fromEntries(NOTIFY_EVENTS.map((e) => [e, body[e]])) as NotifyPrefs;
  setPrefs(req.user!.id, prefs);
  res.json(prefs);
});

accountApi.put("/visibility", (req, res) => {
  const { findableName, findableEmail } = req.body ?? {};
  if (typeof findableName !== "boolean" || typeof findableEmail !== "boolean") throw new HttpError(400, "Valeur invalide");
  db.prepare("UPDATE users SET findable_name = ?, findable_email = ? WHERE id = ?").run(findableName ? 1 : 0, findableEmail ? 1 : 0, req.user!.id);
  res.json({ findableName, findableEmail });
});

accountApi.post("/onboarded", (req, res) => {
  db.prepare("UPDATE users SET onboarded = 1 WHERE id = ?").run(req.user!.id);
  res.json({ ok: true });
});

type SessionRow = { token_hash: string; public_id: string; created_at: number | null; last_used_at: number | null; user_agent_label: string | null; ip_prefix: string | null };

/** Lists the caller's own sessions (coarse metadata only; ids are opaque, not token hashes). */
accountApi.get("/sessions", (req, res) => {
  const cur = currentSessionHash(req);
  const rows = db
    .prepare(
      "SELECT token_hash, public_id, created_at, last_used_at, user_agent_label, ip_prefix FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY COALESCE(last_used_at, created_at, 0) DESC",
    )
    .all(req.user!.id, Date.now()) as SessionRow[];
  res.json(
    rows.map((r) => ({
      id: r.public_id,
      current: r.token_hash === cur,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at ?? r.created_at,
      label: r.user_agent_label ?? "",
      ipPrefix: r.ip_prefix ?? "",
    })),
  );
});

accountApi.post("/sessions/revoke-others", (req, res) => {
  if (!rateLimit(`sessions:${req.user!.id}`, 20)) throw new HttpError(429, "Trop d'essais, réessaie plus tard");
  const cur = currentSessionHash(req) ?? "";
  const others = db.prepare("SELECT token_hash FROM sessions WHERE user_id = ? AND token_hash != ?").all(req.user!.id, cur) as { token_hash: string }[];
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(req.user!.id, cur);
  dropUserTunnelSessions(req.user!.id, cur);
  for (const o of others) kickSession(o.token_hash, 4001, "session terminée");
  res.json({ ok: true, revoked: others.length });
});

accountApi.delete("/sessions/:id", (req, res) => {
  if (!rateLimit(`sessions:${req.user!.id}`, 20)) throw new HttpError(429, "Trop d'essais, réessaie plus tard");
  const row = db.prepare("SELECT token_hash FROM sessions WHERE public_id = ? AND user_id = ?").get(String(req.params.id), req.user!.id) as
    | { token_hash: string }
    | undefined;
  if (!row) throw new HttpError(404, "Session introuvable");
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(row.token_hash);
  dropMainSessionTunnels(row.token_hash);
  kickSession(row.token_hash, 4001, "session terminée");
  res.json({ ok: true, current: row.token_hash === currentSessionHash(req) });
});

accountApi.delete("/", async (req, res) => {
  const user = req.user!;
  if (!rateLimit(`account-delete:${user.id}`, 5, 15 * 60_000)) throw new HttpError(429, "Trop d'essais, réessaie plus tard");
  const authKey = blob(req.body?.authKey, 100);
  const keys = { account: user.id, ip: req.ip! };
  assertNotLocked("reauth", keys);
  const row = getUserRow(user.id);
  if (!row || !verifySecret(authKey, row.auth_hash)) {
    await failed("reauth", keys);
    throw new HttpError(403, "Mot de passe incorrect");
  }
  succeeded("reauth", keys);
  if (user.isAdmin) {
    const others = db.prepare("SELECT COUNT(*) AS n FROM users WHERE id != ?").get(user.id) as { n: number };
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id != ?").get(user.id) as { n: number };
    if (others.n > 0 && admins.n === 0) throw new HttpError(400, "Nomme d'abord un autre administrateur");
  }
  purgeUser(user.id);
  destroySession(req, res);
  res.json({ ok: true });
});
