// End-to-end: two users, nested shared folders, encrypted collab + terminal, revoke + rotation,
// third user / admin cannot read. Uses the real web crypto + library code against the real server/agent.
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import WebSocket from "../server/node_modules/ws/index.js";
const WebSocketServer = (WebSocket as any).WebSocketServer;
import * as c from "../web/src/crypto.ts";
import * as lib from "../web/src/library.tsx";
import { solveChallenge } from "../web/src/pow.ts";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createMachine } from "../web/src/vault.ts";
import { encryptEntry, decryptEntry } from "../web/src/board/boardCrypto.ts";
import * as sd from "../web/src/board/sharedDoc.ts";
import * as codeDoc from "../web/src/board/codeDoc.ts";
import * as mf from "../web/src/board/machineFiles.ts";
import * as nbDoc from "../web/src/board/notebookDoc.ts";
import { NotebookRunner } from "../web/src/board/notebookRunner.ts";
import * as nbSvc from "../web/src/board/notebookService.ts";
import { CodeRunner } from "../web/src/board/codeRunner.ts";
import { LineSplitter, parseEvent } from "../web/src/board/kernelProtocol.ts";
import { FileClient } from "../web/src/board/fileTransfer.ts";
import * as Y from "../web/node_modules/yjs/dist/yjs.mjs";
import { Awareness, encodeAwarenessUpdate } from "../web/node_modules/y-protocols/awareness.js";

const BASE = process.env.BASE ?? "http://127.0.0.1:6797";
const PROXY = process.env.PROXY ?? "http://127.0.0.1:6799";
const DB = process.env.DB!;
const realFetch = globalThis.fetch;
const jar = { current: "" };
globalThis.fetch = (async (url: string, init: any = {}) => {
  const r = await realFetch(BASE + url, { ...init, headers: { ...(init.headers ?? {}), cookie: jar.current } });
  const sc = r.headers.get("set-cookie");
  if (sc) jar.current = sc.split(";")[0];
  return r;
}) as any;

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`/api${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined } as any);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j as any };
}

type U = { user: any; keys: c.KeyPair; cookie: string; recovery: string };

const pow = async () => solveChallenge((await api("GET", "/auth/challenge")).body);

/** Last verification code emailed to `email`, read from the server log (SMTP_TRANSPORT=log). */
function mailCode(email: string): string {
  const lines = readFileSync(`${dirname(DB)}/server.log`, "utf8").split("\n").filter((l) => l.startsWith(`[mail] to=${email} `));
  return lines.at(-1)?.match(/code=(\d{6})/)?.[1] ?? "";
}

/** Subjects of the emails sent to `email`, read from the server log. */
function mails(email: string): string[] {
  return readFileSync(`${dirname(DB)}/server.log`, "utf8")
    .split("\n")
    .filter((l) => l.startsWith(`[mail] to=${email} `))
    .map((l) => l.match(/subject=(.*) code=/)?.[1] ?? "");
}

/** Setup code the server prints while it has no account. */
function setupCode(): string {
  return readFileSync(`${dirname(DB)}/server.log`, "utf8").match(/Code d'installation[^:]*: ([A-Z0-9-]+)/)?.[1] ?? "";
}

async function register(email: string, name: string, password: string, invite?: string, setup?: string): Promise<U> {
  jar.current = "";
  const id = c.randomId();
  const salt = c.toB64(c.randomBytes(16));
  const { authKey, masterKey } = await c.deriveAccountKeys(password, salt);
  const kp = await c.generateKeyPair();
  const rraw = c.randomBytes(32);
  const rec = await c.recoveryKeys(rraw);
  const r = await api("POST", "/auth/register", {
    pow: await pow(), website: "",
    id, email, name, invite, setupCode: setup, salt, authKey,
    publicKey: c.toB64(kp.pub),
    encPrivateKey: await c.box(masterKey, kp.pkcs8, c.AAD.priv(id)),
    recoveryEncPrivateKey: await c.box(rec.recoveryEnc, kp.pkcs8, c.AAD.priv(id)),
    recoveryAuth: rec.recoveryAuth,
  });
  if (r.status !== 200) throw new Error(`register ${email}: ${JSON.stringify(r.body)}`);
  let user = r.body.user;
  if (r.body.needsVerification) {
    const v = await api("POST", "/auth/verify", { email, code: mailCode(email) });
    if (v.status !== 200) throw new Error(`verify ${email}: ${JSON.stringify(v.body)}`);
    user = v.body.user;
  }
  return { user, keys: { priv: await c.importPrivateKey(kp.pkcs8), pub: kp.pub }, cookie: jar.current, recovery: c.formatRecoveryKey(rraw) };
}

async function as<T>(u: U, fn: () => Promise<T>): Promise<T> {
  jar.current = u.cookie;
  return fn();
}

async function tree(u: U) {
  return as(u, async () => {
    const r = await api("GET", "/tree");
    // Re-use the provider's decryption by calling the same logic through a tiny shim.
    const nodes: Map<string, lib.Node> = await lib.decryptTree(u.user, u.keys, r.body.items, r.body.grants);
    return nodes;
  });
}

const ctxOf = (u: U, nodes: Map<string, lib.Node>) => ({ user: u.user, keys: u.keys, nodes });

function boardSocket(u: U, boardId: string) {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?board=${boardId}`, { headers: { cookie: u.cookie } });
  const queue: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (raw: any) => {
    const m = JSON.parse(raw.toString());
    const w = waiters.findIndex(() => true);
    queue.push(m);
    waiters.splice(0).forEach((f) => f(m));
  });
  const next = (pred: (m: any) => boolean, ms = 6000) =>
    new Promise<any>((resolve, reject) => {
      let expired = false;
      // A timed-out wait must not stay registered: it would swallow a later message meant for another wait.
      const t = setTimeout(() => ((expired = true), reject(new Error("timeout waiting for message"))), ms);
      const check = () => {
        if (expired) return true;
        const i = queue.findIndex(pred);
        if (i >= 0) {
          clearTimeout(t);
          resolve(queue.splice(i, 1)[0]);
          return true;
        }
        return false;
      };
      if (check()) return;
      const loop = () => {
        if (!check()) waiters.push(loop);
      };
      waiters.push(loop);
    });
  const closed = new Promise<number>((r) => ws.on("close", (code: number) => r(code)));
  return { ws, next, closed, open: new Promise((r) => ws.on("open", r)), send: (m: object) => ws.send(JSON.stringify(m)) };
}

const gens = new Map<string, string>();

async function termOutput(sock: ReturnType<typeof boardSocket>, kt: c.SymKey, tid: string, needle: string) {
  let acc = "";
  for (let i = 0; i < 50; i++) {
    const m = await sock.next((x) => x.t === "term.data" && x.id === tid, 8000);
    acc += c.fromUtf8(await c.unbox(kt, m.d, c.AAD.termOut(tid, m.gen, m.seq)));
    gens.set(tid, m.gen);
    if (acc.includes(needle)) return acc;
  }
  return acc;
}

/** Subscribes and learns the current gen (from the replay or the agent's announce). */
async function subscribe(sock: ReturnType<typeof boardSocket>, tid: string) {
  sock.send({ t: "term.sub", id: tid });
  const r = await sock.next((x) => x.t === "term.replay" && x.id === tid);
  if (r.chunks.length) gens.set(tid, r.chunks.at(-1).gen);
  else gens.set(tid, (await sock.next((x) => x.t === "term.data" && x.id === tid)).gen);
}

let counter = 0;
async function sendInput(sock: ReturnType<typeof boardSocket>, kt: c.SymKey, tid: string, s: string, text: string) {
  const k = ++counter;
  const ts = Date.now();
  const gen = gens.get(tid)!;
  const frame = { t: "term.input", id: tid, s, k, ts, d: await c.box(kt, c.utf8(text), c.AAD.termIn(tid, gen, s, k, ts)) };
  sock.send(frame);
  return frame;
}

// ---------------------------------------------------------------------------------------

