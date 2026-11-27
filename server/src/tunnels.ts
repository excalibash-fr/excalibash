import { db } from "./db.ts";
import { agentHooks, isMachineOnline, sendAgent } from "./terminals.ts";
import type { WebSocket } from "ws";
import { broadcastToBoard } from "./hub.ts";
import { isRid } from "./validate.ts";
import { dropTunnelSessions, onSessionsDropped } from "./tunnelSessions.ts";

// Web tunnels relay end-to-end encrypted HTTP between a viewer's browser (service worker on the
// proxy origin) and an agent. The server never sees requests or responses: it only forwards
// {rid, ts, d} frames to the machine and the encrypted answer back.

type Tunnel = {
  id: string;
  boardId: string;
  machineId: string;
  createdBy: string | null;
  keyForBoard: string;
  keyForAgent: string;
  encLabel: string;
};

export type TunnelInfo = Omit<Tunnel, "keyForAgent"> & { machineOwnerId: string | null; online: boolean };

const tunnels = new Map<string, Tunnel>();

type Row = { id: string; board_id: string; machine_id: string; created_by: string | null; key_for_board: string; key_for_agent: string; enc_label: string };
for (const r of db.prepare("SELECT * FROM tunnels").all() as Row[]) {
  tunnels.set(r.id, {
    id: r.id,
    boardId: r.board_id,
    machineId: r.machine_id,
    createdBy: r.created_by,
    keyForBoard: r.key_for_board,
    keyForAgent: r.key_for_agent,
    encLabel: r.enc_label,
  });
}

function info(t: Tunnel): TunnelInfo {
  const owner = db.prepare("SELECT owner_id FROM machines WHERE id = ?").get(t.machineId) as { owner_id: string } | undefined;
  const { keyForAgent: _k, ...rest } = t;
  return { ...rest, machineOwnerId: owner?.owner_id ?? null, online: isMachineOnline(t.machineId) };
}

const openOnAgent = (t: Tunnel) => sendAgent(t.machineId, { t: "web.open", id: t.id, key: t.keyForAgent });

export function listBoardTunnels(boardId: string): TunnelInfo[] {
  return [...tunnels.values()].filter((t) => t.boardId === boardId).map(info);
}

export function tunnelsOfBoards(boardIds: Set<string>): TunnelInfo[] {
  return [...tunnels.values()].filter((t) => boardIds.has(t.boardId)).map(info);
}

export function tunnelExists(id: string): boolean {
  return tunnels.has(id);
}

/** Board a tunnel belongs to (access to the tunnel follows access to that board). */
export function tunnelBoard(id: string): string | undefined {
  return tunnels.get(id)?.boardId;
}

export function createTunnel(t: Tunnel): TunnelInfo {
  db.prepare(
    "INSERT INTO tunnels (id, board_id, machine_id, created_by, key_for_board, key_for_agent, enc_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(t.id, t.boardId, t.machineId, t.createdBy, t.keyForBoard, t.keyForAgent, t.encLabel, Date.now());
  tunnels.set(t.id, t);
  openOnAgent(t);
  const i = info(t);
  broadcastToBoard(t.boardId, { t: "web", web: i });
  return i;
}

export function closeTunnel(boardId: string, id: string): void {
  const t = tunnels.get(id);
  if (!t || t.boardId !== boardId) return;
  dropTunnels([id]);
}

export function dropTunnels(ids: Iterable<string>): void {
  for (const id of ids) {
    const t = tunnels.get(id);
    if (!t) continue;
    sendAgent(t.machineId, { t: "web.close", id });
    closeLinks((l) => l.tunnelId === id, 1001);
    dropTunnelSessions(id);
    tunnels.delete(id);
    db.prepare("DELETE FROM tunnels WHERE id = ?").run(id);
    broadcastToBoard(t.boardId, { t: "web.gone", id });
  }
}

export function dropBoardTunnels(boardId: string): void {
  dropTunnels([...tunnels.values()].filter((t) => t.boardId === boardId).map((t) => t.id));
}

export function dropMachineTunnels(machineId: string): void {
  dropTunnels([...tunnels.values()].filter((t) => t.machineId === machineId).map((t) => t.id));
}

/** Closes the tunnels of a machine that match (access to the machine withdrawn). */
export function dropMachineTunnelsWhere(machineId: string, pred: (t: { boardId: string; createdBy: string | null }) => boolean): void {
  dropTunnels([...tunnels.values()].filter((t) => t.machineId === machineId && pred(t)).map((t) => t.id));
}

/** New keys after a rotation; the agent switches over and old keys stop working. */
export function rekeyTunnel(id: string, keyForBoard: string, keyForAgent: string, encLabel: string): void {
  const t = tunnels.get(id);
  if (!t) return;
  closeLinks((l) => l.tunnelId === id, 1001); // sockets opened with the old key are cut
  dropTunnelSessions(id); // viewers go through the ticket handshake again
  Object.assign(t, { keyForBoard, keyForAgent, encLabel });
  db.prepare("UPDATE tunnels SET key_for_board = ?, key_for_agent = ?, enc_label = ? WHERE id = ?").run(keyForBoard, keyForAgent, encLabel, id);
  openOnAgent(t);
}

// ---- Relay --------------------------------------------------------------------

const RELAY_TIMEOUT = 65_000;
const pending = new Map<string, { machineId: string; resolve: (d: string | null) => void; timer: NodeJS.Timeout }>();

/** Forwards one encrypted request; resolves with the encrypted response, or null (offline / timeout). */
export function relay(id: string, rid: string, ts: number, d: string): Promise<string | null> {
  const t = tunnels.get(id);
  if (!t || !isMachineOnline(t.machineId)) return Promise.resolve(null);
  const key = `${id}/${rid}`;
  if (pending.has(key)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(key);
      resolve(null);
    }, RELAY_TIMEOUT);
    pending.set(key, { machineId: t.machineId, resolve, timer });
    if (!sendAgent(t.machineId, { t: "http", id, rid, ts, d })) {
      clearTimeout(timer);
      pending.delete(key);
      resolve(null);
    }
  });
}

