import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { rateLimit, readCookie } from "./auth.ts";
import { atLeast, isTrashed, roleOn } from "./access.ts";
import { clientNet } from "./http.ts";
import { logPath, securityEvent } from "./securityLog.ts";
import { checkTunnelSession, createTunnelSession, recheckSessions, redeemTicket, type TunnelSession } from "./tunnelSessions.ts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { attachTunnelSocket, relay, socketSessionKeys, tunnelBoard, tunnelExists } from "./tunnels.ts";
import { certificatePem, serve, type Listener } from "./tls.ts";
import { isClientId, isTunnelId } from "./validate.ts";

// Second origin for web tunnels. Tunnelled sites run here, isolated from Excalibash's own origin
// (its storage holds the account keys). This server hands out the boot page and service worker,
// and relays encrypted frames; it decrypts nothing.
//
// Two modes:
// - path mode (default): one origin for all tunnels, /t/<id>/…, no session on this origin;
// - subdomain mode (TUNNEL_DOMAIN): every tunnel has its own origin https://<id>.<TUNNEL_DOMAIN>/,
//   behind a reverse proxy that adds X-Tunnel-Host and X-Tunnel-Auth. The relay then also needs a
//   cookie session obtained with a one-time ticket from Excalibash (see tunnelSessions.ts).

/** Excalibash's own origin, the only one allowed to hand tunnel keys to this origin. */
export function mainOrigin(req: Request): string {
  if (config.publicUrl) return new URL(config.publicUrl).origin;
  return `${req.protocol}://${hostOf(req)}:${config.port}`;
}

/** Public URL of the proxy origin, as seen from Excalibash's own origin. */
export function proxyUrl(req: Request): string {
  if (config.proxyUrl) return config.proxyUrl.replace(/\/$/, "");
  return `${req.protocol}://${hostOf(req)}:${config.proxyPort}`;
}

/**
 * The Host of a request when no URL is configured. It ends up inside served JavaScript and CSP
 * headers: anything but a plain name or address becomes "localhost" (no quote, no space, no $).
 */
function hostOf(req: Request): string {
  const h = req.hostname ?? "";
  return /^[a-z0-9.-]{1,253}$/i.test(h) || /^\[[0-9a-f:.]{2,45}\]$/i.test(h) ? h : "localhost";
}

const asset = (name: string) => readFileSync(join(import.meta.dirname, "proxy", name), "utf8");
const SW = asset("sw.js");
const BOOT = asset("boot.js");
const WS_SHIM = asset("ws-shim.js");

const bootHtml = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Excalibash · tunnel</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0b1020;color:#e2e8f0;font:600 14px system-ui,sans-serif}p{max-width:36em;padding:0 16px;text-align:center}</style>
</head><body><p id="status">Chargement…</p><script src="/eb-proxy/boot.js"></script></body></html>`;

/** The tunnel id is injected by the server (subdomain mode), never read from the URL; empty in path mode. */
const swScript = (req: Request, tunnelId: string) => SW.replace("__MAIN_ORIGIN__", () => mainOrigin(req)).replace("__TUNNEL_ID__", () => tunnelId);

function sendSw(req: Request, res: Response, tunnelId: string): void {
  res
    .type("application/javascript")
    .set({ "Service-Worker-Allowed": "/", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" })
    .send(swScript(req, tunnelId));
}

function sendBoot(req: Request, res: Response, tunnelId: string): void {
  const cert = certificatePem() ? `${mainOrigin(req)}/certificate.pem` : "";
  res
    .type("application/javascript")
    .set("Cache-Control", "no-cache")
    .send(BOOT.replace("__MAIN_ORIGIN__", () => mainOrigin(req)).replace("__CERT_URL__", () => cert).replace("__TUNNEL_ID__", () => tunnelId));
}

// Replaces WebSocket in tunnelled pages (the service worker adds the script tag): the sockets then
// travel sealed through the agent instead of reaching this origin directly.
function sendShim(res: Response): void {
  res.type("application/javascript").set({ "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" }).send(WS_SHIM);
}

function sendBootPage(req: Request, res: Response): void {
  res
    .type("html")
    .set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self' ${mainOrigin(req)}`,
      "Referrer-Policy": "no-referrer",
    })
    .send(bootHtml);
}

type RelayBody = { rid?: unknown; ts?: unknown; d?: unknown };

/** Forwards one sealed request to the agent and answers with the sealed reply. */
async function relayRequest(id: string, body: RelayBody | undefined, res: Response): Promise<void> {
  const { rid, ts, d } = body ?? {};
  if (typeof rid !== "string" || rid.length > 64 || !Number.isSafeInteger(ts) || typeof d !== "string") {
    res.status(400).json({ error: "requête invalide" });
    return;
  }
  const reply = await relay(id, rid, ts as number, d);
  if (reply === null) {
    res.status(504).json({ error: "machine hors ligne ou sans réponse" });
    return;
  }
  res.set("Cache-Control", "no-store").json({ d: reply });
}

