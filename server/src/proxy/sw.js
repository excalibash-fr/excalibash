// Excalibash web-tunnel service worker (runs on the proxy origin, never on Excalibash's own).
// Every request of a tunnelled site is encrypted here with the tunnel key, relayed by the server
// to the agent, and the encrypted answer is decrypted back here. The server sees neither.
/* global self, clients, indexedDB, crypto */
"use strict";

const MAIN_ORIGIN = "__MAIN_ORIGIN__";
const ID = /^[A-Za-z0-9_-]{16,43}$/;
// Subdomain mode: the tunnel of this origin, set by the server from the verified host (empty in path mode,
// where the id is the first segment of /t/<id>/…). The site then lives at the root, with its real paths.
const HOST_ID = "__TUNNEL_ID__";
const mount = (id) => (HOST_ID ? "" : "/t/" + id);
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- tiny crypto (same formats as the app: box = 0x01 ‖ iv ‖ AES-256-GCM) -------------

const b64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function box(key, pt, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, pt));
  const out = new Uint8Array(13 + ct.length);
  out[0] = 1;
  out.set(iv, 1);
  out.set(ct, 13);
  return b64(out);
}

async function unbox(key, data, aad) {
  const b = unb64(data);
  if (b[0] !== 1) throw new Error("bad box");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(1, 13), additionalData: enc.encode(aad) }, key, b.subarray(13)));
}

// ---- tunnel keys and cookie jars (IndexedDB of the proxy origin) ----------------------

const db = new Promise((resolve, reject) => {
  const r = indexedDB.open("excalibash-proxy", 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore("tunnels");
    r.result.createObjectStore("cookies");
  };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const idb = async (store, mode, fn) => {
  const d = await db;
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

const tunnels = new Map(); // id -> { key: CryptoKey, target: URL }

async function getTunnel(id) {
  if (tunnels.has(id)) return tunnels.get(id);
  const saved = await idb("tunnels", "readonly", (s) => s.get(id));
  if (!saved) return null;
  // Stored as a non-extractable CryptoKey (a raw string from an older worker is imported, then replaced).
  let key = saved.key;
  if (typeof key === "string") {
    key = await importTunnelKey(key);
    await idb("tunnels", "readwrite", (s) => s.put({ key, target: saved.target }, id));
  }
  const t = { key, target: new URL(saved.target) };
  tunnels.set(id, t);
  return t;
}

async function cookiesOf(id) {
  return (await idb("cookies", "readonly", (s) => s.get(id))) || {};
}

async function storeCookies(id, setCookies) {
  if (!setCookies.length) return;
  const jar = await cookiesOf(id);
  for (const line of setCookies) {
    const [pair, ...attrs] = line.split(";");
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const expired = attrs.some((a) => {
      const [k, v] = a.trim().split("=");
      if (/^max-age$/i.test(k)) return Number(v) <= 0;
      if (/^expires$/i.test(k)) return Date.parse(v) < Date.now();
      return false;
    });
    if (expired) delete jar[name];
    else jar[name] = value;
  }
  await idb("cookies", "readwrite", (s) => s.put(jar, id));
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Every tunnelled site shares this origin, so its pages can open this IndexedDB. Keys are kept as
// non-extractable CryptoKeys: a page can't read one out to use it elsewhere (see SECURITY.md).
const importTunnelKey = (raw) => crypto.subtle.importKey("raw", unb64(raw), "AES-GCM", false, ["encrypt", "decrypt"]);

/** The tunnel a client (page) belongs to, from its URL: /t/<id>/… */
const tunnelOfClient = (client) => (client && client.url ? prefixed(new URL(client.url))?.id : undefined);

// Keys arrive from the boot page, which got them from Excalibash by postMessage. Only a page of that
// very tunnel may set its key: a site in another tunnel can't swap it for one of its own.
self.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.type !== "key" || !ID.test(m.tunnelId) || typeof m.key !== "string" || typeof m.target !== "string") return;
  if (tunnelOfClient(e.source) !== m.tunnelId) return;
  e.waitUntil(
    (async () => {
      let key;
      try {
        key = await importTunnelKey(m.key);
        new URL(m.target);
      } catch {
        return;
      }
      await idb("tunnels", "readwrite", (s) => s.put({ key, target: m.target }, m.tunnelId));
      tunnels.delete(m.tunnelId);
      e.source && e.source.postMessage({ type: "key-ok", tunnelId: m.tunnelId });
    })(),
  );
});

// ---- routing ----------------------------------------------------------------------------

const clientTunnel = new Map(); // clientId -> tunnel id

function prefixed(url) {
  if (HOST_ID) return { id: HOST_ID, path: url.pathname + url.search, unprefixed: true };
  const m = url.pathname.match(/^\/t\/([^/]+)(\/.*)?$/);
  return m && ID.test(m[1]) ? { id: m[1], path: (m[2] || "/") + url.search } : null;
}

async function tunnelOf(e, url) {
  const p = prefixed(url);
  if (p) return p;
  // An absolute path used by the site: it belongs to the tunnel of the page that asked.
  let id = e.clientId && clientTunnel.get(e.clientId);
  if (!id && e.clientId) {
    const c = await self.clients.get(e.clientId);
    if (c) id = prefixed(new URL(c.url))?.id;
  }
  if (!id && e.request.referrer) id = prefixed(new URL(e.request.referrer))?.id;
  return id ? { id, path: url.pathname + url.search, unprefixed: true } : null;
}

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding", "cookie"]);

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/eb-proxy/")) return;
  e.respondWith(handle(e, url));
});

