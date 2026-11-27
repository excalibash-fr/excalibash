import { WebSocket } from "ws";
import { db, isClientId, newId } from "./db.ts";
import type { User } from "./auth.ts";
import { atLeast, getItem, getMachine, machineAccess, type Role } from "./access.ts";
import { rooms, type BoardRoom } from "./hub.ts";
import {
  createTerminal,
  listBoardTerminals,
  terminalClose,
  terminalExists,
  terminalInput,
  terminalReplay,
  terminalResize,
  terminalRestart,
} from "./terminals.ts";
import { fileRequest } from "./files.ts";
import { HistoryTracker } from "./history.ts";
import {
  COMPACT_UPDATES,
  MAX_AWARENESS,
  MAX_FRAME,
  MAX_SNAPSHOT,
  appendUpdate,
  applySnapshot,
  deleteDoc,
  docState,
  isDeletedDoc,
  isDocId,
} from "./docs.ts";
import { isB64Url } from "./validate.ts";
import { closeTunnel, createTunnel, listBoardTunnels, tunnelExists } from "./tunnels.ts";

/** Encrypted element: only the merge metadata is readable by the server. */
type Entry = { id: string; v: number; n: number; c: string };

type Client = {
  id: string;
  user: User;
  role: Role;
  session?: string;
  /** Shared documents this socket is subscribed to. */
  docs: Set<string>;
  /** Awareness rate limit: token bucket. */
  awTokens: number;
  awAt: number;
  /** General rate limit: token bucket. */
  msgTokens: number;
  msgAt: number;
  /** Set once the socket is being closed (rights changed, keys rotated): its messages are ignored. */
  gone?: boolean;
  /** Rate limit of every doc.* message (token bucket), and a stricter one for doc.sub (each one reads the whole document). */
  docTokens: number;
  subTokens: number;
  docAt: number;
};

const AWARENESS_RATE = 10; // messages per second per socket
// Every message: a generous bucket (cursors, typing, pastes) that still stops a flood.
const MESSAGE_RATE = 300; // per second per socket
const MESSAGE_BURST = 3000;
// Elements of a board, deleted ones included (far above any real diagram).
const MAX_ELEMENTS = 50_000;
const MAX_ELEMENT_BYTES = 128 * 1024 * 1024;
// Images of a board (encrypted, base64): beyond this, new ones are refused.
const MAX_FILES = 2000;
// Stays well below V8's longest string (~512 MiB): flush() serializes them all in one JSON string.
const MAX_FILES_BYTES = 256 * 1024 * 1024;
const MAX_SUBSCRIPTIONS = 64;
const DOC_RATE = 200; // doc.* messages per second per socket (several documents typed into at once)
const DOC_BURST = 400;
// A fresh socket may open many documents at once, then a few per second.
const SUB_RATE = 8; // doc.sub per second once the burst is spent (each one reads the document from the database)
const SUB_BURST = 4 * MAX_SUBSCRIPTIONS; // opening every window of a board at once, several times
const COMPACT_RETRY = 5000;

const SAVE_DELAY = 1500;
const MAX_CIPHERTEXT = 2 * 1024 * 1024;

/** Excalidraw's rule: higher version wins, ties go to the lower versionNonce. */
function isNewer(incoming: Entry, current: Entry | undefined): boolean {
  if (!current) return true;
  if (incoming.v !== current.v) return incoming.v > current.v;
  return incoming.n < current.n;
}

function isEntry(e: any): e is Entry {
  return (
    e &&
    typeof e === "object" &&
    typeof e.id === "string" &&
    e.id.length <= 64 &&
    Number.isInteger(e.v) &&
    Number.isInteger(e.n) &&
    typeof e.c === "string" &&
    e.c.length <= MAX_CIPHERTEXT
  );
}

const str = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

