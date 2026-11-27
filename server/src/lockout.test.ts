// Unit tests of the brute-force lockout (no framework):
//   node --experimental-strip-types server/src/lockout.test.ts
import { assertNotLocked, failed, succeeded, hooks, resetLockout, trackedCount } from "./lockout.ts";

let failures = 0;
// The module journals every failure on stdout: keep those lines (counted) apart from the test report.
const report = console.log;
const events: string[] = [];
console.log = (line: string) => void events.push(line);
const ok = (cond: unknown, msg: string) => {
  report(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};

let now = 1_000_000;
const delays: number[] = [];
hooks.now = () => now;
hooks.sleep = async (ms) => void delays.push(ms);

const locked = (scope: Parameters<typeof assertNotLocked>[0], keys: Parameters<typeof assertNotLocked>[1]) => {
  try {
    assertNotLocked(scope, keys);
    return null;
  } catch (e: any) {
    return e;
  }
};
const fail = async (n: number, account: string, ip = "1.1.1.1", scope: Parameters<typeof failed>[0] = "login") => {
  for (let i = 0; i < n; i++) await failed(scope, { account, ip });
};

// Progressive delay: from the 4th failure, 250 ms doubling, capped at 4 s; nothing before.
await fail(3, "a@x.y");
ok(delays.length === 0, "no delay for the first 3 failures");
await fail(7, "a@x.y");
ok(JSON.stringify(delays) === JSON.stringify([250, 500, 1000, 2000, 4000, 4000]), "delay 250 ms doubling up to 4 s (the locking failure answers at once)");

// Lock at 10 failures, same answer for the same account and for a different IP.
const e = locked("login", { account: "a@x.y", ip: "9.9.9.9" });
ok(e?.status === 429 && /Trop de tentatives/.test(e.message), "10 failures: account locked (429), from any IP");
ok(locked("login", { account: "  A@X.Y ", ip: "9.9.9.9" })?.message === e.message, "email normalised (case, spaces)");
ok(locked("login", { account: "other@x.y", ip: "9.9.9.9" }) === null, "another account is not locked");
ok(locked("recover", { account: "a@x.y", ip: "9.9.9.9" }) === null, "other scopes are separate");

// A success during the lock changes nothing; the lock then expires.
succeeded("login", { account: "a@x.y" });
ok(locked("login", { account: "a@x.y", ip: "9.9.9.9" }) !== null, "a success does not lift a lock in progress");
now += 15 * 60_000 - 1;
ok(locked("login", { account: "a@x.y", ip: "9.9.9.9" }) !== null, "still locked just before 15 minutes");
now += 2;
ok(locked("login", { account: "a@x.y", ip: "9.9.9.9" }) === null, "unlocked after 15 minutes");
delays.length = 0;
await fail(3, "a@x.y", "2.2.2.2");
ok(delays.length === 0, "the count starts again after a lock");

// A success clears the account counter (and the delay); the failures window expires.
resetLockout();
delays.length = 0;
await fail(9, "b@x.y");
succeeded("login", { account: "b@x.y" });
await fail(9, "b@x.y");
ok(locked("login", { account: "b@x.y", ip: "3.3.3.3" }) === null, "success resets the account counter");
now += 15 * 60_000 + 1;
await fail(1, "b@x.y");
ok(locked("login", { account: "b@x.y", ip: "3.3.3.3" }) === null, "failures older than 15 minutes are forgotten");

// IP: 100 failures over any accounts (and IP-only keys), a success does not clear it.
resetLockout();
for (let i = 0; i < 99; i++) await failed("login", { account: `u${i}@x.y`, ip: "4.4.4.4" });
ok(locked("login", { account: "fresh@x.y", ip: "4.4.4.4" }) === null, "99 failures from an IP: not locked");
succeeded("login", { account: "u0@x.y" });
await failed("login", { account: "u99@x.y", ip: "4.4.4.4" });
ok(locked("login", { account: "fresh@x.y", ip: "4.4.4.4" })?.status === 429, "100 failures from an IP (many accounts): IP locked, success did not clear it");
ok(locked("login", { account: "fresh@x.y", ip: "5.5.5.5" }) === null, "another IP is free");
ok(locked("pair", { ip: "4.4.4.4" }) === null, "the IP lock is per scope");

// IP-only scope (pairing, setup code): no delay, locks at 100.
resetLockout();
delays.length = 0;
for (let i = 0; i < 100; i++) await failed("pair", { ip: "6.6.6.6" });
ok(delays.length === 0 && locked("pair", { ip: "6.6.6.6" })?.status === 429, "IP-only scope: locked after 100 failures, never delayed");

// Capped number of entries.
resetLockout();
for (let i = 0; i < 50_000 + 500; i++) await failed("pair", { ip: `ip${i}` });
ok(trackedCount() <= 50_000, "the number of tracked keys is capped");
ok(locked("pair", { ip: "ip50499" }) === null, "…and keeps counting recent keys");

ok(events.some((l) => /^excalibash-security event=account_locked scope=login account=unknown ip=1\.1\.1\.1 minutes=15$/.test(l)), "account_locked is journaled (no email in the line)");
ok(!events.some((l) => l.includes("@")), "no email in any journal line");
report(failures ? `\n${failures} ÉCHEC(S)` : "\nTOUT EST OK");
process.exit(failures ? 1 : 0);
