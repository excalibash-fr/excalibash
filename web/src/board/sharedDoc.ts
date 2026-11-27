// Shared documents: one Y.Doc per docId on a board, synchronised through the board socket.
// The server only ever sees ciphertext (box under the board key, AAD bound to board, doc and epoch).
// Bound to the editors (Monaco, notebooks) by later code: this module is the transport.
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { AAD, box, randomId, unbox, type SymKey } from "../crypto.ts";
import type { DocHandler } from "./collab.ts";

const AW_IDS_PER_SOCKET = 2;
const AW_MAX_PEERS = 64;

/** What a shared document needs from a BoardSession (BoardSession implements it). */
export interface DocHost {
  readonly boardId: string;
  readonly key: SymKey;
  readonly canEdit: boolean;
  readonly currentEpoch: number;
  /** Peer identity of this tab (name, colour), known once the socket received `init`. */
  readonly you: { name: string; color: string } | null;
  docSend(msg: object): boolean;
  docRegister(doc: string, handler: DocHandler): () => void;
  on(event: "peers", fn: (peers?: { id: string }[]) => void): () => void;
}

export type SharedDoc = {
  readonly docId: string;
  readonly ydoc: Y.Doc;
  readonly awareness: Awareness;
  /** True for viewers: local changes are never sent (editors should disable input). */
  readonly readOnly: boolean;
  /** Resolves once the state held by the server was loaded (and local offline edits were pushed). */
  readonly synced: Promise<void>;
  /** Server refusals and rejected frames (e.g. "document trop gros"). Returns an unsubscribe function. */
  onError(fn: (message: string) => void): () => void;
  /** Called when the document was deleted for good (`doc.gone`). Returns an unsubscribe function. */
  onGone(fn: () => void): () => void;
  /** Releases this handle; the last one leaves the document (awareness removed, unsubscribed). */
  destroy(): void;
};

/** A fresh document id: 128 random bits, base64url. */
export const newDocId = (): string => randomId();

const REMOTE = Symbol("remote");
const UPDATE_DELAY = 30;
const AWARENESS_DELAY = 50;
/** Largest raw update that still fits a frame once boxed and base64-encoded (512 KiB). */
const MAX_RAW_UPDATE = 380 * 1024;
/** Largest raw snapshot that still fits the server's MAX_SNAPSHOT (8 MiB of base64) once boxed. */
const MAX_RAW_SNAPSHOT = 6 * 1024 * 1024 - 1024;

/**
 * Per host, the outgoing chain of each document being closed. A new handle on the same document
 * subscribes only once it has finished: otherwise the server would see doc.sub before the old
 * doc.unsub (StrictMode, quick hide/show) and drop the new subscription.
 */
const closing = new WeakMap<DocHost, Map<string, Promise<void>>>();

