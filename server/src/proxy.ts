import { readFileSync } from "node:fs";
import { join } from "node:path";
import express, { type Request } from "express";
import { config } from "./config.ts";
import { rateLimit } from "./auth.ts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { attachTunnelSocket, relay, tunnelExists } from "./tunnels.ts";
import { certificatePem, serve, type Listener } from "./tls.ts";
import { isClientId } from "./validate.ts";

// Second origin for web tunnels. Tunnelled sites run here, isolated from Excalibash's own origin
// (its storage holds the account keys). This server only hands out the boot page and service
// worker, and relays encrypted frames; it holds no session and decrypts nothing.

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

const app = express();
app.set("trust proxy", config.trustProxy);
app.disable("x-powered-by");

app.get("/eb-proxy/sw.js", (req, res) => {
  res
    .type("application/javascript")
    .set({ "Service-Worker-Allowed": "/", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" })
    .send(SW.replace("__MAIN_ORIGIN__", mainOrigin(req)));
});

app.get("/eb-proxy/boot.js", (req, res) => {
  const cert = certificatePem() ? `${mainOrigin(req)}/certificate.pem` : "";
  res.type("application/javascript").set("Cache-Control", "no-cache").send(BOOT.replace("__MAIN_ORIGIN__", mainOrigin(req)).replace("__CERT_URL__", cert));
});

// Replaces WebSocket in tunnelled pages (the service worker adds the script tag): the sockets then
// travel sealed through the agent instead of reaching this origin directly.
app.get("/eb-proxy/ws-shim.js", (_req, res) => {
  res.type("application/javascript").set({ "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" }).send(WS_SHIM);
});

/** Rejects unknown tunnels and floods before reading the body: this origin has no authentication. */
function tunnelGuard(req: Request, res: express.Response, next: express.NextFunction) {
  const id = String(req.params.id);
  if (!rateLimit(`proxy:${req.ip}`, 2000)) {
    res.status(429).json({ error: "trop de requêtes" });
    return;
  }
  if (!isClientId(id) || !tunnelExists(id)) {
    res.status(404).json({ error: "tunnel inconnu" });
    return;
  }
  next();
}

app.post("/eb-proxy/req/:id", tunnelGuard, express.json({ limit: "64mb" }), async (req, res) => {
  const id = String(req.params.id);
  const { rid, ts, d } = req.body ?? {};
  if (typeof rid !== "string" || rid.length > 64 || !Number.isSafeInteger(ts) || typeof d !== "string") {
    res.status(400).json({ error: "requête invalide" });
    return;
  }
  const reply = await relay(id, rid, ts, d);
  if (reply === null) {
    res.status(504).json({ error: "machine hors ligne ou sans réponse" });
    return;
  }
  res.set("Cache-Control", "no-store").json({ d: reply });
});

// Anything else, before the service worker controls the page: the boot page.
app.get(/.*/, (req, res) => {
  res
    .type("html")
    .set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self' ${mainOrigin(req)}`,
      "Referrer-Policy": "no-referrer",
    })
    .send(bootHtml);
});

// Browser-side sockets of tunnelled sites. Like the HTTP relay this origin has no session: the
// tunnel id only routes the socket, and the agent drops anything not sealed with the tunnel key.
const socketWss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024 });

const LOCAL_PEER = /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd]|fe80|::ffff:(127|10|192\.168)\.)/i;

/** Address of the viewer; X-Forwarded-For counts only when a local reverse proxy relays it. */
function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "?";
  const fwd = req.headers["x-forwarded-for"];
  // The last entry is the one our proxy added; earlier ones come from the client and can be anything.
  if (config.trustProxy !== "false" && LOCAL_PEER.test(peer) && typeof fwd === "string") return fwd.split(",").at(-1)!.trim() || peer;
  return peer;
}

function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const reject = (code: number, text: string): void => {
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  };
  const m = new URL(req.url ?? "/", "http://x").pathname.match(/^\/eb-proxy\/ws\/([^/]+)$/);
  if (!m || !isClientId(m[1])) return reject(404, "Not Found");
  // Only pages of this very origin (the shim) may open one; a foreign page has no key anyway.
  const origin = req.headers.origin;
  try {
    if (origin && new URL(origin).host !== req.headers.host) return reject(403, "Forbidden");
  } catch {
    return reject(403, "Forbidden");
  }
  if (!rateLimit(`proxyws:${clientIp(req)}`, 600)) return reject(429, "Too Many Requests");
  const id = m[1]!;
  if (!tunnelExists(id)) return reject(404, "Not Found");
  socketWss.handleUpgrade(req, socket, head, (ws) => {
    try {
      attachTunnelSocket(ws, id);
    } catch (e) {
      console.error("[proxy ws]", e);
      ws.close(1011, "erreur serveur");
    }
  });
}

export function startProxy(): Listener {
  return serve(app, config.proxyPort, "Tunnels web (origine séparée)", upgrade);
}
