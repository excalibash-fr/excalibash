import { HttpError } from "./http.ts";
import { securityEvent } from "./securityLog.ts";

// Brute-force protection on top of the per-minute rateLimit: failures are counted per account and per IP,
// slow down progressively, and lock the key for a while. In memory like rateLimit: a restart forgets it.

/** What is being guessed. "mfa" is for the second factor (used by its own routes). */
export type Scope = "login" | "recover" | "pair" | "reauth" | "mfa";
type Keys = { account?: string; ip: string };

const WINDOW_MS = 15 * 60_000; // failures are counted over this window…
const LOCK_MS = 15 * 60_000; // …and a key that reaches its cap is locked for this long
const ACCOUNT_MAX = 10; // failures per account (all IPs)
const IP_MAX = 30; // failures per IP (all accounts), per scope
const DELAY_FROM = 4; // from this failure on, the answer is slowed down: 250 ms, 500 ms, … up to 4 s
const MAX_TRACKED = 50_000;

type Entry = { n: number; reset: number; lockedUntil: number };
const entries = new Map<string, Entry>();

/** Clock and sleep, replaceable by the unit tests. */
export const hooks = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
};

/** Unknown emails get a counter like the others, so a lock never tells whether an account exists. */
const accountKey = (scope: Scope, account: string) => `${scope}|a|${account.trim().toLowerCase()}`;
const ipKey = (scope: Scope, ip: string) => `${scope}|i|${ip}`;

const keysOf = (scope: Scope, k: Keys): string[] => [...(k.account ? [accountKey(scope, k.account)] : []), ipKey(scope, k.ip)];

/** Throws the same 429 for a locked account (known or not) and a locked IP. Call before verifying anything. */
export function assertNotLocked(scope: Scope, keys: Keys): void {
  const now = hooks.now();
  for (const key of keysOf(scope, keys)) {
    if ((entries.get(key)?.lockedUntil ?? 0) > now) throw new HttpError(429, "Trop de tentatives, réessaie plus tard");
  }
}

/** Counts one failure for `key`; returns the entry and whether this failure locked it. */
function bump(key: string, max: number, now: number): { e: Entry; locked: boolean } {
  let e = entries.get(key);
  if (e && e.lockedUntil <= now && e.reset <= now) e = undefined; // window over, lock over
  if (!e) {
    if (entries.size >= MAX_TRACKED) {
      prune(now);
      if (entries.size >= MAX_TRACKED) entries.delete(entries.keys().next().value!);
    }
    e = { n: 0, reset: now + WINDOW_MS, lockedUntil: 0 };
    entries.set(key, e);
  }
  e.n++;
  const locked = e.n >= max && e.lockedUntil <= now;
  if (locked) {
    e.lockedUntil = now + LOCK_MS;
    e.n = 0; // a fresh count once the lock is over
    e.reset = e.lockedUntil;
  }
  return { e, locked };
}

/**
 * Records a failure: counts it, locks at the caps, journals it (never an email or a secret: `fields.account`
 * is a user id), and slows the answer down — await it before answering.
 */
export async function failed(scope: Scope, keys: Keys, fields: Record<string, string> = {}): Promise<void> {
  const now = hooks.now();
  const byId = scope === "reauth" || scope === "mfa";
  const account = fields.account ?? (byId && keys.account ? keys.account : "unknown");
  securityEvent("auth_failed", { scope, ip: keys.ip, account });
  let delay = 0;
  if (keys.account) {
    const { e, locked } = bump(accountKey(scope, keys.account), ACCOUNT_MAX, now);
    if (locked) securityEvent("account_locked", { scope, account, ip: keys.ip, minutes: LOCK_MS / 60_000 });
    else if (e.n >= DELAY_FROM) delay = Math.min(250 * 2 ** (e.n - DELAY_FROM), 4000);
  }
  if (bump(ipKey(scope, keys.ip), IP_MAX, now).locked) securityEvent("ip_locked", { scope, ip: keys.ip, minutes: LOCK_MS / 60_000 });
  if (delay) await hooks.sleep(delay);
}

/** Success: clears the account counter for this scope (not the IP one). A lock in progress stays. */
export function succeeded(scope: Scope, keys: { account?: string }): void {
  if (!keys.account) return;
  const key = accountKey(scope, keys.account);
  if ((entries.get(key)?.lockedUntil ?? 0) <= hooks.now()) entries.delete(key);
}

function prune(now: number): void {
  for (const [k, e] of entries) if (e.lockedUntil <= now && e.reset <= now) entries.delete(k);
}

/** Forgets everything (tests). */
export function resetLockout(): void {
  entries.clear();
}

export const trackedCount = (): number => entries.size;

setInterval(() => prune(hooks.now()), 60_000).unref();