class Shared {
  readonly ydoc = new Y.Doc();
  readonly awareness = new Awareness(this.ydoc);
  readonly synced: Promise<void>;
  refs = 0;
  private resolveSynced!: () => void;
  private unregister: () => void = () => {};
  private offPeers: () => void;
  private errors = new Set<(m: string) => void>();
  private goneListeners = new Set<() => void>();
  /** The state of the server was received for the current socket: local updates may go out. */
  private live = false;
  /** The document was deleted (window closed or node removed by an editor): nothing more is sent. */
  private gone = false;
  private hasSynced = false;
  private appliedSeq = 0;
  private snapSeq = 0;
  private pending: Uint8Array[] = [];
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private awarenessTimer: ReturnType<typeof setTimeout> | undefined;
  private awarenessDirty = false;
  private compacting = false;
  /** An update failed to authenticate: never compact (it would erase what we could not read). */
  private tainted = false;
  private destroyed = false;
  /** Which socket (server-stamped `from`) first showed each awareness client id. */
  private awOwner = new Map<number, string>();
  /** Outgoing frames are encrypted and sent in order. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private host: DocHost, readonly docId: string) {
    this.synced = new Promise((r) => (this.resolveSynced = r));
    this.ydoc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || !this.host.canEdit) return;
      this.pending.push(u);
      this.updateTimer ??= setTimeout(() => this.flushUpdates(), UPDATE_DELAY);
    });
    this.awareness.on("update", (_c: unknown, origin: unknown) => {
      if (origin === REMOTE) return;
      // Only our own state goes out (remote entries expiring locally are not ours to announce).
      this.awarenessDirty = true;
      this.awarenessTimer ??= setTimeout(() => this.flushAwareness(), AWARENESS_DELAY);
    });
    // Someone joined or left: let them see our cursor without waiting for the next heartbeat.
    this.offPeers = host.on("peers", (peers) => {
      // A socket that left (a reload, a reconnection) frees the presence ids it held.
      if (peers) {
        const here = new Set(peers.map((p) => p.id));
        for (const [id, from] of this.awOwner) if (!here.has(from)) this.awOwner.delete(id);
      }
      if (this.live) {
        this.awarenessDirty = true;
        this.awarenessTimer ??= setTimeout(() => this.flushAwareness(), AWARENESS_DELAY);
      }
    });
    const register = () => {
      if (this.destroyed) return;
      this.unregister = host.docRegister(docId, {
        onOpen: () => this.open(),
        onClose: () => {
          this.live = false;
          // A doc.snapped lost with the socket would otherwise block compaction for good.
          this.compacting = false;
        },
        onMessage: (m) => this.onMessage(m),
      });
    };
    const prev = closing.get(host)?.get(docId);
    if (prev) {
      // Our own frames go after the previous handle's last ones too.
      this.chain = prev;
      void prev.then(register);
    } else register();
  }

  onError(fn: (m: string) => void) {
    this.errors.add(fn);
    return () => this.errors.delete(fn);
  }

  onGone(fn: () => void) {
    this.goneListeners.add(fn);
    return () => this.goneListeners.delete(fn);
  }

  private fail(message: string) {
    for (const fn of this.errors) fn(message);
  }

  private enqueue(fn: () => Promise<void>) {
    this.chain = this.chain.then(fn).catch((e) => {
      console.error("[excalibash]", e);
      this.fail("Erreur de document");
    });
  }

  private open() {
    this.live = false;
    this.compacting = false;
    // Deleted for good (the server keeps a tombstone): nothing to subscribe to, nothing to push.
    if (this.gone) return;
    const me = this.host.you;
    if (me) this.awareness.setLocalStateField("user", { name: me.name, color: me.color });
    this.host.docSend({ t: "doc.sub", doc: this.docId });
  }

  private aad = () => AAD.doc(this.host.boardId, this.docId, this.host.currentEpoch);
  private aadAw = () => AAD.docAwareness(this.host.boardId, this.docId, this.host.currentEpoch);

  private async onMessage(msg: any) {
    switch (msg.t) {
      case "doc.state":
        return this.onState(msg);
      case "doc.up": {
        if (!Number.isSafeInteger(msg.seq) || typeof msg.d !== "string") return;
        try {
          Y.applyUpdate(this.ydoc, await unbox(this.host.key, msg.d, this.aad()), REMOTE);
        } catch {
          this.tainted = true;
          this.fail("Mise à jour de document rejetée (authentification)");
          return;
        }
        this.appliedSeq = Math.max(this.appliedSeq, msg.seq);
        return;
      }
      case "doc.ack":
        // Everything below our own seq was relayed to us first: the document includes it.
        if (Number.isSafeInteger(msg.seq)) this.appliedSeq = Math.max(this.appliedSeq, msg.seq);
        return;
      case "doc.aw": {
        if (typeof msg.d !== "string") return;
        try {
          const before = new Map([...this.awareness.meta].map(([id, m]) => [id, m.clock]));
          applyAwarenessUpdate(this.awareness, await unbox(this.host.key, msg.d, this.aadAw()), REMOTE);
          this.checkAwareness(before, typeof msg.from === "string" ? msg.from : "");
          // A viewer's presence is shown, but without `execs` (running notebook cells), which only
          // editors may announce: the server flags viewers' frames with `ro`.
          if (msg.ro === true) {
            for (const [id, m] of this.awareness.meta) {
              if (id === this.awareness.clientID || before.get(id) === m.clock) continue;
              const st = this.awareness.getStates().get(id) as Record<string, unknown> | undefined;
              if (st && "execs" in st) delete st.execs;
            }
          }
        } catch {
          /* unauthenticated or malformed awareness is ignored */
        }
        return;
      }
      case "doc.gone":
        this.gone = true;
        this.live = false;
        this.pending = [];
        clearTimeout(this.updateTimer);
        this.updateTimer = undefined;
        this.fail("Ce document a été supprimé");
        for (const fn of [...this.goneListeners]) fn();
        return;
      case "doc.compact":
        return this.compact();
      case "doc.snapped":
        if (Number.isSafeInteger(msg.upto)) this.snapSeq = Math.max(this.snapSeq, msg.upto);
        this.compacting = false;
        return;
      case "doc.err":
        this.compacting = false;
        this.fail(typeof msg.error === "string" ? msg.error : "Erreur de document");
        return;
    }
  }

  /**
   * Presence comes from anyone holding the board key, viewers included. A socket may only speak for
   * the few client ids it showed first (no impersonating someone else's cursor or running cell), and
   * the number of peers is bounded (thousands of fake ones would freeze every editor).
   */
  private checkAwareness(before: Map<number, number>, from: string): void {
    const drop: number[] = [];
    for (const [id, m] of this.awareness.meta) {
      // Only the ids this update touched (new, or a newer clock).
      if (id === this.awareness.clientID || before.get(id) === m.clock) continue;
      const owner = this.awOwner.get(id);
      if (owner === undefined) {
        const mine = [...this.awOwner.values()].filter((o) => o === from).length;
        if (!from || mine >= AW_IDS_PER_SOCKET || this.awOwner.size >= AW_MAX_PEERS) drop.push(id);
        else this.awOwner.set(id, from);
      } else if (owner !== from) drop.push(id);
    }
    if (drop.length) removeAwarenessStates(this.awareness, drop.filter((id) => this.awareness.getStates().has(id)), REMOTE);
  }


  private async onState(msg: any) {
    const ups: { d: string; seq: number }[] = Array.isArray(msg.ups) ? msg.ups : [];
    // Local content (offline edits, or a document created here): push only what the server lacks,
    // computed against the server's own state. Yjs merges are idempotent, so a resend is harmless.
    const server = this.host.canEdit && (this.hasSynced || this.ydoc.store.clients.size > 0) ? new Y.Doc() : null;
    let seq = 0;
    const apply = async (d: string, s: number) => {
      try {
        const u = await unbox(this.host.key, d, this.aad());
        Y.applyUpdate(this.ydoc, u, REMOTE);
        if (server) Y.applyUpdate(server, u);
        seq = Math.max(seq, s);
      } catch {
        this.tainted = true;
        this.fail("Mise à jour de document rejetée (authentification)");
      }
    };
    if (msg.snap && typeof msg.snap.d === "string" && Number.isSafeInteger(msg.snap.seq)) {
      await apply(msg.snap.d, msg.snap.seq);
      this.snapSeq = msg.snap.seq;
    } else this.snapSeq = 0;
    for (const u of ups) if (typeof u.d === "string" && Number.isSafeInteger(u.seq)) await apply(u.d, u.seq);
    this.appliedSeq = Math.max(this.appliedSeq, seq);
    // Updates queued before the state arrived are part of the diff below.
    clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.pending = [];
    this.live = true;
    this.hasSynced = true;
    if (server) {
      const diff = Y.encodeStateAsUpdate(this.ydoc, Y.encodeStateVector(server));
      server.destroy();
      if (diff.length > 2) {
        this.pending.push(diff);
        this.flushUpdates();
      }
    }
    this.awarenessDirty = true;
    this.flushAwareness();
    this.resolveSynced();
  }

  private flushUpdates() {
    clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    if (!this.pending.length) return;
    if (this.gone) {
      this.pending = [];
      return;
    }
    // Not synced or offline: dropped here, the diff against the server state after (re)subscribing covers it.
    if (!this.live || !this.host.canEdit) {
      this.pending = [];
      return;
    }
    const merged = this.pending.length === 1 ? this.pending[0] : Y.mergeUpdates(this.pending);
    this.pending = [];
    if (merged.length > MAX_RAW_UPDATE) {
      this.fail("Modification trop volumineuse pour être envoyée");
      return;
    }
    this.enqueue(async () => {
      const d = await box(this.host.key, merged, this.aad());
      this.host.docSend({ t: "doc.up", doc: this.docId, epoch: this.host.currentEpoch, d });
    });
  }

  private flushAwareness() {
    clearTimeout(this.awarenessTimer);
    this.awarenessTimer = undefined;
    // Viewers' awareness is refused by the server (it could forge others' state): not sent.
    if (!this.awarenessDirty || !this.live) return;
    this.awarenessDirty = false;
    const update = encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]);
    this.enqueue(async () => {
      this.host.docSend({ t: "doc.aw", doc: this.docId, d: await box(this.host.key, update, this.aadAw()) });
    });
  }

  /** The server asked for a compaction: replace everything up to what we applied by one snapshot. */
  private async compact() {
    if (!this.host.canEdit || !this.live || this.compacting || this.destroyed || this.tainted || this.appliedSeq <= this.snapSeq) return;
    const upto = this.appliedSeq;
    const snap = Y.encodeStateAsUpdate(this.ydoc);
    if (snap.length > MAX_RAW_SNAPSHOT) return this.fail("Document trop gros pour être compacté");
    this.compacting = true;
    this.enqueue(async () => {
      const d = await box(this.host.key, snap, this.aad());
      if (!this.host.docSend({ t: "doc.snap", doc: this.docId, epoch: this.host.currentEpoch, d, upto })) this.compacting = false;
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.updateTimer);
    this.offPeers();
    this.unregister();
    // Tell the others our cursor is gone, then leave the document, in order.
    this.awareness.setLocalState(null);
    clearTimeout(this.awarenessTimer);
    const { host, docId } = this;
    const bye = this.live ? encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]) : null;
    this.live = false;
    this.enqueue(async () => {
      if (bye) host.docSend({ t: "doc.aw", doc: docId, d: await box(host.key, bye, AAD.docAwareness(host.boardId, docId, host.currentEpoch)) });
      host.docSend({ t: "doc.unsub", doc: docId });
    });
    const done = this.chain;
    let map = closing.get(host);
    if (!map) closing.set(host, (map = new Map()));
    map.set(docId, done);
    void done.then(() => {
      if (map.get(docId) === done) map.delete(docId);
      this.awareness.destroy();
      this.ydoc.destroy();
    });
  }
}

