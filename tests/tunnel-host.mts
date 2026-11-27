// Web tunnels in subdomain mode (TUNNEL_DOMAIN), at HTTP level, against a throwaway server started by run.sh
// with TUNNEL_DOMAIN=tunnel.localhost, TUNNEL_SCHEME=http and a test secret, plus the real agent.
// The requests are the ones a reverse proxy would send: X-Tunnel-Auth and X-Tunnel-Host in front of the tunnel port.
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "../server/node_modules/ws/index.js";
import * as c from "../web/src/crypto.ts";
import * as lib from "../web/src/library.tsx";
import { solveChallenge } from "../web/src/pow.ts";
import { createMachine, listMachines } from "../web/src/vault.ts";

const BASE = process.env.BASE!;
const PROXY = new URL(process.env.PROXY!);
const DB = process.env.DB!;
const SECRET = process.env.TUNNEL_SECRET!;
const DOMAIN = "tunnel.localhost";
const LOG = `${dirname(DB)}/server.log`;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`/api${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined } as any);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j as any };
}

type U = { user: any; keys: c.KeyPair; cookie: string };
const logText = () => readFileSync(LOG, "utf8");
const mailCode = (email: string) => logText().split("\n").filter((l) => l.startsWith(`[mail] to=${email} `)).at(-1)?.match(/code=(\d{6})/)?.[1] ?? "";
const setupCode = () => logText().match(/Code d'installation[^:]*: ([A-Z0-9-]+)/)?.[1] ?? "";
const events = () => logText().split("\n").filter((l) => l.startsWith("excalibash-security "));

async function register(email: string, name: string, password: string, setup?: string): Promise<U> {
  jar.current = "";
  const id = c.randomId();
  const salt = c.toB64(c.randomBytes(16));
  const { authKey, masterKey } = await c.deriveAccountKeys(password, salt);
  const kp = await c.generateKeyPair();
  const rec = await c.recoveryKeys(c.randomBytes(32));
  const r = await api("POST", "/auth/register", {
    pow: await solveChallenge((await api("GET", "/auth/challenge")).body), website: "",
    id, email, name, setupCode: setup, salt, authKey,
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
  return { user, keys: { priv: await c.importPrivateKey(kp.pkcs8), pub: kp.pub }, cookie: jar.current };
}
async function as<T>(u: U, fn: () => Promise<T>): Promise<T> {
  jar.current = u.cookie;
  return fn();
}
const tree = (u: U) =>
  as(u, async () => {
    const r = await api("GET", "/tree");
    return lib.decryptTree(u.user, u.keys, r.body.items, r.body.grants);
  });

/** A second session of an existing account (another cookie jar). */
async function loginAs(u: U, email: string, password: string): Promise<U> {
  const { salt } = (await (await realFetch(`${BASE}/api/auth/prelogin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) })).json()) as any;
  const { authKey } = await c.deriveAccountKeys(password, salt);
  const r = await realFetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, authKey }) });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`);
  return { ...u, cookie: r.headers.get("set-cookie")!.split(";")[0]! };
}
const ctxOf = (u: U, nodes: Map<string, lib.Node>) => ({ user: u.user, keys: u.keys, nodes });

function boardSocket(u: U, boardId: string) {
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?board=${boardId}`, { headers: { cookie: u.cookie } });
  const queue: any[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (raw: any) => {
    queue.push(JSON.parse(raw.toString()));
    waiters.splice(0).forEach((f) => f());
  });
  const next = (pred: (m: any) => boolean, ms = 8000) =>
    new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
      const check = () => {
        const i = queue.findIndex(pred);
        if (i < 0) return waiters.push(check);
        clearTimeout(t);
        resolve(queue.splice(i, 1)[0]);
      };
      check();
    });
  return { ws, next, open: new Promise((r) => ws.on("open", r)), send: (m: object) => ws.send(JSON.stringify(m)) };
}

// ---- requests as the reverse proxy would send them -----------------------------------------------------

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
const statuses: number[] = [];
type Opt = { host?: string | null; secret?: string | null; headers?: Record<string, string>; body?: string; ip?: string };

