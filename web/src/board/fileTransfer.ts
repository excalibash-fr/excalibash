// Browser side of file transfers and packet captures (agent/files.go). Everything rides on a
// local-shell terminal and is sealed with its key; the server only relays opaque frames. Names,
// paths, contents, interfaces and filters never leave a box.
import { fromB64, randomId, sha256Hex, toB64 } from "../crypto.ts";
import { FILTER_TOKEN_RE } from "../validators.ts";
import type { BoardSession } from "./collab.ts";
import { OutdatedError, supports, type Feature } from "../agentCaps.ts";
import { reportOutdated } from "../outdatedBus.ts";

/** Same limits as the agent. */
export const MAX_FILE = 200 * 1024 * 1024;
export const CHUNK = 192 * 1024;
const WINDOW = 8;
/** Silence between two frames of a transfer, and the wait for the answer to a chunk (the agent may be writing to disk). */
const REPLY_TIMEOUT = 70_000;
/** The first answer of an operation: an agent that is offline, or too old to know the frame, never answers. */
export const FIRST_REPLY_TIMEOUT = 10_000;
const NO_ANSWER = "La machine ne répond pas : agent hors ligne ou trop ancien";

/** Why a BPF filter is refused, or null. */
export function filterProblem(filter: string): string | null {
  const tokens = filter.split(/\s+/).filter(Boolean);
  if (tokens.length > 32) return "32 mots au maximum";
  const bad = tokens.find((t) => t.startsWith("-") || !FILTER_TOKEN_RE.test(t));
  return bad ? `« ${bad.slice(0, 30)} » n'est pas autorisé (lettres, chiffres et . _ : / ! ( ) & | < > = -, sans option)` : null;
}

export function validName(name: string): boolean {
  return !!name && name !== "." && name !== ".." && !/[/\\\0]/.test(name) && new TextEncoder().encode(name).length <= 255;
}

export class FileError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export type Entry = { name: string; dir: boolean; size: number; mtime: number };
export type Listing = { cwd: string; entries: Entry[]; truncated: boolean };
export type MachineIface = { name: string; up: boolean; addrs: string[] };


/** `aborted` cancels a transfer; `stop` ends a capture early and keeps what was captured. */
export type Signal = { aborted: boolean; stop?: boolean };

/** The file operations of one local shell. */
export class FileClient {
  private session: BoardSession;
  private term: string;

  constructor(session: BoardSession, term: string) {
    this.session = session;
    this.term = term;
  }

  /** The terminal this client talks through (a stable identity: the client itself is cheap and rebuilt often). */
  get terminal(): string {
    return this.term;
  }

  /**
   * Refuses early, with the update instructions, what the machine's agent announced it cannot do.
   * Unknown terminals and hosts without a terminal list are not judged (the agent will answer).
   */
  private gate(feature: Feature) {
    const t = this.session.terminals?.get(this.term);
    if (!t || supports(t.agentCaps, feature)) return;
    const e = new OutdatedError(t.label || "cette machine", feature);
    reportOutdated(e);
    throw e;
  }

  /** Why the agent of this shell cannot do this (too old), or null. Same check as the operations, without raising anything. */
  refusal(feature: Feature): OutdatedError | null {
    const t = this.session.terminals?.get(this.term);
    return !t || supports(t.agentCaps, feature) ? null : new OutdatedError(t.label || "cette machine", feature);
  }

  /** One request, one answer. */
  private call(op: object): Promise<any> {
    const op0 = (op as { op?: string }).op;
    const timeout = op0 === "chunk" || op0 === "end" ? REPLY_TIMEOUT : FIRST_REPLY_TIMEOUT;
    return new Promise((resolve, reject) => {
      let rid: string | undefined;
      const timer = setTimeout(() => {
        if (rid) this.session.fileDrop(rid);
        reject(new FileError(timeout === REPLY_TIMEOUT ? "La machine ne répond pas" : NO_ANSWER));
      }, timeout);
      const done = (f: () => void) => {
        clearTimeout(timer);
        f();
      };
      this.session
        .fileRequest(
          this.term,
          op,
          (_n, body) => done(() => (body?.error ? reject(new FileError(String(body.error), body.code)) : resolve(body))),
          (m) => done(() => reject(new FileError(m))),
        )
        .then((r) => (rid = r))
        .catch((e) => done(() => reject(new FileError(e.message))));
    });
  }

  /** The network interfaces of the machine (names, state, addresses), for the capture panel. */
  async ifaces(): Promise<MachineIface[]> {
    this.gate("ifaces");
    const b = await this.call({ op: "ifaces" });
    const list: unknown[] = Array.isArray(b.ifaces) ? b.ifaces : [];
    return list
      .filter((i: any) => i && typeof i.name === "string" && i.name)
      .map((i: any) => ({ name: i.name, up: i.up === true, addrs: Array.isArray(i.addrs) ? i.addrs.filter((a: unknown) => typeof a === "string") : [] }));
  }

  async ls(path?: string): Promise<Listing> {
    this.gate("files");
    const b = await this.call({ op: "ls", ...(path ? { path } : {}) });
    return { cwd: String(b.cwd), entries: Array.isArray(b.entries) ? b.entries : [], truncated: !!b.truncated };
  }