class Room implements BoardRoom {
  readonly boardId: string;
  private epoch: number;
  private elements = new Map<string, Entry>();
  private order: string[] = [];
  private files: Record<string, string>;
  private clients = new Map<WebSocket, Client>();
  private saveTimer: NodeJS.Timeout | undefined;
  private dirtyFiles = false;
  private history: HistoryTracker;
  /** Sockets subscribed to each shared document. */
  private docSubs = new Map<string, Set<WebSocket>>();
  /** When a compaction was last requested per document (not repeated while one is likely under way). */
  private compactAsked = new Map<string, number>();
  /** Total size of the element ciphertexts (flush() serializes them in one string). */
  private elementBytes = 0;

  constructor(boardId: string) {
    this.boardId = boardId;
    this.history = new HistoryTracker(boardId);
    this.epoch = getItem(boardId)!.key_epoch;
    const row = db.prepare("SELECT elements, files FROM boards WHERE id = ?").get(boardId) as { elements: string; files: string };
    for (const e of JSON.parse(row.elements) as Entry[]) {
      this.elements.set(e.id, e);
      this.order.push(e.id);
      this.elementBytes += e.c.length;
    }
    this.files = JSON.parse(row.files);
  }

  broadcast(data: string, except?: WebSocket): void {
    for (const ws of this.clients.keys()) {
      if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private peer(c: Client) {
    return { id: c.id, userId: c.user.id, name: c.user.name, color: c.user.color, role: c.role };
  }

  join(ws: WebSocket, user: User, role: Role, session?: string): void {
    const client: Client = { id: newId(6), user, role, session, docs: new Set(), awTokens: AWARENESS_RATE, awAt: Date.now(), msgTokens: MESSAGE_BURST, msgAt: Date.now(), docTokens: DOC_BURST, subTokens: SUB_BURST, docAt: Date.now() };
    this.clients.set(ws, client);
    ws.send(
      JSON.stringify({
        t: "init",
        you: this.peer(client),
        epoch: this.epoch,
        elements: this.order.map((id) => this.elements.get(id)),
        files: this.files,
        terminals: listBoardTerminals(this.boardId),
        webs: listBoardTunnels(this.boardId),
        peers: [...this.clients.values()].filter((c) => c !== client).map((c) => this.peer(c)),
      }),
    );
    this.broadcast(JSON.stringify({ t: "peer.join", peer: this.peer(client) }), ws);

    // Without a listener, a protocol error (oversized or malformed frame) would throw and stop the process.
    ws.on("error", () => ws.terminate());

    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // `null`, a number or a string parse fine, and `msg.t` would then throw out of the handler.
      if (!msg || typeof msg !== "object") return;
      // A closing socket may keep sending until the close handshake ends: nothing it says counts.
      if (client.gone) return;
      const now = Date.now();
      client.msgTokens = Math.min(MESSAGE_BURST, client.msgTokens + ((now - client.msgAt) / 1000) * MESSAGE_RATE);
      client.msgAt = now;
      if (client.msgTokens < 1) return this.drop(ws, client, 1008, "trop de messages");
      client.msgTokens--;
      try {
        this.onMessage(ws, client, msg);
      } catch (e) {
        console.error("[room]", e);
        ws.send(JSON.stringify({ t: "error", message: "Erreur serveur", reqId: msg.reqId }));
      }
    });

    ws.on("close", () => {
      this.clients.delete(ws);
      for (const doc of client.docs) this.unsubscribe(ws, client, doc);
      this.broadcast(JSON.stringify({ t: "peer.leave", id: client.id }));
      if (this.clients.size === 0) {
        this.flush();
        // The work session is over: keep its end state in the history (not if the keys changed meanwhile).
        if (this.current()) this.history.capture(this.epoch, this.snapshot(), true);
        if (rooms.get(this.boardId) === this) rooms.delete(this.boardId);
      }
    });
  }

