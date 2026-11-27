// Excalibash web-tunnel WebSocket shim (proxy origin). The service worker adds it to the HTML pages
// of a tunnelled site. It replaces window.WebSocket so that the site's sockets travel through the
// tunnel: each message is sealed with the tunnel key, relayed by the server to the agent, and the
// agent talks to the real target. The server sees neither the messages nor the target.
/* global indexedDB, crypto */
(() => {
  "use strict";
  const Native = window.WebSocket;
  const script = document.currentScript;
  const ID = script && script.dataset.ebTunnel;
  const TARGET = script && script.dataset.ebTarget;
  // Where the tunnel is mounted on this origin: /t/<id> in path mode, nothing in subdomain mode.
  const MOUNT = script && script.dataset.ebMount !== undefined ? script.dataset.ebMount : `/t/${ID}`;
  if (!ID || !TARGET || !/^[A-Za-z0-9_-]{16,43}$/.test(ID)) return;
  let targetHost;
  try {
    targetHost = new URL(TARGET).host;
  } catch {
    return;
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const MAX_MESSAGE = 8 * 1024 * 1024;
  const CLOSE_WAIT = 5000;

  // ---- same formats as the service worker (box = 0x01 ‖ iv ‖ AES-256-GCM) -----------------

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

  // ---- key and cookie jar, kept by the service worker in IndexedDB ------------------------

  const idb = (store) =>
    new Promise((resolve, reject) => {
      const r = indexedDB.open("excalibash-proxy", 1);
      r.onerror = () => reject(r.error);
      r.onupgradeneeded = () => r.transaction.abort(); // the service worker creates it; never create it here
      r.onsuccess = () => {
        const q = r.result.transaction(store, "readonly").objectStore(store).get(ID);
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => reject(q.error);
      };
    });

  let material;
  const getMaterial = () =>
    (material ||= (async () => {
      const saved = await idb("tunnels");
      if (!saved) throw new Error("no tunnel key");
      // A non-extractable CryptoKey since the key is stored as one; a raw string from an older worker.
      const key = typeof saved.key === "string" ? await crypto.subtle.importKey("raw", unb64(saved.key), "AES-GCM", false, ["encrypt", "decrypt"]) : saved.key;
      const jar = (await idb("cookies")) || {};
      return { key, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ") };
    })());

  // ---- the socket ---------------------------------------------------------------------------

  const syntax = (msg) => new DOMException(msg, "SyntaxError");
  const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  const HANDLERS = ["open", "message", "error", "close"];

  class TunnelWebSocket extends EventTarget {
    constructor(url, protocols) {
      let u;
      try {
        u = new URL(String(url), location.href);
      } catch {
        throw syntax("URL de WebSocket invalide");
      }
      if (!["ws:", "wss:", "http:", "https:"].includes(u.protocol)) throw syntax("Schéma de WebSocket non pris en charge");
      if (u.hash) throw syntax("Un fragment est interdit dans l'URL d'une WebSocket");
      // Sockets to other hosts do not belong to the tunnel: the browser handles them itself.
      if (u.host !== location.host && u.host !== targetHost) return new Native(url, protocols);

      super();
      const protos = protocols === undefined ? [] : Array.isArray(protocols) ? protocols.map(String) : [String(protocols)];
      if (protos.some((p) => !TOKEN.test(p)) || new Set(protos).size !== protos.length) throw syntax("Sous-protocole invalide");

      const path = (MOUNT && (u.pathname === MOUNT || u.pathname.startsWith(`${MOUNT}/`)) ? u.pathname.slice(MOUNT.length) || "/" : u.pathname) + u.search;
      this._u = u;
      this._rs = 0;
      this._binaryType = "blob";
      this._buffered = 0;
      this._protocol = "";
      this._real = null;
      this._sendN = 0;
      this._recvN = 0;
      this._inbox = Promise.resolve(); // decrypts in arrival order
      this._outbox = Promise.resolve(); // seals in call order
      this._done = false;
      this._connect(path, protos);
    }

    get url() {
      return this._u.href.replace(/^http/, "ws");
    }
    get readyState() {
      return this._rs;
    }
    get bufferedAmount() {
      return this._buffered;
    }
    get extensions() {
      return "";
    }
    get protocol() {
      return this._protocol;
    }
    get binaryType() {
      return this._binaryType;
    }
    set binaryType(v) {
      if (v === "blob" || v === "arraybuffer") this._binaryType = v;
    }

    _emit(ev) {
      const h = this[`_on${ev.type}`];
      if (typeof h === "function") {
        try {
          h.call(this, ev);
        } catch (e) {
          setTimeout(() => {
            throw e;
          });
        }
      }
      this.dispatchEvent(ev);
    }

    _finish(code, reason, clean) {
      if (this._done) return;
      this._done = true;
      this._rs = 3;
      clearTimeout(this._closeTimer);
      const real = this._real;
      if (real && real.readyState < 2) {
        try {
          real.close(1000);
        } catch {
          /* already closing */
        }
      }
      if (!clean) this._emit(new Event("error"));
      this._emit(new CloseEvent("close", { code, reason, wasClean: clean }));
    }

    async _connect(path, protos) {
      let m;
      try {
        m = await getMaterial();
      } catch {
        return this._finish(1006, "", false);
      }
      if (this._rs === 2) return this._finish(1006, "", false); // closed while loading the key
      const sid = b64(crypto.getRandomValues(new Uint8Array(16)));
      this._sid = sid;
      this._key = m.key;
      let real;
      try {
        real = new Native(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/eb-proxy/ws/${ID}`);
      } catch {
        return this._finish(1006, "", false);
      }
      this._real = real;
      real.onopen = async () => {
        try {
          const ts = Date.now();
          const d = await box(m.key, enc.encode(JSON.stringify({ p: path, protos, cookie: m.cookie })), `eb:ws-open:${ID}:${sid}:${ts}`);
          real.send(JSON.stringify({ t: "open", sid, ts, d }));
        } catch {
          this._finish(1006, "", false);
        }
      };
      real.onmessage = (e) => {
        let f;
        try {
          f = JSON.parse(e.data);
        } catch {
          return this._finish(1006, "", false);
        }
        this._inbox = this._inbox.then(() => this._receive(f)).catch(() => this._finish(1006, "", false));
      };
      real.onclose = () => this._finish(1006, "", false); // no sealed close seen: abnormal
      real.onerror = () => {};
    }

    async _receive(f) {
      if (this._done) return;
      const key = this._key;
      if (this._rs === 0) {
        if (f.t !== "ack" || typeof f.d !== "string") throw new Error("ack expected");
        const ack = JSON.parse(dec.decode(await unbox(key, f.d, `eb:ws-ack:${ID}:${this._sid}`)));
        if (!ack.ok) return this._finish(1006, "", false);
        this._protocol = typeof ack.proto === "string" ? ack.proto : "";
        this._rs = 1;
        return this._emit(new Event("open"));
      }
      if (typeof f.d !== "string") throw new Error("frame without payload");
      if (f.t === "data") {
        const pt = await unbox(key, f.d, `eb:ws-msg:${ID}:${this._sid}:a2c:${this._recvN}`);
        this._recvN++;
        if (this._rs !== 1 && this._rs !== 2) return;
        let data;
        if (pt[0] === 0) data = dec.decode(pt.subarray(1));
        else data = this._binaryType === "arraybuffer" ? pt.slice(1).buffer : new Blob([pt.subarray(1)]);
        return this._emit(new MessageEvent("message", { data, origin: this._u.origin }));
      }
      if (f.t === "close") {
        const b = JSON.parse(dec.decode(await unbox(key, f.d, `eb:ws-close:${ID}:${this._sid}:a2c:${this._recvN}`)));
        return this._finish(Number(b.code) || 1005, String(b.reason || ""), true);
      }
      throw new Error("unexpected frame");
    }

    send(data) {
      if (this._rs === 0) throw new DOMException("La WebSocket n'est pas encore ouverte", "InvalidStateError");
      let kind = 1;
      let src = data;
      if (typeof data === "string") {
        kind = 0;
        src = enc.encode(data);
      } else if (data instanceof ArrayBuffer) {
        src = new Uint8Array(data.slice(0));
      } else if (ArrayBuffer.isView(data)) {
        src = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      } else if (!(data instanceof Blob)) {
        kind = 0;
        src = enc.encode(String(data));
      }
      const size = src instanceof Blob ? src.size : src.length;
      this._buffered += size;
      if (this._rs !== 1) return; // closing or closed: the message is dropped
      this._outbox = this._outbox
        .then(async () => {
          const bytes = src instanceof Blob ? new Uint8Array(await src.arrayBuffer()) : src;
          if (this._rs !== 1) return;
          if (bytes.length > MAX_MESSAGE) return this.close(1000, "message trop volumineux");
          const body = new Uint8Array(bytes.length + 1);
          body[0] = kind;
          body.set(bytes, 1);
          const d = await box(this._key, body, `eb:ws-msg:${ID}:${this._sid}:c2a:${this._sendN++}`);
          this._real.send(JSON.stringify({ t: "data", d }));
        })
        .catch(() => this._finish(1006, "", false))
        .finally(() => {
          this._buffered = Math.max(0, this._buffered - size);
        });
    }

    close(code, reason) {
      if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) throw new DOMException("Code de fermeture invalide", "InvalidAccessError");
      reason = reason === undefined ? "" : String(reason);
      if (enc.encode(reason).length > 123) throw syntax("Raison de fermeture trop longue");
      if (this._rs >= 2) return;
      if (this._rs === 0) {
        this._rs = 2;
        if (this._real) this._finish(1006, "", false); // abandoning the handshake
        return;
      }
      this._rs = 2;
      this._outbox = this._outbox
        .then(async () => {
          const d = await box(this._key, enc.encode(JSON.stringify({ code: code ?? 1000, reason })), `eb:ws-close:${ID}:${this._sid}:c2a:${this._sendN}`);
          this._real.send(JSON.stringify({ t: "close", d }));
        })
        .catch(() => this._finish(1006, "", false));
      this._closeTimer = setTimeout(() => this._finish(code ?? 1005, reason, false), CLOSE_WAIT);
    }
  }

  for (const [name, v] of [["CONNECTING", 0], ["OPEN", 1], ["CLOSING", 2], ["CLOSED", 3]]) {
    Object.defineProperty(TunnelWebSocket, name, { value: v, enumerable: true });
    Object.defineProperty(TunnelWebSocket.prototype, name, { value: v, enumerable: true });
  }
  for (const h of HANDLERS) {
    Object.defineProperty(TunnelWebSocket.prototype, `on${h}`, {
      enumerable: true,
      get() {
        return this[`_on${h}`] || null;
      },
      set(fn) {
        this[`_on${h}`] = typeof fn === "function" ? fn : null;
      },
    });
  }
  Object.defineProperty(window, "WebSocket", { value: TunnelWebSocket, writable: true, configurable: true });
})();