const badCode = await register("mallory@test.local", "Mallory", "mallory-password-1", undefined, "AAAA-AAAA").then(() => true, () => false);
ok(!badCode, "sans le bon code d'installation, personne ne peut prendre le premier compte (admin)");
const alice = await register("alice@test.local", "Alice", "alice-password-1", undefined, setupCode());
ok(alice.user.isAdmin, "le premier compte, créé avec le code d'installation, est admin");
const unknownTunnel = await realFetch(`${PROXY}/eb-proxy/req/${c.randomId()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rid: "x", ts: Date.now(), d: "x".repeat(1_000_000) }) });
ok(unknownTunnel.status === 404, "un tunnel inconnu est refusé avant la lecture du corps");

// Alice: F / S / B (nested), with one encrypted element on B.
let nA = await tree(alice);
const F = await lib.createItem(ctxOf(alice, nA), "folder", null, "Projet secret");
nA = await tree(alice);
const S = await lib.createItem(ctxOf(alice, nA), "folder", F, "Sous-dossier infra");
nA = await tree(alice);
const rect = { id: "rect1", type: "rectangle", version: 3, versionNonce: 111, x: 0, y: 0, width: 10, height: 10, isDeleted: false, label: "TOP_SECRET_DIAGRAM" };
const B = await lib.createItem(ctxOf(alice, nA), "board", S, "Tableau confidentiel", { elements: [rect], files: {} });
nA = await tree(alice);
ok(nA.get(B)?.name === "Tableau confidentiel", "Alice déchiffre le nom du tableau imbriqué");

// Machine + agent.
const machine = await as(alice, () => createMachine(alice.keys, "laptop-alice"));
const agent = spawn(new URL(`../agent/dist/excalibash-agent-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`, import.meta.url).pathname, ["--server", BASE], {
  env: { ...process.env, EXCALIBASH_TOKEN: machine.token, EXCALIBASH_KEY: machine.privateKey },
  stdio: ["ignore", "ignore", "pipe"],
});
let agentLog = "";
agent.stderr.on("data", (d) => (agentLog += d));
await new Promise((r) => setTimeout(r, 1200));
ok(agentLog.includes(machine.fingerprint), "l'agent affiche la même empreinte que le navigateur");

// Bob + share F.
await as(alice, () => api("PATCH", "/admin/settings", { registrationOpen: true }));
const bob = await register("bob@test.local", "Bob", "bob-password-12");
// Anti-bot and email verification (registrations are open here).
{
  const noPow = await api("POST", "/auth/register", { email: "x@test.local", name: "X" });
  ok(noPow.status === 400 && /anti-robot/.test(noPow.body.error), "inscription sans preuve de travail refusée");
  const trap = await api("POST", "/auth/register", { pow: await pow(), website: "http://spam", email: "x@test.local", name: "X" });
  ok(trap.status === 400, "champ piège rempli refusé");
  const badSig = await api("POST", "/auth/register", { pow: { ...(await pow()), signature: "00" }, website: "", email: "x@test.local", name: "X" });
  ok(badSig.status === 400, "signature de défi invalide refusée");

  const id = c.randomId();
  const b64 = "AAAAAAAAAAAAAAAA";
  const dave = "dave@test.local";
  jar.current = "";
  const usedPow = await pow();
  const reg = await api("POST", "/auth/register", {
    pow: usedPow, website: "", id, email: dave, name: "Dave", salt: b64, authKey: b64,
    publicKey: b64, encPrivateKey: b64, recoveryEncPrivateKey: b64, recoveryAuth: b64,
  });
  ok(reg.status === 200 && reg.body.needsVerification && !reg.body.user && !jar.current, "inscription : en attente de vérification, sans session");
  const replay = await api("POST", "/auth/register", { pow: usedPow, website: "", email: "x@test.local", name: "X" });
  ok(replay.status === 400 && /anti-robot/.test(replay.body.error), "preuve de travail rejouée refusée");
  const dup = await api("POST", "/auth/register", {
    pow: await pow(), website: "", id: c.randomId(), email: dave, name: "Dave", salt: b64, authKey: b64,
    publicKey: b64, encPrivateKey: b64, recoveryEncPrivateKey: b64, recoveryAuth: b64,
  });
  ok(dup.status === 409 && /renvoyer/i.test(dup.body.error), "email non vérifié déjà inscrit : 409 avec invitation à renvoyer le code");
  const early = await api("POST", "/auth/login", { email: dave, authKey: b64 });
  ok(early.status === 403 && early.body.code === "EMAIL_NOT_VERIFIED", "connexion avant vérification : EMAIL_NOT_VERIFIED");
  const code = mailCode(dave);
  ok(/^\d{6}$/.test(code), "un code à 6 chiffres est envoyé par email");
  const wrong = await api("POST", "/auth/verify", { email: dave, code: code === "000000" ? "111111" : "000000" });
  ok(wrong.status === 400 && !jar.current, "mauvais code refusé");
  const resend = await api("POST", "/auth/resend", { email: dave });
  const ghost = await api("POST", "/auth/resend", { email: "personne@test.local" });
  ok(resend.status === 200 && ghost.status === 200 && JSON.stringify(resend.body) === JSON.stringify(ghost.body), "renvoi du code : même réponse si le compte existe ou non");
  const oldCode = await api("POST", "/auth/verify", { email: dave, code });
  ok(oldCode.status === 400 || mailCode(dave) === code, "un code remplacé n'est plus accepté");
  const good = await api("POST", "/auth/verify", { email: dave, code: mailCode(dave) });
  ok(good.status === 200 && good.body.user?.email === dave && !!jar.current, "bon code accepté : session ouverte");
  const after = await api("POST", "/auth/login", { email: dave, authKey: b64 });
  ok(after.status === 200, "connexion possible après vérification");

  // Brute force: 10 failures lock the account 15 minutes, even for the right password; an unknown email is locked
  // and answers just the same. The per-minute limits (8 per email, 20 per address) come first and answer "dans une
  // minute": on those, wait for the next minute and go on, so only real failures (401) are counted.
  const unknownEmail = "fantome@test.local";
  const wrongLogin = (email: string) => api("POST", "/auth/login", { email, authKey: "Z".repeat(16) });
  const fail10 = async (email: string) => {
    for (let n = 0; n < 10; ) {
      const r = await wrongLogin(email);
      if (r.status === 401) n++;
      else if (/une minute/.test(r.body.error)) await new Promise((res) => setTimeout(res, 61_000));
      else return r;
    }
    return undefined;
  };
  const stray = await Promise.all([fail10(dave), fail10(unknownEmail)]);
  ok(stray.every((r) => !r), "10 mauvais mots de passe : tous refusés en 401 (existant ou non)");
  const lockedReal = await api("POST", "/auth/login", { email: dave, authKey: b64 });
  const lockedGhost = await api("POST", "/auth/login", { email: unknownEmail, authKey: b64 });
  ok(lockedReal.status === 429 && /plus tard/.test(lockedReal.body.error), "11e tentative avec le BON mot de passe : compte verrouillé (429)");
  ok(lockedGhost.status === 429 && JSON.stringify(lockedGhost.body) === JSON.stringify(lockedReal.body), "email inexistant : même verrou, même réponse");
  const security = readFileSync(`${dirname(DB)}/server.log`, "utf8").split("\n").filter((l) => l.startsWith("excalibash-security "));
  ok(security.filter((l) => l.includes("event=account_locked scope=login")).length >= 2, "journal : excalibash-security event=account_locked pour les deux comptes");
  ok(security.some((l) => l.includes("event=auth_failed scope=login ip=")) && !security.some((l) => l.includes("@")), "journal : auth_failed avec l'IP, jamais d'email");
}
await as(alice, () => api("PATCH", "/admin/settings", { registrationOpen: false }));
// Findable by name (default) and by email (off by default); a hidden account answers like a missing one.
{
  const look = (q: string) => as(alice, () => api("GET", `/auth/lookup?q=${encodeURIComponent(q)}`));
  const settings = (await as(bob, () => api("GET", "/account"))).body;
  ok(settings.findableName === true && settings.findableEmail === false, "visibilité par défaut : trouvable par nom, pas par email");
  const byName = await look("bob");
  ok(byName.status === 200 && byName.body.users.length === 1 && byName.body.users[0].id === bob.user.id, "recherche par nom (insensible à la casse) : Bob trouvé");
  ok(!("email" in byName.body.users[0]), "la recherche par nom ne renvoie pas l'email");
  ok((await look("Bo")).body.users.some((u: any) => u.id === bob.user.id), "recherche par préfixe du nom");
  ok((await look("b")).body.users.length === 0, "recherche par nom : 2 caractères minimum");
  ok((await look("alice")).body.users.length === 0, "la recherche par nom exclut soi-même");
  const hidden = await look("bob@test.local");
  const missing = await look("personne@test.local");
  ok(hidden.status === 404 && JSON.stringify(hidden.body) === JSON.stringify(missing.body), "email non trouvable : même réponse qu'un compte inexistant");
  await as(bob, () => api("PUT", "/account/visibility", { findableName: false, findableEmail: false }));
  ok((await look("bob")).body.users.length === 0, "compte non trouvable par nom : absent des résultats");
  ok((await as(bob, () => api("GET", "/account"))).body.findableName === false, "le réglage de visibilité est enregistré");
  await as(bob, () => api("PUT", "/account/visibility", { findableName: true, findableEmail: true }));
  const byMail = await look("bob@test.local");
  ok(byMail.status === 200 && byMail.body.users[0]?.email === "bob@test.local", "email trouvable une fois activé, et renvoyé");
  ok((await as(bob, () => api("PUT", "/account/visibility", { findableName: true }))).status === 400, "réglages de visibilité invalides refusés");
}
// SMTP status and test email (admin), email notifications (all off by default).
{
  const status = await as(alice, () => api("GET", "/admin/smtp"));
  ok(status.status === 200 && status.body.mode === "log" && !JSON.stringify(status.body).match(/pass/i), "admin : état du SMTP (mode log), sans mot de passe");
  ok((await as(bob, () => api("GET", "/admin/smtp"))).status === 403, "état du SMTP réservé aux admins");
  ok((await as(bob, () => api("POST", "/admin/smtp/test", {}))).status === 403, "email de test réservé aux admins");
  ok((await as(alice, () => api("POST", "/admin/smtp/test", { to: "pas-un-email" }))).status === 400, "email de test : adresse invalide refusée");
  const test = await as(alice, () => api("POST", "/admin/smtp/test", {}));
  ok(test.status === 200 && mails("alice@test.local").some((m) => m.startsWith("Test d'envoi")), "email de test envoyé à l'admin par défaut");
  const acc = (await as(bob, () => api("GET", "/account"))).body;
  const n = acc.notifications;
  ok(acc.emailEnabled === true && Object.keys(n).length === 5 && n.itemShared === true && !n.itemDeleted && !n.accessRevoked && !n.itemTransferred && !n.newLogin, "notifications : seuls les partages sont activés par défaut");
  ok((await as(alice, () => api("GET", "/admin"))).body.emailVerification === true, "vérification de l'email à l'inscription activée par défaut");
  await as(alice, () => api("PATCH", "/admin/settings", { emailVerification: false }));
  ok((await as(alice, () => api("GET", "/admin"))).body.emailVerification === false, "l'admin peut couper la vérification de l'email");
  await as(alice, () => api("PATCH", "/admin/settings", { emailVerification: true }));
  ok((await as(bob, () => api("PUT", "/account/notifications", { itemShared: true }))).status === 400, "réglages de notification incomplets refusés");
  await as(alice, () => api("PUT", "/account/notifications", { itemDeleted: false, itemShared: false, accessRevoked: false, itemTransferred: false, newLogin: false }));
  const prefs = { itemDeleted: true, itemShared: true, accessRevoked: false, itemTransferred: true, newLogin: false };
  ok((await as(bob, () => api("PUT", "/account/notifications", prefs))).status === 200, "Bob active des notifications");
  ok(JSON.stringify((await as(bob, () => api("GET", "/account"))).body.notifications) === JSON.stringify(prefs), "les notifications choisies sont enregistrées");
}
const bobPub = (await as(alice, () => api("GET", "/auth/lookup?email=bob@test.local"))).body.users[0];
nA = await tree(alice);
const aliceMails = mails("alice@test.local").length;
await as(alice, () => lib.shareItem(ctxOf(alice, nA), F, bobPub, "editor"));
ok(mails("bob@test.local").some((m) => m.includes("Alice t'a partagé un dossier")), "notification : Bob est prévenu du partage");
await as(bob, () => api("PUT", "/account/visibility", { findableName: false, findableEmail: false }));
ok((await as(alice, () => api("GET", "/auth/lookup?q=bob@test.local"))).body.users?.[0]?.id === bob.user.id, "compte masqué : toujours trouvable (email compris) par qui partage déjà avec lui");
ok((await as(alice, () => api("GET", "/auth/lookup?q=bob"))).body.users?.[0]?.email === "bob@test.local", "idem par nom, avec son email");
await as(bob, () => api("PUT", "/account/visibility", { findableName: true, findableEmail: false }));
let nB = await tree(bob);
ok(nB.get(F)?.name === "Projet secret" && nB.get(F)?.root, "Bob voit le dossier partagé à la racine de ses partages");
ok(nB.get(S)?.name === "Sous-dossier infra", "le sous-dossier est partagé par héritage");
ok(nB.get(B)?.name === "Tableau confidentiel" && nB.get(B)?.role === "editor", "le tableau du sous-dossier est accessible en éditeur");
const bobContent = await as(bob, () => lib.fetchBoardContent(nB.get(B)!.key!, B));
ok(bobContent.elements[0]?.label === "TOP_SECRET_DIAGRAM", "Bob déchiffre le contenu du tableau");

// Giving a root item away.
{
  const G = await as(alice, () => lib.createItem(ctxOf(alice, nA), "folder", null, "Cadeau"));
  nA = await tree(alice);
  await as(alice, () => lib.shareItem(ctxOf(alice, nA), G, bobPub, "viewer"));
  const give = (u: U, id: string, userId: string) => as(u, () => api("POST", `/items/${id}/transfer`, { userId }));
  ok((await give(bob, G, bob.user.id)).status === 403, "transfert : refusé à qui n'est pas propriétaire");
  ok((await give(alice, G, "personne")).status === 400, "transfert : refusé vers quelqu'un sans accès");
  ok((await give(alice, G, alice.user.id)).status === 400, "transfert : refusé vers soi-même");
  ok((await give(alice, S, bob.user.id)).status === 400, "transfert : refusé pour un élément qui n'est pas à la racine");
  const done = await give(alice, G, bob.user.id);
  ok(done.status === 200, "transfert : propriété donnée à Bob");
  nA = await tree(alice);
  nB = await tree(bob);
  ok(nB.get(G)?.role === "owner" && nB.get(G)?.ownerId === bob.user.id, "après le transfert, Bob est propriétaire");
  ok(nA.get(G)?.role === "editor" && nA.get(G)?.ownerId === bob.user.id, "après le transfert, Alice est éditrice");
  ok((await give(alice, G, bob.user.id)).status === 403, "transfert : l'ancien propriétaire ne peut plus rien donner");
  const alicePub = { id: alice.user.id, email: "alice@test.local", publicKey: alice.user.publicKey };
  await as(bob, () => lib.shareItem(ctxOf(bob, nB), G, alicePub, "viewer"));
  ok((await tree(alice)).get(G)?.role === "viewer", "le nouveau propriétaire peut partager");
  ok(mails("bob@test.local").some((m) => m.includes("Alice t'a donné un dossier")), "notification : Bob est prévenu du transfert");
}
// Deletion notifies those who turned it on (Bob), not the others (Alice: everything off).
{
  const D = await as(alice, () => lib.createItem(ctxOf(alice, nA), "board", null, "À jeter"));
  nA = await tree(alice);
  await as(alice, () => lib.shareItem(ctxOf(alice, nA), D, bobPub, "viewer"));
  const before = mails("bob@test.local").length;
  ok((await as(alice, () => api("DELETE", `/items/${D}`))).status === 200, "Alice met un tableau partagé à la corbeille");
  const after = mails("bob@test.local").slice(before);
  ok(after.length === 1 && after[0].includes("un tableau a été mis à la corbeille"), "notification : Bob est prévenu de la suppression");
  ok(mails("alice@test.local").length === aliceMails, "sans notification activée, aucun email n'est envoyé");
}

// Live collab + encrypted terminal.
const sa = boardSocket(alice, B);
const sb = boardSocket(bob, B);
await Promise.all([sa.open, sb.open]);
const initB = await sb.next((m) => m.t === "init");
await sa.next((m) => m.t === "init");
ok(initB.elements.length === 1 && !JSON.stringify(initB.elements).includes("TOP_SECRET"), "le serveur n'envoie que du chiffré");

const keyB = nA.get(B)!.key!;
const moved = { ...rect, x: 42, version: 4, versionNonce: 222 };
sb.send({ t: "scene", epoch: initB.epoch, elements: [await encryptEntry(nB.get(B)!.key!, B, moved)] });
const sceneA = await sa.next((m) => m.t === "scene");
ok((await decryptEntry(keyB, B, sceneA.elements[0])).x === 42, "modif de Bob reçue et déchiffrée par Alice");

// Tampering: server-side swap of the clear version must be rejected by the client.
const tampered = { ...sceneA.elements[0], v: 99 };
let rejected = false;
await decryptEntry(keyB, B, tampered).catch(() => (rejected = true));
ok(rejected, "un élément dont la version en clair est falsifiée est rejeté");

// Terminal created by Alice on her machine, sealed to its vault-authenticated public key.
const { listMachines } = await import("../web/src/vault.ts");
const mAlice = (await as(alice, () => listMachines(alice.keys)))[0];
ok(mAlice?.fingerprint === machine.fingerprint, "clé publique de la machine authentifiée via le coffre");
const tid2 = c.randomId();
const kt = await c.newSymKey();
sa.send({
  t: "term.create", reqId: "r2", id: tid2, machineId: machine.id, cols: 80, rows: 24,
  keyForBoard: await c.wrapKey(keyB, kt, c.AAD.termKey(B, tid2)),
  keyForAgent: await c.box(mAlice.auth, kt.raw, c.AAD.termAgent(tid2)),
  encLabel: await c.boxText(keyB, "laptop-alice", c.AAD.termLabel(B, tid2)),
});
const created = await sa.next((m) => m.t === "term.created" && m.reqId === "r2");
const termB = await sb.next((m) => m.t === "term" && m.terminal.id === tid2 && m.terminal.status === "running", 8000);
const ktBob = await c.unwrapKey(nB.get(B)!.key!, termB.terminal.keyForBoard, c.AAD.termKey(B, tid2));
ok(c.toB64(ktBob.raw) === c.toB64(kt.raw), "Bob récupère la clé du terminal via la clé du tableau");

await subscribe(sb, tid2);
const frame = await sendInput(sb, ktBob, tid2, "bobtab", "echo CLEAR_$((6*7))\n");
const out = await termOutput(sb, ktBob, tid2, "CLEAR_42");
ok(out.includes("CLEAR_42"), "Bob tape dans le terminal d'Alice, sortie chiffrée bout en bout");

// Replay attack: the server re-sends the exact same input frame.
sb.send(frame);
const out2 = await termOutput(sb, ktBob, tid2, "CLEAR_42").catch(() => "");
ok(!out2.includes("CLEAR_42"), "le rejeu d'une frappe par le serveur est ignoré par l'agent");

// File transfer rides on the local shell of tid2 and is sealed with its key: the server relays blind.
{
  const fdir = mkdtempSync(join(tmpdir(), "eb-files-"));
  await sendInput(sb, ktBob, tid2, "bobtab", `cd ${fdir} && echo CWD_$((6*7))\n`);
  await termOutput(sb, ktBob, tid2, "CWD_42");
  const seen: string[] = []; // everything the server relayed to the requester
  const fileReq = async (sock: ReturnType<typeof boardSocket>, key: c.SymKey, op: object) => {
    const rid = c.randomId();
    const ts = Date.now();
    const f = { t: "file.req", term: tid2, rid, ts, d: await c.box(key, c.utf8(JSON.stringify(op)), c.AAD.fileReq(tid2, rid, ts)) };
    sock.send(f);
    return { rid, f };
  };
  const open = async (key: c.SymKey, m: any) => {
    seen.push(JSON.stringify(m));
    return JSON.parse(c.fromUtf8(await c.unbox(key, m.d, c.AAD.fileRes(tid2, m.rid, m.n))));
  };
  const fileOne = async (sock: ReturnType<typeof boardSocket>, key: c.SymKey, op: object) => {
    const { rid } = await fileReq(sock, key, op);
    const m = await sock.next((x) => (x.t === "file.res" || x.t === "file.err") && x.rid === rid, 10000);
    return m.t === "file.err" ? { error: m.message } : open(key, m);
  };

  const name = "SECRET_NOM_FICHIER_42.txt";
  const content = Buffer.from("CONTENU_SECRET_FICHIER_42\n".repeat(50));
  const xfer = c.randomId();
  const begun = await fileOne(sb, ktBob, { op: "put", xfer, name, size: content.length });
  const chunked = await fileOne(sb, ktBob, { op: "chunk", xfer, n: 0, data: c.toB64(content) });
  const ended = await fileOne(sb, ktBob, { op: "end", xfer, sha256: createHash("sha256").update(content).digest("hex") });
  ok(begun.ok && chunked.ok && ended.ok && ended.path === join(fdir, name), "envoi d'un fichier dans le dossier du shell, par un éditeur");
  ok(readFileSync(join(fdir, name)).equals(content), "le fichier arrive sur le disque de la machine avec le bon contenu");
  const dup = await fileOne(sb, ktBob, { op: "put", xfer: c.randomId(), name, size: 1 });
  ok(dup.code === "exists", "écraser un fichier existant est refusé sans confirmation");
  const evil = await fileOne(sb, ktBob, { op: "put", xfer: c.randomId(), name: "../evil", size: 1 });
  ok(!!evil.error, "un nom avec un chemin est refusé");

  const listing = await fileOne(sb, ktBob, { op: "ls" });
  ok(listing.cwd === fdir && listing.entries.some((e: any) => e.name === name && e.size === content.length), "ls liste le fichier envoyé");

  const gx = c.randomId();
  const { rid: grid } = await fileReq(sb, ktBob, { op: "get", xfer: gx, path: name });
  const parts: Buffer[] = [];
  for (let n = 0; ; n++) {
    const m = await sb.next((x) => x.t === "file.res" && x.rid === grid, 10000);
    const body = await open(ktBob, m);
    if (body.data) parts.push(Buffer.from(c.fromB64(body.data)));
    if (m.end) {
      ok(body.sha256 === createHash("sha256").update(content).digest("hex"), "get : l'empreinte finale correspond");
      break;
    }
    await fileReq(sb, ktBob, { op: "ack", xfer: gx, n: n + 1 }); // answered by nothing
  }
  ok(Buffer.concat(parts).equals(content), "get renvoie exactement les mêmes octets");

  // Replay of a captured request: the agent answers once.
  const { rid: rrid, f: rframe } = await fileReq(sb, ktBob, { op: "ls" });
  await sb.next((x) => x.t === "file.res" && x.rid === rrid, 10000);
  sb.send(rframe);
  const echo = await sb.next((x) => (x.t === "file.res" || x.t === "file.err") && x.rid === rrid, 1500).then(() => true, () => false);
  ok(!echo, "le rejeu d'une requête de fichier est ignoré par l'agent");
  // An answer is never sent to someone else than the requester.
  const aliceHeard = await sa.next((x) => x.t === "file.res", 800).then(() => true, () => false);
  ok(!aliceHeard, "les réponses de fichier ne sont envoyées qu'à celui qui les a demandées");

  // A viewer is refused by the server.
  await as(alice, async () => {
    nA = await tree(alice);
    const X = await lib.createItem(ctxOf(alice, nA), "board", null, "Tableau lecture seule", { elements: [], files: {} });
    nA = await tree(alice);
    await lib.shareItem(ctxOf(alice, nA), X, bobPub, "viewer");
    const keyX = nA.get(X)!.key!;
    const tx = c.randomId();
    const ktx = await c.newSymKey();
    const sx = boardSocket(alice, X);
    await sx.open;
    await sx.next((m) => m.t === "init");
    sx.send({
      t: "term.create", reqId: "rx", id: tx, machineId: machine.id, cols: 80, rows: 24,
      keyForBoard: await c.wrapKey(keyX, ktx, c.AAD.termKey(X, tx)),
      keyForAgent: await c.box(mAlice.auth, ktx.raw, c.AAD.termAgent(tx)),
      encLabel: await c.boxText(keyX, "laptop-alice", c.AAD.termLabel(X, tx)),
    });
    await sx.next((m) => m.t === "term.created" && m.reqId === "rx");
    await sx.next((m) => m.t === "term" && m.terminal.id === tx && m.terminal.status === "running", 8000);
    const viewer = boardSocket(bob, X);
    await viewer.open;
    const vinit = await viewer.next((m) => m.t === "init");
    ok(vinit.you.role === "viewer", "Bob est lecteur sur ce tableau");
    const rid = c.randomId();
    const ts = Date.now();
    viewer.send({ t: "file.req", term: tx, rid, ts, d: await c.box(ktx, c.utf8(JSON.stringify({ op: "ls" })), c.AAD.fileReq(tx, rid, ts)) });
    const refused = await viewer.next((m) => m.t === "file.err" && m.rid === rid, 4000);
    ok(/lecture seule/i.test(refused.message), "un lecteur ne peut pas transférer de fichiers");
    // The owner's own request on the same terminal works, so the refusal was about the role.
    const rid2 = c.randomId();
    const ts2 = Date.now();
    sx.send({ t: "file.req", term: tx, rid: rid2, ts: ts2, d: await c.box(ktx, c.utf8(JSON.stringify({ op: "ls" })), c.AAD.fileReq(tx, rid2, ts2)) });
    const okAnswer = await sx.next((m) => m.t === "file.res" && m.rid === rid2, 8000);
    ok(!!okAnswer, "l'éditeur obtient sa réponse sur le même terminal");
    viewer.ws.close();
    sx.ws.close();
  });

  // Nothing about the file ever appears in clear: not in the database, the server log, nor the frames relayed.
  await new Promise((r) => setTimeout(r, 500));
  const fs = await import("node:fs");
  const haystacks = [DB, `${DB}-wal`, `${dirname(DB)}/server.log`].filter((p) => fs.existsSync(p)).map((p) => fs.readFileSync(p).toString("latin1"));
  haystacks.push(seen.join("\n"));
  const needles = [name, "SECRET_NOM_FICHIER", "CONTENU_SECRET_FICHIER", fdir, c.toB64(content).slice(0, 40)];
  ok(haystacks.every((h) => needles.every((n) => !h.includes(n))), "ni le nom, ni le contenu, ni le dossier du fichier n'apparaissent en clair côté serveur");
}

// Telnet to a device reachable from the machine (a fake switch): the target is sealed with the key.
const IAC = 255, DO = 253, WILL = 251, ECHO = 1, SGA = 3;
let switchGotNaws = false;
const fakeSwitch = createTcpServer((sock) => {
  sock.write(Buffer.from([IAC, WILL, ECHO, IAC, WILL, SGA, IAC, DO, 31]));
  sock.write("\r\nSwitch-TP>");
  sock.on("data", (d) => {
    if (d.includes(Buffer.from([IAC, 250, 31]))) switchGotNaws = true;
    const text = d.toString("latin1").replace(/\xff[\xfb-\xfe]./g, "").replace(/\xff\xfa[\s\S]*?\xff\xf0/g, "");
    if (text.includes("show version")) sock.write("\r\nIOS 12.2(55)SE TELNET_OK\r\nSwitch-TP>");
  });
});
await new Promise<void>((r) => fakeSwitch.listen(0, "127.0.0.1", () => r()));
const switchPort = (fakeSwitch.address() as any).port;
const tid3 = c.randomId();
const kt3 = await c.newSymKey();
sa.send({
  t: "term.create", reqId: "r3", id: tid3, machineId: machine.id, cols: 80, rows: 24,
  keyForBoard: await c.wrapKey(keyB, kt3, c.AAD.termKey(B, tid3)),
  keyForAgent: await c.boxJson(mAlice.auth, { k: c.toB64(kt3.raw), target: { kind: "telnet", host: "127.0.0.1", port: switchPort } }, c.AAD.termAgent(tid3)),
  encLabel: await c.boxText(keyB, `telnet 127.0.0.1:${switchPort} via laptop-alice`, c.AAD.termLabel(B, tid3)),
});
await sa.next((m) => m.t === "term.created" && m.reqId === "r3");
await subscribe(sa, tid3);
await termOutput(sa, kt3, tid3, "Switch-TP>");
await sendInput(sa, kt3, tid3, "alicetab", "show version\r");
const telnetOut = await termOutput(sa, kt3, tid3, "TELNET_OK");
ok(telnetOut.includes("TELNET_OK") && switchGotNaws, "telnet vers un équipement depuis la machine, négocié et chiffré jusqu'à l'agent");
const dbTelnet = new DatabaseSync(DB, { readOnly: true });
const tRow = JSON.stringify(dbTelnet.prepare("SELECT * FROM terminals WHERE id = ?").get(tid3) ?? {});
dbTelnet.close();
ok(!tRow.includes("127.0.0.1") && !tRow.includes("telnet"), "le serveur ne voit ni l'équipement ni le protocole");
fakeSwitch.close();

// Web tunnel: HTTP to a service on the machine, end-to-end encrypted through the agent.
const site = createServer((req, res) => res.end(`site:${req.method}:${req.url}:${req.headers["x-t"]}`));
// The same site also speaks WebSocket (echo; "bye" closes with 4001).
let wsSeen = { url: "", origin: "", cookie: "", protocol: "" };
new WebSocketServer({ server: site, handleProtocols: (p: Set<string>) => (p.has("chat") ? "chat" : false) }).on("connection", (sock: any, req: any) => {
  wsSeen = { url: req.url, origin: req.headers.origin ?? "", cookie: req.headers.cookie ?? "", protocol: sock.protocol };
  sock.on("message", (data: Buffer, isBinary: boolean) => (data.toString() === "bye" && !isBinary ? sock.close(4001, "fini") : sock.send(data, { binary: isBinary })));
});
await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
const sitePort = (site.address() as any).port;
const wid = c.randomTunnelId();
const kwA = await c.newSymKey();
const siteUrl = `http://127.0.0.1:${sitePort}`;
sa.send({
  t: "web.create", reqId: "w1", id: wid, machineId: machine.id,
  keyForBoard: await c.wrapKey(keyB, kwA, c.AAD.webKey(B, wid)),
  keyForAgent: await c.boxJson(mAlice.auth, { k: c.toB64(kwA.raw), url: siteUrl, insecure: false }, c.AAD.webAgent(wid)),
  encLabel: await c.boxJson(keyB, { url: siteUrl, insecure: false, machine: "laptop-alice" }, c.AAD.webLabel(B, wid)),
});
await sa.next((m) => m.t === "web.created" && m.reqId === "w1");
const webForBob = await sb.next((m) => m.t === "web" && m.web.id === wid);
const kwB = await c.unwrapKey(nB.get(B)!.key!, webForBob.web.keyForBoard, c.AAD.webKey(B, wid));
await new Promise((r) => setTimeout(r, 300));
async function tunnelGet(kw: c.SymKey, path: string) {
  const rid = c.randomId();
  const ts = Date.now();
  const d = await c.box(kw, c.utf8(JSON.stringify({ m: "GET", p: path, h: { "x-t": ["ok"] }, b: "" })), `eb:http-req:${wid}:${rid}:${ts}`);
  const r = await realFetch(`${PROXY}/eb-proxy/req/${wid}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rid, ts, d }) });
  const j: any = await r.json();
  const res = JSON.parse(c.fromUtf8(await c.unbox(kw, j.d, `eb:http-res:${wid}:${rid}`)));
  return { status: res.s, body: c.fromUtf8(c.fromB64(res.b)) };
}
const got = await tunnelGet(kwB, "/hello?x=1");
ok(got.status === 200 && got.body === "site:GET:/hello?x=1:ok", "Bob consulte le site de la machine d'Alice via le tunnel chiffré");

// Cable state: Alice's machine pings addresses for her, sealed both ways under the machine auth key.
async function probe(who: any, targets: string[]) {
  const rid = c.randomId();
  const ts = Date.now();
  const d = await c.boxJson(mAlice.auth, { targets }, c.AAD.probe(rid, ts));
  const r = await as(who, () => api("POST", `/machines/${machine.id}/probe`, { rid, ts, d }));
  return { ...r, rid };
}
const pr = await probe(alice, ["127.0.0.1", "not-an-ip"]);
const pres = pr.status === 200 ? await c.unboxJson<{ r: Record<string, { up: boolean }> }>(mAlice.auth, pr.body.d, c.AAD.probeRes(pr.rid)) : null;
ok(!!pres && "127.0.0.1" in pres.r && !("not-an-ip" in pres.r), "sonde d'un câble : l'agent d'Alice répond pour les adresses IP seulement");
ok(pres?.r["127.0.0.1"]?.up === true, "127.0.0.1 joignable depuis la machine d'Alice");
const misbound = pr.status === 200 ? await c.unboxJson(mAlice.auth, pr.body.d, c.AAD.probeRes(c.randomId())).then(() => true, () => false) : true;
ok(!misbound, "la réponse de la sonde est liée à sa requête");
ok((await probe(alice, ["127.0.0.1"])).status === 429, "sondes trop rapprochées refusées par le serveur");
ok((await probe(bob, ["127.0.0.1"])).status === 404, "Bob ne peut pas sonder depuis la machine d'Alice");

// "Vérifier le schéma": the same probe path with kind "ifaces" returns the machine's interfaces, sealed both ways.
{
  await new Promise((r) => setTimeout(r, 2100)); // one probe per machine every 2 s
  const rid = c.randomId();
  const ts = Date.now();
  const d = await c.boxJson(mAlice.auth, { kind: "ifaces", targets: [] }, c.AAD.probe(rid, ts));
  const r = await as(alice, () => api("POST", `/machines/${machine.id}/probe`, { rid, ts, d }));
  const res = r.status === 200 ? await c.unboxJson<{ ifaces?: { name: string; up: boolean; addrs: string[] }[]; r?: unknown }>(mAlice.auth, r.body.d, c.AAD.probeRes(rid)) : null;
  const lo = res?.ifaces?.find((i) => i.name === "lo" || i.name === "lo0");
  ok(r.status === 200 && Array.isArray(res?.ifaces) && res.r === undefined, "sonde « ifaces » : l'agent répond avec ses interfaces, pas des pings");
  ok(!!lo && lo.up && lo.addrs.includes("127.0.0.1/8"), "sonde « ifaces » : lo avec 127.0.0.1/8");
  // What the server relays and keeps: neither the blob nor the log nor the database holds an address or a name in clear.
  const relayed = Buffer.from(r.body.d, "base64").toString("latin1");
  const dbText = [DB, `${DB}-wal`, `${dirname(DB)}/server.log`].filter((p) => existsSync(p)).map((p) => readFileSync(p).toString("latin1")).join("\n");
  ok(![relayed, dbText].some((t) => t.includes("127.0.0.1/8") || t.includes('"name":"lo"') || t.includes('"kind":"ifaces"')), "sonde « ifaces » : ni adresse ni nom d'interface en clair côté serveur (blob relayé, base, journal)");
  await new Promise((r) => setTimeout(r, 2100));
  const old = await probe(alice, ["127.0.0.1"]);
  const oldRes = old.status === 200 ? await c.unboxJson<{ r?: Record<string, unknown>; ifaces?: unknown }>(mAlice.auth, old.body.d, c.AAD.probeRes(old.rid)) : null;
  ok(!!oldRes?.r && oldRes.ifaces === undefined, "sonde sans « kind » (ancien web) : toujours un ping");
}

// Machine sharing. Through the board: Alice's machine has a shell here, so her browser links it to
// the board (its keys boxed under the board key) and Bob, editor, can use it from this board.
{
  const vault = await import("../web/src/vault.ts");
  const keyBobB = nB.get(B)!.key!;
  const tryTerm = async (auth: c.SymKey, reqId: string) => {
    const id = c.randomId();
    const k = await c.newSymKey();
    sb.send({
      t: "term.create", reqId, id, machineId: machine.id, cols: 80, rows: 24,
      keyForBoard: await c.wrapKey(keyBobB, k, c.AAD.termKey(B, id)),
      keyForAgent: await c.box(auth, k.raw, c.AAD.termAgent(id)),
      encLabel: await c.boxText(keyBobB, "partagée", c.AAD.termLabel(B, id)),
    });
    const r = await sb.next((m) => (m.t === "term.created" || m.t === "error") && m.reqId === reqId);
    return { ok: r.t === "term.created", id, k };
  };
  const bogus = await c.newSymKey();
  ok(!(await tryTerm(bogus, "s0")).ok, "partage : Bob ne peut pas ouvrir de shell sur la machine d'Alice sans partage");

  const bobMachines = async (board: boolean) => {
    vault.setMachineBoard(board ? { id: B, key: keyBobB } : null);
    try {
      return await as(bob, () => vault.listMachines(bob.keys));
    } finally {
      vault.setMachineBoard(null);
    }
  };
  ok((await bobMachines(true)).length === 0, "partage : aucune machine liée au tableau tant qu'Alice ne l'a pas liée");
  // The session list comes from the server: it alone never makes Alice's browser link her machine.
  await as(alice, () => vault.syncBoardLinks(alice.keys, { id: B, key: keyB }, new Set([machine.id])));
  ok((await bobMachines(true)).length === 0, "partage via le tableau : pas de lien sans action d'Alice (liste de sessions du serveur ignorée)");
  await as(alice, () => vault.linkMachine({ id: B, key: keyB }, mAlice));
  const viaBoard = (await bobMachines(true)).find((m) => m.id === machine.id);
  ok(viaBoard?.access === "board" && viaBoard.name === "laptop-alice" && viaBoard.fingerprint === machine.fingerprint, "partage via le tableau : Bob voit la machine d'Alice depuis ce tableau");
  ok(!(await bobMachines(false)).some((m) => m.id === machine.id), "partage via le tableau : la machine n'est pas proposée hors de ce tableau");
  const sh = await tryTerm(viaBoard!.auth, "s1");
  ok(sh.ok, "partage via le tableau : Bob ouvre un shell sur la machine d'Alice");
  await sb.next((m) => m.t === "term" && m.terminal.id === sh.id && m.terminal.status === "running", 8000);
  await subscribe(sb, sh.id);
  await sendInput(sb, sh.k, sh.id, "bobshare", "echo SHARED_$((6*8))\n");
  ok((await termOutput(sb, sh.k, sh.id, "SHARED_48")).includes("SHARED_48"), "partage via le tableau : le shell de Bob tourne sur l'agent d'Alice");

  const lastProbe = Date.now();
  await new Promise((r) => setTimeout(r, Math.max(0, 2100 - (Date.now() - lastProbe))));
  const rid = c.randomId();
  const ts = Date.now();
  const d = await c.boxJson(viaBoard!.auth, { targets: ["127.0.0.1"] }, c.AAD.probe(rid, ts));
  const noBoard = await as(bob, () => api("POST", `/machines/${machine.id}/probe`, { rid, ts, d }));
  ok(noBoard.status === 404, "partage via le tableau : pas de sonde sans dire de quel tableau");
  const withBoard = await as(bob, () => api("POST", `/machines/${machine.id}/probe`, { rid, ts, d, boardId: B }));
  ok(withBoard.status === 200, "partage via le tableau : Bob sonde les câbles du tableau depuis la machine d'Alice");

  for (const [path, body] of [
    [`/machines/${machine.id}/shares/${bob.user.id}`, { sealed: "AAAA" }],
    [`/machines/${machine.id}/links/${B}`, { wrapped: "AAAA" }],
  ] as const) {
    ok((await as(bob, () => api("PUT", path, body))).status === 404, `partage : Bob ne peut pas se donner la machine d'Alice (${path.split("/")[3]})`);
  }
  ok((await as(bob, () => api("GET", `/machines/${machine.id}/shares`))).status === 404, "partage : Bob ne voit pas les partages de la machine d'Alice");

  await as(alice, () => vault.setShareBoards(machine.id, false));
  const gone = await sb.next((m) => m.t === "term.gone" && m.id === sh.id).then(() => true, () => false);
  ok(gone, "partage via les tableaux désactivé : le shell de Bob est fermé");
  ok((await bobMachines(true)).length === 0 && !(await tryTerm(viaBoard!.auth, "s2")).ok, "partage via les tableaux désactivé : Bob n'a plus accès");
  const relink = await as(alice, () => api("PUT", `/machines/${machine.id}/links/${B}`, { wrapped: "AAAA" }));
  ok(relink.status === 409, "partage via les tableaux désactivé : plus aucun lien possible");

  // Directly: the keys sealed to Bob's public key, usable from any board he edits.
  await as(alice, () => vault.shareMachine(alice.user, alice.keys, mAlice, { id: bob.user.id, email: "bob@test.local", publicKey: c.toB64(bob.keys.pub) }));
  const direct = (await bobMachines(false)).find((m) => m.id === machine.id);
  ok(direct?.access === "shared" && direct.ownerName === "Alice" && c.toB64(direct.auth.raw) === c.toB64(mAlice.auth.raw), "partage direct : Bob reçoit la machine, scellée pour sa clé");
  const sh2 = await tryTerm(direct!.auth, "s3");
  ok(sh2.ok, "partage direct : Bob ouvre un shell sur la machine d'Alice");
  const shares = await as(alice, () => vault.machineShares(machine.id));
  ok(shares.shares.length === 1 && shares.shares[0].userId === bob.user.id, "partage direct : Alice voit avec qui elle partage");
  await as(alice, () => vault.unshareMachine(machine.id, bob.user.id));
  ok(await sb.next((m) => m.t === "term.gone" && m.id === sh2.id).then(() => true, () => false), "partage direct retiré : le shell de Bob est fermé");
  ok(!(await bobMachines(false)).some((m) => m.id === machine.id) && !(await tryTerm(direct!.auth, "s4")).ok, "partage direct retiré : Bob n'a plus accès");
  await as(alice, () => vault.setShareBoards(machine.id, true));
}
// WebSocket through the tunnel: sealed messages, sealed close, counters in the AAD.
async function tunnelSocket(kw: c.SymKey, path: string, opts: { cookie?: string; protos?: string[]; badKey?: boolean } = {}) {
  const sid = c.randomId();
  const ws = new WebSocket(`${PROXY.replace("http", "ws")}/eb-proxy/ws/${wid}`);
  const frames: any[] = [];
  const waiters: ((f: any) => void)[] = [];
  ws.on("message", (raw: Buffer) => {
    const f = JSON.parse(raw.toString());
    const w = waiters.shift();
    if (w) w(f);
    else frames.push(f);
  });
  const closed = new Promise<number>((r) => ws.on("close", (code: number) => r(code)));
  const frame = (ms = 4000) =>
    new Promise<any>((resolve, reject) => {
      const f = frames.shift();
      if (f) return resolve(f);
      const t = setTimeout(() => reject(new Error("pas de trame")), ms);
      waiters.push((x) => (clearTimeout(t), resolve(x)));
    });
  await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
  const ts = Date.now();
  const useKey = opts.badKey ? await c.newSymKey() : kw;
  const d = await c.box(useKey, c.utf8(JSON.stringify({ p: path, protos: opts.protos ?? [], cookie: opts.cookie ?? "" })), `eb:ws-open:${wid}:${sid}:${ts}`);
  ws.send(JSON.stringify({ t: "open", sid, ts, d }));
  let sendN = 0;
  let recvN = 0;
  return {
    ws, closed, frame,
    ack: async () => JSON.parse(c.fromUtf8(await c.unbox(kw, (await frame()).d, `eb:ws-ack:${wid}:${sid}`))),
    send: async (text: string) => {
      const d = await c.box(kw, new Uint8Array([0, ...c.utf8(text)]), `eb:ws-msg:${wid}:${sid}:c2a:${sendN++}`);
      ws.send(JSON.stringify({ t: "data", d }));
    },
    recv: async () => {
      const f = await frame();
      if (f.t === "close") return { close: JSON.parse(c.fromUtf8(await c.unbox(kw, f.d, `eb:ws-close:${wid}:${sid}:a2c:${recvN}`))) };
      const pt = await c.unbox(kw, f.d, `eb:ws-msg:${wid}:${sid}:a2c:${recvN++}`);
      return { text: c.fromUtf8(pt.subarray(1)) };
    },
    sid,
  };
}
const sock = await tunnelSocket(kwB, "/live?x=1", { cookie: "s=1", protos: ["chat"] });
const sockAck = await sock.ack();
ok(sockAck.ok && sockAck.proto === "chat", "WebSocket : le site accepte l'ouverture et le sous-protocole");
ok(wsSeen.url === "/live?x=1" && wsSeen.cookie === "s=1" && wsSeen.origin === siteUrl, "WebSocket : chemin, cookies et Origin sont ceux du site cible");
await sock.send("bonjour");
ok((await sock.recv()).text === "bonjour", "WebSocket : les messages font l'aller-retour chiffrés");
await sock.send("bye");
const bye: any = await sock.recv();
ok(bye.close?.code === 4001 && bye.close?.reason === "fini", "WebSocket : la fermeture du site est authentifiée et garde son code");
// The server cannot slip a message in, replay one or reorder: frames are bound to a counter.
const sock2 = await tunnelSocket(kwB, "/live");
await sock2.ack();
await sock2.send("un");
await sock2.recv();
const forged = await c.box(kwB, new Uint8Array([0, ...c.utf8("forgé")]), `eb:ws-msg:${wid}:${sock2.sid}:c2a:7`);
sock2.ws.send(JSON.stringify({ t: "data", d: forged }));
await sock2.send("après");
const afterForge = await sock2.frame().catch(() => null);
ok(afterForge?.t === "close" && !afterForge.d, "WebSocket : un message hors compteur coupe la socket (fermeture non authentifiée)");
sock2.ws.close();
// Wrong key: the agent never opens anything, the page just gets no ack.
const sock3 = await tunnelSocket(kwB, "/live", { badKey: true });
const noAck = await Promise.race([sock3.frame().then(() => "ack"), new Promise((r) => setTimeout(() => r("rien"), 800))]);
ok(noAck === "rien", "WebSocket : une ouverture scellée avec une autre clé est ignorée");
sock3.ws.close();
const unknown = new WebSocket(`${PROXY.replace("http", "ws")}/eb-proxy/ws/${c.randomId()}`);
const unknownCode = await new Promise((r) => (unknown.on("error", () => r("refusé")), unknown.on("open", () => r("ouvert"))));
ok(unknownCode === "refusé", "WebSocket : un tunnel inconnu est refusé");
const foreign = new WebSocket(`${PROXY.replace("http", "ws")}/eb-proxy/ws/${wid}`, { headers: { origin: "https://evil.example" } });
const foreignCode = await new Promise((r) => (foreign.on("error", () => r("refusé")), foreign.on("open", () => r("ouvert"))));
ok(foreignCode === "refusé", "WebSocket : une page d'une autre origine ne peut pas ouvrir de socket");

// Third user / admin cannot read.
const inv = await as(alice, () => api("POST", "/admin/invites", { note: "carol" }));
const carol = await register("carol@test.local", "Carol", "carol-password-1", new URL(inv.body.url).searchParams.get("invite")!);
const carolRead = await as(carol, () => api("GET", `/items/${B}/content`));
ok(carolRead.status === 404, "un tiers ne peut pas lire le tableau");
const carolGrant = await as(carol, () => api("PUT", `/items/${B}/grants/${carol.user.id}`, { role: "editor", wrappedKey: "AAAA" }));
ok(carolGrant.status === 404 || carolGrant.status === 403, "un tiers ne peut pas s'ajouter un partage");
const adminSelf = await as(alice, () => api("PUT", `/items/${B}/grants/${carol.user.id}`, { role: "editor", wrappedKey: "AAAA" }));
ok(adminSelf.status === 200, "(le propriétaire, lui, peut partager)");
await as(alice, () => api("POST", `/items/${B}/revoke`, {})).catch(() => {});
// Admin endpoints never expose content or credentials.
const adminView = await as(alice, () => api("GET", "/admin"));
ok(!JSON.stringify(adminView.body).match(/enc_|auth_hash|private/i), "l'API admin n'expose ni clés ni hash");
const resetOther = await as(alice, () => api("PATCH", `/admin/users/${bob.user.id}`, { password: "hacked" }));
ok(resetOther.status === 400, "un admin ne peut pas changer le mot de passe d'un autre");

// Revoke Bob on F: rotation.
nA = await tree(alice);
// clean the bogus Carol grant via a proper revoke as well (exercises rotation twice)
await as(alice, () => lib.revokeAccess(ctxOf(alice, nA), B, carol.user.id));
nA = await tree(alice);
const oldKeyB = keyB;

// Malicious server: slips a fake member (its own key) into the folder before the rotation.
const evil = await c.generateKeyPair();
const rw = new DatabaseSync(DB);
rw.prepare("INSERT INTO users (id, email, name, auth_hash, kdf_salt, public_key, enc_private_key, recovery_enc_private_key, recovery_auth_hash, color, created_at) VALUES ('evilevilevilevilevil', 'evil@x.y', 'Evil', 'x', 'x', ?, 'x', 'x', 'x', '#000', 0)").run(c.toB64(evil.pub));
rw.prepare("INSERT INTO grants (item_id, user_id, role, wrapped_key, created_at) VALUES (?, 'evilevilevilevilevil', 'viewer', 'AAAA', 0)").run(F);
let injected = "";
await as(alice, () => lib.revokeAccess(ctxOf(alice, nA), F, bob.user.id)).catch((e) => (injected = String(e)));
ok(/non vérifiée/.test(injected), "rotation refusée si le serveur glisse un membre non vérifié");
rw.prepare("DELETE FROM grants WHERE user_id = 'evilevilevilevilevil'").run();

// Malicious server: swaps Bob's public key, then Alice changes Bob's role.
const realBobKey = rw.prepare("SELECT public_key AS k FROM users WHERE id = ?").get(bob.user.id) as any;
rw.prepare("UPDATE users SET public_key = ? WHERE id = ?").run(c.toB64(evil.pub), bob.user.id);
let swapped = "";
const bobMember = { id: bob.user.id, email: "bob@test.local", publicKey: c.toB64(evil.pub) };
await as(alice, () => lib.shareItem(ctxOf(alice, nA), F, bobMember, "viewer")).catch((e) => (swapped = String(e)));
ok(/a changé/.test(swapped), "partage refusé si la clé d'un contact a été substituée");
rw.prepare("UPDATE users SET public_key = ? WHERE id = ?").run(realBobKey.k, bob.user.id);

const sb2 = boardSocket(bob, B);
await sb2.open;
await sb2.next((m) => m.t === "init");
await as(alice, () => lib.revokeAccess(ctxOf(alice, nA), F, bob.user.id, (m) => console.log("   ↳", m)));
const codeB = await sb2.closed;
ok(codeB === 4409, "les sessions ouvertes sont coupées après rotation (4409)");
nB = await tree(bob);
ok(!nB.has(F) && !nB.has(S) && !nB.has(B), "Bob ne voit plus rien du dossier");
const bobAfter = await as(bob, () => api("GET", `/items/${B}/content`));
ok(bobAfter.status === 404, "le serveur refuse le contenu à Bob");
nA = await tree(alice);
const newKeyB = nA.get(B)!.key!;
ok(c.toB64(newKeyB.raw) !== c.toB64(oldKeyB.raw), "la clé du tableau a changé");
ok(nA.get(B)!.name === "Tableau confidentiel" && nA.get(S)!.name === "Sous-dossier infra", "Alice déchiffre tout avec les nouvelles clés");
const fresh = await as(alice, () => lib.fetchBoardContent(newKeyB, B));
ok(fresh.elements[0]?.x === 42, "contenu re-chiffré intact");
const rawAfter = (await as(alice, () => api("GET", `/items/${B}/content`))).body.elements[0];
let oldKeyWorks = true;
await decryptEntry(oldKeyB, B, rawAfter).catch(() => (oldKeyWorks = false));
ok(!oldKeyWorks, "l'ancienne clé (connue de Bob) ne déchiffre plus rien");

// Terminal was re-keyed (on Alice's machine): new key works, old doesn't.
const sa2 = boardSocket(alice, B);
await sa2.open;
const init2 = await sa2.next((m) => m.t === "init");
const t2 = init2.terminals.find((t: any) => t.id === tid2);
const kt2 = await c.unwrapKey(newKeyB, t2.keyForBoard, c.AAD.termKey(B, tid2));
ok(c.toB64(kt2.raw) !== c.toB64(kt.raw), "le terminal a reçu une nouvelle clé");
const w2 = init2.webs.find((w: any) => w.id === wid);
const kw2 = await c.unwrapKey(newKeyB, w2.keyForBoard, c.AAD.webKey(B, wid));
ok(c.toB64(kw2.raw) !== c.toB64(kwA.raw), "le tunnel web a reçu une nouvelle clé");
await new Promise((r) => setTimeout(r, 300));
ok((await tunnelGet(kw2, "/after")).body === "site:GET:/after:ok", "le tunnel fonctionne avec la nouvelle clé");
await subscribe(sa2, tid2);
await sendInput(sa2, kt2, tid2, "alicetab", "echo ROTATED_$((7*7))\n");
ok((await termOutput(sa2, kt2, tid2, "ROTATED_49")).includes("ROTATED_49"), "le terminal fonctionne avec la nouvelle clé");

// Nothing sensitive in the database.
await new Promise((r) => setTimeout(r, 2000));
const dump = JSON.stringify(new DatabaseSync(DB, { readOnly: true }).prepare("SELECT * FROM items").all()) +
  JSON.stringify(new DatabaseSync(DB, { readOnly: true }).prepare("SELECT * FROM boards").all()) +
  JSON.stringify(new DatabaseSync(DB, { readOnly: true }).prepare("SELECT * FROM machines").all()) +
  JSON.stringify(new DatabaseSync(DB, { readOnly: true }).prepare("SELECT * FROM tunnels").all());
ok(!/Projet secret|Sous-dossier|confidentiel|TOP_SECRET|laptop-alice|CLEAR_42|127\.0\.0\.1/.test(dump), "aucun nom, contenu ni adresse en clair dans la base");
site.close();

// Pairing with a short code (no copy-paste): the agent makes its key on the machine.
{
  const { approvePairing, listMachines: lm } = await import("../web/src/vault.ts");
  const pr = (await as(alice, () => api("POST", "/machines/pairings"))).body;
  const cfgPath = `${process.env.DB}.agent-pair.json`;
  const agentBin = new URL(`../agent/dist/excalibash-agent-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`, import.meta.url).pathname;
  const pairProc = spawn(agentBin, ["--server", BASE, "--pair", pr.code.toLowerCase(), "--pair-only", "--config", cfgPath, "--name", "vm-tp"], { stdio: ["ignore", "ignore", "pipe"] });
  let pairOut = "";
  pairProc.stderr.on("data", (d) => (pairOut += d));
  let claim: any = null;
  for (let i = 0; i < 30 && !claim; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const st = (await as(alice, () => api("GET", `/machines/pairings/${pr.code}`))).body;
    if (st.status === "claimed") claim = st;
  }
  const fp = await c.fingerprint(c.fromB64(claim.agentPub));
  ok(pairOut.includes(fp), "l'empreinte affichée sur la machine est celle montrée dans le navigateur");
  const confirm = pairOut.match(/Code de confirmation : ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1];
  ok(!!confirm, "la machine affiche un code de confirmation");
  ok(c.confirmValid(c.normalizeConfirm(confirm!)) && !c.confirmValid("7KQ4FDX6") && c.confirmValid("7KQ4FDX5"), "le code de confirmation porte une lettre de contrôle (même calcul que l'agent)");
  await as(alice, () => approvePairing(alice.keys, pr.code, claim.agentPub, confirm!, "vm-tp"));
  const exit = await new Promise<number>((r) => pairProc.on("exit", (code) => r(code ?? -1)));
  ok(exit === 0, "l'agent est appairé et sa configuration enregistrée");
  const reuse = await realFetch(`${BASE}/api/pair/${pr.code.replace("-", "")}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pub: c.toB64(c.randomBytes(32)) }) });
  ok(reuse.status === 404, "un code déjà utilisé est refusé");
  const paired = spawn(agentBin, ["--config", cfgPath], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1200));
  const pm = (await as(alice, () => lm(alice.keys))).find((m) => m.name === "vm-tp");
  ok(pm?.online, "la machine appairée se connecte avec sa configuration");
  const pt = c.randomId();
  const pk = await c.newSymKey();
  const sp = boardSocket(alice, B);
  await sp.open;
  await sp.next((m) => m.t === "init");
  const nowKeyB = (await tree(alice)).get(B)!.key!;
  sp.send({
    t: "term.create", reqId: "p1", id: pt, machineId: pm!.id, cols: 80, rows: 24,
    keyForBoard: await c.wrapKey(nowKeyB, pk, c.AAD.termKey(B, pt)),
    keyForAgent: await c.box(pm!.auth, pk.raw, c.AAD.termAgent(pt)),
    encLabel: await c.boxText(nowKeyB, "vm-tp", c.AAD.termLabel(B, pt)),
  });
  const runningMsg = await sp.next((m) => m.t === "term" && m.terminal.id === pt && m.terminal.status === "running", 8000);
  await subscribe(sp, pt);
  await sendInput(sp, pk, pt, "pairtab", "echo PAIRED_$((5*5))\n");
  ok((await termOutput(sp, pk, pt, "PAIRED_25")).includes("PAIRED_25"), "un shell s'ouvre sur la machine appairée");
  // The hello carries the agent's version and features: plain metadata, in the machine list and in the terminal's state.
  const mine = (await as(alice, () => api("GET", "/machines"))).body.machines.find((m: any) => m.id === pm!.id);
  ok(Array.isArray(mine?.agentCaps) && ["files", "capture", "ifaces", "jupyter", "probe", "schema"].every((k) => mine.agentCaps.includes(k)) && typeof mine.agentVersion === "string", "le hello de l'agent annonce sa version et ses fonctions (liste des machines)");
  const tinfo = runningMsg.terminal;
  ok(tinfo.agentCaps.includes("capture") && typeof tinfo.agentVersion === "string" && !("hostname" in tinfo), "l'état d'un terminal porte les fonctions de l'agent, sans autre métadonnée de la machine");
  paired.kill();
  sp.ws.close();
  // Removing the machine hands back the command that removes its agent from the machine itself.
  ok((await as(bob, () => api("DELETE", `/machines/${pm!.id}`))).status === 404, "Bob ne peut pas supprimer la machine d'Alice");
  const del = await as(alice, () => api("DELETE", `/machines/${pm!.id}`));
  ok(del.status === 200 && /^curl .*\/uninstall\.sh \| sh$/.test(del.body.uninstall ?? ""), "suppression d'une machine : commande de désinstallation de l'agent fournie");
  const script = await (await realFetch(`${BASE}/uninstall.sh`)).text();
  ok(script.startsWith("#!/bin/sh") && script.includes(".config/excalibash") && script.includes("systemctl --user disable"), "/uninstall.sh retire le service, le programme et la configuration");
  const upd = await (await realFetch(`${BASE}/update.sh`)).text();
  ok(upd.startsWith("#!/bin/sh") && upd.includes("excalibash-agent-$OS-$ARCH") && upd.includes("systemctl --user restart") && !/rm -rf|--token|EXCALIBASH_KEY|agent\.env/.test(upd), "/update.sh remplace le programme et relance le service, sans toucher à l'identité ni contenir de secret");
}

// Agent self-update (tests/run.sh builds a v1 agent with a throwaway release key, serves a signed v2 release
// from AGENT_DIST_DIR, and gives us the tools). Real crypto end to end: the browser boxes the request under the
// machine auth key, the server relays blind, the agent verifies the signature with the key compiled into it.
if (process.env.UPDATE_V1_BIN && process.env.UPDATE_SIGN && process.env.UPDATE_KEY && process.env.UPDATE_DIST) {
  const { approvePairing, listMachines: lm } = await import("../web/src/vault.ts");
  const { execFileSync } = await import("node:child_process");
  const { copyFileSync, chmodSync, mkdirSync, rmSync } = await import("node:fs");
  const sign = (key: string, version: string) => execFileSync(process.env.UPDATE_SIGN!, ["sign", "--key", key, "--dist", process.env.UPDATE_DIST!, "--version", version], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "eb-upd-"));
  const exe = join(home, "excalibash-agent");
  copyFileSync(process.env.UPDATE_V1_BIN, exe);
  chmodSync(exe, 0o755);
  const cfgPath = join(home, "agent.json");

  // Pair a v1 agent (it runs from its own directory, so it can replace itself).
  const pr = (await as(alice, () => api("POST", "/machines/pairings"))).body;
  const pairProc = spawn(exe, ["--server", BASE, "--pair", pr.code.toLowerCase(), "--pair-only", "--config", cfgPath, "--name", "maj-agent"], { stdio: ["ignore", "ignore", "pipe"] });
  let pairErr = "";
  pairProc.stderr.on("data", (d) => (pairErr += d));
  let claim: any = null;
  for (let i = 0; i < 30 && !claim; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const st = (await as(alice, () => api("GET", `/machines/pairings/${pr.code}`))).body;
    if (st.status === "claimed") claim = st;
  }
  let confirmCode: string | undefined;
  for (let i = 0; i < 30 && !confirmCode; i++) {
    confirmCode = pairErr.match(/Code de confirmation : ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1];
    if (!confirmCode) await new Promise((r) => setTimeout(r, 200));
  }
  await as(alice, () => approvePairing(alice.keys, pr.code, claim.agentPub, confirmCode!, "maj-agent"));
  await new Promise<number>((r) => pairProc.on("exit", (code) => r(code ?? -1)));
  const upProc = spawn(exe, ["--config", cfgPath], { stdio: ["ignore", "ignore", "pipe"] });
  let upLog = "";
  upProc.stderr.on("data", (d) => (upLog += d));
  const listUm = async () => (await as(alice, () => lm(alice.keys))).find((m) => m.name === "maj-agent");
  const waitFor = async (cond: (m: any) => boolean, ms = 20_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
      const m = await listUm();
      if (m && cond(m)) return m;
    }
    return null;
  };
  const um = (await waitFor((m) => m.online && !!m.agentVersion))!;
  ok(um?.agentVersion === "1.0.0" && um.agentCaps.includes("update"), "mise à jour : l'agent v1 annonce sa version et la fonction « update »");
  const machineId = um.id;

  const latest = await (await realFetch(`${BASE}/api/agent/latest`)).json();
  ok(latest.version === "2.0.0" && latest.signed === true, "GET /api/agent/latest annonce la version signée publiée");
  const dl = async (f: string) => realFetch(`${BASE}/downloads/${f}`);
  ok((await dl("agent-manifest.json")).status === 200 && (await dl("agent-manifest.json.sig")).status === 200, "le manifeste et sa signature sont servis par /downloads");
  ok((await dl("agent-manifest.json.bak")).status === 404 && (await dl("agent-manifest.json.sig.old")).status === 404 && (await dl("..%2Fserver.log")).status === 404, "/downloads : liste blanche stricte des noms");
  ok(((await (await realFetch(`${BASE}/downloads`)).json()) as any).files.includes("agent-manifest.json"), "/downloads liste le manifeste");

  /** POST /machines/:id/update with real crypto, then reads the boxed progress frames for at most `ms`. */
  async function trigger(who: U, key: any, ms: number, o: { rid?: string; ts?: number; d?: string } = {}) {
    const rid = o.rid ?? c.randomId();
    const ts = o.ts ?? Date.now();
    const d = o.d ?? (await c.boxJson(key, { op: "update" }, c.AAD.update(rid, ts)));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    const frames: any[] = [];
    let raw = "";
    let status = 0;
    try {
      const r = await realFetch(`${BASE}/api/machines/${machineId}/update`, { method: "POST", headers: { "content-type": "application/json", cookie: who.cookie }, body: JSON.stringify({ rid, ts, d }), signal: ctl.signal });
      status = r.status;
      if (status !== 200) return { status, frames, raw, rid, ts, d, error: ((await r.json().catch(() => ({}))) as any).error };
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        raw += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) frames.push(await c.unboxJson(key, JSON.parse(line).d, c.AAD.updateRes(rid)));
        }
      }
    } catch {
      // aborted: the agent said nothing more
    } finally {
      clearTimeout(timer);
    }
    return { status, frames, raw, rid, ts, d, error: undefined as string | undefined };
  }
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const cool = (ms = 1700) => pause(ms); // UPDATE_INTERVAL_MS=1500 on this server: one request per machine every 1.5 s here

  // Who may ask, and how often.
  ok((await trigger(bob, um.auth, 2000)).status === 404, "mise à jour : Bob ne peut pas la demander sur la machine d'Alice");
  const wrongKey = await c.newSymKey();
  const wrong = await trigger(alice, wrongKey, 1000);
  ok(wrong.status === 200 && wrong.frames.length === 0 && wrong.raw === "", "une requête chiffrée avec une autre clé que machineAuth est ignorée par l'agent");
  ok((await listUm())?.agentVersion === "1.0.0", "…l'agent reste en version 1.0.0");
  const tooFast = await trigger(alice, um.auth, 1000);
  ok(tooFast.status === 429, "mises à jour trop rapprochées refusées par le serveur (1 par intervalle et par machine)");
  await cool();

  // A manifest signed with another key is refused; the agent stays up on v1. The same request replayed is ignored.
  const rogue = join(home, "rogue.key");
  execFileSync(process.env.UPDATE_SIGN!, ["keygen", "--out", rogue], { stdio: "pipe" });
  sign(rogue, "2.0.0");
  const refused = await trigger(alice, um.auth, 15_000);
  const last = refused.frames.at(-1);
  ok(last?.phase === "error" && /signature/.test(last.msg) && refused.frames.every((f: any, i: number) => f.n === i + 1), `manifeste signé par une autre clé refusé : « ${last?.msg} »`);
  ok(!refused.raw.includes("signature") && !refused.raw.includes("phase"), "le serveur ne relaie que des chiffrés (aucune phase ni message en clair)");
  ok(refused.frames.some((f: any) => f.phase === "check"), "la progression commence par la vérification");
  const stillV1 = await listUm();
  ok(stillV1?.online && stillV1.agentVersion === "1.0.0", "…l'agent est toujours en ligne en 1.0.0");
  await cool();
  const replay = await trigger(alice, um.auth, 2500, { rid: refused.rid, ts: refused.ts, d: refused.d });
  ok(replay.status === 200 && replay.frames.length === 0, "la même requête rejouée est ignorée par l'agent");
  await cool();
  const stale = await trigger(alice, um.auth, 2500, { ts: Date.now() - 6 * 60_000 });
  ok(stale.frames.length === 0, "une requête de plus de 5 minutes est ignorée");
  await cool();

  // The real update: signed by the release key, v2 replaces v1, the process execs itself and reconnects.
  sign(process.env.UPDATE_KEY!, "2.0.0");
  const pid1 = upProc.pid;
  const okRun = await trigger(alice, um.auth, 60_000);
  const phases = okRun.frames.map((f: any) => f.phase).join(",");
  ok(/^check,download,install,restarting$/.test(phases), `mise à jour réelle : ${phases}`);
  const v2 = await waitFor((m) => m.online && m.agentVersion === "2.0.0", 30_000);
  ok(!!v2 && v2.id === machineId, "l'agent revient en 2.0.0 avec le même identifiant de machine");
  ok(upProc.exitCode === null && upProc.pid === pid1, "même processus (exec) : le service garde son PID");
  ok(/excalibash-agent 2\.0\.0/.test(upLog), "l'agent journalise son redémarrage en 2.0.0");
  await pause(1500);
  ok(!existsSync(join(home, ".excalibash-agent.old")) && !existsSync(join(home, ".excalibash-agent.new")), "après connexion réussie, l'ancien binaire est supprimé");
  ok((v2 as any)?.agentNote == null, "pas de note « mise à jour annulée »");
  await cool();
  const again = await trigger(alice, v2!.auth, 15_000);
  ok(again.frames.at(-1)?.phase === "error" && /déjà à jour/.test(again.frames.at(-1).msg), "même version : réinstallation refusée par l'agent");

  upProc.kill();
  await as(alice, () => api("DELETE", `/machines/${machineId}`));
  rmSync(home, { recursive: true, force: true });
} else {
  console.log("⚠ mise à jour des agents : ignorée (UPDATE_V1_BIN / UPDATE_SIGN / UPDATE_KEY / UPDATE_DIST absents, voir tests/run.sh)");
}

// Active sessions: list, revoke one (cuts its websocket), isolation between users, coarse metadata only.
{
  const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0 RAWUA-MARKER";
  const pre = await realFetch(BASE + "/api/auth/prelogin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "alice@test.local" }) });
  const { salt } = (await pre.json()) as any;
  const { authKey } = await c.deriveAccountKeys("alice-password-1", salt);
  const lr = await realFetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ email: "alice@test.local", authKey }) });
  const second = lr.headers.get("set-cookie")!.split(";")[0];
  ok(lr.status === 200 && !!second, "sessions : seconde connexion d'Alice (autre jeu de cookies)");
  const asJar = async (cookie: string, method: string, path: string) => {
    const r = await realFetch(BASE + "/api" + path, { method, headers: { cookie } });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  const list = await asJar(alice.cookie, "GET", "/account/sessions");
  ok(list.status === 200 && list.body.length === 2 && list.body.filter((x: any) => x.current).length === 1, "sessions : deux sessions listées, une seule « cet appareil »");
  const other = list.body.find((x: any) => !x.current);
  ok(other.label === "Firefox · Linux" && other.ipPrefix === "127.0.0.x" && other.lastUsedAt > 0, "sessions : libellé et préfixe IP grossiers, dernière utilisation renseignée");
  const raw = new DatabaseSync(DB, { readOnly: true });
  ok(!JSON.stringify(raw.prepare("SELECT * FROM sessions").all()).includes("RAWUA-MARKER"), "sessions : le User-Agent brut n'est pas stocké");
  ok(!list.body.some((x: any) => /^[0-9a-f]{64}$/.test(x.id)), "sessions : l'id public n'est pas le hachage du jeton");
  const bobSessions = await asJar(bob.cookie, "GET", "/account/sessions");
  ok(bobSessions.body.length >= 1 && !bobSessions.body.some((x: any) => x.id === other.id), "sessions : Bob ne voit pas les sessions d'Alice");
  ok((await asJar(bob.cookie, "DELETE", `/account/sessions/${other.id}`)).status === 404, "sessions : révoquer la session d'un autre renvoie 404");
  ok((await asJar(second, "GET", "/auth/me")).status === 200, "sessions : la seconde session fonctionne avant révocation");
  const sx = boardSocket({ ...alice, cookie: second }, B);
  await sx.open;
  await sx.next((m) => m.t === "init");
  const closed = new Promise<number>((resolve) => sx.ws.on("close", (code: number) => resolve(code)));
  const del = await asJar(alice.cookie, "DELETE", `/account/sessions/${other.id}`);
  ok(del.status === 200, "sessions : Alice révoque sa seconde session");
  ok((await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(-1), 4000))])) === 4001, "sessions : la websocket de la session révoquée est coupée (4001)");
  ok((await asJar(second, "GET", "/auth/me")).status === 401, "sessions : le cookie révoqué reçoit 401");
  ok((await asJar(alice.cookie, "GET", "/auth/me")).status === 200, "sessions : la session courante reste valable");
  const l3 = await realFetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "alice@test.local", authKey }) });
  const third = l3.headers.get("set-cookie")!.split(";")[0];
  const ro = await asJar(alice.cookie, "POST", "/account/sessions/revoke-others");
  ok(ro.status === 200 && ro.body.revoked === 1 && (await asJar(third, "GET", "/auth/me")).status === 401, "sessions : « déconnecter les autres » révoque tout sauf la session courante");
  ok((await asJar(alice.cookie, "GET", "/account/sessions")).body.length === 1, "sessions : il ne reste que la session courante");
  raw.close();
}

// MCP client: local login, stdio JSON-RPC, decrypted reads, opt-in typing, audit log, board scoping.
{
  const { mkdtempSync, statSync, readFileSync: rf, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const bundle = new URL("../mcp/dist/excalibash-mcp.mjs", import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), "eb-mcp-"));
  const cfgFile = join(dir, "mcp.json");
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number; err: string }>((resolve) => {
      const p = spawn(process.execPath, [bundle, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("exit", (code) => resolve({ code: code ?? -1, err }));
    });
  const loginRun = await run(["login", "--config", cfgFile], { EXCALIBASH_URL: BASE, EXCALIBASH_EMAIL: "alice@test.local", EXCALIBASH_PASSWORD: "alice-password-1" });
  ok(loginRun.code === 0 && existsSync(cfgFile), "MCP : connexion non interactive, configuration enregistrée");
  ok((statSync(cfgFile).mode & 0o777) === 0o600 && (statSync(dir).mode & 0o777) === 0o700, "MCP : fichier de configuration en 0600 dans un dossier 0700");
  const badPw = await run(["login", "--config", join(dir, "x.json")], { EXCALIBASH_URL: BASE, EXCALIBASH_EMAIL: "alice@test.local", EXCALIBASH_PASSWORD: "mauvais" });
  ok(badPw.code !== 0, "MCP : mauvais mot de passe refusé");

  const startMcp = (args: string[], cfg = cfgFile) => {
    const p = spawn(process.execPath, [bundle, "serve", "--config", cfg, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    const waiting = new Map<number, (m: any) => void>();
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = JSON.parse(line); // stdout must carry protocol only
        waiting.get(m.id)?.(m);
      }
    });
    p.stderr.on("data", (d) => (stderr += d));
    let n = 0;
    const rpc = (method: string, params?: object, ms = 20000) =>
      new Promise<any>((resolve, reject) => {
        const id = ++n;
        const t = setTimeout(() => reject(new Error(`MCP timeout ${method}`)), ms);
        waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
        p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    const call = async (name: string, args: object = {}) => {
      const r = await rpc("tools/call", { name, arguments: args });
      return { text: r.result?.content?.[0]?.text ?? "", isError: !!r.result?.isError, error: r.error };
    };
    return { p, rpc, call, stderr: () => stderr, stop: () => p.kill() };
  };

  const m1 = startMcp([]);
  const init = await m1.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  ok(init.result?.protocolVersion === "2025-03-26" && init.result?.serverInfo?.name === "excalibash", "MCP : initialize renvoie la version du client");
  const tl = await m1.rpc("tools/list");
  const names: string[] = tl.result.tools.map((t: any) => t.name);
  ok(names.includes("lire_terminal") && !names.includes("ecrire_terminal") && !names.includes("ajouter_note"), "MCP : sans option, ni saisie ni édition");
  ok((await m1.rpc("nope")).error?.code === -32601, "MCP : méthode inconnue = -32601");
  ok((await m1.call("lire_tableau", { tableau: B, bidon: 1 })).isError, "MCP : argument inconnu = erreur d'outil, sans plantage");
  const lb = await m1.call("lister_tableaux");
  ok(lb.text.includes("Tableau confidentiel") && lb.text.includes(B), "MCP : lister_tableaux déchiffre les noms localement");
  const board = await m1.call("lire_tableau", { tableau: "Tableau confidentiel" });
  ok(!board.isError && board.text.includes("Tableau confidentiel"), "MCP : lire_tableau accepte le nom exact");
  ok(lb.text.startsWith("[Contenu écrit par des tiers") && board.text.startsWith("[Contenu écrit par des tiers"), "MCP : noms et textes de tableau marqués comme non fiables");
  const lt = await m1.call("lister_terminaux", { tableau: B });
  ok(lt.text.includes(tid2) && lt.text.includes("shell"), "MCP : lister_terminaux");
  const rd = await m1.call("lire_terminal", { tableau: B, terminal: tid2, lignes: 50 });
  ok(!rd.isError && rd.text.includes("non fiable") && !rd.text.includes("\x1b"), "MCP : lire_terminal renvoie du texte sans séquences d'échappement, avec avertissement");
  ok((await m1.call("lister_machines")).text.includes("laptop-alice"), "MCP : lister_machines");
  m1.stop();

  const m2 = startMcp(["--autoriser-saisie"]);
  await m2.rpc("initialize", { protocolVersion: "2025-06-18" });
  ok((await m2.rpc("tools/list")).result.tools.some((t: any) => t.name === "ecrire_terminal"), "MCP : --autoriser-saisie enregistre ecrire_terminal");
  const w = await m2.call("ecrire_terminal", { tableau: B, terminal: tid2, texte: "echo MCPSECRET_$((7*6))", attendre_ms: 2500 });
  ok(!w.isError && w.text.includes("MCPSECRET_42"), "MCP : ecrire_terminal tape dans le terminal et renvoie la sortie");
  const auditFile = join(dir, "mcp-audit.log");
  const auditText = existsSync(auditFile) ? rf(auditFile, "utf8") : "";
  ok(auditText.includes(tid2) && !auditText.includes("MCPSECRET") && !m2.stderr().includes("MCPSECRET") && (statSync(auditFile).mode & 0o777) === 0o600, "MCP : journal d'audit en 0600, sans le texte tapé");
  m2.stop();

  const m3 = startMcp(["--tableaux", "inconnu-1,inconnu-2"]);
  await m3.rpc("initialize", { protocolVersion: "2025-06-18" });
  const restricted = await m3.call("lire_tableau", { tableau: B });
  ok(restricted.isError && !(await m3.call("lister_tableaux")).text.includes(B), "MCP : --tableaux refuse un autre tableau");
  m3.stop();

  const m4 = startMcp(["--autoriser-edition"]);
  await m4.rpc("initialize", { protocolVersion: "2025-06-18" });
  const note = await m4.call("ajouter_note", { tableau: B, texte: "NOTE_MCP_TEST" });
  m4.stop();
  const sn = boardSocket(alice, B);
  await sn.open;
  const initN = await sn.next((m) => m.t === "init");
  const keyNow = (await tree(alice)).get(B)!.key!;
  const decoded = await Promise.all(initN.elements.map((e: any) => decryptEntry(keyNow, B, e)));
  ok(!note.isError && decoded.some((e: any) => e.type === "text" && e.text === "NOTE_MCP_TEST" && e.customData?.source === "mcp"), "MCP : ajouter_note dépose un texte chiffré sur le tableau");
  ok(!JSON.stringify(initN.elements).includes("NOTE_MCP_TEST"), "MCP : la note n'est jamais en clair côté serveur");
  sn.ws.close();

  const { chmodSync } = await import("node:fs");
  chmodSync(cfgFile, 0o644);
  ok((await run(["serve", "--config", cfgFile])).code !== 0, "MCP : refuse de démarrer si la configuration est lisible par d'autres");
  chmodSync(cfgFile, 0o600);
  const out = await run(["logout", "--config", cfgFile]);
  ok(out.code === 0 && !existsSync(cfgFile), "MCP : logout supprime la configuration");
}

// Public read-only links: created with real crypto, read without any account, gone after a key rotation.
{
  const pl = await import("../web/src/publicLinks.ts");
  const { createHash } = await import("node:crypto");
  (globalThis as any).location = { origin: BASE };
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const parts = (url: string) => ({ token: new URL(url).pathname.split("/")[2], key: new URL(url).hash.slice(1) });
  const pubGet = (token: string, headers: Record<string, string> = {}) => realFetch(`${BASE}/api/public/${token}`, { headers });
  const db2 = new DatabaseSync(DB);

  let nL = await tree(alice);
  const F2 = await lib.createItem(ctxOf(alice, nL), "folder", null, "Dossier jury");
  nL = await tree(alice);
  const sceneRect = { ...rect, id: "pubrect", label: "PUBLIC_VISIBLE_42" };
  const win = { ...rect, id: "pubwin", type: "embeddable", customData: { terminalId: "TERM_SECRET_ID" } };
  const nodeEl = { ...rect, id: "pubnode", customData: { node: true, title: "Routeur", shells: [{ terminalId: "TERM_SECRET_ID" }], machineId: "MACHINE_SECRET", machineName: "laptop-secret", remote: { machineId: "x", target: { kind: "ssh", host: "10.9.9.9", port: 22 } } } };
  const P = await lib.createItem(ctxOf(alice, nL), "board", F2, "Plan public", { elements: [sceneRect], files: {} });
  nL = await tree(alice);
  const keyP = nL.get(P)!.key!;
  // Windows and node data cannot be written through createItem (it drops terminals): put them in the way a client would.
  db2.prepare("UPDATE boards SET elements = ? WHERE id = ?").run(
    JSON.stringify(await Promise.all([sceneRect, win, nodeEl].map((e) => encryptEntry(keyP, P, e)))),
    P,
  );
  await as(alice, () => lib.shareItem(ctxOf(alice, nL), F2, { id: bob.user.id, email: "bob@test.local", publicKey: bob.user.publicKey }, "editor"));
  await as(alice, () => lib.shareItem(ctxOf(alice, nL), F2, { id: carol.user.id, email: "carol@test.local", publicKey: carol.user.publicKey }, "viewer"));
  const board = (n: Map<string, lib.Node>) => ({ id: P, key: n.get(P)!.key!, epoch: n.get(P)!.epoch, name: n.get(P)!.name });

  const url1 = await as(alice, () => pl.createPublicLink(board(nL), "Pour le jury", 7));
  const { token, key: frag } = parts(url1);
  ok(/^\/v\/[A-Za-z0-9_-]{22}$/.test(new URL(url1).pathname) && frag.length === 43, "lien public : URL /v/<jeton 128 bits>#<clé 256 bits>");

  const r1 = await pubGet(token);
  const body1 = (await r1.json()) as any;
  ok(r1.status === 200 && /no-store/.test(r1.headers.get("cache-control") ?? ""), "lien public : lu sans compte, Cache-Control no-store");
  const linkKey = pl.linkKeyFromFragment(frag)!;
  const scene = await pl.decryptPublic(body1, linkKey);
  ok(scene.title === "Plan public", "lien public : titre déchiffré avec la clé du lien");
  ok(scene.elements.some((e: any) => e.id === "pubrect" && e.label === "PUBLIC_VISIBLE_42"), "lien public : élément déchiffré avec la clé du fragment");
  ok(!scene.elements.some((e: any) => e.id === "pubwin"), "lien public : les fenêtres de terminal sont écartées");
  const nodeOut = scene.elements.find((e: any) => e.id === "pubnode");
  ok(!!nodeOut && !/TERM_SECRET_ID|MACHINE_SECRET|laptop-secret|10\.9\.9\.9/.test(JSON.stringify(scene)), "lien public : les tuiles perdent terminaux, machine et cible distante");
  const wrongKey = await pl.decryptPublic(body1, c.randomBytes(32)).then(() => true, () => false);
  ok(!wrongKey, "lien public : une autre clé ne déchiffre rien");
  ok(!JSON.stringify(body1).includes("Plan public") && !JSON.stringify(body1).includes("PUBLIC_VISIBLE_42"), "lien public : le serveur ne sert que des chiffrés");

  const etag = r1.headers.get("etag")!;
  ok((await pubGet(token, { "if-none-match": etag })).status === 304, "lien public : 304 tant que rien n'a changé");

  // Stored hashed, never raw; neither the token nor the key reach the database or the logs.
  const rows = JSON.stringify(db2.prepare("SELECT * FROM board_links").all());
  const logText = readFileSync(`${dirname(DB)}/server.log`, "utf8");
  ok(rows.includes(sha(token)) && !rows.includes(token) && !rows.includes(frag), "lien public : base = hachage du jeton, ni jeton ni clé du lien");
  ok(!logText.includes(token) && !logText.includes(frag), "lien public : ni jeton ni clé du lien dans les logs du serveur");
  ok(!rows.includes("Pour le jury") && !rows.includes("Plan public"), "lien public : libellé et titre chiffrés dans la base");

  // Who can manage links.
  const carolTry = await as(carol, () => api("POST", `/items/${P}/links`, { publicId: "0123456789abcdef", epoch: nL.get(P)!.epoch, wrappedKey: "AAAA" }));
  ok(carolTry.status === 403, "lien public : un lecteur ne peut pas créer de lien");
  ok((await as(carol, () => api("GET", `/items/${P}/links`))).status === 403, "lien public : un lecteur ne voit pas les liens");
  const nBL = await tree(bob);
  const urlBob = await as(bob, () => pl.createPublicLink(board(nBL), "Par Bob", null));
  const listed = await as(alice, () => pl.listPublicLinks(P, keyP));
  ok(listed.length === 2 && listed.some((l) => l.label === "Pour le jury" && l.createdBy === "Alice") && listed.some((l) => l.label === "Par Bob" && l.createdBy === "Bob" && l.expiresAt === null), "lien public : un éditeur crée, la liste montre libellés déchiffrés, auteurs et expirations");
  ok((await as(carol, () => api("DELETE", `/items/${P}/links/${listed[0].publicId}`))).status === 403, "lien public : un lecteur ne supprime pas de lien");
  ok((await as(bob, () => api("DELETE", `/items/${P}/links/${listed.find((l) => l.label === "Par Bob")!.publicId}`))).status === 200, "lien public : un éditeur supprime un lien");
  ok((await pubGet(parts(urlBob).token)).status === 404, "lien public : supprimé, il répond 404");

  // Expired, unknown and malformed tokens answer the same way.
  const urlExp = await as(alice, () => pl.createPublicLink(board(nL), "Court", 1));
  db2.prepare("UPDATE board_links SET expires_at = 1 WHERE token_hash = ?").run(sha(parts(urlExp).token));
  const exp = await pubGet(parts(urlExp).token);
  const unknown = await pubGet(c.toB64(c.randomBytes(16)));
  const malformed = await pubGet("nope");
  const [bExp, bUnk, bMal] = await Promise.all([exp.text(), unknown.text(), malformed.text()]);
  ok(exp.status === 404 && unknown.status === 404 && malformed.status === 404 && bExp === bUnk && bUnk === bMal, "lien public : expiré, inconnu et mal formé répondent identiquement (404)");

  // Trash hides the board from link holders; restoring brings it back.
  await as(alice, () => api("DELETE", `/items/${P}`));
  ok((await pubGet(token)).status === 404, "lien public : 404 quand le tableau est à la corbeille");
  await as(alice, () => api("POST", `/items/${P}/restore`));
  ok((await pubGet(token)).status === 200, "lien public : de nouveau lisible après restauration");

  // Limit per board.
  let last = 200;
  for (let i = 0; i < 25 && last === 200; i++) {
    const publicId = [...c.randomBytes(8)].map((x) => x.toString(16).padStart(2, "0")).join("");
    last = (await as(alice, () => api("POST", `/items/${P}/links`, { publicId, epoch: nL.get(P)!.epoch, wrappedKey: "AAAA" }))).status;
  }
  ok(last === 400 && (db2.prepare("SELECT COUNT(*) AS n FROM board_links WHERE board_id = ?").get(P) as any).n === 20, "lien public : 20 liens au plus par tableau");
  db2.prepare("DELETE FROM board_links WHERE board_id = ? AND public_id != ?").run(P, body1.publicId);

  // Rate limit, per IP (X-Forwarded-For is honoured behind a local proxy).
  let throttled = 0;
  for (let i = 0; i < 70; i++) if ((await pubGet(c.toB64(c.randomBytes(16)), { "x-forwarded-for": "7.7.7.7" })).status === 429) throttled++;
  ok(throttled > 0, "lien public : limitation de débit par IP");

  // Revoking someone rotates every key: the links made under the old keys are deleted with them.
  nL = await tree(alice);
  const epochBefore = nL.get(P)!.epoch;
  await as(alice, () => lib.revokeAccess(ctxOf(alice, nL), F2, carol.user.id));
  ok((await pubGet(token)).status === 404, "lien public : supprimé par la rotation des clés (membre retiré)");
  ok((db2.prepare("SELECT COUNT(*) AS n FROM board_links WHERE board_id = ?").get(P) as any).n === 0, "lien public : plus aucun lien en base après rotation");
  nL = await tree(alice);
  ok(nL.get(P)!.epoch === epochBefore + 1, "lien public : le tableau est passé à l'époque suivante");
  const urlNew = await as(alice, () => pl.createPublicLink(board(nL), "Après rotation", 1));
  const bodyNew = (await (await pubGet(parts(urlNew).token)).json()) as any;
  const sceneNew = await pl.decryptPublic(bodyNew, pl.linkKeyFromFragment(parts(urlNew).key)!);
  ok(bodyNew.epoch === epochBefore + 1 && sceneNew.elements.some((e: any) => e.id === "pubrect"), "lien public : un nouveau lien fonctionne avec les nouvelles clés");

  // Deleting the board deletes its links.
  await as(alice, () => api("DELETE", `/items/${P}`));
  await as(alice, () => api("DELETE", `/items/${P}?permanent=1`));
  ok((db2.prepare("SELECT COUNT(*) AS n FROM board_links").get() as any).n === 0 && (await pubGet(parts(urlNew).token)).status === 404, "lien public : supprimé avec le tableau");
  db2.close();
}

// Board history: ciphertext snapshots, deduplicated per element, retention, purge on rotation.
// (The server runs with HISTORY_INTERVAL_MIN=0: a version at every flush; HISTORY_KEEP=3.)
{
  nA = await tree(alice);
  const H = await as(alice, () => lib.createItem(ctxOf(alice, nA), "board", null, "Historique"));
  nA = await tree(alice);
  await as(alice, () => lib.shareItem(ctxOf(alice, nA), H, bobPub, "viewer"));
  let hKey = (await tree(alice)).get(H)!.key!;
  const box = (id: string, version: number, label: string) => ({ id, type: "rectangle", version, versionNonce: Math.floor(Math.random() * 1e9), x: 0, y: 0, width: 10, height: 10, isDeleted: false, label });
  const versions = async (u: U = alice) => (await as(u, () => api("GET", `/items/${H}/versions`))).body as { id: number; createdAt: number; count: number; epoch: number }[];
  const stored = () => (rw.prepare("SELECT COUNT(*) AS n FROM board_entries WHERE board_id = ?").get(H) as any).n as number;
  /** Connects, optionally writes the given entries, leaves (the end of the session captures a version). */
  async function session(u: U, key: c.SymKey, els: any[], raw?: any[]) {
    const s = boardSocket(u, H);
    await s.open;
    const init = await s.next((m) => m.t === "init");
    const entries = raw ?? (await Promise.all(els.map((e) => encryptEntry(key, H, e))));
    if (entries.length) s.send({ t: "scene", epoch: init.epoch, elements: entries });
    const err = entries.length ? await s.next((m) => m.t === "error", 400).catch(() => null) : null;
    s.ws.close();
    await s.closed;
    await new Promise((r) => setTimeout(r, 150));
    return { entries, err, init };
  }

  ok((await versions()).length === 0, "historique : aucun version pour un tableau vide");
  const a1 = box("ha", 1, "HISTSECRET_ONE");
  const b1 = box("hb", 1, "HISTSTABLE");
  await session(alice, hKey, [a1, b1]);
  const afterOne = await versions();
  ok(afterOne.length === 1 && afterOne[0].count === 2, "historique : une première version enregistrée en fin de session");
  const second = await session(alice, hKey, [box("ha", 2, "HISTSECRET_TWO")]);
  ok((await versions()).length === 2, "historique : une modification ajoute une version");
  ok(stored() === 3, "historique : l'élément inchangé n'est stocké qu'une fois (3 chiffrés pour 2 versions)");
  await session(alice, hKey, []);
  ok((await versions()).length === 2, "historique : un état identique n'ajoute pas de version");
  const replay = await session(alice, hKey, [], second.entries);
  ok(replay.err === null && (await versions()).length === 2 && stored() === 3, "historique : un envoi non plus récent n'ajoute rien");

  const list = await versions();
  ok(list[0].id > list[1].id && list[0].epoch === 0, "historique : liste du plus récent au plus ancien");
  const getV = async (id: number, u: U = alice) => (await as(u, () => api("GET", `/items/${H}/versions/${id}`))).body;
  const old = await getV(list[1].id);
  const oldEls = await Promise.all(old.elements.map((e: any) => decryptEntry(hKey, H, e)));
  ok(oldEls.length === 2 && oldEls.some((e: any) => e.label === "HISTSECRET_ONE") && !oldEls.some((e: any) => e.label === "HISTSECRET_TWO"), "historique : la version ancienne se déchiffre dans son état d'alors");
  const cur = await getV(list[0].id);
  const curEls = await Promise.all(cur.elements.map((e: any) => decryptEntry(hKey, H, e)));
  ok(curEls.some((e: any) => e.label === "HISTSECRET_TWO") && curEls.some((e: any) => e.label === "HISTSTABLE") && typeof cur.files === "object", "historique : la version récente contient l'état courant");
  ok((await as(alice, () => api("GET", `/items/${H}/versions/999999`))).status === 404, "historique : version inconnue : 404");
  const dump = JSON.stringify(rw.prepare("SELECT data FROM board_entries WHERE board_id = ?").all(H)) + JSON.stringify(rw.prepare("SELECT hashes FROM board_versions WHERE board_id = ?").all(H));
  ok(!dump.includes("HISTSECRET") && !dump.includes("HISTSTABLE"), "historique : aucun texte en clair dans la base");

  // A viewer can browse but not write; a stranger sees nothing.
  const asViewer = await versions(bob);
  ok(asViewer.length === 2 && (await getV(list[1].id, bob)).elements.length === 2, "historique : un lecteur peut consulter les versions");
  const viewerWrite = await session(bob, hKey, [box("ha", 9, "HACK")]);
  ok(viewerWrite.err?.message === "Lecture seule" && (await versions()).length === 2, "historique : un lecteur ne peut toujours pas écrire");
  ok((await as(bob, () => api("GET", `/items/${B}/versions`))).status === 404, "historique : pas d'accès aux versions d'un tableau non partagé");

  // Retention (HISTORY_KEEP=3): oldest versions and their now-unreferenced entries go.
  for (let v = 3; v <= 6; v++) await session(alice, hKey, [box("ha", v, `HISTSECRET_V${v}`)]);
  const kept = await versions();
  ok(kept.length === 3 && !kept.some((v) => v.id === list[1].id), "historique : rétention, seules les 3 dernières versions restent");
  const referenced = new Set((rw.prepare("SELECT hashes FROM board_versions WHERE board_id = ?").all(H) as any[]).flatMap((r) => JSON.parse(r.hashes)));
  ok(stored() === referenced.size && stored() === 4, "historique : les chiffrés orphelins sont supprimés");

  // Key rotation: history sealed under the old key is purged; a new one starts.
  await as(alice, () => lib.revokeAccess(ctxOf(alice, nA), H, bob.user.id));
  ok((await versions()).length === 0 && stored() === 0, "historique : la rotation des clés purge l'historique");
  hKey = (await tree(alice)).get(H)!.key!;
  await session(alice, hKey, [box("ha", 7, "HISTSECRET_NEW")]);
  const fresh = await versions();
  ok(fresh.length === 1 && fresh[0].epoch === 1 && (await getV(fresh[0].id)).elements.length > 0, "historique : une nouvelle version repart avec les nouvelles clés");
}

// Shared documents (Yjs): the server stores and relays ciphertext of CRDT updates, snapshots survive key rotation.
{
  const D = await as(alice, async () => lib.createItem(ctxOf(alice, await tree(alice)), "board", null, "Documents partagés"));
  await as(alice, async () => lib.shareItem(ctxOf(alice, await tree(alice)), D, bobPub, "editor"));
  await as(alice, async () => lib.shareItem(ctxOf(alice, await tree(alice)), D, { id: carol.user.id, email: "carol@test.local", publicKey: carol.user.publicKey }, "viewer"));
  const keyOf = async (u: U, id = D) => (await tree(u)).get(id)!.key!;
  const kA = await keyOf(alice);
  const kB = await keyOf(bob);
  const kC = await keyOf(carol);
  const docId = sd.newDocId();
  const until = async (cond: () => boolean, ms = 6000) => {
    for (const t = Date.now(); Date.now() - t < ms; ) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return cond();
  };
  const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const docsRows = (b: string) => rw.prepare("SELECT * FROM board_docs WHERE board_id = ? ORDER BY doc_id").all(b) as any[];
  const upRows = (b: string, d: string) => (rw.prepare("SELECT COUNT(*) AS n FROM board_doc_updates WHERE board_id = ? AND doc_id = ?").get(b, d) as any).n as number;

  /** A DocHost over a real board socket (what BoardSession is in the browser). */
  function docHost(u: U, boardId: string, key: c.SymKey, role: "editor" | "viewer") {
    const handlers = new Map<string, any>();
    const peerListeners = new Set<() => void>();
    let sock: ReturnType<typeof boardSocket>;
    let you: any = null;
    let epoch = 0;
    let connected = false;
    let inbox: Promise<void> = Promise.resolve();
    const attach = () => {
      sock = boardSocket(u, boardId);
      sock.ws.on("message", (raw: any) => {
        inbox = inbox.then(async () => {
          const m = JSON.parse(raw.toString());
          if (m.t === "init") {
            you = m.you;
            epoch = m.epoch;
            connected = true;
            for (const h of handlers.values()) h.onOpen();
          } else if (m.t === "peer.join" || m.t === "peer.leave") for (const f of peerListeners) f();
          else if (typeof m.t === "string" && m.t.startsWith("doc.")) await handlers.get(m.doc)?.onMessage(m);
        });
      });
    };
    attach();
    const host = {
      boardId,
      key,
      get canEdit() {
        return role !== "viewer";
      },
      get currentEpoch() {
        return epoch;
      },
      get you() {
        return you;
      },
      docSend(m: object) {
        if (sock.ws.readyState !== 1) return false;
        sock.ws.send(JSON.stringify(m));
        return true;
      },
      docRegister(doc: string, h: any) {
        handlers.set(doc, h);
        if (connected) h.onOpen();
        return () => handlers.delete(doc);
      },
      on(_e: "peers", fn: () => void) {
        peerListeners.add(fn);
        return () => peerListeners.delete(fn);
      },
    };
    return {
      host,
      get closed() {
        return sock.closed;
      },
      /** Loses the connection (the tab goes offline). */
      drop() {
        connected = false;
        sock.ws.close();
        for (const h of handlers.values()) h.onClose();
      },
      reconnect() {
        attach();
      },
      close() {
        sock.ws.close();
      },
    };
  }

  /** Reads a document the way a fresh subscriber does: doc.state, decrypted and merged. */
  async function readDoc(u: U, boardId: string, key: c.SymKey, doc: string, aadEpoch?: number) {
    const s = boardSocket(u, boardId);
    await s.open;
    const init = await s.next((m) => m.t === "init");
    s.send({ t: "doc.sub", doc });
    const st = await s.next((m) => m.t === "doc.state");
    const y = new Y.Doc();
    for (const part of [...(st.snap ? [st.snap] : []), ...st.ups]) Y.applyUpdate(y, await c.unbox(key, part.d, c.AAD.doc(boardId, doc, aadEpoch ?? init.epoch)));
    s.ws.close();
    return { text: y.getText("t").toString(), state: st };
  }
  const upFrame = async (boardId: string, key: c.SymKey, doc: string, epoch: number, update: Uint8Array) => ({
    t: "doc.up",
    doc,
    epoch,
    d: await c.box(key, update, c.AAD.doc(boardId, doc, epoch)),
  });

  // Two editors and a viewer, through the real shared-document client.
  const hA = docHost(alice, D, kA, "editor");
  const hB = docHost(bob, D, kB, "editor");
  const hC = docHost(carol, D, kC, "viewer");
  const dA = sd.openSharedDoc(hA.host, docId);
  const dB = sd.openSharedDoc(hB.host, docId);
  const dC = sd.openSharedDoc(hC.host, docId);
  await Promise.all([dA.synced, dB.synced, dC.synced]);
  ok(!dA.readOnly && !dB.readOnly && dC.readOnly, "documents : un lecteur est en lecture seule côté client");
  ok(sd.openSharedDoc(hA.host, docId).ydoc === dA.ydoc, "documents : deux fenêtres du même document partagent un seul Y.Doc");
  const tA = dA.ydoc.getText("t");
  const tB = dB.ydoc.getText("t");
  const tC = dC.ydoc.getText("t");
  tA.insert(0, "ALPHA_SECRET_CODE ");
  tB.insert(0, "BRAVO_SECRET_CODE ");
  const converged = await until(() => tA.toString() === tB.toString() && tA.length === 36 && tC.toString() === tA.toString());
  ok(converged && tA.toString().includes("ALPHA_SECRET_CODE") && tA.toString().includes("BRAVO_SECRET_CODE"), "documents : deux éditeurs écrivent en même temps, tous convergent vers le même texte (lecteur compris)");
  const final = tA.toString();

  // Viewer: local edits are never sent, and the server refuses a forged doc.up.
  const before = docsRows(D)[0];
  tC.insert(0, "HACK_VIEWER ");
  const raw = boardSocket(carol, D);
  await raw.open;
  const rawInit = await raw.next((m) => m.t === "init");
  raw.send({ t: "doc.sub", doc: docId });
  await raw.next((m) => m.t === "doc.state");
  const hack = new Y.Doc();
  hack.getText("t").insert(0, "HACK_RAW ");
  raw.send(await upFrame(D, kC, docId, rawInit.epoch, Y.encodeStateAsUpdate(hack)));
  const refused = await raw.next((m) => m.t === "doc.err");
  raw.send({ t: "doc.snap", doc: docId, epoch: rawInit.epoch, d: await c.box(kC, Y.encodeStateAsUpdate(hack), c.AAD.doc(D, docId, rawInit.epoch)), upto: 1 });
  const refusedSnap = await raw.next((m) => m.t === "doc.err");
  await nap(300);
  const after = docsRows(D)[0];
  ok(refused.error === "Lecture seule" && refusedSnap.error === "Lecture seule" && after.last_seq === before.last_seq && after.bytes === before.bytes && tA.toString() === final, "documents : le serveur refuse doc.up et doc.snap d'un lecteur sans toucher au document");
  raw.ws.close();

  // A fresh subscriber gets the whole state.
  const fresh = await readDoc(bob, D, kB, docId);
  ok(fresh.text === final, "documents : un nouvel abonné reçoit l'état complet par doc.state");
  const wrong = await readDoc(bob, D, kB, docId, 7).then(() => true, () => false);
  ok(!wrong, "documents : l'AAD lie la mise à jour à son epoch");

  // The database only holds ciphertext.
  const dump = JSON.stringify(rw.prepare("SELECT * FROM board_docs").all()) + JSON.stringify(rw.prepare("SELECT * FROM board_doc_updates").all());
  ok(docsRows(D).length === 1 && !dump.includes("SECRET_CODE") && !dump.includes("ALPHA") && !dump.includes("BRAVO"), "documents : aucun texte en clair dans la base");

  // Awareness: relayed to the others, never stored.
  dA.awareness.setLocalStateField("cursor", { anchor: 3, note: "AW_SECRET_MARK" });
  const sawAw = await until(() => (dB.awareness.getStates().get(dA.awareness.clientID) as any)?.cursor?.note === "AW_SECRET_MARK" && (dC.awareness.getStates().get(dA.awareness.clientID) as any)?.cursor?.note === "AW_SECRET_MARK");
  ok(sawAw && (dB.awareness.getStates().get(dA.awareness.clientID) as any)?.user?.name === "Alice", "documents : la présence (curseur, nom) est relayée à l'autre éditeur et au lecteur");
  dC.awareness.setLocalStateField("cursor", { anchor: 1 });
  ok(await until(() => (dA.awareness.getStates().get(dC.awareness.clientID) as any)?.cursor?.anchor === 1), "documents : un lecteur peut aussi publier sa présence");
  await nap(200);
  const rawFiles = [DB, `${DB}-wal`].filter(existsSync).map((f) => readFileSync(f).toString("latin1")).join("");
  ok(!rawFiles.includes("AW_SECRET_MARK") && !rawFiles.includes("SECRET_CODE"), "documents : la présence n'est jamais stockée (fichiers de la base)");

  // Awareness is rate limited per socket.
  {
    const x = boardSocket(alice, D);
    const y = boardSocket(bob, D);
    await Promise.all([x.open, y.open]);
    await x.next((m) => m.t === "init");
    await y.next((m) => m.t === "init");
    const aw = new Awareness(new Y.Doc());
    aw.setLocalState({ junk: 1 });
    const d = await c.box(kA, encodeAwarenessUpdate(aw, [aw.clientID]), c.AAD.docAwareness(D, docId, 0));
    x.send({ t: "doc.sub", doc: docId });
    y.send({ t: "doc.sub", doc: docId });
    await x.next((m) => m.t === "doc.state");
    await y.next((m) => m.t === "doc.state");
    for (let i = 0; i < 60; i++) x.send({ t: "doc.aw", doc: docId, d });
    await nap(500);
    let relayed = 0;
    while (await y.next((m) => m.t === "doc.aw", 50).then(() => true, () => false)) relayed++;
    ok(relayed >= 1 && relayed <= 16, `documents : la présence est limitée en débit par socket (${relayed} relayées sur 60)`);
    x.ws.close();
    y.ws.close();
  }

  // Offline edits merge on reconnection (the diff against the server state is pushed).
  hB.drop();
  tB.insert(0, "OFFLINE_EDIT ");
  tA.insert(tA.length, " ONLINE_EDIT");
  hB.reconnect();
  const merged = await until(() => tA.toString() === tB.toString() && tA.toString().includes("OFFLINE_EDIT") && tA.toString().includes("ONLINE_EDIT"), 8000);
  ok(merged && tC.toString().includes("OFFLINE_EDIT"), "documents : après une reconnexion, les modifications faites hors ligne sont fusionnées");
  const errors: string[] = [];
  dA.onError((m) => errors.push(m));

  // Compaction: > 200 updates make the server ask for a snapshot; updates are then folded into it.
  const cdoc = sd.newDocId();
  {
    const s = boardSocket(alice, D);
    await s.open;
    const init = await s.next((m) => m.t === "init");
    s.send({ t: "doc.sub", doc: cdoc });
    await s.next((m) => m.t === "doc.state");
    const local = new Y.Doc();
    const frames: any[] = [];
    local.on("update", async (u: Uint8Array) => frames.push(u));
    const t = local.getText("t");
    for (let i = 0; i < 230; i++) t.insert(t.length, `l${i}:COMPACT_SECRET `);
    for (const u of frames) s.send(await upFrame(D, kA, cdoc, init.epoch, u));
    let last = 0;
    while (last < 230) last = (await s.next((m) => m.t === "doc.ack", 8000)).seq;
    const ask = await s.next((m) => m.t === "doc.compact", 3000).then((m) => m, () => null);
    ok(ask?.doc === cdoc && upRows(D, cdoc) === 230, "documents : au-delà de 200 mises à jour, le serveur demande une compaction (doc.compact)");
    s.send({ t: "doc.snap", doc: cdoc, epoch: init.epoch, upto: 230, d: await c.box(kA, Y.encodeStateAsUpdate(local), c.AAD.doc(D, cdoc, init.epoch)) });
    await s.next((m) => m.t === "doc.snapped");
    const row = docsRows(D).find((r) => r.doc_id === cdoc);
    ok(upRows(D, cdoc) === 0 && row.snap_seq === 230 && row.last_seq === 230, "documents : après doc.snap, les lignes de mises à jour ont disparu (instantané seul)");
    s.send(await upFrame(D, kA, cdoc, init.epoch, (() => { const u = new Y.Doc(); Y.applyUpdate(u, Y.encodeStateAsUpdate(local)); let out!: Uint8Array; u.on("update", (x: Uint8Array) => (out = x)); u.getText("t").insert(0, "AFTER "); return out; })()));
    const ack = await s.next((m) => m.t === "doc.ack");
    ok(ack.seq === 231, "documents : la numérotation continue après la compaction");
    s.send({ t: "doc.snap", doc: cdoc, epoch: init.epoch, upto: 5, d: await c.box(kA, Y.encodeStateAsUpdate(local), c.AAD.doc(D, cdoc, init.epoch)) });
    ok((await s.next((m) => m.t === "doc.err")).error === "instantané périmé", "documents : un instantané qui ne couvre rien de nouveau est refusé");
    const reread = await readDoc(bob, D, kB, cdoc);
    ok(reread.text.startsWith("AFTER l0:COMPACT_SECRET") && reread.text.includes("l229:COMPACT_SECRET") && reread.state.snap && reread.state.ups.length === 1, "documents : un nouvel abonné relit le même texte après compaction");
    s.ws.close();
  }

  // Identifiers and sizes.
  {
    const s = boardSocket(alice, D);
    await s.open;
    const init = await s.next((m) => m.t === "init");
    s.send({ t: "doc.sub", doc: "../../etc" });
    ok((await s.next((m) => m.t === "doc.err")).error === "identifiant de document invalide", "documents : identifiant invalide refusé");
    const big = sd.newDocId();
    s.send({ t: "doc.sub", doc: big });
    await s.next((m) => m.t === "doc.state");
    s.send({ t: "doc.up", doc: big, epoch: init.epoch, d: "A".repeat(512 * 1024 + 1) });
    ok((await s.next((m) => m.t === "doc.err")).error === "mise à jour invalide", "documents : une trame de plus de 512 Kio est refusée");
    s.send({ t: "doc.up", doc: big, epoch: init.epoch + 5, d: "AAAA" });
    ok((await s.next((m) => m.t === "rekey")).t === "rekey", "documents : une mise à jour avec un mauvais epoch demande de recharger");
    s.ws.close();
  }

  // Rotation: revoke the viewer. The documents are re-encrypted (not purged) under the new key and epoch.
  const rowsBefore = docsRows(D);
  ok(rowsBefore.length === 2 && rowsBefore.every((r) => r.epoch === 0), "documents : deux documents sur le tableau, epoch 0 avant la rotation");
  const textMain = tA.toString();
  const closedA = hA.closed;
  await as(alice, async () => lib.revokeAccess(ctxOf(alice, await tree(alice)), D, carol.user.id));
  ok((await Promise.race([closedA, nap(4000).then(() => 0)])) === 4409, "documents : la rotation coupe les abonnés (4409)");
  const rowsAfter = docsRows(D);
  ok(rowsAfter.length === 2 && rowsAfter.every((r) => r.epoch === 1 && r.snap && upRows(D, r.doc_id) === 0 && r.snap_seq === r.last_seq), "documents : après la rotation, chaque document est un instantané d'epoch 1");
  const kA2 = await keyOf(alice);
  const afterRot = await readDoc(alice, D, kA2, docId);
  ok(afterRot.text === textMain, "documents : le document reste lisible avec la nouvelle clé après rotation");
  const afterBob = await readDoc(bob, D, await keyOf(bob), cdoc);
  ok(afterBob.text.startsWith("AFTER l0:COMPACT_SECRET") && afterBob.text.includes("l229:"), "documents : l'éditeur restant relit aussi l'autre document");
  const oldKey = await readDoc(alice, D, kA, docId).then(() => true, () => false);
  ok(!oldKey, "documents : l'ancienne clé ne déchiffre plus rien");
  ok((await as(carol, () => api("GET", `/items/${D}/docs`))).status === 404, "documents : le membre révoqué n'accède plus aux documents");
  const listed = (await as(alice, () => api("GET", `/items/${D}/docs`))).body;
  ok(listed.length === 2 && listed.every((d: any) => d.epoch === 1 && d.ups.length === 0), "documents : GET /items/:id/docs liste les documents chiffrés");
  hB.close();
  hC.close();
  dA.destroy();

  // Document count cap per board.
  {
    const E = await as(alice, async () => lib.createItem(ctxOf(alice, await tree(alice)), "board", null, "Beaucoup de documents"));
    const kE = await keyOf(alice, E);
    const s = boardSocket(alice, E);
    await s.open;
    const init = await s.next((m) => m.t === "init");
    const one = new Y.Doc();
    one.getText("t").insert(0, "x");
    const u = Y.encodeStateAsUpdate(one);
    let accepted = 0;
    let lastErr = "";
    for (let i = 0; i < 65; i++) {
      const id = sd.newDocId();
      s.send({ t: "doc.sub", doc: id });
      await s.next((m) => m.t === "doc.state");
      s.send(await upFrame(E, kE, id, init.epoch, u));
      const r = await s.next((m) => m.t === "doc.ack" || m.t === "doc.err");
      if (r.t === "doc.ack") accepted++;
      else lastErr = r.error;
      s.send({ t: "doc.unsub", doc: id });
    }
    ok(accepted === 64 && lastErr === "trop de documents" && docsRows(E).length === 64, "documents : 64 documents au plus par tableau");
    s.ws.close();

    // Stored size cap (8 MiB of ciphertext per document).
    const F = await as(alice, async () => lib.createItem(ctxOf(alice, await tree(alice)), "board", null, "Gros document"));
    const kF = await keyOf(alice, F);
    const doc = sd.newDocId();
    const s2 = boardSocket(alice, F);
    await s2.open;
    await s2.next((m) => m.t === "init");
    s2.send({ t: "doc.sub", doc });
    await s2.next((m) => m.t === "doc.state");
    let reply: any = null;
    let n = 0;
    for (; n < 30 && (!reply || reply.t === "doc.ack"); n++) {
      const part = new Y.Doc();
      part.getText("t").insert(0, Array.from({ length: 5 }, () => c.toB64(c.randomBytes(45_000))).join("").slice(0, 300_000));
      s2.send(await upFrame(F, kF, doc, init.epoch, Y.encodeStateAsUpdate(part)));
      reply = await s2.next((m) => m.t === "doc.ack" || m.t === "doc.err", 10000);
    }
    ok(reply?.t === "doc.err" && reply.error === "document trop gros" && n > 10, "documents : un document ne dépasse pas 8 Mio");
    s2.ws.close();
  }
  // Code window, without a browser: what CodeEmbed does with the document (Y.Text "content" + Y.Map "meta"),
  // the real FileClient over the real agent's local shell (board B, terminal tid2), and the server blind throughout.
  {
    const cdocId = sd.newDocId();
    const hA3 = docHost(alice, D, kA, "editor");
    const hB3 = docHost(bob, D, kB, "editor");
    const ca = sd.openSharedDoc(hA3.host, cdocId);
    const cb = sd.openSharedDoc(hB3.host, cdocId);
    await Promise.all([ca.synced, cb.synced]);
    // The file channel of the shell: frames sealed with the terminal key, like BoardSession.fileRequest.
    // (Alice's first socket on board B was cut by the session tests above: a fresh one.)
    const sf = boardSocket(alice, B);
    await sf.open;
    await sf.next((m) => m.t === "init");
    const waiting = new Map<string, { on: (n: number, body: any, end: boolean) => void; fail: (m: string) => void; last: number }>();
    let chain: Promise<void> = Promise.resolve();
    sf.ws.on("message", (raw: any) => {
      chain = chain.then(async () => {
        const m = JSON.parse(raw.toString());
        const w = waiting.get(m.rid);
        if (!w || (m.t !== "file.res" && m.t !== "file.err")) return;
        if (m.t === "file.err") return void (waiting.delete(m.rid), w.fail(m.message));
        if (m.n <= w.last) return;
        const body = JSON.parse(c.fromUtf8(await c.unbox(kt2, m.d, c.AAD.fileRes(tid2, m.rid, m.n))));
        w.last = m.n;
        if (m.end) waiting.delete(m.rid);
        w.on(m.n, body, m.end === true);
      });
    });
    const fileHost = {
      async fileRequest(term: string, op: object, on?: any, fail?: any) {
        const rid = c.randomId();
        const ts = Date.now();
        if (on) waiting.set(rid, { on, fail: fail ?? (() => {}), last: -1 });
        sf.send({ t: "file.req", term, rid, ts, d: await c.box(kt2, c.utf8(JSON.stringify(op)), c.AAD.fileReq(term, rid, ts)), ...(on ? {} : { nr: true }) });
        return rid;
      },
      fileDrop: (rid: string) => void waiting.delete(rid),
    };
    const client = new FileClient(fileHost as any, tid2);
    const cwd = (await client.ls()).cwd;

    // Alice creates a blank document and types.
    ok(codeDoc.initBlank(ca.ydoc, "demo.py"), "code : un document neuf reçoit son nom");
    ca.ydoc.getText("content").insert(0, "print('salut')\n");
    const sameText = await until(() => cb.ydoc.getText("content").toString() === "print('salut')\n" && codeDoc.readMeta(cb.ydoc.getMap("meta")).name === "demo.py");
    ok(sameText && codeDoc.readMeta(cb.ydoc.getMap("meta")).language === "python", "code : Bob voit le même contenu et les mêmes métadonnées (langage Python)");
    ok(codeDoc.isDirty(await codeDoc.sha256Hex("print('salut')\n"), codeDoc.readMeta(cb.ydoc.getMap("meta")).savedSha), "code : jamais enregistré = modifié");

    // Save through the shell's file channel: a new file is written without asking.
    let asked: string[] = [];
    const confirm = (answer: boolean) => async (reason: string) => (asked.push(reason), answer);
    const saved = await mf.saveMachineFile(client, "demo.py", ca.ydoc.getText("content").toString(), { baseSha: undefined, confirm: confirm(true) });
    ok(!!saved && saved.path === join(cwd, "demo.py") && readFileSync(join(cwd, "demo.py"), "utf8") === "print('salut')\n" && asked.length === 0, "code : enregistrer écrit demo.py dans le dossier du shell (agent réel), sans question");
    codeDoc.markSaved(ca.ydoc, { path: saved!.path, sha: saved!.sha, by: "Alice" });
    const bobMeta = await until(() => codeDoc.readMeta(cb.ydoc.getMap("meta")).savedSha === saved!.sha);
    ok(bobMeta && !codeDoc.isDirty(await codeDoc.sha256Hex(cb.ydoc.getText("content").toString()), codeDoc.readMeta(cb.ydoc.getMap("meta")).savedSha), "code : après enregistrement, le document n'est plus modifié, pour Bob aussi");

    // Reading it back gives the same text and the same fingerprint.
    const back = await mf.openMachineFile(client, "demo.py");
    ok(back.text === "print('salut')\n" && back.sha === saved!.sha, "code : rouvrir le fichier de la machine redonne le même texte et la même empreinte");

    // Conflict: the file changed on the machine behind our back.
    writeFileSync(join(cwd, "demo.py"), "modifié ailleurs\n");
    cb.ydoc.getText("content").insert(0, "# par Bob\n");
    const bobMetaNow = codeDoc.readMeta(cb.ydoc.getMap("meta"));
    const refused = await mf.saveMachineFile(client, bobMetaNow.path!, cb.ydoc.getText("content").toString(), { baseSha: bobMetaNow.savedSha, confirm: confirm(false) });
    ok(refused === null && asked.join() === "changed" && readFileSync(join(cwd, "demo.py"), "utf8") === "modifié ailleurs\n", "code : fichier modifié sur la machine, écraser refusé : rien n'est écrit");
    asked = [];
    const forced = await mf.saveMachineFile(client, bobMetaNow.path!, cb.ydoc.getText("content").toString(), { baseSha: bobMetaNow.savedSha, confirm: confirm(true) });
    ok(!!forced && asked.join() === "changed" && readFileSync(join(cwd, "demo.py"), "utf8") === "# par Bob\nprint('salut')\n", "code : écraser confirmé écrit le contenu partagé");
    // "Save as" onto an existing file asks too; a folder is refused.
    asked = [];
    const exists = await mf.saveMachineFile(client, "demo.py", "x", { baseSha: undefined, confirm: confirm(false) });
    const dirErr = await mf.saveMachineFile(client, ".", "x", { confirm: confirm(true) }).then(() => "", (e: any) => String(e.message));
    ok(exists === null && asked.join() === "exists" && dirErr !== "", "code : « enregistrer sous » sur un fichier existant demande confirmation ; un dossier est refusé");

    // The server never saw the code.
    await until(() => upRows(D, cdocId) > 0);
    await nap(300);
    const codeDump = JSON.stringify(rw.prepare("SELECT * FROM board_docs").all()) + JSON.stringify(rw.prepare("SELECT * FROM board_doc_updates").all());
    const codeRaw = [DB, `${DB}-wal`].filter(existsSync).map((f) => readFileSync(f).toString("latin1")).join("");
    ok(upRows(D, cdocId) > 0 && !codeDump.includes("salut") && !codeRaw.includes("salut") && !codeDump.includes("demo.py") && !codeRaw.includes("par Bob"), "code : aucun texte ni nom de fichier en clair dans la base");

    // ---- Notebook: shared cells, ONE Jupyter kernel session on Alice's machine (real agent + real ipykernel) ----
    const nbId = sd.newDocId();
    const na = sd.openSharedDoc(hA3.host, nbId);
    const nbBob = sd.openSharedDoc(hB3.host, nbId);
    const bobErrors: string[] = [];
    nbBob.onError((m) => bobErrors.push(m));
    await Promise.all([na.synced, nbBob.synced]);
    nbDoc.initBlankNotebook(na.ydoc, "demo.ipynb");
    const first = nbDoc.cellViews(na.ydoc)[0].id;
    nbDoc.findCell(na.ydoc, first)!.source.insert(0, "x = 41");
    const second = nbDoc.insertCell(na.ydoc, { type: "code", source: "print(x + 1)", at: { after: first } });
    const bobSees = await until(() => nbDoc.cellViews(nbBob.ydoc).length === 2 && nbDoc.findCell(nbBob.ydoc, second)?.source.toString() === "print(x + 1)" && nbDoc.readMeta(nbBob.ydoc.getMap("meta")).name === "demo.ipynb");
    ok(bobSees, "notebook : Bob reçoit les cellules et le nom, chiffrés");

    // Alice starts the kernel session on her machine: a "jupyter" target sealed under the machine key (like RemoteForm).
    const sAl = boardSocket(alice, D);
    const sBo = boardSocket(bob, D);
    await Promise.all([sAl.open, sBo.open]);
    await sAl.next((m) => m.t === "init");
    const bobInit = await sBo.next((m) => m.t === "init");
    const kid = c.randomId();
    const kk = await c.newSymKey();
    sAl.send({
      t: "term.create", reqId: "nbk", id: kid, machineId: machine.id, cols: 80, rows: 24,
      keyForBoard: await c.wrapKey(kA, kk, c.AAD.termKey(D, kid)),
      keyForAgent: await c.boxJson(mAlice.auth, { k: c.toB64(kk.raw), target: { kind: "jupyter", host: "", port: 0 } }, c.AAD.termAgent(kid)),
      encLabel: await c.boxText(kA, "Noyau Jupyter python3 via laptop-alice", c.AAD.termLabel(D, kid)),
    });
    const madeK = await sAl.next((m) => (m.t === "term.created" && m.reqId === "nbk") || (m.t === "error" && m.reqId === "nbk"), 10000);
    ok(madeK.t === "term.created", `notebook : le noyau Jupyter démarre sur la machine (${madeK.message ?? "ok"})`);
    nbDoc.setKernelTerm(na.ydoc, kid);
    ok(await until(() => nbDoc.kernelTermOf(nbBob.ydoc) === kid), "notebook : l'identifiant de la session de noyau est partagé par le document");
    // Bob gets the terminal key from the board like for any shared terminal.
    const termForBob = await sBo.next((m) => m.t === "term" && m.terminal.id === kid, 8000).catch(() => null);
    const bobTermInfo = termForBob?.terminal ?? bobInit.terminals?.find((t: any) => t.id === kid);
    const kkBob = bobTermInfo ? await c.unwrapKey(kB, bobTermInfo.keyForBoard, c.AAD.termKey(D, kid)) : null;
    ok(!!kkBob && c.toB64(kkBob.raw) === c.toB64(kk.raw), "notebook : Bob récupère la clé de la session de noyau par la clé du tableau");

    /** What BoardSession offers a runner, over a raw socket: subscribe (replay then data, decrypted in order) and input. */
    const kGens = new Map<string, string>();
    function kernelPort(sock: ReturnType<typeof boardSocket>, key: c.SymKey, sender: string, taps: ((d: Uint8Array) => void)[] = []) {
      const listeners = new Set<{ onReplay(d: Uint8Array): void; onData(d: Uint8Array): void }>();
      let chain: Promise<void> = Promise.resolve();
      let last = { gen: "", seq: -1 };
      const take = (gen: string, seq: number) => {
        if (last.gen === gen && seq <= last.seq) return false;
        last = { gen, seq };
        kGens.set(sender, gen);
        return true;
      };
      sock.ws.on("message", (raw: any) => {
        chain = chain.then(async () => {
          const m = JSON.parse(raw.toString());
          if (m.id !== kid) return;
          if (m.t === "term.replay") {
            const parts: Uint8Array[] = [];
            for (const ch of m.chunks) if (take(ch.gen, ch.seq)) parts.push(await c.unbox(key, ch.d, c.AAD.termOut(kid, ch.gen, ch.seq)));
            const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let o = 0;
            for (const p of parts) (all.set(p, o), (o += p.length));
            for (const l of listeners) l.onReplay(all);
          } else if (m.t === "term.data" && take(m.gen, m.seq)) {
            const d = await c.unbox(key, m.d, c.AAD.termOut(kid, m.gen, m.seq));
            for (const t of taps) t(d);
            for (const l of listeners) l.onData(d);
          }
        });
      });
      let out: Promise<void> = Promise.resolve();
      return {
        subscribe(term: string, l: any) {
          listeners.add(l);
          sock.send({ t: "term.sub", id: term });
          return () => listeners.delete(l);
        },
        input(term: string, data: Uint8Array) {
          out = out.then(async () => {
            for (let i = 0; i < 400 && !kGens.has(sender); i++) await nap(25);
            const k = ++counter;
            const ts = Date.now();
            sock.send({ t: "term.input", id: term, s: sender, k, ts, d: await c.box(key, data, c.AAD.termIn(term, kGens.get(sender)!, sender, k, ts)) });
          });
        },
      };
    }
    // Bob also taps the raw stream: he must see the very same events as the executor.
    const bobSplit = new LineSplitter();
    const bobEvents: any[] = [];
    const portA = kernelPort(sAl, kk, "nb-alice");
    const portB = kernelPort(sBo, kkBob!, "nb-bob", [(d) => bobSplit.push(d).forEach((l) => { const e = parseEvent(l); if (e) bobEvents.push(e); })]);
    const runA = new NotebookRunner(na.ydoc, portA, { awareness: na.awareness, canEdit: true });
    const runB = new NotebookRunner(nbBob.ydoc, portB, { awareness: nbBob.awareness, canEdit: true });
    runA.attach(kid);
    runB.attach(kid);
    const waitIdle = async (cell: string) => until(() => !nbDoc.findCell(na.ydoc, cell)?.running, 40000);

    const r1 = runA.run(first);
    ok(r1.ok && nbDoc.findCell(nbBob.ydoc, first) !== undefined && (await until(() => nbDoc.findCell(nbBob.ydoc, first)!.running === (r1.ok ? r1.execId : ""), 4000)), "notebook : Bob voit la cellule « en cours » dès que Alice la lance");
    const done1 = await waitIdle(first);
    ok(done1 && nbDoc.findCell(na.ydoc, first)!.executionCount === 1, `notebook : « x = 41 » s'exécute sur le noyau (${runA.fatal ?? runA.status})`);
    const r2 = runA.run(second);
    ok(r2.ok, "notebook : « print(x + 1) » est envoyé par la saisie chiffrée du terminal");
    const done2 = await waitIdle(second);
    const out2 = nbDoc.findCell(na.ydoc, second)!;
    ok(done2 && out2.outputs.some((o) => o.output_type === "stream" && o.text === "42\n") && out2.executionCount === 2, "notebook : le noyau garde son état (x) : la sortie « 42 » est écrite par Alice");
    const bobGot = await until(() => nbDoc.findCell(nbBob.ydoc, second)?.outputs.some((o) => o.output_type === "stream" && o.text === "42\n") === true && !nbDoc.findCell(nbBob.ydoc, second)!.running, 8000);
    ok(bobGot && nbDoc.findCell(nbBob.ydoc, second)!.outputs.length === 1, "notebook : le document de Bob reçoit « 42 » (une seule fois : seul l'exécuteur écrit)");
    const bobSaw = bobEvents.some((e) => e.ev === "stream" && e.id === (r2.ok ? r2.execId : "") && e.text === "42\n") && bobEvents.some((e) => e.ev === "done" && e.id === (r2.ok ? r2.execId : ""));
    ok(bobSaw && runB.localRuns.length === 0, "notebook : Bob, abonné au même noyau, voit les mêmes événements (stream, done) sans rien écrire");
    // Bob can run too (any editor): the kernel is shared, so the variable is there.
    const third = nbDoc.insertCell(nbBob.ydoc, { type: "code", source: "print(x * 2)", at: "end" });
    await until(() => nbDoc.findCell(na.ydoc, third) !== undefined);
    const r3 = runB.run(third);
    ok(r3.ok && (await until(() => nbDoc.findCell(na.ydoc, third)?.outputs.some((o) => o.text === "82\n") === true && !nbDoc.findCell(na.ydoc, third)!.running, 40000)), "notebook : Bob exécute à son tour dans le même noyau, Alice voit « 82 »");
    // An error, rendered as data.
    const bad = nbDoc.insertCell(na.ydoc, { type: "code", source: "1/0", at: "end" });
    runA.run(bad);
    ok(await until(() => nbDoc.findCell(na.ydoc, bad)?.outputs.some((o) => o.output_type === "error" && o.ename === "ZeroDivisionError") === true && !nbDoc.findCell(na.ydoc, bad)!.running, 40000), "notebook : une exception arrive comme sortie d'erreur (ZeroDivisionError)");

    // Completion and docstrings go through the same encrypted terminal (complete / inspect ops of the bridge).
    {
      await until(() => runA.status === "idle", 20000);
      const src = "import math\nmath.sq";
      const comp = await runA.complete(src, src.length);
      ok(!!comp && comp.matches.includes("sqrt") && comp.start === src.length - 2 && comp.end === src.length, `notebook : « complete » sur « import math / math.sq » renvoie « sqrt », par le terminal chiffré (${JSON.stringify(comp)})`);
      const emojiSrc = "import math\nt = '😀é'\nmath.sq";
      const comp2 = await runA.complete(emojiSrc, emojiSrc.length);
      ok(!!comp2 && comp2.matches.includes("sqrt") && comp2.start === emojiSrc.length - 2, "notebook : la position part en points de code (emoji, accents) et revient en UTF-16");
      const imp = nbDoc.insertCell(na.ydoc, { type: "code", source: "import math", at: "end" });
      runA.run(imp);
      await until(() => !nbDoc.findCell(na.ydoc, imp)?.running && nbDoc.findCell(na.ydoc, imp)?.executionCount != null, 40000);
      await until(() => runA.status === "idle", 20000);
      const doc = await runA.inspect("math.sqrt", "math.sqrt".length);
      ok(!!doc && /sqrt/.test(doc) && doc.startsWith("```text\n") && !doc.includes("\u001b"), "notebook : « inspect » renvoie la documentation de math.sqrt, sans ANSI, en bloc de code");
      ok((await runB.complete(src, src.length)) !== null, "notebook : Bob, éditeur, complète aussi sur le même noyau");
      ok(nbDoc.findCell(na.ydoc, imp)!.outputs.length === 0 && !bobErrors.length, "notebook : une requête de complétion n'écrit rien dans le document");
      nbDoc.deleteCell(na.ydoc, imp);
    }

    // A code window runs its CURRENT buffer in a kernel session kept in the code document; everybody sees the last run.
    {
      const runDoc = sd.newDocId();
      const crA = sd.openSharedDoc(hA3.host, runDoc);
      const crB = sd.openSharedDoc(hB3.host, runDoc);
      await Promise.all([crA.synced, crB.synced]);
      codeDoc.initBlank(crA.ydoc, "calc.py");
      crA.ydoc.getText("content").insert(0, "x = 6\nprint(x * 7)\n");
      codeDoc.setKernelTerm(crA.ydoc, kid);
      ok(await until(() => codeDoc.kernelTermOf(crB.ydoc) === kid), "code : la session de noyau du fichier est partagée par son document (meta.kernelTerm)");
      const codeRun = new CodeRunner(crA.ydoc, kernelPort(sAl, kk, "code-alice"), { awareness: crA.awareness, canEdit: true });
      const codeRunB = new CodeRunner(crB.ydoc, kernelPort(sBo, kkBob!, "code-bob"), { awareness: crB.awareness, canEdit: true });
      codeRun.attach(kid);
      codeRunB.attach(kid);
      await until(() => codeRun.status === "idle", 20000);
      const cr1 = codeRun.run(crA.ydoc.getText("content").toString());
      ok(cr1.ok && (await until(() => codeDoc.readMeta(crB.ydoc.getMap("meta")).running === (cr1.ok ? cr1.execId : ""), 4000)), "code : Bob voit « en cours » dès qu'Alice lance le fichier");
      const gotRun = await until(() => !codeDoc.readMeta(crB.ydoc.getMap("meta")).running && codeDoc.readOutputs(crB.ydoc).some((o) => o.output_type === "stream" && o.text === "42\n"), 40000);
      ok(gotRun && codeDoc.readOutputs(crB.ydoc).length === 1 && codeDoc.readMeta(crB.ydoc.getMap("meta")).runCount !== undefined, "code : « 42 » est écrit dans les sorties du document de code (une seule fois), Bob le voit");
      ok(codeRunB.localRuns.length === 0, "code : Bob, abonné au même noyau, n'écrit rien");
      // The window is hidden / the file is edited meanwhile: what runs is what was on screen at the click.
      crA.ydoc.getText("content").insert(0, "import sys\n");
      const cr2 = codeRunB.run("print(x + 1)\nraise ValueError('boum')");
      ok(cr2.ok && (await until(() => !codeDoc.readMeta(crA.ydoc.getMap("meta")).running && codeDoc.readOutputs(crA.ydoc).some((o) => o.output_type === "error" && o.ename === "ValueError"), 40000)), "code : le noyau du fichier garde son état (x), une exception arrive comme sortie d'erreur, lancée par Bob");
      ok(codeDoc.readOutputs(crA.ydoc)[0]?.text === "7\n" && codeDoc.readOutputs(crA.ydoc).length === 2, "code : la nouvelle exécution a remplacé les sorties précédentes");
      await nap(300);
      const rawNow = [DB, `${DB}-wal`].filter(existsSync).map((f) => readFileSync(f).toString("latin1")).join("");
      // A whole word only: a short word turns up by chance inside megabytes of base64 ciphertext.
      const clear = (w: string) => new RegExp(`(^|[^A-Za-z0-9_-])${w.replace(".", "\\.")}($|[^A-Za-z0-9_-])`).test(rawNow);
      ok(!clear("calc.py") && !clear("ValueError") && !clear("boum"), "code : ni le nom du fichier ni les sorties en clair dans la base");
      codeRun.destroy();
      codeRunB.destroy();
      crA.destroy();
      crB.destroy();
    }

    // The runner belongs to the board session, not to the window: hide the window in the middle of a run and
    // the outputs keep coming (real kernel, real encrypted terminal stream).
    const svcDocId = sd.newDocId();
    const svcEnv: nbSvc.ServiceEnv = { port: kernelPort(sAl, kk, "nb-svc"), watchTerminals: () => () => {}, terminalOver: () => false, onClose: () => () => {} };
    const svcWin = nbSvc.acquireNotebook(hA3.host, svcEnv, svcDocId, { idleMs: 1500 });
    const svcBob = sd.openSharedDoc(hB3.host, svcDocId);
    await Promise.all([svcWin.doc.synced, svcBob.synced]);
    nbDoc.initBlankNotebook(svcWin.doc.ydoc, "svc.ipynb");
    nbDoc.setKernelTerm(svcWin.doc.ydoc, kid);
    const svcCell = nbDoc.cellViews(svcWin.doc.ydoc)[0].id;
    nbDoc.findCell(svcWin.doc.ydoc, svcCell)!.source.insert(0, "import time\nfor i in range(3):\n    print('tick', i, flush=True)\n    time.sleep(0.4)\nprint('fin')");
    const svcRun = svcWin.runner.run(svcCell);
    svcWin.release(); // the window is hidden right after the click
    ok(svcRun.ok && nbSvc.hasNotebookService(hA3.host, svcDocId), "notebook : fenêtre masquée en pleine exécution, le service du tableau garde le runner");
    const svcDone = await until(() => {
      const v = nbDoc.findCell(svcBob.ydoc, svcCell);
      return !!v && !v.running && v.outputs.map((o) => String(o.text ?? "")).join("").includes("fin");
    }, 40000);
    const svcOut = nbDoc.findCell(svcBob.ydoc, svcCell)?.outputs.map((o) => String(o.text ?? "")).join("") ?? "";
    ok(svcDone && svcOut === "tick 0\ntick 1\ntick 2\nfin\n", `notebook : les sorties d'une exécution lancée puis masquée arrivent toutes dans le document (${JSON.stringify(svcOut)})`);
    ok(await until(() => !nbSvc.hasNotebookService(hA3.host, svcDocId), 8000), "notebook : sans fenêtre ni exécution, le service se libère tout seul");
    svcBob.destroy();

    // Save the .ipynb on the machine through the sealed file channel.
    const nbText = nbDoc.exportIpynb(na.ydoc);
    const nbSaved = await mf.saveMachineFile(client, "demo.ipynb", nbText, { baseSha: undefined, confirm: confirm(true), limit: nbDoc.MAX_NOTEBOOK_BYTES });
    nbDoc.markSaved(na.ydoc, { path: nbSaved!.path, sha: nbSaved!.sha, by: "Alice" });
    const onDisk = JSON.parse(readFileSync(join(cwd, "demo.ipynb"), "utf8"));
    const diskCell = onDisk.cells.find((x: any) => x.source.join("") === "print(x + 1)");
    ok(onDisk.nbformat === 4 && onDisk.cells.length === 4 && diskCell?.outputs?.[0]?.text?.join("") === "42\n" && diskCell.execution_count === 2, "notebook : demo.ipynb est un nbformat 4 valide sur le disque, avec la sortie « 42 »");
    const reopened = await mf.openMachineFile(client, "demo.ipynb", nbDoc.MAX_NOTEBOOK_BYTES);
    const reParsed = nbDoc.parseIpynb(reopened.text);
    ok(reopened.sha === nbSaved!.sha && reParsed.cells.length === 4 && reParsed.warnings.length === 0, "notebook : le fichier de la machine se relit et s'analyse sans réserve");

    // Blind server: neither code nor outputs in clear in the database.
    await until(() => upRows(D, nbId) > 0);
    await nap(300);
    const nbDump = JSON.stringify(rw.prepare("SELECT * FROM board_docs").all()) + JSON.stringify(rw.prepare("SELECT * FROM board_doc_updates").all());
    const nbRaw = [DB, `${DB}-wal`].filter(existsSync).map((f) => readFileSync(f).toString("latin1")).join("");
    const clearTexts = ["print(x + 1)", "print(x * 2)", "ZeroDivisionError", "x = 41", "demo.ipynb", "output_type", "42\\n", "82\\n"];
    ok(upRows(D, nbId) > 0 && clearTexts.every((t) => !nbDump.includes(t) && !nbRaw.includes(t)), "notebook : ni le code, ni les sorties (42, 82, erreur), ni le nom du fichier en clair dans la base");

    // The kernel session is closed with the notebook; the document is deleted for good (doc.del).
    sAl.send({ t: "term.close", id: kid });
    ok((await until(() => upRows(D, nbId) > 0)) && docsRows(D).some((r) => r.doc_id === nbId), "notebook : le document est bien stocké avant suppression");
    // A viewer (Carol) and a wrong epoch can't delete; an editor can.
    // (Carol was removed from this board by the rotation test above: she comes back as a viewer.)
    await as(alice, async () => lib.shareItem(ctxOf(alice, await tree(alice)), D, { id: carol.user.id, email: "carol@test.local", publicKey: carol.user.publicKey }, "viewer"));
    // Re-sharing drops the board sockets: the two editors reconnect and resubscribe (the hosts do it on init).
    hA3.reconnect();
    hB3.reconnect();
    const sCarol = boardSocket(carol, D);
    await sCarol.open;
    await sCarol.next((m) => m.t === "init");
    sCarol.send({ t: "doc.del", doc: nbId, epoch: 0 });
    const carolDel = await sCarol.next((m) => m.t === "doc.err" || m.t === "doc.gone" || m.t === "rekey", 4000).catch(() => null);
    ok(carolDel?.t === "doc.err" && carolDel.error === "Lecture seule" && docsRows(D).some((r) => r.doc_id === nbId), "documents : un lecteur ne peut pas supprimer un document (« Lecture seule »)");
    sCarol.ws.close();
    const sDel = boardSocket(alice, D);
    await sDel.open;
    const delInit = await sDel.next((m) => m.t === "init");
    sDel.send({ t: "doc.del", doc: nbId, epoch: delInit.epoch + 1 });
    ok((await sDel.next((m) => m.t === "rekey" || m.t === "doc.gone", 4000).catch(() => ({ t: "?" }))).t === "rekey" && docsRows(D).some((r) => r.doc_id === nbId), "documents : un doc.del d'une autre génération de clés est refusé (rekey), rien n'est supprimé");
    sDel.send({ t: "doc.del", doc: "not-a-doc-id", epoch: delInit.epoch });
    ok((await sDel.next((m) => m.t === "doc.err", 4000).catch(() => ({ error: "?" }))).error === "identifiant de document invalide", "documents : doc.del valide l'identifiant");
    const otherDocs = docsRows(D).filter((r) => r.doc_id !== nbId).length;
    await nap(1200);
    const wasGone = bobErrors.length;
    sDel.send({ t: "doc.del", doc: nbId, epoch: delInit.epoch });
    const goneBob = await until(() => bobErrors.length > wasGone && bobErrors.some((e) => /supprimé/.test(e)), 6000);
    ok(goneBob && !docsRows(D).some((r) => r.doc_id === nbId) && upRows(D, nbId) === 0 && docsRows(D).filter((r) => r.doc_id !== nbId).length === otherDocs, "documents : doc.del supprime les lignes du document (et d'elles seules) et prévient les abonnés (doc.gone)");
    sDel.send({ t: "doc.sub", doc: nbId });
    // Deleted for good: a later subscription (or a stale client pushing its local copy) gets doc.gone,
    // the document is not recreated.
    const reSub = await sDel.next((m) => (m.t === "doc.state" || m.t === "doc.gone") && m.doc === nbId, 4000);
    ok(reSub.t === "doc.gone" && !docsRows(D).some((r) => r.doc_id === nbId), "documents : un document supprimé ne revient pas (doc.gone au réabonnement)");
    // ---- Duplicating a board copies its documents (re-sealed under the copy's own key) ----
    {
      const dupNb = sd.newDocId();
      const dupCode = sd.newDocId();
      const nodeEl = { ...rect, id: "dupnode", customData: { node: true, shells: [], codes: [{ docId: dupCode, label: "demo.py" }], notebooks: [{ docId: dupNb }] } };
      const SRC = await as(alice, async () => lib.createItem(ctxOf(alice, await tree(alice)), "board", null, "Source avec documents", { elements: [nodeEl], files: {} }));
      const kSrc = await keyOf(alice, SRC);
      const hSrc = docHost(alice, SRC, kSrc, "editor");
      const dn = sd.openSharedDoc(hSrc.host, dupNb);
      const dc = sd.openSharedDoc(hSrc.host, dupCode);
      await Promise.all([dn.synced, dc.synced]);
      nbDoc.initBlankNotebook(dn.ydoc, "copie.ipynb");
      nbDoc.findCell(dn.ydoc, nbDoc.cellViews(dn.ydoc)[0].id)!.source.insert(0, "SECRET_DUP_CELL = 1");
      nbDoc.setKernelTerm(dn.ydoc, kid);
      codeDoc.initBlank(dc.ydoc, "copie.py");
      dc.ydoc.getText("content").insert(0, "print('SECRET_DUP_CODE')\n");
      await until(() => upRows(SRC, dupNb) > 0 && upRows(SRC, dupCode) > 0);
      await nap(200);
      const NEW = await as(alice, async () => lib.duplicateBoard(ctxOf(alice, await tree(alice)), SRC));
      const kNew = await keyOf(alice, NEW);
      const stored = (await as(alice, () => api("GET", `/items/${NEW}/docs`))).body as { doc: string; epoch: number; snap: string | null; snapSeq: number; seq: number; ups: any[] }[];
      ok(stored.length === 2 && stored.map((d) => d.doc).sort().join() === [dupNb, dupCode].sort().join() && stored.every((d) => d.epoch === 0 && d.snap && d.ups.length === 0), "duplication : le tableau copié a ses deux documents (mêmes identifiants), chacun en un instantané");
      const read = async (key: c.SymKey, board: string, d: (typeof stored)[number]) => {
        const y = new Y.Doc();
        Y.applyUpdate(y, await c.unbox(key, d.snap!, c.AAD.doc(board, d.doc, d.epoch)));
        return y;
      };
      const copyNb = await read(kNew, NEW, stored.find((d) => d.doc === dupNb)!);
      const copyCode = await read(kNew, NEW, stored.find((d) => d.doc === dupCode)!);
      ok(nbDoc.cellViews(copyNb)[0].source.toString() === "SECRET_DUP_CELL = 1" && nbDoc.readMeta(copyNb.getMap("meta")).name === "copie.ipynb" && copyCode.getText("content").toString() === "print('SECRET_DUP_CODE')\n", "duplication : la copie se déchiffre avec la clé du nouveau tableau et garde le contenu");
      ok(nbDoc.readMeta(copyNb.getMap("meta")).kernelTerm === undefined && nbDoc.kernelTermOf(dn.ydoc) === kid, "duplication : la référence à la session de noyau est effacée dans la copie, pas dans l'original");
      const oldCantRead = await c.unbox(kSrc, stored[0].snap!, c.AAD.doc(NEW, stored[0].doc, 0)).then(() => false, () => true);
      const crossBoard = await c.unbox(kNew, stored[0].snap!, c.AAD.doc(SRC, stored[0].doc, 0)).then(() => false, () => true);
      ok(oldCantRead && crossBoard, "duplication : l'ancienne clé ne lit pas la copie, et le chiffré ne vaut que pour le nouveau tableau");
      const rawDup = [DB, `${DB}-wal`].filter(existsSync).map((f) => readFileSync(f).toString("latin1")).join("");
      ok(!rawDup.includes("SECRET_DUP_CELL") && !rawDup.includes("SECRET_DUP_CODE") && !rawDup.includes("copie.ipynb"), "duplication : rien en clair dans la base");
      // The copy is a live board: its documents open and accept edits with the new key.
      const hNew = docHost(alice, NEW, kNew, "editor");
      const openedCopy = sd.openSharedDoc(hNew.host, dupCode);
      await openedCopy.synced;
      openedCopy.ydoc.getText("content").insert(0, "# édité dans la copie\n");
      ok(openedCopy.ydoc.getText("content").toString().endsWith("SECRET_DUP_CODE')\n") && (await until(() => upRows(NEW, dupCode) > 0)), "duplication : le document copié s'ouvre sur le nouveau tableau et accepte des modifications");
      ok(dc.ydoc.getText("content").toString() === "print('SECRET_DUP_CODE')\n", "duplication : l'original n'est pas modifié par la copie");
      openedCopy.destroy();
      dn.destroy();
      dc.destroy();
      hSrc.close();
      hNew.close();
    }

    sDel.ws.close();
    runA.destroy();
    runB.destroy();
    na.destroy();
    nbBob.destroy();
    sAl.ws.close();
    sBo.ws.close();
    sf.ws.close();
    ca.destroy();
    cb.destroy();
    hA3.close();
    hB3.close();
  }
  ok(errors.length === 0, `documents : aucune erreur côté client${errors.length ? ` (${errors.join("; ")})` : ""}`);
}

// Unauthenticated hardening (after the MCP tests: the login rate limit below would lock Alice out).
const nullOrigin = await new Promise<number>((resolve) => {
  const w = new WebSocket(`${BASE.replace("http", "ws")}/ws?board=${B}`, { headers: { cookie: alice.cookie, origin: "null" } });
  w.on("unexpected-response", (_q: any, r: any) => resolve(r.statusCode));
  w.on("error", () => {});
});
ok(nullOrigin === 403 && (await api("GET", "/auth/status")).status === 200, "Origin: null refusé sans faire tomber le serveur");
jar.current = "";
const big = await realFetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x", authKey: "y".repeat(600_000) }) });
ok(big.status === 413, "corps énorme refusé avant authentification");
let limited = 0;
for (let i = 0; i < 12; i++) {
  const r = await realFetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `9.9.9.${i}` }, body: JSON.stringify({ email: "alice@test.local", authKey: "nope" }) });
  if (r.status === 429) limited++;
}
ok(limited > 0, "limitation des tentatives de connexion par compte, même en changeant X-Forwarded-For");

