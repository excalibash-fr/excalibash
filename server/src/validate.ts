// Shape checks of client-supplied strings. Pure regex tests: no lookup, no side effect.

/** Non-empty base64url (no padding), at most `max` characters. */
export const isB64Url = (v: unknown, max = Infinity): v is string => typeof v === "string" && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);

/** Client-generated ids (bound into ciphertext AADs): 12 to 32 random bytes, base64url. */
export const isClientId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{16,43}$/.test(v);

/** 128-bit random id, base64url without padding. */
export const isId22 = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{22}$/.test(v);

/** Request id of an agent exchange (file transfer, tunnel stream). */
export const isRid = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v);

/** Loose email shape: something@domain.tld, no spaces. */
export const isEmail = (v: unknown): v is string => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