async function handle(e, url) {
  const route = await tunnelOf(e, url);
  if (!route) return fetch(e.request); // boot page
  // A page of one tunnel may only reach its own: a site in tunnel A must not drive tunnel B with B's
  // key (cookies included). Navigations have no client yet and are checked by their referrer.
  const ref = e.request.referrer ? new URL(e.request.referrer) : null;
  const from = e.clientId ? tunnelOfClient(await self.clients.get(e.clientId)) : ref && ref.origin === self.location.origin ? prefixed(ref)?.id : undefined;
  if (from && from !== route.id) return new Response("Accès à un autre tunnel refusé.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  const t = await getTunnel(route.id);
  // Paths under /t/<id>/ are relative to the target's path (the agent prepends it): an absolute path of the site
  // that already starts with it loses it, else a target http://host/app would get /app/app/….
  if (route.unprefixed && t) route.path = underBase(route.path, t.target);
  // Keep navigations under /t/<id>/ so every page knows its tunnel.
  if (route.unprefixed && !HOST_ID && e.request.mode === "navigate") return Response.redirect(`/t/${route.id}${route.path}`, 302);
  if (!t) return fetch(e.request); // no key yet: the boot page will fetch it
  if (e.request.mode === "navigate" && e.resultingClientId) clientTunnel.set(e.resultingClientId, route.id);

  const headers = {};
  for (const [k, v] of e.request.headers) if (!HOP.has(k)) headers[k] = [v];
  const jar = await cookiesOf(route.id);
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  if (cookie) headers.cookie = [cookie];
  // The site sees itself, not the proxy origin.
  if (headers.origin) headers.origin = [t.target.origin];
  const own = self.location.origin + mount(route.id);
  if (headers.referer && headers.referer[0].startsWith(own)) headers.referer = [t.target.origin + basePath(t.target) + headers.referer[0].slice(own.length)];
  const body = ["GET", "HEAD"].includes(e.request.method) ? new Uint8Array() : new Uint8Array(await e.request.arrayBuffer());

  const rid = b64(crypto.getRandomValues(new Uint8Array(16)));
  const ts = Date.now();
  const d = await box(t.key, enc.encode(JSON.stringify({ m: e.request.method, p: route.path, h: headers, b: b64(body) })), `eb:http-req:${route.id}:${rid}:${ts}`);
  let reply;
  try {
    const r = await fetch(`/eb-proxy/req/${route.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rid, ts, d }) });
    if (HOST_ID && r.status === 404) {
      // Session expired or server restarted: a page load goes back through the boot page to shake hands again.
      if (e.request.mode === "navigate") return fetch(e.request);
      return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (!r.ok) return errorPage(r.status === 404 ? "Ce tunnel n'existe plus." : "La machine est hors ligne ou ne répond pas.");
    reply = await r.json();
  } catch {
    return errorPage("Impossible de joindre Excalibash.");
  }
  let res;
  try {
    res = JSON.parse(dec.decode(await unbox(t.key, reply.d, `eb:http-res:${route.id}:${rid}`)));
  } catch {
    return errorPage("Réponse refusée : elle n'est pas authentique.");
  }

  const out = new Headers();
  const setCookies = [];
  for (const [k, vs] of Object.entries(res.h || {})) {
    const lk = k.toLowerCase();
    if (lk === "set-cookie") setCookies.push(...vs);
    else if (lk === "x-frame-options" || lk === "content-encoding" || lk === "content-length") continue;
    else if (lk === "location") out.set(k, rewriteLocation(vs[0], route.id, t.target));
    else if (lk === "content-security-policy") out.set(k, vs.map((v) => v.replace(/frame-ancestors[^;]*;?/gi, "")).join(", "));
    else for (const v of vs) out.append(k, v);
  }
  await storeCookies(route.id, setCookies);
  // Only Excalibash may frame a tunnelled page.
  if (e.request.mode === "navigate") out.append("Content-Security-Policy", `frame-ancestors 'self' ${MAIN_ORIGIN}`);
  const status = res.s >= 200 && res.s <= 599 ? res.s : 502;
  const noBody = e.request.method === "HEAD" || [204, 205, 304].includes(status);
  let payload = noBody ? null : unb64(res.b);
  if (payload && ["document", "iframe", "frame"].includes(e.request.destination) && /^text\/html/i.test(out.get("content-type") || "")) {
    payload = withWebSocketShim(withTunnelBase(payload, route.id, t.target), route.id, t.target.origin);
  }
  return new Response(payload, { status, headers: out });
}

// The service worker cannot see WebSocket connections, so pages get a script that carries them
// through the tunnel (see ws-shim.js). Bytes are handled as Latin-1 so any ASCII-compatible
// encoding survives untouched; the tag goes after <head> (or the doctype), never before it.
function withWebSocketShim(bytes, id, origin) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  if (/^\s*(\xff\xfe|\xfe\xff|\x00)/.test(head)) return bytes; // UTF-16 page
  const m = /<head(\s[^>]*)?>/i.exec(head) || /<html(\s[^>]*)?>/i.exec(head) || /^\s*<!doctype[^>]*>/i.exec(head);
  const at = m ? m.index + m[0].length : 0;
  const tag = enc.encode(`<script src="/eb-proxy/ws-shim.js" data-eb-tunnel="${id}" data-eb-mount="${mount(id)}" data-eb-target="${origin}"></script>`);
  const out = new Uint8Array(bytes.length + tag.length);
  out.set(bytes.subarray(0, at));
  out.set(tag, at);
  out.set(bytes.subarray(at), at + tag.length);
  return out;
}

/** The target's path without its trailing slash ("" for a target at the root). */
const basePath = (target) => target.pathname.replace(/\/+$/, "");

/** A path of the site seen from the tunnel: without the target's own path when it starts with it. */
function underBase(path, target) {
  const base = basePath(target);
  if (!base || !(path === base || path.startsWith(base + "/") || path.startsWith(base + "?"))) return path;
  return path.slice(base.length) || "/";
}

function rewriteLocation(loc, id, target) {
  try {
    const u = new URL(loc, target);
    if (u.origin !== target.origin) return loc;
    return `${mount(id)}${underBase(u.pathname, target)}${u.search}${u.hash}`;
  } catch {
    return loc;
  }
}

// Single-page apps take their base from <base href="/app/"> (written by the server from the path it was asked:
// Centreon, Angular…) and redirect when the address doesn't start with it. Under /t/<id>/ that redirect re-adds the
// whole path at every turn (/t/<id>/app/t/<id>/app/…): the base is moved under the tunnel like a redirect.
function withTunnelBase(bytes, id, target) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 65536));
  const m = /<base\s[^>]*?\bhref\s*=\s*(["']?)([^"'\s>]*)\1/i.exec(head);
  if (!m || !m[2] || !(m[2].startsWith("/") && !m[2].startsWith("//")) && !/^https?:\/\//i.test(m[2])) return bytes;
  const href = rewriteLocation(m[2].replace(/&amp;/g, "&"), id, target);
  if (href === m[2] || /[^\x21-\x7e]|["'<>]/.test(href)) return bytes;
  const at = m.index + m[0].length - m[1].length - m[2].length;
  const tag = new Uint8Array(href.length);
  for (let i = 0; i < href.length; i++) tag[i] = href.charCodeAt(i) & 0xff;
  const out = new Uint8Array(bytes.length - m[2].length + tag.length);
  out.set(bytes.subarray(0, at));
  out.set(tag, at);
  out.set(bytes.subarray(at + m[2].length), at + tag.length);
  return out;
}

function errorPage(text) {
  const html = `<!doctype html><meta charset="utf-8"><title>Excalibash</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#0b1020;color:#e2e8f0"><p>${text.replace(/</g, "&lt;")}</p>`;
  return new Response(html, { status: 502, headers: { "content-type": "text/html; charset=utf-8" } });
}
