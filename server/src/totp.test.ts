// Unit tests of TOTP (RFC 6238 vectors), base32 and the sealed storage (no framework):
//   node --experimental-strip-types server/src/totp.test.ts
import { randomBytes } from "node:crypto";
import { base32Decode, base32Encode, hotp, newSecret, open, otpauthUri, seal, stepOf, totp, verifyTotp } from "./totp.ts";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};

// RFC 6238, appendix B: SHA-1, secret "12345678901234567890", 8 digits.
const seed = Buffer.from("12345678901234567890");
const vectors: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];
for (const [t, want] of vectors) ok(totp(seed, t * 1000, 8) === want, `RFC 6238 : T=${t} → ${want}`);
ok(totp(seed, 59_000) === "287082", "6 chiffres : les 6 derniers de la valeur à 8 chiffres");

// RFC 4226, appendix D: HOTP counters 0 and 9.
ok(hotp(seed, 0) === "755224" && hotp(seed, 9) === "520489", "RFC 4226 : compteurs 0 et 9");

// base32 (RFC 4648 test vectors, no padding) and round trip.
const enc = (s: string) => base32Encode(Buffer.from(s));
ok(enc("") === "" && enc("f") === "MY" && enc("fo") === "MZXQ" && enc("foo") === "MZXW6" && enc("foobar") === "MZXW6YTBOI", "base32 : vecteurs RFC 4648");
ok(base32Decode("mzxw 6ytb-oi==")?.toString() === "foobar", "base32 : casse, espaces, tirets et « = » ignorés");
ok(base32Decode("MZXW1") === null, "base32 : caractère hors alphabet refusé");
const s = newSecret();
ok(s.length === 20 && base32Encode(s).length === 32 && base32Decode(base32Encode(s))?.equals(s), "secret de 20 octets, 32 caractères base32, aller-retour");

// Window ±1, replay.
const T = 1_700_000_000_000;
const step = stepOf(T);
const at = (d: number) => hotp(seed, step + d);
ok(verifyTotp(seed, at(0), T, 0) === step, "code du pas courant accepté");
ok(verifyTotp(seed, at(-1), T, 0) === step - 1 && verifyTotp(seed, at(1), T, 0) === step + 1, "pas précédent et suivant acceptés (±1)");
ok(verifyTotp(seed, at(-2), T, 0) === null && verifyTotp(seed, at(2), T, 0) === null, "au-delà de ±1 pas : refusé");
ok(verifyTotp(seed, at(0), T, step) === null, "rejeu : un pas déjà utilisé est refusé");
ok(verifyTotp(seed, at(-1), T, step) === null, "rejeu : un pas plus ancien que le dernier utilisé est refusé");
ok(verifyTotp(seed, at(1), T, step) === step + 1, "le pas suivant reste utilisable");
ok(verifyTotp(seed, "12345", T, 0) === null && verifyTotp(seed, "abcdef", T, 0) === null && verifyTotp(seed, at(0) + "0", T, 0) === null, "longueur et caractères vérifiés");
ok(verifyTotp(seed, at(0), T, 0, { window: 0 }) === step && verifyTotp(seed, at(1), T, 0, { window: 0 }) === null, "fenêtre réglable");
ok(verifyTotp(seed, totp(seed, T, 8), T, 0, { digits: 8 }) === step, "chiffres paramétrables (8)");

// URI.
const uri = otpauthUri("a+b@x.y", "ABCDEFGH");
ok(uri === "otpauth://totp/Excalibash:a%2Bb%40x.y?secret=ABCDEFGH&issuer=Excalibash&algorithm=SHA1&digits=6&period=30", "URI otpauth encodée");

// Sealed storage: round trip, wrong key, wrong owner, altered blob, fresh IV.
const key = randomBytes(32);
const blob = seal(key, "user-1", seed);
ok(open(key, "user-1", blob)?.equals(seed), "secret chiffré (AES-256-GCM) puis déchiffré");
ok(!blob.includes(seed.toString("base64url")) && seal(key, "user-1", seed) !== blob, "le secret n'apparaît pas en clair, IV neuf à chaque fois");
ok(open(randomBytes(32), "user-1", blob) === null, "autre clé : refusé");
ok(open(key, "user-2", blob) === null, "autre propriétaire (AAD) : refusé");
const parts = blob.split(".");
parts[3] = (parts[3]![0] === "A" ? "B" : "A") + parts[3]!.slice(1);
ok(open(key, "user-1", parts.join(".")) === null && open(key, "user-1", "n'importe quoi") === null, "blob altéré ou mal formé : refusé");

process.exit(failures ? 1 : 0);