agentHooks.message.push((machineId, msg) => {
  if (msg.t !== "http.res" || typeof msg.d !== "string") return;
  const key = `${msg.id}/${msg.rid}`;
  const p = pending.get(key);
  if (!p || p.machineId !== machineId) return;
  clearTimeout(p.timer);
  pending.delete(key);
  p.resolve(msg.d);
});

agentHooks.hello.push((machineId) => {
  for (const t of tunnels.values()) if (t.machineId === machineId) openOnAgent(t);
  for (const t of tunnels.values()) if (t.machineId === machineId) broadcastToBoard(t.boardId, { t: "web", web: info(t) });
});

// ---- WebSockets ----------------------------------------------------------------
//
// One browser socket per tunnelled-site socket. The server only pairs it with the agent and
// forwards sealed frames ({sid, ts, d}); it cannot read, alter, replay or reorder messages (each
// carries a counter in its AAD), only drop the whole socket.

type Link = { tunnelId: string; sid: string; machineId: string; ws: WebSocket };
const links = new Map<string, Link>(); // `${tunnelId}/${sid}`
const MAX_LINKS_PER_TUNNEL = 64;
const MAX_BUFFERED = 32 * 1024 * 1024;

function closeLinks(match: (l: Link) => boolean, code: number): void {
  for (const [k, l] of links) {
    if (!match(l)) continue;
    links.delete(k);
    l.ws.close(code);
  }
}

// Sockets opened with a tunnel session (subdomain mode): cut when that session ends.
const socketSessions = new Map<WebSocket, string>();

onSessionsDropped((keys) => {
  for (const [ws, k] of socketSessions) if (keys.has(k)) ws.close(1008);
});

/** Keys of the tunnel sessions that have an open socket. */
export const socketSessionKeys = (): Set<string> => new Set(socketSessions.values());

/** Speaks the browser side of a tunnelled WebSocket (shim on the proxy origin). */
export function attachTunnelSocket(ws: WebSocket, tunnelId: string, sessionKey?: string): void {
  let link: Link | undefined;
  if (sessionKey) {
    socketSessions.set(ws, sessionKey);
    ws.on("close", () => socketSessions.delete(ws));
  }
  const fail = (code: number) => ws.close(code);

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return fail(1003);
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return fail(1007);
    }
    const t = tunnels.get(tunnelId);
    if (!t) return fail(1001);
    if (!link) {
      if (msg?.t !== "open" || !isRid(msg.sid) || !Number.isSafeInteger(msg.ts) || typeof msg.d !== "string") return fail(1008);
      const key = `${tunnelId}/${msg.sid}`;
      let n = 0;
      for (const l of links.values()) if (l.tunnelId === tunnelId) n++;
      if (links.has(key) || n >= MAX_LINKS_PER_TUNNEL) return fail(1013);
      const l: Link = { tunnelId, sid: msg.sid, machineId: t.machineId, ws };
      if (!sendAgent(t.machineId, { t: "ws.open", id: tunnelId, sid: msg.sid, ts: msg.ts, d: msg.d })) return fail(1013);
      links.set(key, l);
      link = l;
      return;
    }
    if (msg?.t === "data" && typeof msg.d === "string") {
      if (!sendAgent(link.machineId, { t: "ws.data", id: tunnelId, sid: link.sid, d: msg.d })) fail(1013);
    } else if (msg?.t === "close") {
      sendAgent(link.machineId, { t: "ws.close", id: tunnelId, sid: link.sid, d: typeof msg.d === "string" ? msg.d : undefined });
    } else {
      fail(1008);
    }
  });

  ws.on("close", () => {
    if (!link) return;
    const key = `${tunnelId}/${link.sid}`;
    if (links.get(key) !== link) return;
    links.delete(key);
    sendAgent(link.machineId, { t: "ws.close", id: tunnelId, sid: link.sid });
  });
  ws.on("error", () => ws.terminate());
}

agentHooks.message.push((machineId, msg) => {
  if (msg.t !== "ws.ack" && msg.t !== "ws.data" && msg.t !== "ws.close") return;
  if (typeof msg.id !== "string" || typeof msg.sid !== "string") return;
  const key = `${msg.id}/${msg.sid}`;
  const l = links.get(key);
  if (!l || l.machineId !== machineId) return;
  if (l.ws.bufferedAmount > MAX_BUFFERED) {
    // The browser does not keep up: cut the socket rather than buffering without bound.
    links.delete(key);
    l.ws.terminate();
    sendAgent(machineId, { t: "ws.close", id: msg.id, sid: msg.sid });
    return;
  }
  const d = typeof msg.d === "string" ? msg.d : undefined;
  const type = msg.t.slice(3); // ack | data | close
  l.ws.send(JSON.stringify({ t: type, d }));
  if (msg.t === "ws.close") {
    links.delete(key);
    l.ws.close(1000);
  }
});

agentHooks.disconnect.push((machineId) => closeLinks((l) => l.machineId === machineId, 1012));
