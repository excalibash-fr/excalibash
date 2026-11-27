import { Router } from "express";
import { db, getSetting, setSetting } from "../db.ts";
import { stat } from "node:fs/promises";
import { getUserRow, requireAdmin, requireUser, sha256 } from "../auth.ts";
import { config } from "../config.ts";
import { rooms } from "../hub.ts";
import { subtree, type ItemRow } from "../access.ts";
import { disconnectUserMachines, dropBoardTerminals, dropMachine, isMachineOnline } from "../terminals.ts";
import { dropBoardTunnels, dropMachineTunnels } from "../tunnels.ts";
import { evictRoom, kickUser } from "../rooms.ts";
import { HttpError, pid, publicUrl, str } from "../http.ts";
import { newInviteToken } from "./auth.ts";
import { sendTestMail, smtpStatus } from "../mailer.ts";
import { isEmail } from "../validate.ts";

/**
 * Administration is deliberately narrow: admins manage *accounts*, never content.
 * There is no way to read, reset, impersonate or join another user's data.
 */
export const adminApi = Router();
adminApi.use(requireUser, requireAdmin);

const num = (sql: string, ...args: any[]): number => (db.prepare(sql).get(...args) as { n: number | null }).n ?? 0;

async function dbFilesSize(): Promise<number> {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += (await stat(config.dbPath + suffix)).size;
    } catch {}
  }
  return total;
}

adminApi.get("/", async (_req, res) => {
  // Sizes are computed on ciphertext lengths only: nothing is decrypted, no names are read.
  const rows = db
    .prepare(
      `SELECT u.id, u.email, u.name, u.is_admin AS isAdmin, u.color, u.created_at AS createdAt,
        u.email_verified AS emailVerified, u.suspended, u.last_seen_at AS lastSeenAt,
        (SELECT COUNT(*) FROM items i WHERE i.owner_id = u.id AND i.kind = 'board') AS boards,
        (SELECT COUNT(*) FROM items i WHERE i.owner_id = u.id AND i.kind = 'folder') AS folders,
        (SELECT COUNT(*) FROM machines m WHERE m.owner_id = u.id) AS machines,
        (SELECT COUNT(*) FROM terminals t JOIN machines m ON m.id = t.machine_id WHERE m.owner_id = u.id AND t.status != 'exited') AS terminals,
        (SELECT COALESCE(SUM(length(b.elements)), 0) FROM boards b JOIN items i ON i.id = b.id WHERE i.owner_id = u.id) AS sBoards,
        (SELECT COALESCE(SUM(length(b.files)), 0) FROM boards b JOIN items i ON i.id = b.id WHERE i.owner_id = u.id) AS sImages,
        (SELECT COALESCE(SUM(length(b.preview)), 0) FROM boards b JOIN items i ON i.id = b.id WHERE i.owner_id = u.id) AS sPreviews,
        COALESCE(length(u.enc_library), 0) AS sLibrary,
        COALESCE(length(u.enc_vault), 0) + length(u.enc_private_key) + length(u.recovery_enc_private_key) + length(u.public_key)
          + (SELECT COALESCE(SUM(length(i.enc_name) + COALESCE(length(i.key_wrap), 0)), 0) FROM items i WHERE i.owner_id = u.id)
          + (SELECT COALESCE(SUM(length(m.enc_name) + length(m.enc_pub) + COALESCE(length(m.enc_auth), 0)), 0) FROM machines m WHERE m.owner_id = u.id) AS sOther
       FROM users u ORDER BY u.created_at`,
    )
    .all() as any[];
  const machineIds = db.prepare("SELECT id, owner_id AS ownerId FROM machines").all() as { id: string; ownerId: string }[];
  const online = new Map<string, number>();
  for (const m of machineIds) if (isMachineOnline(m.id)) online.set(m.ownerId, (online.get(m.ownerId) ?? 0) + 1);

  let storageTotal = 0;
  let machinesOnline = 0;
  const users = rows.map((r) => {
    const storage = { boards: r.sBoards, images: r.sImages, previews: r.sPreviews, library: r.sLibrary, other: r.sOther };
    const bytes = r.sBoards + r.sImages + r.sPreviews + r.sLibrary + r.sOther;
    storageTotal += bytes;
    machinesOnline += online.get(r.id) ?? 0;
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      isAdmin: r.isAdmin,
      color: r.color,
      createdAt: r.createdAt,
      emailVerified: !!r.emailVerified,
      suspended: !!r.suspended,
      lastSeenAt: r.lastSeenAt as number | null,
      boards: r.boards,
      folders: r.folders,
      items: r.boards + r.folders,
      machines: r.machines,
      machinesOnline: online.get(r.id) ?? 0,
      terminals: r.terminals,
      storageBytes: bytes,
      storage,
    };
  });
  const stats = {
    accounts: users.length,
    verified: users.filter((u) => u.emailVerified).length,
    pending: users.filter((u) => !u.emailVerified).length,
    suspended: users.filter((u) => u.suspended).length,
    storageBytes: storageTotal,
    dbFileBytes: await dbFilesSize(),
    machinesOnline,
    machines: machineIds.length,
    openBoards: rooms.size,
    signupsLast7Days: num("SELECT COUNT(*) AS n FROM users WHERE created_at > ?", Date.now() - 7 * 86400_000),
  };
  const invites = db
    .prepare(
      `SELECT i.token_hash AS id, i.note, i.expires_at AS expiresAt, i.created_at AS createdAt, u.name AS usedBy
       FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 50`,
    )
    .all();
  res.json({
    users,
    invites,
    stats,
    registrationOpen: getSetting("registration_open", "false") === "true",
    emailVerification: getSetting("email_verification", "true") === "true",
  });
});

