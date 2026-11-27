import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";

const SCHEMA_VERSION = 2;

mkdirSync(dirname(config.dbPath), { recursive: true });

// Databases from before end-to-end encryption cannot be migrated: their content was never encrypted
// client-side. Keep them aside instead of mixing plaintext with the new model.
if (existsSync(config.dbPath)) {
  const probe = new DatabaseSync(config.dbPath);
  const version = (probe.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  const hasTables = !!probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get();
  probe.close();
  if (hasTables && version < SCHEMA_VERSION) {
    const backup = `${config.dbPath}.pre-e2e-${Date.now()}.bak`;
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(config.dbPath + suffix)) renameSync(config.dbPath + suffix, backup + suffix);
    }
    console.warn(`[db] ancienne base non chiffrée mise de côté : ${backup}`);
  }
}

export const db = new DatabaseSync(config.dbPath);
// synchronous = NORMAL is SQLite's recommended setting with WAL: commits no longer wait for a disk
// sync (fsync), which can take seconds on hosted disks. The database stays consistent; a power
// loss or OS crash (not an app crash) can only drop the last few commits.
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  auth_hash TEXT NOT NULL,
  kdf_salt TEXT NOT NULL,
  public_key TEXT NOT NULL,
  enc_private_key TEXT NOT NULL,
  recovery_enc_private_key TEXT NOT NULL,
  recovery_auth_hash TEXT NOT NULL,
  enc_vault TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
  note TEXT,
  expires_at INTEGER NOT NULL,
  used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'board')),
  parent_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  enc_name TEXT NOT NULL,
  key_wrap TEXT,
  key_epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS grants (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  wrapped_key TEXT NOT NULL,
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  elements TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '{}',
  preview TEXT
);
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enc_name TEXT NOT NULL,
  enc_pub TEXT NOT NULL,
  enc_auth TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  hostname TEXT,
  os TEXT,
  arch TEXT,
  last_seen INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  key_for_board TEXT NOT NULL,
  key_for_agent TEXT NOT NULL,
  enc_label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tunnels (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  key_for_board TEXT NOT NULL,
  key_for_agent TEXT NOT NULL,
  enc_label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tunnels_board ON tunnels(board_id);
-- Public read-only links: only the hash of the URL token is stored; the link key lives in the URL fragment.
CREATE TABLE IF NOT EXISTS board_links (
  token_hash TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  board_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  key_epoch INTEGER NOT NULL,
  wrapped_key TEXT NOT NULL,
  enc_label TEXT,
  enc_title TEXT
);
CREATE INDEX IF NOT EXISTS board_links_board ON board_links(board_id);
CREATE INDEX IF NOT EXISTS items_parent ON items(parent_id);
CREATE INDEX IF NOT EXISTS items_owner ON items(owner_id);
CREATE INDEX IF NOT EXISTS grants_user ON grants(user_id);
CREATE INDEX IF NOT EXISTS terminals_board ON terminals(board_id);
CREATE INDEX IF NOT EXISTS terminals_machine ON terminals(machine_id);
-- Board history: ciphertext entries stored once per board (content-addressed), versions list hashes.
CREATE TABLE IF NOT EXISTS board_entries (
  board_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (board_id, hash)
);
CREATE TABLE IF NOT EXISTS board_versions (
  id INTEGER PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  hashes TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS board_versions_board ON board_versions(board_id, id);
PRAGMA user_version = ${SCHEMA_VERSION};
`);

// v2 databases created before machines carried an owner-only auth key.
if (!(db.prepare("PRAGMA table_info(machines)").all() as { name: string }[]).some((c) => c.name === "enc_auth")) {
  db.exec("ALTER TABLE machines ADD COLUMN enc_auth TEXT");
}
// Personal Excalidraw library, encrypted under the owner's vault key.
if (!(db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).some((c) => c.name === "enc_library")) {
  db.exec("ALTER TABLE users ADD COLUMN enc_library TEXT");
}

/** Adds a column to an existing table if it is missing (lightweight migrations). */
function addColumn(table: string, column: string, ddl: string, backfill?: string) {
  if ((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  if (backfill) db.exec(backfill);
}

// What the agent announces about itself (plain metadata like hostname / os / arch): its version and
// the features it supports (JSON array). Null caps = an agent from before capabilities existed.
addColumn("machines", "agent_version", "TEXT");
addColumn("machines", "agent_caps", "TEXT");

// Registration, verification and administration.
addColumn("users", "email_verified", "INTEGER NOT NULL DEFAULT 1"); // accounts from before verification count as verified
addColumn("users", "verify_code_hash", "TEXT");
addColumn("users", "verify_expires", "INTEGER");
addColumn("users", "verify_attempts", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "suspended", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "last_seen_at", "INTEGER");
addColumn("users", "onboarded", "INTEGER NOT NULL DEFAULT 0", "UPDATE users SET onboarded = 1"); // existing users skip the guide
addColumn("users", "discoverable", "INTEGER NOT NULL DEFAULT 1"); // legacy, no longer read
addColumn("users", "findable_name", "INTEGER NOT NULL DEFAULT 1");
addColumn("users", "findable_email", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "notify", "TEXT NOT NULL DEFAULT '{}'"); // email notifications, all off by default

// Active sessions: coarse connection metadata only (never the raw User-Agent or full IP).
addColumn("sessions", "public_id", "TEXT"); // opaque id shown to the owner, distinct from the token hash
db.exec("UPDATE sessions SET public_id = lower(hex(randomblob(8))) WHERE public_id IS NULL");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id ON sessions(public_id)");
addColumn("sessions", "created_at", "INTEGER");
addColumn("sessions", "last_used_at", "INTEGER");
addColumn("sessions", "user_agent_label", "TEXT");
addColumn("sessions", "ip_prefix", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)");

// Machine sharing. A direct share seals the machine auth key to one person; a board link boxes it
// under a board's key, for the editors of that board (see docs/SECURITY.md, « Partage de machines »).
// Machines from before this feature keep it off; new ones have it on unless the owner says otherwise.
addColumn("machines", "share_boards", "INTEGER NOT NULL DEFAULT 1", "UPDATE machines SET share_boards = 0");
db.exec(`
CREATE TABLE IF NOT EXISTS machine_shares (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sealed TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, user_id)
);
CREATE INDEX IF NOT EXISTS machine_shares_user ON machine_shares(user_id);
CREATE TABLE IF NOT EXISTS machine_boards (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  board_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  wrapped TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, board_id)
);
CREATE INDEX IF NOT EXISTS machine_boards_board ON machine_boards(board_id);
`);

// Shared documents (Yjs): the server stores ciphertext of CRDT updates and snapshots, nothing else.
// seq is monotonic per document (last_seq survives compaction); updates with seq <= snap_seq were
// folded into the snapshot. bytes = ciphertext length of the snapshot plus the remaining updates.
db.exec(`
CREATE TABLE IF NOT EXISTS board_docs (
  board_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  snap TEXT,
  snap_seq INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, doc_id)
);
CREATE TABLE IF NOT EXISTS board_doc_updates (
  board_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  d TEXT NOT NULL,
  PRIMARY KEY (board_id, doc_id, seq),
  FOREIGN KEY (board_id, doc_id) REFERENCES board_docs(board_id, doc_id) ON DELETE CASCADE
);
`);

export function newId(bytes = 12): string {
  return randomBytes(bytes).toString("base64url");
}

export { isClientId } from "./validate.ts";

export function getSetting(key: string, fallback: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function serverSecret(): string {
  let s = getSetting("server_secret", "");
  if (!s) {
    s = randomBytes(32).toString("base64url");
    setSetting("server_secret", s);
  }
  return s;
}

/** Runs fn inside a transaction. */
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
