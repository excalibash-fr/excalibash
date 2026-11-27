import { isIPv6 } from "node:net";
import type { Request } from "express";
import { config } from "./config.ts";
import { knownHostnames } from "./tls.ts";
import type { MailLink } from "./mailTemplate.ts";
import { isB64Url } from "./validate.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Opaque client-produced blob (ciphertext, key, wrapped key): must be a non-empty base64url string. */
export function blob(v: unknown, max = 8192): string {
  if (!isB64Url(v, max)) throw new HttpError(400, "Données chiffrées invalides");
  return v;
}

export const pid = (req: Request, name = "id"): string => String(req.params[name]);

export function publicUrl(req: Request): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

let warnedHost = false;

/**
 * A link for an email sent to someone else. Without PUBLIC_URL the address comes from the Host
 * header, which the sender controls: only a name this instance knows as its own is used, otherwise
 * the email goes without the link (a forged Host would send the recipient elsewhere).
 */
export function mailLink(req: Request, path: string, label: string): MailLink | undefined {
  if (config.publicUrl) return { label, url: config.publicUrl.replace(/\/$/, "") + path };
  const host = req.hostname?.replace(/^\[|\]$/g, "").toLowerCase();
  // The URL is built from the very value checked (req.host follows X-Forwarded-Host like req.hostname).
  if (host && knownHostnames().map((n) => n.toLowerCase()).includes(host)) return { label, url: `${req.protocol}://${req.host}${path}` };
  if (!warnedHost) {
    warnedHost = true;
    console.warn(`[mail] hôte « ${host} » inconnu : liens retirés des emails. Définir PUBLIC_URL.`);
  }
  return undefined;
}

/** "2001:db8:1:2:a:b:c:d" → "2001:db8:1:2::" (still an address, for ipPrefix and the logs). */
function ipv6Net64(ip: string): string {
  const [head, tail = ""] = ip.split("%")[0]!.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).join(":") + "::";
}

/** The address rate limits count: IPv6 clients are grouped by /64 (one subscriber usually holds a whole one). */
export const clientNet = (ip: string): string => (isIPv6(ip) && !/^::ffff:/i.test(ip) ? ipv6Net64(ip) : ip);