// Malformed input must not stop the process (upgrades run outside Express).
{
  const { connect } = await import("node:net");
  const raw = (req: string) =>
    new Promise<string>((resolve) => {
      const s = connect(Number(new URL(BASE).port), new URL(BASE).hostname, () => s.write(req));
      let out = "";
      s.on("data", (d) => (out += d));
      s.on("close", () => resolve(out));
      s.on("error", () => resolve(out));
      setTimeout(() => s.destroy(), 2000);
    });
  const upgrade = "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
  await raw(`GET // HTTP/1.1\r\nHost: x\r\n${upgrade}\r\n`);
  await raw(`GET /ws?board=x HTTP/1.1\r\nHost: x\r\nCookie: eb_session=%E0\r\n${upgrade}\r\n`);
  const sn = boardSocket(alice, B);
  await sn.open;
  await sn.next((m) => m.t === "init");
  for (const m of ["null", "42", '"x"', "[]"]) sn.ws.send(m);
  await new Promise((r) => setTimeout(r, 300));
  sn.ws.close();
  const alive = await realFetch(BASE + "/api/config").then((r) => r.ok, () => false);
  ok(alive, "le serveur survit à une URL `//`, un cookie mal encodé et des messages `null`");
}

agent.kill();
sa.ws.close();
sa2.ws.close();
console.log(failures ? `\n${failures} ÉCHEC(S)` : "\nTOUT EST OK");
process.exit(failures ? 1 : 0);
