import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");

/** Non-negative number from the environment (HISTORY_* settings). */
function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name}=${raw} : nombre positif attendu`);
  return n;
}

const tlsMode = process.env.TLS || "auto";
if (tlsMode !== "auto" && tlsMode !== "off") throw new Error(`TLS=${tlsMode} : valeurs possibles auto ou off`);

/**
 * Subdomain mode for web tunnels: every tunnel gets its own origin https://<id>.<TUNNEL_DOMAIN>/,
 * reached through a reverse proxy that adds X-Tunnel-Host and X-Tunnel-Auth. Off without TUNNEL_DOMAIN.
 */
function tunnelConfig() {
  const domain = (process.env.TUNNEL_DOMAIN ?? "").trim().toLowerCase();
  const secret = process.env.TUNNEL_PROXY_SECRET ?? "";
  const scheme = process.env.TUNNEL_SCHEME || "https";
  if (scheme !== "https" && scheme !== "http") throw new Error(`TUNNEL_SCHEME=${scheme} : valeurs possibles https ou http`);
  const hours = numEnv("TUNNEL_SESSION_HOURS", 8);
  if (!domain) return { domain: "", secret: "", scheme, sessionHours: hours } as const;
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  if (domain.length > 200 || !new RegExp(`^${label}(?:\\.${label})*$`).test(domain)) throw new Error(`TUNNEL_DOMAIN=${domain} : nom DNS en minuscules attendu (ex. tunnel.example.com)`);
  if (secret.length < 32) throw new Error("TUNNEL_PROXY_SECRET : 32 caractères au moins sont obligatoires quand TUNNEL_DOMAIN est défini");
  if (hours <= 0) throw new Error("TUNNEL_SESSION_HOURS : un nombre d'heures strictement positif est attendu");
  if (!process.env.PUBLIC_URL) throw new Error("PUBLIC_URL : obligatoire quand TUNNEL_DOMAIN est défini (l'origine d'Excalibash ne peut pas se déduire des requêtes des tunnels)");
  return { domain, secret, scheme, sessionHours: hours } as const;
}

export const config = {
  port: Number(process.env.PORT ?? 6767),
  host: process.env.HOST ?? "0.0.0.0",
  dataDir: resolve(process.env.DATA_DIR ?? resolve(root, "data")),
  get dbPath() {
    return resolve(this.dataDir, "excalibash.db");
  },
  /** Built frontend served as static files. */
  webDir: resolve(process.env.WEB_DIR ?? resolve(root, "web", "dist")),
  /** Cross-compiled agent binaries offered for download. */
  agentDistDir: resolve(process.env.AGENT_DIST_DIR ?? resolve(root, "agent", "dist")),
  /** Bundled MCP client (excalibash-mcp.mjs) offered for download. */
  mcpDistDir: resolve(process.env.MCP_DIST_DIR ?? resolve(root, "mcp", "dist")),
  /** Minimum time between two agent update requests for one machine (ms). */
  updateIntervalMs: numEnv("UPDATE_INTERVAL_MS", 60_000),
  /** Public URL used in agent install commands (falls back to the request's host). */
  publicUrl: process.env.PUBLIC_URL ?? "",
  cookieSecure: process.env.COOKIE_SECURE === "true",
  /**
   * HTTPS on both ports. "auto": the certificate given by TLS_CERT/TLS_KEY, or a self-signed one
   * kept in DATA_DIR/tls. "off": plain HTTP, for a reverse proxy that does TLS itself.
   */
  tls: {
    mode: tlsMode,
    cert: process.env.TLS_CERT ?? "",
    key: process.env.TLS_KEY ?? "",
    /** Extra names or IPs for the self-signed certificate. */
    sans: (process.env.TLS_SANS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
  /**
   * Which proxies may set X-Forwarded-*: by default only local/private networks (a reverse proxy
   * on the host or in Docker), so internet clients cannot spoof their IP or the protocol.
   */
  trustProxy: process.env.TRUST_PROXY ?? "loopback, linklocal, uniquelocal",
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  /**
   * Web tunnels are served from a *separate origin* (another port, or PROXY_URL behind a reverse
   * proxy), so the proxied sites can never touch Excalibash's own storage and keys.
   */
  /**
   * Outgoing email (verification codes). Without SMTP_HOST, accounts are not email-verified.
   * SMTP_TRANSPORT=log prints emails to the server log instead (development and tests).
   */
  smtp: {
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true", // true for port 465
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.SMTP_FROM ?? "",
    transport: process.env.SMTP_TRANSPORT ?? "", // "log" for development
  },
  /** Public contact (abuse reports, privacy requests) shown on the privacy page. */
  contactEmail: process.env.CONTACT_EMAIL ?? "",
  /** Who runs this instance, shown on the privacy page. */
  legalName: process.env.LEGAL_NAME ?? "",
  /** Instance-wide cap on new accounts per hour (on top of per-IP limits). */
  registrationsPerHour: Number(process.env.REGISTRATIONS_PER_HOUR ?? 50),
  /** Code required to create the first (admin) account. Random and printed at startup when unset. */
  setupCode: process.env.SETUP_CODE ?? "",
  proxyPort: Number(process.env.PROXY_PORT ?? 6768),
  tunnel: tunnelConfig(),
  proxyUrl: process.env.PROXY_URL ?? "",
  /** Encrypted scrollback kept per terminal, replayed to new viewers. */
  scrollbackBytes: Number(process.env.SCROLLBACK_BYTES ?? 768 * 1024),
  /**
   * Board history: ciphertext snapshots of the scene, kept per board. `keep` = 0 turns it off.
   * `intervalMs` = 0 means no minimum delay between two versions (tests only).
   */
  history: {
    keep: numEnv("HISTORY_KEEP", 10),
    days: numEnv("HISTORY_DAYS", 7),
    maxBytes: numEnv("HISTORY_MAX_MB", 5) * 1024 * 1024,
    intervalMs: numEnv("HISTORY_INTERVAL_MIN", 15) * 60_000,
  },
};