  private onMessage(ws: WebSocket, client: Client, msg: any): void {
    const deny = (message: string) => ws.send(JSON.stringify({ t: "error", reqId: msg.reqId, message }));
    const editor = atLeast(client.role, "editor");

    switch (msg.t) {
      case "scene": {
        if (!editor) return deny("Lecture seule");
        if (msg.epoch !== this.epoch) return ws.send(JSON.stringify({ t: "rekey" }));
        if (!Array.isArray(msg.elements)) return;
        const accepted: Entry[] = [];
        for (const e of msg.elements) {
          if (!isEntry(e)) continue;
          const entry: Entry = { id: e.id, v: e.v, n: e.n, c: e.c };
          const prev = this.elements.get(e.id);
          if (!isNewer(entry, prev)) continue;
          const grown = this.elementBytes + entry.c.length - (prev?.c.length ?? 0);
          if (grown > MAX_ELEMENT_BYTES) {
            deny("Ce tableau a atteint sa taille maximale");
            break;
          }
          if (!prev) {
            // Deleted elements stay (as tombstones): this bounds what one board can hold in memory.
            if (this.order.length >= MAX_ELEMENTS) {
              deny("Ce tableau a atteint sa limite d'éléments");
              break;
            }
            this.order.push(e.id);
          }
          this.elements.set(e.id, entry);
          this.elementBytes = grown;
          accepted.push(entry);
        }
        if (accepted.length) {
          this.history.markDirty();
          this.broadcast(JSON.stringify({ t: "scene", elements: accepted }), ws);
          this.scheduleSave();
        }
        break;
      }
      case "files": {
        if (!editor) return deny("Lecture seule");
        if (msg.epoch !== this.epoch) return ws.send(JSON.stringify({ t: "rekey" }));
        if (!msg.files || typeof msg.files !== "object") return;
        const added: Record<string, string> = {};
        let count = Object.keys(this.files).length;
        let bytes = Object.values(this.files).reduce((n, c) => n + c.length, 0);
        for (const [id, c] of Object.entries(msg.files)) {
          if (this.files[id] || id.length > 128 || !str(c, 32 * 1024 * 1024)) continue;
          if (count + 1 > MAX_FILES || bytes + (c as string).length > MAX_FILES_BYTES) {
            deny("Ce tableau a atteint sa limite d'images");
            break;
          }
          count++;
          bytes += (c as string).length;
          this.files[id] = c;
          added[id] = c;
        }
        if (Object.keys(added).length) {
          this.dirtyFiles = true;
          this.broadcast(JSON.stringify({ t: "files", files: added }), ws);
          this.scheduleSave();
        }
        break;
      }
      case "pointer":
        if (!str(msg.c, 4096)) return;
        this.broadcast(JSON.stringify({ t: "pointer", id: client.id, userId: client.user.id, name: client.user.name, color: client.user.color, c: msg.c }), ws);
        break;
      case "term.create": {
        if (!editor) return deny("Lecture seule");
        const machine = getMachine(String(msg.machineId));
        if (!machine || !machineAccess(client.user.id, machine, this.boardId)) return deny("Cette machine ne t'est pas partagée");
        if (!isClientId(msg.id) || terminalExists(msg.id)) return deny("Identifiant de terminal invalide");
        if (!str(msg.keyForBoard) || !str(msg.keyForAgent) || !str(msg.encLabel)) return deny("Clés manquantes");
        const terminal = createTerminal({
          id: msg.id,
          boardId: this.boardId,
          machineId: machine.id,
          userId: client.user.id,
          cols: Number(msg.cols),
          rows: Number(msg.rows),
          keyForBoard: msg.keyForBoard,
          keyForAgent: msg.keyForAgent,
          encLabel: msg.encLabel,
        });
        ws.send(JSON.stringify({ t: "term.created", reqId: msg.reqId, terminal }));
        break;
      }
      case "web.create": {
        if (!editor) return deny("Lecture seule");
        const machine = getMachine(String(msg.machineId));
        if (!machine || !machineAccess(client.user.id, machine, this.boardId)) return deny("Cette machine ne t'est pas partagée");
        if (!isClientId(msg.id) || tunnelExists(msg.id)) return deny("Identifiant de tunnel invalide");
        if (!str(msg.keyForBoard) || !str(msg.keyForAgent) || !str(msg.encLabel)) return deny("Clés manquantes");
        const web = createTunnel({
          id: msg.id,
          boardId: this.boardId,
          machineId: machine.id,
          createdBy: client.user.id,
          keyForBoard: msg.keyForBoard,
          keyForAgent: msg.keyForAgent,
          encLabel: msg.encLabel,
        });
        ws.send(JSON.stringify({ t: "web.created", reqId: msg.reqId, web }));
        break;
      }
      case "web.close":
        if (editor) closeTunnel(this.boardId, String(msg.id));
        break;
      case "term.sub": {
        const chunks = terminalReplay(this.boardId, String(msg.id));
        if (chunks) ws.send(JSON.stringify({ t: "term.replay", id: msg.id, chunks }));
        break;
      }
      case "term.input":
        if (!editor) return;
        if (str(msg.s, 64) && Number.isSafeInteger(msg.k) && Number.isSafeInteger(msg.ts) && str(msg.d, 256 * 1024)) {
          terminalInput(this.boardId, String(msg.id), { s: msg.s, k: msg.k, ts: msg.ts, d: msg.d });
        }
        break;
      case "doc.sub":
      case "doc.unsub":
      case "doc.up":
      case "doc.aw":
      case "doc.snap":
      case "doc.del":
        this.onDoc(ws, client, msg, editor);
        break;
      case "file.req":
        fileRequest(ws, this.boardId, editor, msg);
        break;
      case "term.resize":
        if (editor) terminalResize(this.boardId, String(msg.id), Number(msg.cols), Number(msg.rows));
        break;
      case "term.close":
        if (editor) terminalClose(this.boardId, String(msg.id));
        break;
      case "term.restart":
        if (editor) terminalRestart(this.boardId, String(msg.id));
        break;
    }
  }