adminApi.patch("/settings", (req, res) => {
  if (typeof req.body.registrationOpen === "boolean") setSetting("registration_open", String(req.body.registrationOpen));
  if (typeof req.body.emailVerification === "boolean") setSetting("email_verification", String(req.body.emailVerification));
  res.json({ ok: true });
});

adminApi.get("/smtp", (_req, res) => {
  res.json(smtpStatus());
});

/** Sends a test email (to the admin by default) and reports the SMTP server's answer. */
adminApi.post("/smtp/test", async (req, res) => {
  const to = str(req.body?.to, 254) || req.user!.email;
  if (!isEmail(to)) throw new HttpError(400, "Adresse email invalide");
  if (smtpStatus().mode === "off") throw new HttpError(400, "Aucun serveur SMTP configuré (variable SMTP_HOST)");
  const started = Date.now();
  try {
    await sendTestMail(to);
  } catch (e) {
    throw new HttpError(502, `Échec de l'envoi : ${(e as Error).message}`);
  }
  res.json({ ok: true, to, ms: Date.now() - started, status: smtpStatus() });
});

adminApi.post("/invites", (req, res) => {
  const token = newInviteToken();
  const days = Math.min(30, Math.max(1, Number(req.body.days) || 7));
  db.prepare("INSERT INTO invites (token_hash, created_by, note, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").run(
    sha256(token),
    req.user!.id,
    str(req.body.note, 100) || null,
    Date.now() + days * 86400_000,
    Date.now(),
  );
  res.json({ url: `${publicUrl(req)}/register?invite=${token}` });
});

adminApi.delete("/invites/:id", (req, res) => {
  db.prepare("DELETE FROM invites WHERE token_hash = ?").run(pid(req));
  res.json({ ok: true });
});

adminApi.patch("/users/:id", (req, res) => {
  const id = pid(req);
  if (id === req.user!.id) throw new HttpError(400, "Impossible de modifier son propre compte");
  const { isAdmin, suspended } = req.body;
  if (typeof isAdmin !== "boolean" && typeof suspended !== "boolean") throw new HttpError(400, "Rien à modifier");
  if (!getUserRow(id)) throw new HttpError(404, "Compte introuvable");
  if (typeof isAdmin === "boolean") {
    db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  }
  if (typeof suspended === "boolean") {
    db.prepare("UPDATE users SET suspended = ? WHERE id = ?").run(suspended ? 1 : 0, id);
    if (suspended) {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      kickUser(id, 4403, "compte suspendu");
      disconnectUserMachines(id);
    }
  }
  res.json({ ok: true });
});

/** Removes a user and everything they own, closing live rooms, terminals and tunnels first. */
export function purgeUser(id: string): void {
  kickUser(id, 4403, "compte supprimé");
  const roots = db.prepare("SELECT * FROM items WHERE owner_id = ? AND parent_id IS NULL").all(id) as ItemRow[];
  for (const root of roots) {
    for (const i of subtree(root.id)) {
      if (i.kind !== "board") continue;
      evictRoom(i.id, 4404, "supprimé", true);
      dropBoardTerminals(i.id);
      dropBoardTunnels(i.id);
    }
  }
  for (const { id: m } of db.prepare("SELECT id FROM machines WHERE owner_id = ?").all(id) as { id: string }[]) {
    dropMachine(m);
    dropMachineTunnels(m);
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

adminApi.delete("/users/:id", (req, res) => {
  const id = pid(req);
  if (id === req.user!.id) throw new HttpError(400, "Impossible de supprimer son propre compte");
  purgeUser(id);
  res.json({ ok: true });
});
