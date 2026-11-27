import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { config } from "./config.ts";
import { currentSessionHash, pruneSessions, userFromRequest } from "./auth.ts";
import { HttpError, publicUrl, clientNet } from "./http.ts";
import { announceSetup, authApi } from "./api/auth.ts";
import { itemsApi } from "./api/items.ts";
import { publicApi } from "./api/links.ts";
import { machinesApi } from "./api/machines.ts";
import { adminApi } from "./api/admin.ts";
import { getItem, isTrashed, roleOn } from "./access.ts";
import { joinBoard, flushAllRooms } from "./rooms.ts";
import { authenticateAgent, handleAgent } from "./terminals.ts";
import { installScript, uninstallScript, updateScript } from "./install.ts";
import { pairScript, pairingAgentApi, pairingOwnerApi } from "./api/pairing.ts";
import { accountApi } from "./api/account.ts";
import { tunnelsApi } from "./api/tunnels.ts";
import { proxyUrl, startProxy } from "./proxy.ts";
import { MANIFEST_FILE, latestRelease } from "./agentUpdate.ts";
import { certificatePem, initTls, pinFor, serve, tlsInfo } from "./tls.ts";

initTls();

const CSP = [
  "default-src 'self'",
  // Argon2 runs as WebAssembly.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Installing a library from libraries.excalidraw.com fetches it from there (explicit user action).
  "connect-src 'self' https://libraries.excalidraw.com",
  "worker-src 'self' blob:",
  // Excalidraw's own embeds (YouTube, Figma…) are third-party iframes; web tunnels use the proxy origin.
  "frame-src 'self' https: __PROXY__",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Where tunnelled sites may be framed from: any tunnel subdomain, or the single proxy origin. */
function tunnelFrameSource(req: Request): string {
  const { domain, scheme } = config.tunnel;
  if (domain) return `${scheme}://*.${domain}${scheme === "http" ? ":*" : ""}`;
  return new URL(proxyUrl(req)).origin;
}

const app = express();
app.set("trust proxy", config.trustProxy);
app.disable("x-powered-by");
// Rate limits key on req.ip. One IPv6 subscriber usually holds a whole /64: counted as one address.
app.use((req, _res, next) => {
  if (req.ip) Object.defineProperty(req, "ip", { value: clientNet(req.ip) });
  next();
});
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy": CSP.replace("__PROXY__", tunnelFrameSource(req)),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  // Public links are for the people they were given to, not for search engines.
  if (req.path.startsWith("/v/")) res.set("X-Robots-Tag", "noindex, nofollow");
  if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000");
  next();
});

// The API answers with personal data: never in a cache. Changes must come from this origin's own
// pages: SameSite=Strict lets the tunnel origin (same site, another port) send the cookie, so a
// browser that says where a request comes from (Sec-Fetch-Site) is checked. Agents and the MCP
// client send no such header.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const site = req.get("sec-fetch-site");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && site && site !== "same-origin" && site !== "none") {
    res.status(403).json({ error: "Requête refusée : elle ne vient pas d'Excalibash" });
    return;
  }
  next();
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});
app.get("/api/config", (req, res) => {
  res.json({
    proxyUrl: proxyUrl(req),
    tunnelDomain: config.tunnel.domain || null,
    tunnelScheme: config.tunnel.scheme,
    emailVerification: !!(config.smtp.host || config.smtp.transport === "log"),
    contactEmail: config.contactEmail || null,
    legalName: config.legalName || null,
    tls: tlsInfo(req),
  });
});
// Small bodies before authentication; large ones (board content, key rotation) only for signed-in users.
// Without a JSON content type, req.body stays undefined: routes read fields from it, so give them {}.
const withBody = (req: Request, _res: Response, next: NextFunction) => {
  req.body ??= {};
  next();
};
const small = [express.json({ limit: "256kb" }), withBody];
const large = [express.json({ limit: "200mb" }), withBody];
// Public metadata: the newest published agent release (the agents check its signature themselves).
app.get("/api/agent/latest", (_req, res) => {
  res.set("Cache-Control", "no-store").json(latestRelease());
});
app.use("/api/auth", small, authApi);
app.use("/api/machines/pairings", small, pairingOwnerApi);
app.use("/api/machines", small, machinesApi);
app.use("/api/pair", small, pairingAgentApi);
app.use("/api/admin", small, adminApi);
app.use("/api/account", small, accountApi);
app.use("/api/tunnels", small, tunnelsApi);
app.use("/api/public", publicApi);
app.use("/api", (req, res, next) => (userFromRequest(req) ? large : small)[0]!(req, res, next), withBody, itemsApi);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Introuvable" });
});
app.use("/api", (err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: "Contenu trop volumineux" });
    return;
  }
  // Malformed JSON, a bad escape in the URL…: the client's fault, not worth a stack trace.
  if (err?.status >= 400 && err?.status < 500) {
    res.status(err.status).json({ error: "Requête invalide" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Erreur serveur" });
});

const AGENT_FILE = /^excalibash-agent-(linux|darwin)-(amd64|arm64)$/;
const MCP_FILE = /^excalibash-mcp\.mjs$/;

/** Directory a downloadable file lives in, by strict filename match (no path traversal possible). */
function downloadDir(file: string): string | null {
  if (AGENT_FILE.test(file) || MANIFEST_FILE.test(file)) return config.agentDistDir;
  if (MCP_FILE.test(file)) return config.mcpDistDir;
  return null;
}

app.get("/p/:code", (req, res) => {
  res.type("text/x-shellscript").set("Cache-Control", "no-store").send(pairScript(publicUrl(req), String(req.params.code), pinFor(req)));
});

app.get("/uninstall.sh", (_req, res) => {
  res.type("text/x-shellscript").set("Cache-Control", "no-store").send(uninstallScript());
});

app.get("/update.sh", (req, res) => {
  res.type("text/x-shellscript").set("Cache-Control", "no-store").send(updateScript(publicUrl(req), pinFor(req)));
});
app.get("/install.sh", (req, res) => {
  res.type("text/x-shellscript").set("Cache-Control", "no-store").send(installScript(publicUrl(req), pinFor(req)));
});

app.get("/certificate.pem", (_req, res) => {
  const pem = certificatePem();
  if (!pem) {
    res.status(404).send("not found\n");
    return;
  }
  res.attachment("excalibash.pem").type("application/x-pem-file").send(Buffer.from(pem));
});

app.get("/downloads", (_req, res) => {
  const list = (dir: string, re: RegExp) => (existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)) : []);
  res.json({ files: [...list(config.agentDistDir, AGENT_FILE), ...list(config.agentDistDir, MANIFEST_FILE), ...list(config.mcpDistDir, MCP_FILE)] });
});