  // ---- Shared documents (opaque ciphertext: the server only orders, stores and relays) ----------

  private unsubscribe(ws: WebSocket, client: Client, doc: string): void {
    client.docs.delete(doc);
    const subs = this.docSubs.get(doc);
    subs?.delete(ws);
    if (subs && !subs.size) {
      this.docSubs.delete(doc);
      this.compactAsked.delete(doc);
    }
  }

  /** Asks this socket (an editor that has the document loaded) to compact it, at most every COMPACT_RETRY. */
  private askCompact(ws: WebSocket, doc: string): void {
    const now = Date.now();
    if (now - (this.compactAsked.get(doc) ?? 0) <= COMPACT_RETRY) return;
    this.compactAsked.set(doc, now);
    ws.send(JSON.stringify({ t: "doc.compact", doc }));
  }

  private onDoc(ws: WebSocket, client: Client, msg: any, editor: boolean): void {
    const doc = msg.doc;
    const fail = (error: string) => ws.send(JSON.stringify({ t: "doc.err", doc: typeof doc === "string" ? doc.slice(0, 64) : "", error }));
    // Leaving is never limited (it only lowers the load); everything else draws from the bucket.
    if (msg.t !== "doc.unsub") {
      const now = Date.now();
      const dt = (now - client.docAt) / 1000;
      client.docAt = now;
      client.docTokens = Math.min(DOC_BURST, client.docTokens + dt * DOC_RATE);
      client.subTokens = Math.min(SUB_BURST, client.subTokens + dt * SUB_RATE);
      if (client.docTokens < 1) return msg.t === "doc.aw" ? undefined : fail("trop de requêtes");
      client.docTokens--;
    }
    if (!isDocId(doc)) return fail("identifiant de document invalide");
    const relay = (data: object) => {
      const text = JSON.stringify(data);
      for (const peer of this.docSubs.get(doc) ?? []) if (peer !== ws && peer.readyState === WebSocket.OPEN) peer.send(text);
    };

    switch (msg.t) {
      case "doc.sub": {
        // Clients subscribe once per socket: a repeat would only re-read and re-send the whole document.
        if (client.docs.has(doc)) return fail("document déjà ouvert");
        if (client.docs.size >= MAX_SUBSCRIPTIONS) return fail("trop de documents ouverts");
        if (client.subTokens < 1) return fail("trop de requêtes");
        client.subTokens--;
        // Deleted for good: a client that was offline must not bring it back from its local copy.
        if (isDeletedDoc(this.boardId, doc)) return ws.send(JSON.stringify({ t: "doc.gone", doc }));
        client.docs.add(doc);
        let subs = this.docSubs.get(doc);
        if (!subs) this.docSubs.set(doc, (subs = new Set()));
        subs.add(ws);
        // Same tick as the subscription: no update can slip between the state and the live relay.
        const state = docState(this.boardId, doc);
        ws.send(JSON.stringify({ t: "doc.state", doc, ...state }));
        // Left uncompacted (its last writer went away): the first editor to load it compacts it.
        if (editor && state.ups.length > COMPACT_UPDATES) this.askCompact(ws, doc);
        break;
      }
      case "doc.unsub":
        this.unsubscribe(ws, client, doc);
        break;
      case "doc.up": {
        if (!editor) return fail("Lecture seule");
        if (msg.epoch !== this.epoch) return ws.send(JSON.stringify({ t: "rekey" }));
        if (!client.docs.has(doc)) return fail("document non ouvert");
        if (!isB64Url(msg.d, MAX_FRAME)) return fail("mise à jour invalide");
        const r = appendUpdate(this.boardId, doc, this.epoch, msg.d);
        if (!r.ok) {
          if (r.gone) {
            this.unsubscribe(ws, client, doc);
            return ws.send(JSON.stringify({ t: "doc.gone", doc }));
          }
          fail(r.error);
          // Full: a compaction (history folded into one snapshot) usually frees most of the room.
          if (r.tooBig) this.askCompact(ws, doc);
          return;
        }
        relay({ t: "doc.up", doc, d: msg.d, seq: r.seq });
        ws.send(JSON.stringify({ t: "doc.ack", doc, seq: r.seq }));
        // The writer is an editor that has the document loaded: it is the one asked to compact.
        if (r.compact) this.askCompact(ws, doc);
        break;
      }
      case "doc.snap": {
        if (!editor) return fail("Lecture seule");
        if (msg.epoch !== this.epoch) return ws.send(JSON.stringify({ t: "rekey" }));
        if (!isB64Url(msg.d, MAX_SNAPSHOT)) return fail("instantané invalide");
        const r = applySnapshot(this.boardId, doc, msg.d, msg.upto);
        if (!r.ok) return fail(r.error);
        this.compactAsked.delete(doc);
        ws.send(JSON.stringify({ t: "doc.snapped", doc, upto: msg.upto }));
        break;
      }
      case "doc.del": {
        // Same rights as doc.up (editors, current key generation); no subscription needed since the
        // window that owned the document is usually closed by then. Scoped to this board by the query.
        if (!editor) return fail("Lecture seule");
        if (msg.epoch !== this.epoch) return ws.send(JSON.stringify({ t: "rekey" }));
        deleteDoc(this.boardId, doc);
        // Subscribers (the sender included) learn it is gone and forget it.
        const gone = JSON.stringify({ t: "doc.gone", doc });
        const subs = this.docSubs.get(doc) ?? new Set<WebSocket>();
        for (const peer of subs) {
          this.clients.get(peer)?.docs.delete(doc);
          if (peer.readyState === WebSocket.OPEN) peer.send(gone);
        }
        this.docSubs.delete(doc);
        this.compactAsked.delete(doc);
        if (!subs.has(ws)) ws.send(gone);
        break;
      }
      case "doc.aw": {
        // Viewers publish their presence too, but their frames are flagged `ro`: awareness also carries
        // state others act on (running notebook cells), which a viewer, holding the board key, could forge.
        if (!client.docs.has(doc) || !isB64Url(msg.d, MAX_AWARENESS)) return;
        // Relayed only, never stored; at most AWARENESS_RATE messages per second per socket.
        const now = Date.now();
        client.awTokens = Math.min(AWARENESS_RATE, client.awTokens + ((now - client.awAt) / 1000) * AWARENESS_RATE);
        client.awAt = now;
        if (client.awTokens < 1) return;
        client.awTokens--;
        relay({ t: "doc.aw", doc, d: msg.d, from: client.id, ...(editor ? {} : { ro: true }) });
        break;
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      try {
        this.flush();
      } catch (e) {
        console.error("[room] sauvegarde", this.boardId, e);
      }
    }, SAVE_DELAY);
  }

