import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { sha256 } from "./auth.ts";
import { serverSecret } from "./db.ts";

const MAX_NUMBER = 150_000;
const TTL_MS = 10 * 60_000;

export type PowSolution = { salt: string; number: number; challenge: string; expires: number; signature: string };

const sign = (salt: string, challenge: string, expires: number) =>
  createHmac("sha256", serverSecret()).update(`${salt}${challenge}${expires}`).digest("hex");

export function createChallenge() {
  const salt = randomBytes(12).toString("hex");
  const expires = Date.now() + TTL_MS;
  const secret = randomInt(MAX_NUMBER / 10, MAX_NUMBER + 1);
  const challenge = sha256(salt + secret);
  return { salt, challenge, maxnumber: MAX_NUMBER, expires, signature: sign(salt, challenge, expires) };
}

const used = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of used) if (exp < now) used.delete(k);
}, 60_000).unref();

/** Checks signature, expiry and the solution; a challenge can be used only once. */
export function verifyPow(p: any): boolean {
  if (!p || typeof p !== "object") return false;
  const { salt, number, challenge, expires, signature } = p;
  if (typeof salt !== "string" || typeof challenge !== "string" || typeof signature !== "string") return false;
  if (!Number.isInteger(number) || number < 0 || number > MAX_NUMBER) return false;
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const good = Buffer.from(sign(salt, challenge, expires));
  const got = Buffer.from(signature);
  if (good.length !== got.length || !timingSafeEqual(good, got)) return false;
  if (sha256(salt + number) !== challenge) return false;
  if (used.has(signature)) return false;
  used.set(signature, expires);
  return true;
}