const registry = new WeakMap<DocHost, Map<string, Shared>>();

/**
 * Opens (or joins) a shared document of the board. Handles are reference-counted per
 * (board, docId): several windows share one Y.Doc and the last `destroy()` closes it.
 */
export function openSharedDoc(session: DocHost, docId: string): SharedDoc {
  let docs = registry.get(session);
  if (!docs) registry.set(session, (docs = new Map()));
  let shared = docs.get(docId);
  if (!shared) docs.set(docId, (shared = new Shared(session, docId)));
  const s = shared;
  s.refs++;
  const unsubs = new Set<() => void>();
  let released = false;
  return {
    docId,
    ydoc: s.ydoc,
    awareness: s.awareness,
    readOnly: !session.canEdit,
    synced: s.synced,
    onError(fn) {
      const off = s.onError(fn);
      unsubs.add(off);
      return () => {
        off();
        unsubs.delete(off);
      };
    },
    onGone(fn) {
      const off = s.onGone(fn);
      unsubs.add(off);
      return () => {
        off();
        unsubs.delete(off);
      };
    },
    destroy() {
      if (released) return;
      released = true;
      for (const off of unsubs) off();
      if (--s.refs === 0) {
        docs!.delete(docId);
        s.destroy();
      }
    },
  };
}