  /** Whether the board is still under the keys this room was opened with. */
  private current(): boolean {
    return getItem(this.boardId)?.key_epoch === this.epoch;
  }

  flush(): void {
    if (!this.saveTimer && !this.dirtyFiles) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    // Content under older keys must never overwrite what a rotation re-encrypted.
    if (!this.current()) {
      this.dirtyFiles = false;
      return;
    }
    const elements = JSON.stringify(this.snapshot());
    if (this.dirtyFiles) {
      db.prepare("UPDATE boards SET elements = ?, files = ? WHERE id = ?").run(elements, JSON.stringify(this.files), this.boardId);
      this.dirtyFiles = false;
    } else {
      db.prepare("UPDATE boards SET elements = ? WHERE id = ?").run(elements, this.boardId);
    }
    db.prepare("UPDATE items SET updated_at = ? WHERE id = ?").run(Date.now(), this.boardId);
    this.history.capture(this.epoch, this.snapshot());
  }

  /** Entries in scene order. */
  private snapshot(): Entry[] {
    return this.order.map((id) => this.elements.get(id)!);
  }

  /** Closes a socket for good: its messages stop counting now, and it is cut if it lingers. */
  private drop(ws: WebSocket, c: Client, code: number, reason: string): void {
    c.gone = true;
    ws.close(code, reason);
    setTimeout(() => ws.terminate(), 2000).unref();
  }

