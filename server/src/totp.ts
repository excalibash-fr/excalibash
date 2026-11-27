import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Time-based one-time passwords (RFC 6238 on top of the HOTP of RFC 4226), without dependency.
// Pure functions: nothing here touches the database.

export const PERIOD = 30; // seconds per step
export const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding. */
export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32 (case, spaces, dashes and padding ignored); null when a character is not in the alphabet. */
export function base32Decode(s: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/[\s=-]/g, "")) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret (the size of the SHA-1 block the HMAC is keyed with). */
export const newSecret = (): Buffer => randomBytes(20);

/** HOTP (RFC 4226): HMAC-SHA1 of the 8-byte counter, dynamic truncation, `digits` digits. */
export function hotp(secret: Uint8Array, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The step (counter) a moment in time falls in. */
export const stepOf = (ms: number, period = PERIOD): number => Math.floor(ms / 1000 / period);

export const totp = (secret: Uint8Array, ms: number, digits = DIGITS, period = PERIOD): string => hotp(secret, stepOf(ms, period), digits);

/**
 * Checks a code against the steps around `ms` (±`window` steps, for clock drift). Returns the step it matches, or
 * null. A step at or below `lastStep` is refused: a code works once, and an older one never comes back. Every step
 * is compared, in constant time, whether or not an earlier one matched.
 */
export function verifyTotp(secret: Uint8Array, code: string, ms: number, lastStep: number, o: { window?: number; digits?: number; period?: number } = {}): number | null {
  const { window = 1, digits = DIGITS, period = PERIOD } = o;
  if (code.length !== digits || !/^\d+$/.test(code)) return null;
  const given = Buffer.from(code);
  const now = stepOf(ms, period);
  let found: number | null = null;
  for (let step = now - window; step <= now + window; step++) {
    if (step < 0) continue;
    const match = timingSafeEqual(Buffer.from(hotp(secret, step, digits)), given);
    if (match && step > lastStep && (found === null || step > found)) found = step;
  }
  return found;
}

/** The URI authenticator apps read from the QR code. */
export function otpauthUri(email: string, secretB32: string): string {
  return (
    `otpauth://totp/Excalibash:${encodeURIComponent(email)}` +
    `?secret=${secretB32}&issuer=Excalibash&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`
  );
}

// ---- Encryption at rest (AES-256-GCM) ---------------------------------------------------

/** `v1.iv.tag.ciphertext` (base64url). `aad` ties the blob to its owner (a user id), so it cannot be moved to another row. */
export function seal(key: Buffer, aad: string, plain: Uint8Array): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** The sealed bytes, or null if the blob is malformed, was altered or belongs to someone else. */
export function open(key: Buffer, aad: string, sealed: string): Buffer | null {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]);
  } catch {
    return null;
  }
}
