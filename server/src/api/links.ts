// Public read-only links to one board. The URL is `/v/<token>#<linkKey>`: the server learns the
// token (and stores only its SHA-256), never the link key, which stays in the URL fragment.
// There is no write path for links: a link can only be used to read the board's ciphertext.
import { Router, type Request } from "express";
import { randomBytes } from "node:crypto";
import { db, tx } from "../db.ts";
import { rateLimit, sha256 } from "../auth.ts";
import { atLeast, getItem, isTrashed, roleOn } from "../access.ts";
import { HttpError, blob, pid } from "../http.ts";
import { flushRoom } from "../rooms.ts";
import { isId22 } from "../validate.ts";

const MAX_LINKS_PER_BOARD = 20;
const PUBLIC_ID_RE = /^[0-9a-f]{16}$/;

type LinkRow = {
  token_hash: string;
  public_id: string;
  board_id: string;
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
  key_epoch: number;
  wrapped_key: string;
  enc_label: string | null;
  enc_title: string | null;
};

// ---- Authenticated management (owner and editors of the board) ----------------------

export const linksApi = Router();

function needEditor(req: Request) {
  const item = getItem(pid(req));
  const role = item ? roleOn(req.user!.id, item.id) : undefined;
  if (!item || !role || item.kind !== "board") throw new HttpError(404, "Tableau introuvable");
  if (!atLeast(role, "editor")) throw new HttpError(403, "Réservé aux éditeurs du tableau");
  if (role !== "owner" && isTrashed(item.id)) throw new HttpError(404, "Tableau introuvable");
  return item;
}

linksApi.post("/items/:id/links", (req, res) => {
  const item = needEditor(req);
  if (isTrashed(item.id)) throw new HttpError(400, "Sors d'abord le tableau de la corbeille");
  const b = req.body ?? {};
  if (b.epoch !== item.key_epoch) throw new HttpError(409, "Clés renouvelées, recharge la page");
  const publicId = String(b.publicId ?? "");
  if (!PUBLIC_ID_RE.test(publicId)) throw new HttpError(400, "Identifiant invalide");
  const wrappedKey = blob(b.wrappedKey, 300);
  const encLabel = b.encLabel ? blob(b.encLabel, 2000) : null;
  const encTitle = b.encTitle ? blob(b.encTitle, 2000) : null;
  let expiresAt: number | null = null;
  if (b.expiresAt !== undefined && b.expiresAt !== null) {
    expiresAt = Number(b.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new HttpError(400, "Date d'expiration invalide");
  }
  const token = randomBytes(16).toString("base64url");
  tx(() => {
    const n = (db.prepare("SELECT COUNT(*) AS n FROM board_links WHERE board_id = ?").get(item.id) as { n: number }).n;
    if (n >= MAX_LINKS_PER_BOARD) throw new HttpError(400, `Ce tableau a déjà ${MAX_LINKS_PER_BOARD} liens publics`);
    if (db.prepare("SELECT 1 FROM board_links WHERE public_id = ?").get(publicId)) throw new HttpError(400, "Identifiant invalide");
    db.prepare(
      `INSERT INTO board_links (token_hash, public_id, board_id, created_by, created_at, expires_at, key_epoch, wrapped_key, enc_label, enc_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sha256(token), publicId, item.id, req.user!.id, Date.now(), expiresAt, item.key_epoch, wrappedKey, encLabel, encTitle);
  });
  // The raw token is returned once and never stored.
  res.set("Cache-Control", "no-store").json({ publicId, token });
});

linksApi.get("/items/:id/links", (req, res) => {
  const item = needEditor(req);
  const rows = db
    .prepare(
      `SELECT l.public_id AS publicId, l.enc_label AS encLabel, l.created_at AS createdAt, l.expires_at AS expiresAt, l.key_epoch AS epoch, u.name AS createdBy
       FROM board_links l LEFT JOIN users u ON u.id = l.created_by WHERE l.board_id = ? ORDER BY l.created_at`,
    )
    .all(item.id);
  res.set("Cache-Control", "no-store").json(rows);
});

linksApi.delete("/items/:id/links/:publicId", (req, res) => {
  const item = needEditor(req);
  const r = db.prepare("DELETE FROM board_links WHERE board_id = ? AND public_id = ?").run(item.id, pid(req, "publicId"));
  if (!r.changes) throw new HttpError(404, "Lien introuvable");
  res.json({ ok: true });
});

// ---- Public, unauthenticated read ---------------------------------------------------

export const publicApi = Router();

const NOT_FOUND = "Lien introuvable ou expiré";

publicApi.get("/:token", (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!rateLimit(`public:${req.ip}`, 60)) throw new HttpError(429, "Trop de requêtes, réessaie dans une minute");
  const token = String(req.params.token);
  // Malformed and unknown tokens answer exactly like expired ones.
  const hash = sha256(isId22(token) ? token : "invalid");
  if (!rateLimit(`public-token:${hash}`, 300)) throw new HttpError(429, "Trop de requêtes, réessaie dans une minute");
  const link = isId22(token) ? (db.prepare("SELECT * FROM board_links WHERE token_hash = ?").get(hash) as LinkRow | undefined) : undefined;
  const item = link ? getItem(link.board_id) : undefined;
  if (!link || !item || item.kind !== "board" || (link.expires_at !== null && link.expires_at <= Date.now()) || link.key_epoch !== item.key_epoch || isTrashed(item.id)) {
    throw new HttpError(404, NOT_FOUND);
  }
  flushRoom(item.id);
  const fresh = getItem(item.id)!;
  const etag = `"${fresh.updated_at}-${fresh.key_epoch}-${link.public_id}"`;
  res.set("ETag", etag);
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  const row = db.prepare("SELECT elements, files FROM boards WHERE id = ?").get(item.id) as { elements: string; files: string };
  res.json({
    boardId: item.id,
    publicId: link.public_id,
    epoch: link.key_epoch,
    wrappedKey: link.wrapped_key,
    encTitle: link.enc_title,
    updatedAt: fresh.updated_at,
    elements: JSON.parse(row.elements),
    files: JSON.parse(row.files),
  });
});