// ---- Refusals: journal, counters, IP blocking -------------------------------------------------

type Reason = "bad_secret" | "bad_host" | "unknown_tunnel" | "no_session" | "bad_origin" | "blocked_ip";

const BLOCK_AFTER = 50; // refusals…
const BLOCK_WINDOW_MS = 10 * 60_000; // …within this window block the address…
const BLOCK_MS = 15 * 60_000; // …for this long
const BURST_PER_MINUTE = 300;
const MAX_TRACKED_IPS = 50_000;

const denials = new Map<string, { n: number; reset: number }>();
const blockedUntil = new Map<string, number>();
let burst = { start: 0, n: 0, alerted: false };

// Refusals that say someone is probing. A missing session is also what an expired page looks like
// (server restart, long idle tab): journaled, but never a reason to block an address.
const COUNTED = new Set<Reason>(["bad_secret", "bad_host", "unknown_tunnel", "bad_origin"]);

const isBlocked = (ip: string): boolean => (blockedUntil.get(ip) ?? 0) > Date.now();

/**
 * Journals one refusal and counts it: per address (50 in 10 minutes block the address for 15, when
 * `block` is on) and overall (one alert line per minute above 300). Refusals of an already blocked
 * address are journaled but not counted again.
 */
function refuse(ip: string, reason: Reason, id: string | undefined, path: string, block: boolean): void {
  securityEvent("tunnel_denied", { reason, ip, host: id ? id.slice(0, 8) : "-", path: logPath(path) });
  const now = Date.now();
  if (now - burst.start >= 60_000) burst = { start: now, n: 0, alerted: false };
  burst.n++;
  if (burst.n > BURST_PER_MINUTE && !burst.alerted) {
    burst.alerted = true;
    securityEvent("tunnel_denied_burst", { count: burst.n, window: "60s" });
  }
  if (!block || !COUNTED.has(reason)) return;
  let d = denials.get(ip);
  if (!d || d.reset <= now) {
    if (!d && denials.size >= MAX_TRACKED_IPS) denials.delete(denials.keys().next().value!);
    d = { n: 0, reset: now + BLOCK_WINDOW_MS };
    denials.set(ip, d);
  }
  if (++d.n >= BLOCK_AFTER) {
    denials.delete(ip);
    blockedUntil.set(ip, now + BLOCK_MS);
    securityEvent("ip_blocked", { scope: "tunnel", ip, minutes: BLOCK_MS / 60_000 });
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, d] of denials) if (d.reset <= now) denials.delete(k);
  for (const [k, t] of blockedUntil) if (t <= now) blockedUntil.delete(k);
}, 60_000).unref();

const LOCAL_PEER = /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd]|fe80|::ffff:(127|10|192\.168)\.)/i;

/** Address of the viewer; X-Forwarded-For counts only when a local reverse proxy relays it. */
function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "?";
  const fwd = req.headers["x-forwarded-for"];
  // The last entry is the one our proxy added; earlier ones come from the client and can be anything.
  if (config.trustProxy !== "false" && LOCAL_PEER.test(peer) && typeof fwd === "string") return fwd.split(",").at(-1)!.trim() || peer;
  return peer;
}

// ---- Subdomain mode: who may reach which tunnel ---------------------------------------------

const SECRET_DIGEST = createHash("sha256").update(config.tunnel.secret).digest();
const TUNNEL_COOKIE = "__Host-eb_tunnel";

/** Constant time on the SHA-256 of both values: neither content nor length leaks. */
function secretOk(v: unknown): boolean {
  return typeof v === "string" && timingSafeEqual(createHash("sha256").update(v).digest(), SECRET_DIGEST);
}

/** The tunnel a reverse proxy says this request is for: X-Tunnel-Host only, never Host. */
function tunnelOfHost(v: unknown): { id: string; host: string } | Reason {
  if (typeof v !== "string") return "bad_host";
  const host = v.toLowerCase();
  const m = /^([a-z0-9.-]{1,253})(?::\d{1,5})?$/.exec(host);
  const name = m?.[1];
  const suffix = `.${config.tunnel.domain}`;
  if (!name || !name.endsWith(suffix)) return "bad_host";
  const id = name.slice(0, -suffix.length);
  if (!isTunnelId(id)) return "bad_host";
  return tunnelExists(id) ? { id, host } : "unknown_tunnel";
}

/** Origin of this tunnel as a browser writes it (port only when the reverse proxy passes one). */
const originOf = (host: string) => `${config.tunnel.scheme}://${host}`;

