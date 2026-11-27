import { createHash, randomBytes } from "node:crypto";
import { config } from "./config.ts";

// Access to a tunnel's origin in subdomain mode. A signed-in user asks Excalibash for a one-time
// ticket (60 s); the tunnel origin swaps it for a cookie session bound to that one tunnel. Neither
// carries content: they only say "this account may reach this tunnel". Kept in memory, like the
// rate limits: a restart sends the pages back through the ticket handshake.

type Ticket = { tunnelId: string; userId: string; sessionHash: string; exp: number };
export type TunnelSession = { key: string; tunnelId: string; userId: string; sessionHash: string; exp: number; checkedAt: number };

const TICKET_MS = 60_000;
const RECHECK_MS = 60_000;
const MAX_PER_USER_TUNNEL = 20;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

const tickets = new Map<string, Ticket>();
const sessions = new Map<string, TunnelSession>();
const dropListeners: ((keys: Set<string>) => void)[] = [];

/** Called with the keys of sessions that were removed (to cut their open sockets). */
export function onSessionsDropped(fn: (keys: Set<string>) => void): void {
  dropListeners.push(fn);
}

export function issueTicket(tunnelId: string, userId: string, sessionHash: string): string {
  const ticket = randomBytes(32).toString("base64url");
  tickets.set(hash(ticket), { tunnelId, userId, sessionHash, exp: Date.now() + TICKET_MS });
  return ticket;
}

/** Single use: the ticket is gone after this call, whatever the outcome. */
export function redeemTicket(ticket: unknown, tunnelId: string): Ticket | null {
  if (typeof ticket !== "string" || ticket.length > 200) return null;
  const k = hash(ticket);
  const t = tickets.get(k);
  if (!t) return null;
  tickets.delete(k);
  return t.exp > Date.now() && t.tunnelId === tunnelId ? t : null;
}

/** Cookie value of a new session; the oldest sessions of the same (user, tunnel) pair make room. */
export function createTunnelSession(t: Ticket): string {
  const token = randomBytes(32).toString("base64url");
  const mine = [...sessions.values()].filter((s) => s.userId === t.userId && s.tunnelId === t.tunnelId);
  const surplus = mine.slice(0, Math.max(0, mine.length - MAX_PER_USER_TUNNEL + 1));
  drop(new Set(surplus.map((s) => s.key)));
  const now = Date.now();
  const key = hash(token);
  sessions.set(key, { key, tunnelId: t.tunnelId, userId: t.userId, sessionHash: t.sessionHash, exp: now + config.tunnel.sessionHours * 3600_000, checkedAt: now });
  return token;
}

/**
 * The session behind a cookie value, if it belongs to this tunnel and is still good. After a minute
 * `recheck` asks again whether the account still has access; a "no" ends the session.
 */
export function checkTunnelSession(token: string | undefined, tunnelId: string, recheck: (s: TunnelSession) => boolean): TunnelSession | null {
  if (!token || token.length > 200) return null;
  const s = sessions.get(hash(token));
  if (!s || s.tunnelId !== tunnelId) return null;
  const now = Date.now();
  if (s.exp <= now) {
    drop(new Set([s.key]));
    return null;
  }
  if (now - s.checkedAt > RECHECK_MS) {
    if (!recheck(s)) {
      drop(new Set([s.key]));
      return null;
    }
    s.checkedAt = now;
  }
  return s;
}

/** Re-checks the given sessions now (those with an open socket), dropping the ones that lost access. */
export function recheckSessions(keys: Iterable<string>, recheck: (s: TunnelSession) => boolean): void {
  const now = Date.now();
  const gone = new Set<string>();
  for (const k of keys) {
    const s = sessions.get(k);
    if (!s) continue;
    if (s.exp <= now || !recheck(s)) gone.add(k);
    else s.checkedAt = now;
  }
  drop(gone);
}

function drop(keys: Set<string>): void {
  if (!keys.size) return;
  for (const k of keys) sessions.delete(k);
  for (const fn of dropListeners) fn(keys);
}

function dropWhere(match: (s: { tunnelId: string; userId: string; sessionHash: string }) => boolean): void {
  for (const [k, t] of tickets) if (match(t)) tickets.delete(k);
  drop(new Set([...sessions.values()].filter(match).map((s) => s.key)));
}

/** The tunnel closed or got a new key: nobody keeps access. */
export const dropTunnelSessions = (tunnelId: string) => dropWhere((s) => s.tunnelId === tunnelId);

/** All access of an account ends (suspension, password change); `keepSession` spares one main session. */
export const dropUserTunnelSessions = (userId: string, keepSession?: string) => dropWhere((s) => s.userId === userId && s.sessionHash !== keepSession);

/** One main session ended (logout, revoked device): the tunnel sessions it opened end with it. */
export const dropMainSessionTunnels = (sessionHash: string) => dropWhere((s) => s.sessionHash === sessionHash);

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.exp <= now) tickets.delete(k);
  drop(new Set([...sessions.values()].filter((s) => s.exp <= now).map((s) => s.key)));
}, 60_000).unref();