function px(method: string, path: string, o: Opt = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.secret !== null) headers["x-tunnel-auth"] = o.secret ?? SECRET;
  if (o.host) headers["x-tunnel-host"] = o.host;
  if (o.ip) headers["x-forwarded-for"] = o.ip;
  if (o.body !== undefined) headers["content-type"] ??= "application/json";
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: PROXY.hostname, port: PROXY.port, method, path, headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        statuses.push(res.statusCode!);
        resolve({ status: res.statusCode!, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

/** Everything that identifies an answer, minus what always differs (date) or belongs to the connection. */
const shape = (r: Res) => {
  const { date: _d, connection: _c, "keep-alive": _k, ...rest } = r.headers;
  return JSON.stringify([r.status, rest, r.body]);
};
const emptyNotFound = (r: Res) => r.status === 404 && r.body === "" && r.headers["cache-control"] === "no-store";

function wsTry(host: string, o: { cookie?: string; origin?: string | null; secret?: string | null; ip?: string } = {}): Promise<{ status: number; ws?: any }> {
  const headers: Record<string, string> = { "x-tunnel-host": host };
  if (o.secret !== null) headers["x-tunnel-auth"] = o.secret ?? SECRET;
  if (o.origin !== null) headers.origin = o.origin ?? `http://${host}`;
  if (o.cookie) headers.cookie = o.cookie;
  if (o.ip) headers["x-forwarded-for"] = o.ip;
  const id = host.split(".")[0];
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${PROXY.host}/eb-proxy/ws/${id}`, { headers });
    ws.on("open", () => resolve({ status: 101, ws }));
    ws.on("unexpected-response", (_req: any, res: any) => {
      statuses.push(res.statusCode);
      resolve({ status: res.statusCode });
    });
    ws.on("error", () => resolve({ status: 0 }));
  });
}

// ---- setup --------------------------------------------------------------------------------------------------

const alice = await register("alice@test.local", "Alice", "alice-password-1", setupCode());
await as(alice, () => api("PATCH", "/admin/settings", { registrationOpen: true }));
const bob = await register("bob@test.local", "Bob", "bob-password-12");
const carol = await register("carol@test.local", "Carol", "carol-password-1");
let nA = await tree(alice);
const B = await as(alice, () => lib.createItem(ctxOf(alice, nA), "board", null, "Tableau tunnels", { elements: [], files: {} }));
nA = await tree(alice);
await as(bob, () => api("PUT", "/account/visibility", { findableName: true, findableEmail: true }));
const bobPub = (await as(alice, () => api("GET", "/auth/lookup?email=bob@test.local"))).body.users[0];
await as(alice, () => lib.shareItem(ctxOf(alice, nA), B, bobPub, "viewer"));
const keyB = (await tree(alice)).get(B)!.key!;

const machine = await as(alice, () => createMachine(alice.keys, "laptop-alice"));
const agent = spawn(new URL(`../agent/dist/excalibash-agent-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`, import.meta.url).pathname, ["--server", BASE], {
  env: { ...process.env, EXCALIBASH_TOKEN: machine.token, EXCALIBASH_KEY: machine.privateKey },
  stdio: ["ignore", "ignore", "pipe"],
});
await sleep(1500);
const mAlice = (await as(alice, () => listMachines(alice.keys)))[0];

const site = createServer((req, res) => res.end(`site:${req.method}:${req.url}:${req.headers["x-t"]}`));
await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
const siteUrl = `http://127.0.0.1:${(site.address() as any).port}`;

const sa = boardSocket(alice, B);
await sa.open;
await sa.next((m) => m.t === "init");

async function createWeb(id: string) {
  const kw = await c.newSymKey();
  sa.send({
    t: "web.create", reqId: id, id, machineId: machine.id,
    keyForBoard: await c.wrapKey(keyB, kw, c.AAD.webKey(B, id)),
    keyForAgent: await c.boxJson(mAlice.auth, { k: c.toB64(kw.raw), url: siteUrl, insecure: false }, c.AAD.webAgent(id)),
    encLabel: await c.boxJson(keyB, { url: siteUrl, insecure: false, machine: "laptop-alice" }, c.AAD.webLabel(B, id)),
  });
  const m = await sa.next((x) => (x.t === "web.created" || x.t === "error") && x.reqId === id);
  return { kw, reply: m };
}

const legacy = await createWeb(c.randomId());
ok(legacy.reply.t === "error", "web.create refuse un identifiant de l'ancien format (base64)");
const idA = c.randomTunnelId();
ok(/^[a-z2-7]{26}$/.test(idA), "un identifiant de tunnel fait 26 caractères a-z2-7");
const A = await createWeb(idA);
ok(A.reply.t === "web.created", "web.create accepte l'identifiant au nouveau format");
const idB = c.randomTunnelId();
const Bt = await createWeb(idB);
await sleep(500);

const hostA = `${idA}.${DOMAIN}:${PROXY.port}`;
const hostB = `${idB}.${DOMAIN}:${PROXY.port}`;
const originA = `http://${hostA}`;
const originB = `http://${hostB}`;
const COOKIE = "__Host-eb_tunnel";

const ticketFor = (u: U, id: string) => as(u, () => api("POST", `/tunnels/${id}/ticket`)).then((r) => ({ ...r, ticket: r.body.ticket as string }));
const exchange = (host: string, ticket: string, origin = `http://${host}`, extra: Opt = {}) =>
  px("POST", "/eb-proxy/session", { host, headers: { origin }, body: JSON.stringify({ ticket }), ...extra });
/** A ready-to-use cookie ("name=value") for a tunnel, as a signed-in user would get it. */
async function login(u: U, id: string, host: string): Promise<{ cookie: string; setCookie: string }> {
  const t = await ticketFor(u, id);
  const r = await exchange(host, t.ticket);
  const sc = String(r.headers["set-cookie"] ?? "");
  return { cookie: sc.split(";")[0]!, setCookie: sc };
}
async function relayGet(kw: c.SymKey, id: string, host: string, path: string, o: { cookie?: string; origin?: string | null } = {}) {
  const rid = c.randomId();
  const ts = Date.now();
  const d = await c.box(kw, c.utf8(JSON.stringify({ m: "GET", p: path, h: { "x-t": ["ok"] }, b: "" })), `eb:http-req:${id}:${rid}:${ts}`);
  const headers: Record<string, string> = {};
  if (o.origin !== null) headers.origin = o.origin ?? `http://${host}`;
  if (o.cookie) headers.cookie = o.cookie;
  const r = await px("POST", `/eb-proxy/req/${id}`, { host, headers, body: JSON.stringify({ rid, ts, d }) });
  if (r.status !== 200) return { r, text: "" };
  const res = JSON.parse(c.fromUtf8(await c.unbox(kw, JSON.parse(r.body).d, `eb:http-res:${id}:${rid}`)));
  return { r, text: c.fromUtf8(c.fromB64(res.b)), status: res.s as number };
}

// ---- secret, host, uniform refusals ---------------------------------------------------------------------------

const ipS = "203.0.113.10";
const noSecret = await px("GET", "/", { host: hostA, secret: null, ip: ipS });
const wrongSecret = await px("GET", "/", { host: hostA, secret: "x".repeat(40), ip: ipS });
const shortSecret = await px("GET", "/", { host: hostA, secret: "x", ip: ipS });
ok([noSecret, wrongSecret, shortSecret].every(emptyNotFound), "secret absent, faux ou de longueur différente : 404, corps vide, no-store");
ok(shape(noSecret) === shape(wrongSecret) && shape(wrongSecret) === shape(shortSecret), "les trois refus de secret sont identiques");
ok(events().filter((l) => l.includes("reason=bad_secret") && l.includes(`ip=${ipS}`)).length === 3, "journal : trois lignes reason=bad_secret avec l'adresse");

const ipH = "203.0.113.11";
const otherDomain = await px("GET", "/", { host: `${idA}.example.com`, ip: ipH });
const badId = await px("GET", "/", { host: `abc.${DOMAIN}`, ip: ipH });
const oldId = await px("GET", "/", { host: `${c.randomId()}.${DOMAIN}`, ip: ipH });
const unknownId = await px("GET", "/", { host: `${c.randomTunnelId()}.${DOMAIN}`, ip: ipH });
const noHost = await px("GET", "/", { host: null, ip: ipH });
const viaHostHeader = await px("GET", "/", { host: null, headers: { host: hostA, "x-forwarded-host": hostA }, ip: ipH });
const refusals = [otherDomain, badId, oldId, unknownId, noHost, viaHostHeader];
ok(refusals.every(emptyNotFound), "bon secret mais hôte d'un autre domaine, id mal formé, ancien id, id inconnu, sans X-Tunnel-Host, Host seul : 404 vide");
ok(refusals.every((r) => shape(r) === shape(refusals[0]!)), "tous ces refus sont identiques entre eux");
ok(shape(refusals[0]!) === shape(noSecret), "… et identiques au refus du secret");
ok(events().some((l) => l.includes("reason=unknown_tunnel") && l.includes(`ip=${ipH}`)) && events().some((l) => l.includes("reason=bad_host")), "journal : unknown_tunnel et bad_host");

// ---- static resources, boot page ----------------------------------------------------------------------------

const sw = await px("GET", "/eb-proxy/sw.js", { host: hostA });
ok(sw.status === 200 && sw.body.includes(`const HOST_ID = "${idA}"`) && !sw.body.includes("__TUNNEL_ID__") && sw.body.includes("http://127.0.0.1"), "sw.js : servi avec le bon secret, l'id du tunnel est injecté");
const boot = await px("GET", "/eb-proxy/boot.js", { host: hostA });
ok(boot.status === 200 && boot.body.includes(`const HOST_ID = "${idA}"`), "boot.js : id injecté par le serveur");
const page = await px("GET", "/anything/here?x=1", { host: hostA });
ok(page.status === 200 && page.body.includes("/eb-proxy/boot.js") && /frame-ancestors 'self' http:\/\/127\.0\.0\.1/.test(String(page.headers["content-security-policy"])), "page de boot : toute GET, frame-ancestors 'self' + origine principale");
const tPath = await px("GET", `/t/${idA}/`, { host: hostA });
ok(tPath.status === 200 && tPath.body === page.body, "/t/<id>/ n'a rien de spécial (c'est la page de boot, comme tout chemin)");
const tPathOther = await px("GET", `/eb-proxy/req/${idA}`, { host: hostA });
ok(tPathOther.status === 200 && tPathOther.body === page.body, "GET sur une route de relais : page de boot");
const cfg = (await realFetch(`${BASE}/api/config`)).headers;
const csp = (await realFetch(`${BASE}/api/config`)).headers.get("content-security-policy") ?? "";
ok(csp.includes(`frame-src 'self' https: http://*.${DOMAIN}:*`), "CSP de l'origine principale : frame-src sur les sous-domaines des tunnels");
ok((await (await realFetch(`${BASE}/api/config`)).json()).tunnelDomain === DOMAIN && (cfg.get("x-frame-options") ?? "") === "DENY", "/api/config annonce tunnelDomain");

// ---- tickets, session cookie ------------------------------------------------------------------------------------

const expiring = await ticketFor(alice, idA); // checked again after a minute
const noAccess = await ticketFor(carol, idA);
ok(noAccess.status === 404 && !noAccess.ticket, "ticket : un compte sans accès au tableau reçoit 404");
ok((await ticketFor(alice, c.randomTunnelId())).status === 404, "ticket : tunnel inconnu, 404");
ok((await ticketFor(alice, c.randomId())).status === 404, "ticket : ancien format, 404");
ok((await as({ ...alice, cookie: "" }, () => api("POST", `/tunnels/${idA}/ticket`))).status === 401, "ticket : sans session Excalibash, 401");
const bobS2 = await loginAs(bob, "bob@test.local", "bob-password-12");
const tBob = await ticketFor(bobS2, idA);
ok(tBob.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(tBob.ticket), "ticket : un lecteur du tableau reçoit un ticket (32 octets base64url)");

const noRelaySession = await relayGet(A.kw, idA, hostA, "/hello");
ok(emptyNotFound(noRelaySession.r), "relais sans cookie : 404 vide");
ok(emptyNotFound(await exchange(hostA, "n'importe quoi")), "échange avec un faux ticket : 404 vide");
ok(emptyNotFound(await exchange(hostA, tBob.ticket, "http://evil.example")), "échange avec une mauvaise Origin : 404 vide");
const t2 = await ticketFor(bobS2, idA);
ok(emptyNotFound(await exchange(hostB, t2.ticket, originB)), "ticket d'un tunnel présenté à un autre : 404 vide");
const t3 = await ticketFor(bobS2, idA);
const ex = await exchange(hostA, t3.ticket);
const setCookie = String(ex.headers["set-cookie"] ?? "");
ok(ex.status === 204 && ex.body === "", "échange du ticket : 204");
ok(setCookie.startsWith(`${COOKIE}=`) && /; Path=\//.test(setCookie) && /; Secure/.test(setCookie) && /; HttpOnly/.test(setCookie) && /; SameSite=Lax/.test(setCookie) && !/Domain=/i.test(setCookie) && /Max-Age=28800\b/.test(setCookie), `cookie __Host-eb_tunnel : Path=/, Secure, HttpOnly, SameSite=Lax, sans Domain, 8 h (${setCookie.replace(/=[^;]+/, "=…")})`);
ok(emptyNotFound(await exchange(hostA, t3.ticket)), "ticket réutilisé : 404 vide");
const bobCookie = setCookie.split(";")[0]!;

// ---- the relay -----------------------------------------------------------------------------------------------------

const good = await relayGet(A.kw, idA, hostA, "/hello?x=1", { cookie: bobCookie });
ok(good.r.status === 200 && good.text === "site:GET:/hello?x=1:ok", "relais avec cookie et Origin : la requête chiffrée atteint l'agent et la réponse se déchiffre");
ok(emptyNotFound((await relayGet(A.kw, idA, hostA, "/hello", { cookie: bobCookie, origin: null })).r), "relais sans Origin : 404 vide");
ok(emptyNotFound((await relayGet(A.kw, idA, hostA, "/hello", { cookie: bobCookie, origin: originB })).r), "relais avec l'Origin d'un autre tunnel : 404 vide");
ok(emptyNotFound((await relayGet(A.kw, idA, hostA, "/hello", { cookie: bobCookie, origin: "http://evil.example" })).r), "relais avec une Origin étrangère : 404 vide");
ok(emptyNotFound((await relayGet(A.kw, idA, hostB, "/hello", { cookie: bobCookie })).r), "cookie du tunnel A sur l'hôte du tunnel B : 404 vide");
// The path id must be the host's own.
{
  const rid = c.randomId();
  const r = await px("POST", `/eb-proxy/req/${idB}`, { host: hostA, headers: { origin: originA, cookie: bobCookie }, body: JSON.stringify({ rid, ts: Date.now(), d: "x" }) });
  ok(emptyNotFound(r), "relais vers l'id d'un autre tunnel sur l'hôte A : 404 vide");
}
// After authentication, functional errors are still functional.
{
  const r = await px("POST", `/eb-proxy/req/${idA}`, { host: hostA, headers: { origin: originA, cookie: bobCookie }, body: JSON.stringify({ rid: "x" }) });
  ok(r.status === 400, "requête mal formée après authentification : 400");
}
const aliceLogin = await login(alice, idA, hostA);
const bobOnB = await login(bobS2, idB, hostB);
const bobS1A = await login(bob, idA, hostA); // the session Bob signed up with
ok((await relayGet(Bt.kw, idB, hostB, "/b", { cookie: bobOnB.cookie })).text === "site:GET:/b:ok", "second tunnel : sa propre session");

// ---- sockets ----------------------------------------------------------------------------------------------------------

ok((await wsTry(hostA, { cookie: undefined })).status === 404, "WebSocket sans cookie : 404");
ok((await wsTry(hostA, { cookie: bobCookie, origin: null })).status === 404, "WebSocket sans Origin : 404");
ok((await wsTry(hostA, { cookie: bobCookie, origin: originB })).status === 404, "WebSocket avec l'Origin d'un autre tunnel : 404");
ok((await wsTry(hostA, { cookie: bobCookie, secret: "x".repeat(32) })).status === 404, "WebSocket avec un faux secret : 404");
ok((await wsTry(hostB, { cookie: bobCookie })).status === 404, "WebSocket avec le cookie d'un autre tunnel : 404");
const rawWs = await new Promise<string>((resolve) => {
  const s = new WebSocket(`ws://${PROXY.host}/eb-proxy/ws/${idA}`, { headers: { "x-tunnel-host": hostA, "x-tunnel-auth": "x".repeat(32), origin: originA } });
  s.on("unexpected-response", (_q: any, res: any) => resolve(`${res.statusCode} ${res.headers["content-length"]} ${res.headers.connection}`));
  s.on("error", () => resolve("erreur"));
});
ok(rawWs === "404 0 close", `refus WebSocket : 404, Content-Length 0, Connection: close (${rawWs})`);
const open = await wsTry(hostA, { cookie: bobCookie });
ok(open.status === 101, "WebSocket avec secret, hôte, Origin et cookie : ouverte");
const bobWsClosed = new Promise<number>((r) => open.ws?.on("close", (code: number) => r(code)));

// Bob signs out of Excalibash: his tunnel sessions end at once and his socket is cut.
{
  const out = await as(bobS2, () => api("POST", "/auth/logout"));
  ok(out.status === 200, "Bob se déconnecte d'Excalibash (cet appareil)");
  ok((await Promise.race([bobWsClosed, sleep(3000).then(() => -1)])) === 1008, "sa WebSocket de tunnel est coupée (1008)");
  ok(emptyNotFound((await relayGet(A.kw, idA, hostA, "/hello", { cookie: bobCookie })).r), "son cookie de tunnel ne donne plus rien : 404 vide");
  ok(emptyNotFound((await relayGet(Bt.kw, idB, hostB, "/b", { cookie: bobOnB.cookie })).r), "… sur ses autres tunnels non plus");
}
ok((await relayGet(A.kw, idA, hostA, "/hello", { cookie: bobS1A.cookie })).text === "site:GET:/hello:ok", "la session de tunnel ouverte depuis son autre appareil continue de marcher")
ok((await relayGet(A.kw, idA, hostA, "/hello", { cookie: aliceLogin.cookie })).text === "site:GET:/hello:ok", "la session d'Alice sur le même tunnel n'est pas touchée");

// ---- access removed, tunnel closed --------------------------------------------------------------------------------------

{
  const dbw = new DatabaseSync(DB);
  dbw.prepare("DELETE FROM grants WHERE item_id = ? AND user_id = ?").run(B, bob.user.id);
  dbw.close();
}
ok((await ticketFor(bob, idA)).status === 404, "ticket : plus de ticket une fois l'accès au tableau retiré");
ok((await relayGet(A.kw, idA, hostA, "/hello", { cookie: bobS1A.cookie })).status === 200, "le cookie de Bob marche encore dans la minute (revérification toutes les 60 s)");

// Tunnel B closes: its sessions go with it.
sa.send({ t: "web.close", id: idB });
await sleep(600);
ok(emptyNotFound((await relayGet(Bt.kw, idB, hostB, "/b", { cookie: aliceLogin.cookie })).r), "tunnel fermé : 404 vide");
const aliceOnB = await ticketFor(alice, idB);
ok(aliceOnB.status === 404, "tunnel fermé : plus de ticket");

// One minute later: the ticket that was never used has expired, and the access check runs again.
console.log("… attente de 62 s (expiration d'un ticket, revérification de l'accès)");
await sleep(62_000);
ok(emptyNotFound(await exchange(hostA, expiring.ticket)), "ticket expiré (plus de 60 s) : 404 vide");
ok(emptyNotFound((await relayGet(A.kw, idA, hostA, "/hello", { cookie: bobS1A.cookie })).r), "accès retiré : le cookie de Bob donne 404 après la revérification");
ok((await relayGet(A.kw, idA, hostA, "/hello", { cookie: aliceLogin.cookie })).text === "site:GET:/hello:ok", "Alice, qui a toujours accès, passe la revérification");

// ---- blocking ------------------------------------------------------------------------------------------------------------

const ipBlock = "203.0.113.99";
ok((await px("GET", "/", { host: hostA, ip: ipBlock })).status === 200, "avant les refus, cette adresse passe avec les bonnes valeurs");
for (let i = 0; i < 49; i++) await px("GET", "/", { host: hostA, secret: "x".repeat(32), ip: ipBlock });
ok((await px("GET", "/", { host: hostA, ip: ipBlock })).status === 200, "49 refus : pas encore bloquée");
await px("GET", "/", { host: hostA, secret: "x".repeat(32), ip: ipBlock });
const blocked = await px("GET", "/", { host: hostA, ip: ipBlock });
ok(emptyNotFound(blocked) && shape(blocked) === shape(noSecret), "50 refus : l'adresse reçoit un 404 vide même avec de bonnes valeurs");
ok((await wsTry(hostA, { cookie: aliceLogin.cookie, ip: ipBlock })).status === 404, "… y compris pour une WebSocket");
ok(events().some((l) => l.includes("event=ip_blocked") && l.includes("scope=tunnel") && l.includes(`ip=${ipBlock}`) && l.includes("minutes=15")), "journal : event=ip_blocked");
ok(events().some((l) => l.includes("reason=blocked_ip") && l.includes(`ip=${ipBlock}`)), "journal : les refus suivants portent reason=blocked_ip");
ok((await px("GET", "/", { host: hostA, ip: "203.0.113.100" })).status === 200, "une autre adresse n'est pas touchée");

// Global alert: more than 300 refusals in a minute, from many addresses.
for (let i = 0; i < 320; i++) await px("GET", "/", { host: hostA, secret: "x".repeat(32), ip: `198.51.100.${(i % 200) + 1}` });
ok(events().some((l) => /event=tunnel_denied_burst count=\d+ window=60s$/.test(l)), "journal : event=tunnel_denied_burst au-delà de 300 refus par minute");

// ---- journal and answers -----------------------------------------------------------------------------------------------------
{
  const lines = events();
  const text = lines.join("\n");
  ok(lines.length > 50 && lines.every((l) => /^excalibash-security event=[a-z_]+( [a-z]+=[^ ]+)*$/.test(l)), `journal : une ligne stable par événement (${lines.length} lignes)`);
  ok(!text.includes(SECRET) && !text.includes(bobCookie.split("=")[1]!) && !text.includes(idA) && !text.includes(idB), "journal : ni secret, ni cookie, ni identifiant complet");
  ok(lines.some((l) => l.includes(`host=${idA.slice(0, 8)} `)), "journal : les 8 premiers caractères de l'id seulement");
  ok(lines.some((l) => l.includes("reason=no_session")) && lines.some((l) => l.includes("reason=bad_origin")), "journal : no_session et bad_origin");
  ok(!statuses.includes(444), `aucune réponse en 444 (${statuses.length} réponses vues)`);
  ok(statuses.every((s) => [101, 200, 204, 400, 404].includes(s)), "seuls 200, 204, 400 et 404 sont servis, jamais 401 ni 403");
}

site.close();
sa.ws.close();
agent.kill();
console.log(failures ? `\n${failures} ÉCHEC(S)` : "\nTOUT EST OK");
process.exit(failures ? 1 : 0);