  kick(userId: string, code: number, reason: string): void {
    for (const [ws, c] of this.clients) if (c.user.id === userId) this.drop(ws, c, code, reason);
  }

  /** Closes the sockets opened with one session (token hash). */
  kickSession(session: string, code: number, reason: string): void {
    for (const [ws, c] of this.clients) if (c.session === session) this.drop(ws, c, code, reason);
  }

  /** Disconnects everyone; pending edits are dropped when `discard` (content was replaced). */
  evict(code: number, reason: string, discard = false): void {
    if (discard) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.dirtyFiles = false;
      this.history.discard();
    }
    for (const [ws, c] of this.clients) this.drop(ws, c, code, reason);
    if (rooms.get(this.boardId) === this) rooms.delete(this.boardId);
  }
}

export function joinBoard(ws: WebSocket, user: User, boardId: string, role: Role, session?: string): void {
  let room = rooms.get(boardId) as Room | undefined;
  if (!room) {
    room = new Room(boardId);
    rooms.set(boardId, room);
  }
  room.join(ws, user, role, session);
}

/** Persists a live room right away (so REST reads see unsaved edits). */
export function flushRoom(boardId: string): void {
  (rooms.get(boardId) as Room | undefined)?.flush();
}

export function evictRoom(boardId: string, code: number, reason: string, discard = false): void {
  (rooms.get(boardId) as Room | undefined)?.evict(code, reason, discard);
}

/** Closes every board socket of a user (e.g. suspended account). */
export function kickUser(userId: string, code: number, reason: string): void {
  for (const r of rooms.values()) (r as Room).kick(userId, code, reason);
}

/** Closes the board sockets opened with a revoked session. */
export function kickSession(session: string, code: number, reason: string): void {
  for (const r of rooms.values()) (r as Room).kickSession(session, code, reason);
}

export function flushAllRooms(): void {
  for (const r of rooms.values()) (r as Room).flush();
}