/** Does this account still reach this tunnel? Asked again once a minute. */
function stillAllowed(s: TunnelSession): boolean {
  const boardId = tunnelBoard(s.tunnelId);
  if (!boardId || isTrashed(boardId) || !atLeast(roleOn(s.userId, boardId), "viewer")) return false;
  // The Excalibash session that opened it must still be alive, for an account that is not suspended.
  const row = db
    .prepare("SELECT 1 AS x FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ? AND u.suspended = 0")
    .get(s.sessionHash, s.userId, Date.now());
  return !!row;
}

// A socket stays open for as long as the page does: sessions that hold one are re-checked too.
if (config.tunnel.domain) setInterval(() => recheckSessions(socketSessionKeys(), stillAllowed), 60_000).unref();

type Tunnel = { id: string; host: string };
type HostRequest = Request & { tunnel?: Tunnel };

function hostApp(): express.Express {
  const app = express();
  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");

  /** The same answer for every refusal: nothing tells a wrong secret from an unknown tunnel. */
  const deny = (req: HostRequest, res: Response, reason: Reason, id?: string): void => {
    refuse(clientNet(req.ip ?? "?"), reason, id ?? req.tunnel?.id, req.path, true);
    res.status(404).set("Cache-Control", "no-store").end();
  };

  // Everything below needs the reverse proxy's secret and an existing tunnel; only then are headers and cookies read.
  app.use((req: HostRequest, res, next) => {
    if (isBlocked(clientNet(req.ip ?? "?"))) return deny(req, res, "blocked_ip");
    if (!secretOk(req.headers["x-tunnel-auth"])) return deny(req, res, "bad_secret");
    const t = tunnelOfHost(req.headers["x-tunnel-host"]);
    if (typeof t === "string") return deny(req, res, t);
    req.tunnel = t;
    if (!rateLimit(`proxy:${clientNet(req.ip ?? "?")}`, 2000) || !rateLimit(`proxyid:${t.id}`, 6000)) {
      res.status(429).json({ error: "trop de requêtes" });
      return;
    }
    next();
  });

  /** Relay and session exchange come from the tunnel's own page, with this tunnel's origin. */
  const sameOrigin = (req: HostRequest): boolean => req.headers.origin === originOf(req.tunnel!.host);
  const session = (req: HostRequest) => checkTunnelSession(readCookie(req.headers.cookie, TUNNEL_COOKIE), req.tunnel!.id, stillAllowed);

  app.get("/eb-proxy/sw.js", (req: HostRequest, res) => sendSw(req, res, req.tunnel!.id));
  app.get("/eb-proxy/boot.js", (req: HostRequest, res) => sendBoot(req, res, req.tunnel!.id));
  app.get("/eb-proxy/ws-shim.js", (_req, res) => sendShim(res));

  // Ticket (from Excalibash, one use) → cookie session for this tunnel.
  app.post("/eb-proxy/session", express.json({ limit: "4kb" }), (req: HostRequest, res) => {
    if (!sameOrigin(req)) return deny(req, res, "bad_origin");
    const ticket = redeemTicket(req.body?.ticket, req.tunnel!.id);
    if (!ticket || !stillAllowed({ ...ticket, key: "", checkedAt: 0 })) return deny(req, res, "no_session");
    const token = createTunnelSession(ticket);
    res
      .status(204)
      .set({
        "Cache-Control": "no-store",
        "Set-Cookie": `${TUNNEL_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.round(config.tunnel.sessionHours * 3600)}`,
      })
      .end();
  });

  const relayGate = (req: HostRequest, res: Response, next: NextFunction) => {
    if (req.params.id !== req.tunnel!.id) return deny(req, res, "bad_host");
    if (!sameOrigin(req)) return deny(req, res, "bad_origin");
    if (!session(req)) return deny(req, res, "no_session");
    next();
  };
  app.post("/eb-proxy/req/:id", relayGate, express.json({ limit: "64mb" }), (req, res) => relayRequest((req as HostRequest).tunnel!.id, req.body, res));

  // Anything else, before the service worker controls the page: the boot page.
  app.get(/.*/, sendBootPage);
  app.use((req, res) => deny(req as HostRequest, res, "bad_host"));
  app.use((err: any, req: HostRequest, res: Response, _next: NextFunction) => {
    // A body the relay could not read is the page's fault; anything else gives away nothing.
    if (req.tunnel && err?.status >= 400 && err?.status < 500) res.status(err.status).json({ error: "requête invalide" });
    else res.status(404).set("Cache-Control", "no-store").end();
  });
  return app;
}

const NOT_FOUND = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

// ---- Browser-side sockets of tunnelled sites ----------------------------------------------------
//
// Like the HTTP relay, the tunnel id only routes the socket, and the agent drops anything not sealed
// with the tunnel key. In subdomain mode the socket also needs a tunnel session.
const socketWss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });

function pathUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const ip = clientNet(clientIp(req));
  const reject = (code: number, text: string): void => {
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  };
  const path = (req.url ?? "/").split("?")[0]!;
  const m = new URL(req.url ?? "/", "http://x").pathname.match(/^\/eb-proxy\/ws\/([^/]+)$/);
  if (!m || !isClientId(m[1])) {
    refuse(ip, "bad_host", undefined, path, false);
    return reject(404, "Not Found");
  }
  const id = m[1]!;
  // Only pages of this very origin (the shim) may open one; a foreign page has no key anyway.
  const origin = req.headers.origin;
  try {
    if (origin && new URL(origin).host !== req.headers.host) {
      refuse(ip, "bad_origin", id, path, false);
      return reject(403, "Forbidden");
    }
  } catch {
    refuse(ip, "bad_origin", id, path, false);
    return reject(403, "Forbidden");
  }
  if (!rateLimit(`proxyws:${clientIp(req)}`, 600)) return reject(429, "Too Many Requests");
  if (!tunnelExists(id)) {
    refuse(ip, "unknown_tunnel", id, path, false);
    return reject(404, "Not Found");
  }
  if (!rateLimit(`proxyid:${id}`, 6000)) return reject(429, "Too Many Requests");
  socketWss.handleUpgrade(req, socket, head, (ws) => {
    try {
      attachTunnelSocket(ws, id);
    } catch (e) {
      console.error("[proxy ws]", e);
      ws.close(1011, "erreur serveur");
    }
  });
}

function hostUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const ip = clientNet(clientIp(req));
  const path = (req.url ?? "/").split("?")[0]!;
  const deny = (reason: Reason, id?: string): void => {
    refuse(ip, reason, id, path, true);
    socket.end(NOT_FOUND);
  };
  if (isBlocked(ip)) return deny("blocked_ip");
  if (!secretOk(req.headers["x-tunnel-auth"])) return deny("bad_secret");
  const t = tunnelOfHost(req.headers["x-tunnel-host"]);
  if (typeof t === "string") return deny(t);
  if (!rateLimit(`proxyws:${clientIp(req)}`, 600) || !rateLimit(`proxyid:${t.id}`, 6000)) return void socket.end("HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  let pathname = "";
  try {
    pathname = new URL(req.url ?? "/", "http://x").pathname;
  } catch {
    return deny("bad_host", t.id);
  }
  if (pathname !== `/eb-proxy/ws/${t.id}`) return deny("bad_host", t.id);
  if (req.headers.origin !== originOf(t.host)) return deny("bad_origin", t.id);
  const s = checkTunnelSession(readCookie(req.headers.cookie, TUNNEL_COOKIE), t.id, stillAllowed);
  if (!s) return deny("no_session", t.id);
  socketWss.handleUpgrade(req, socket, head, (ws) => {
    try {
      attachTunnelSocket(ws, t.id, s.key);
    } catch (e) {
      console.error("[proxy ws]", e);
      ws.close(1011, "erreur serveur");
    }
  });
}

// ---- Path mode ------------------------------------------------------------------------------------

function pathApp(): express.Express {
  const app = express();
  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");

  app.get("/eb-proxy/sw.js", (req, res) => sendSw(req, res, ""));
  app.get("/eb-proxy/boot.js", (req, res) => sendBoot(req, res, ""));
  app.get("/eb-proxy/ws-shim.js", (_req, res) => sendShim(res));

  /** Rejects unknown tunnels and floods before reading the body: this origin has no authentication. */
  function tunnelGuard(req: Request, res: express.Response, next: express.NextFunction) {
    const id = String(req.params.id);
    if (!rateLimit(`proxy:${req.ip}`, 2000)) {
      res.status(429).json({ error: "trop de requêtes" });
      return;
    }
    if (!isClientId(id) || !tunnelExists(id)) {
      refuse(clientNet(req.ip ?? "?"), isClientId(id) ? "unknown_tunnel" : "bad_host", isClientId(id) ? id : undefined, req.path, false);
      res.status(404).json({ error: "tunnel inconnu" });
      return;
    }
    if (!rateLimit(`proxyid:${id}`, 6000)) {
      res.status(429).json({ error: "trop de requêtes" });
      return;
    }
    next();
  }

  app.post("/eb-proxy/req/:id", tunnelGuard, express.json({ limit: "64mb" }), (req, res) => relayRequest(String(req.params.id), req.body, res));

  // Anything else, before the service worker controls the page: the boot page.
  app.get(/.*/, sendBootPage);
  return app;
}

export function startProxy(): Listener {
  return config.tunnel.domain
    ? serve(hostApp(), config.proxyPort, `Tunnels web (un sous-domaine par tunnel, *.${config.tunnel.domain})`, hostUpgrade)
    : serve(pathApp(), config.proxyPort, "Tunnels web (origine séparée)", pathUpgrade);
}
