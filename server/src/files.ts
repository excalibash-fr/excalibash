import { WebSocket } from "ws";
import { agentHooks, sendAgent, terminalMachine, terminalMachineOf } from "./terminals.ts";
import { isRid } from "./validate.ts";

// File transfers and packet captures ride on a local-shell terminal and are authorised by its
// key. The server relays blind: it checks that the requester may type in the terminal (editor),
// forwards the sealed request to the machine's agent, and sends each sealed answer back to the
// socket that asked, and to nobody else. Names, paths, contents, interfaces and filters are
// inside the boxes; the server only sees frame sizes and timing.

/** Largest accepted sealed request (base64): a 192 KiB chunk is about 350 KB once boxed twice. */
const MAX_FRAME = 400 * 1024;
/** Requests waiting for an answer, per board. */
const MAX_PER_BOARD = 32;
/** An answer stream with no frame for this long is forgotten. */
const IDLE_MS = 90_000;
/** A client that does not read its socket gets its transfer cancelled past this backlog. */
const MAX_BUFFERED = 8 * 1024 * 1024;

type Pending = { ws: WebSocket; boardId: string; term: string; machineId: string; timer: NodeJS.Timeout };
const pending = new Map<string, Pending>();
const byWs = new Map<WebSocket, Set<string>>();

function forget(rid: string): void {
  const p = pending.get(rid);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(rid);
  byWs.get(p.ws)?.delete(rid);
}

function arm(rid: string, p: Pending): void {
  clearTimeout(p.timer);
  p.timer = setTimeout(() => forget(rid), IDLE_MS);
  p.timer.unref();
}

function refuse(ws: WebSocket, rid: unknown, message: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "file.err", rid: typeof rid === "string" ? rid.slice(0, 64) : undefined, message }));
}

/**
 * One `file.req {term, rid, ts, d, nr?}` from a board socket. `nr` marks frames that expect no
 * answer (acknowledgements, cancellations): they are relayed without being tracked.
 */
export function fileRequest(ws: WebSocket, boardId: string, editor: boolean, msg: any): void {
  if (!isRid(msg.rid)) return refuse(ws, undefined, "Requête invalide");
  const rid: string = msg.rid;
  if (!editor) return refuse(ws, rid, "Lecture seule : transfert refusé");
  if (typeof msg.term !== "string" || !Number.isSafeInteger(msg.ts) || typeof msg.d !== "string" || msg.d.length === 0 || msg.d.length > MAX_FRAME) {
    return refuse(ws, rid, "Requête invalide");
  }
  const machineId = terminalMachine(boardId, msg.term);
  if (!machineId) return refuse(ws, rid, "Terminal introuvable ou arrêté");
  const track = msg.nr !== true;
  if (track) {
    if (pending.has(rid)) return refuse(ws, rid, "Requête déjà en cours");
    let waiting = 0;
    for (const p of pending.values()) if (p.boardId === boardId) waiting++;
    if (waiting >= MAX_PER_BOARD) return refuse(ws, rid, "Trop de transferts en cours sur ce tableau");
  }
  if (!sendAgent(machineId, { t: "file", id: msg.term, rid, ts: msg.ts, d: msg.d })) return refuse(ws, rid, "Machine hors ligne");
  if (!track) return;
  const p: Pending = { ws, boardId, term: msg.term, machineId, timer: undefined as unknown as NodeJS.Timeout };
  pending.set(rid, p);
  arm(rid, p);
  let mine = byWs.get(ws);
  if (!mine) {
    mine = new Set();
    byWs.set(ws, mine);
    ws.once("close", () => {
      for (const r of [...(byWs.get(ws) ?? [])]) forget(r);
      byWs.delete(ws);
    });
  }
  mine.add(rid);
}

agentHooks.message.push((machineId, msg) => {
  if (msg.t !== "file.res" || typeof msg.rid !== "string" || typeof msg.d !== "string" || !Number.isSafeInteger(msg.n)) return;
  const p = pending.get(msg.rid);
  // Only the machine of the terminal that was asked may answer, and only the asker hears it.
  if (!p || p.machineId !== machineId || p.term !== msg.id || terminalMachineOf(p.term) !== machineId) return;
  if (p.ws.readyState !== WebSocket.OPEN) return forget(msg.rid);
  if (p.ws.bufferedAmount > MAX_BUFFERED) {
    forget(msg.rid);
    return refuse(p.ws, msg.rid, "Connexion trop lente : transfert annulé");
  }
  const end = msg.end === true;
  p.ws.send(JSON.stringify({ t: "file.res", id: msg.id, rid: msg.rid, n: msg.n, d: msg.d, end: end || undefined }));
  if (end) forget(msg.rid);
  else arm(msg.rid, p);
});