app.get("/downloads/:file", (req, res) => {
  const file = req.params.file;
  const dir = downloadDir(file);
  if (!dir || !existsSync(join(dir, file))) {
    res.status(404).send("not found\n");
    return;
  }
  res.download(join(dir, file));
});

if (existsSync(config.webDir)) {
  app.use(express.static(config.webDir, { index: false, maxAge: "1h" }));
  app.get(/^\/(?!api\/|ws|agent).*/, (_req, res) => {
    res.set("Cache-Control", "no-cache").sendFile(join(config.webDir, "index.html"));
  });
} else {
  console.warn(`[web] ${config.webDir} absent — lance le frontend avec \`npm run dev\` dans web/`);
}

const boardWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
// Web tunnel responses (up to ~48 MB of body, base64) travel on the agent socket.
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 72 * 1024 * 1024 });

/** Once a socket is upgraded, an error setting it up closes it as a WebSocket (no HTTP reply any more). */
function onSocket(ws: WebSocket, setup: () => void): void {
  try {
    setup();
  } catch (e) {
    console.error("[ws]", e);
    ws.close(1011, "erreur serveur");
  }
}

function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? "/", "http://x");
  const reject = (code: number, text: string) => {
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
  };

  if (url.pathname === "/agent") {
    const machineId = authenticateAgent(req);
    if (!machineId) return reject(401, "Unauthorized");
    agentWss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, () => handleAgent(ws, machineId)));
    return;
  }

  if (url.pathname === "/ws") {
    // Cookies are SameSite=Strict, but a cross-site page could still open a socket: check the origin.
    const origin = req.headers.origin;
    let sameOrigin = true;
    try {
      sameOrigin = !origin || new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false; // "null" or garbage
    }
    if (!sameOrigin) return reject(403, "Forbidden");
    const user = userFromRequest(req);
    if (!user) return reject(401, "Unauthorized");
    const item = getItem(url.searchParams.get("board") ?? "");
    const role = item ? roleOn(user.id, item.id) : undefined;
    if (!item || item.kind !== "board" || !role || isTrashed(item.id)) return reject(403, "Forbidden");
    boardWss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, () => joinBoard(ws, user, item.id, role, currentSessionHash(req))));
    return;
  }

  reject(404, "Not Found");
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Arrêt…");
  flushAllRooms();
  server.close();
  proxy.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

setInterval(pruneSessions, 3600_000).unref();

// Last resort: one bad message or timer must not take every board, terminal and tunnel down with it.
// Handlers catch what they expect; this only logs what slipped through.
process.on("uncaughtException", (e) => console.error("[fatal évité]", e));
process.on("unhandledRejection", (e) => console.error("[promesse rejetée]", e));

const server = serve(app, config.port, "Excalibash", upgrade);
const proxy = startProxy();
announceSetup();