  /** Uploads into `dir` (default: the shell's working directory). Resolves with the final path. */
  async upload(file: File, o: { dir?: string; overwrite?: boolean; onProgress?: (done: number, total: number) => void; signal?: Signal } = {}): Promise<string> {
    this.gate("files");
    if (!validName(file.name)) throw new FileError("Nom de fichier non pris en charge");
    if (file.size > MAX_FILE) throw new FileError("Fichier trop volumineux (200 Mio au maximum)");
    const xfer = randomId();
    const cancel = () => this.session.fileRequest(this.term, { op: "cancel", xfer }).catch(() => {});
    await this.call({ op: "put", xfer, name: file.name, size: file.size, ...(o.dir ? { dir: o.dir } : {}), ...(o.overwrite ? { overwrite: true } : {}) });
    let sent = 0;
    try {
      const inflight = new Set<Promise<void>>();
      let failure: unknown;
      for (let off = 0, n = 0; off < file.size; off += CHUNK, n++) {
        if (o.signal?.aborted) throw new FileError("Transfert annulé");
        if (failure) throw failure;
        while (inflight.size >= WINDOW) await Promise.race(inflight);
        if (failure) throw failure;
        const part = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
        const p: Promise<void> = this.call({ op: "chunk", xfer, n, data: toB64(part) }).then(
          () => {
            sent += part.length;
            o.onProgress?.(sent, file.size);
          },
          (e) => {
            failure ??= e;
          },
        ).finally(() => inflight.delete(p));
        inflight.add(p);
      }
      await Promise.all(inflight);
      if (failure) throw failure;
      if (o.signal?.aborted) throw new FileError("Transfert annulé");
      const b = await this.call({ op: "end", xfer, sha256: await sha256Hex(await file.arrayBuffer()) });
      return String(b.path);
    } catch (e) {
      cancel();
      throw e;
    }
  }

  /** Streams `get` or `capture` answers into a Blob, acknowledging as chunks arrive. */
  private stream(op: { op: string } & Record<string, unknown>, mime: string, o: { onProgress?: (bytes: number, total?: number) => void; signal?: Signal }): Promise<{ name: string; blob: Blob }> {
    try {
      this.gate(op.op === "capture" ? "capture" : "files");
    } catch (e) {
      return Promise.reject(e);
    }
    const xfer = randomId();
    return new Promise((resolve, reject) => {
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let name = "fichier";
      let total: number | undefined;
      let bytes = 0;
      let finished = false;
      let rid: string | undefined;
      let timer: ReturnType<typeof setTimeout>;
      let poll: ReturnType<typeof setInterval>;
      const finish = (f: () => void, cancel = false) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearInterval(poll);
        if (cancel) {
          if (rid) this.session.fileDrop(rid);
          this.session.fileRequest(this.term, { op: "cancel", xfer }).catch(() => {});
        }
        f();
      };
      let answered = false;
      const arm = () => {
        clearTimeout(timer);
        const first = !answered;
        timer = setTimeout(() => finish(() => reject(new FileError(first ? NO_ANSWER : "La machine ne répond plus")), true), first ? FIRST_REPLY_TIMEOUT : REPLY_TIMEOUT);
      };
      arm();
      let stopSent = false;
      poll = setInterval(() => {
        if (o.signal?.aborted) finish(() => reject(new FileError("Transfert annulé")), true);
        else if (o.signal?.stop && !stopSent) {
          stopSent = true;
          this.session.fileRequest(this.term, { op: "stop", xfer }).catch(() => {});
        }
      }, 200);
      this.session
        .fileRequest(
          this.term,
          { ...op, xfer },
          (n, body, end) => {
            if (finished) return;
            answered = true;
            arm();
            if (body?.error) return finish(() => reject(new FileError(String(body.error), body.code)));
            if (typeof body.name === "string") name = body.name;
            if (typeof body.size === "number" && n === 0 && op.op === "get") total = body.size;
            if (typeof body.data === "string" && body.data) {
              const raw = fromB64(body.data);
              parts.push(raw);
              bytes += raw.length;
              o.onProgress?.(bytes, total);
            }
            if (!end) {
              // Acknowledge, so the agent keeps sending (it waits after a few unacknowledged chunks).
              this.session.fileRequest(this.term, { op: "ack", xfer, n: n + 1 }).catch(() => {});
              return;
            }
            const blob = new Blob(parts, { type: mime });
            blob.arrayBuffer().then(async (buf) => {
              // "end" is on the clear envelope: only the sealed last frame (with size and hash) proves the end.
              if (body.end !== true || typeof body.size !== "number" || typeof body.sha256 !== "string") return finish(() => reject(new FileError("Transfert incomplet")));
              if (body.size !== bytes) return finish(() => reject(new FileError("Transfert incomplet")));
              if (body.sha256 !== (await sha256Hex(buf))) return finish(() => reject(new FileError("Empreinte SHA-256 incorrecte : fichier corrompu")));
              finish(() => resolve({ name, blob }));
            });
          },
          (m) => finish(() => reject(new FileError(m))),
        )
        .then((r) => (rid = r))
        .catch((e) => finish(() => reject(new FileError(e.message))));
    });
  }

  download(path: string, o: { onProgress?: (bytes: number, total?: number) => void; signal?: Signal } = {}) {
    return this.stream({ op: "get", path }, "application/octet-stream", o);
  }

  capture(spec: { iface: string; filter?: string; seconds: number; maxBytes: number }, o: { onProgress?: (bytes: number) => void; signal?: Signal } = {}) {
    return this.stream({ op: "capture", ...spec }, "application/vnd.tcpdump.pcap", o);
  }
}
