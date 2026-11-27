// Files of a node's machine for the code (and later notebook) windows: find a running local
// shell, read a text file from it, write one back with a check that nobody changed it meanwhile.
// Everything rides on FileClient (sealed with the shell's key); nothing here knows the server.
import { FileClient, FileError } from "./fileTransfer.ts";
import { MAX_CODE_BYTES, sha256Hex, splitPath } from "./codeDoc.ts";
import { isRemoteLabel } from "./shellLabel.ts";
import type { BoardSession } from "./collab.ts";
import type { NodeData } from "./nodeData.ts";

/** What these helpers need from the board session (BoardSession implements it). */
export type ShellHost = Pick<BoardSession, "terminals" | "terminalInput" | "fileRequest" | "fileDrop" | "canEdit">;

/** The running local shells (not Telnet / SSH / kernels) of a node, in the node's order. */
export function localShellIds(session: Pick<BoardSession, "terminals">, node: Pick<NodeData, "shells"> | undefined): string[] {
  if (!node) return [];
  return node.shells
    .map((s) => s.terminalId)
    .filter((id) => {
      const t = session.terminals.get(id);
      return t?.status === "running" && !isRemoteLabel(t.label);
    });
}

/** A FileClient on the first running local shell of the node, with that shell's id; null if none. */
export function pickLocalShell(session: BoardSession, node: Pick<NodeData, "shells"> | undefined): { terminalId: string; client: FileClient } | null {
  const terminalId = localShellIds(session, node)[0];
  return terminalId ? { terminalId, client: new FileClient(session, terminalId) } : null;
}

export type OpenedFile = { text: string; sha: string; size: number };

/** Decodes bytes as UTF-8 text; refuses binary-looking files and big ones. */
export async function decodeText(blob: Blob, limit = MAX_CODE_BYTES): Promise<string> {
  if (blob.size > limit) throw new FileError(`Fichier trop volumineux pour l'éditeur (${limit / 1024 / 1024} Mio au maximum)`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.includes(0)) throw new FileError("Ce fichier est binaire : il ne peut pas être ouvert dans l'éditeur");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FileError("Ce fichier n'est pas en UTF-8 : il ne peut pas être ouvert dans l'éditeur");
  }
}

/**
 * Reads a text file of the machine (path absolute, or relative to the shell's folder). `sha` is
 * the SHA-256 of the text as the editor holds it (UTF-8 of the decoded text), so the editor's
 * dirty state and the conflict check compare like with like.
 */
export async function openMachineFile(client: FileClient, path: string, limit = MAX_CODE_BYTES): Promise<OpenedFile> {
  const { blob } = await client.download(path);
  const text = await decodeText(blob, limit);
  return { text, sha: await sha256Hex(text), size: blob.size };
}

export type SaveReason = "changed" | "exists";
export type SaveOptions = {
  /** Sha of the text last read from / written to the machine (meta.savedSha); undefined for a never-saved file. */
  baseSha?: string;
  /** Asked before overwriting a file that changed on the machine, or that exists and was never ours. false cancels. */
  confirm: (reason: SaveReason) => Promise<boolean>;
  /** Largest file, bytes (default: the code editor's limit). */
  limit?: number;
};

/**
 * Writes `text` to `path` (absolute, or relative to the shell's folder), overwriting. Before that
 * the current machine file is read: when it differs from `baseSha` (or exists while we never
 * saved) the caller confirms. A file that does not exist yet is written without asking.
 * Resolves with the final absolute path and the sha of `text`, or null when the user cancelled.
 */
export async function saveMachineFile(client: FileClient, path: string, text: string, o: SaveOptions): Promise<{ path: string; sha: string } | null> {
  const { dir, name } = splitPath(path);
  const limit = o.limit ?? MAX_CODE_BYTES;
  const listing = await client.ls(dir || undefined);
  const entry = listing.entries.find((e) => e.name === name);
  if (entry?.dir) throw new FileError("C'est un dossier");
  if (entry) {
    let reason: SaveReason | null = null;
    if (o.baseSha === undefined) reason = entry.size === 0 ? null : "exists";
    else if (entry.size > limit) reason = "changed";
    else {
      const current = await openMachineFile(client, path, limit).catch(() => null);
      if (!current || current.sha !== o.baseSha) reason = "changed";
    }
    if (reason && !(await o.confirm(reason))) return null;
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > limit) throw new FileError("Document trop volumineux pour être enregistré");
  const final = await client.upload(new File([bytes], name), { ...(dir ? { dir } : {}), overwrite: true });
  return { path: final, sha: await sha256Hex(text) };
}

/** Types a command line into a shell (as if pasted and validated). */
export function sendCommand(session: ShellHost, terminalId: string, line: string) {
  // No control characters at all: the terminal acts on them (Ctrl-C would cancel the line typed so
  // far and run what follows), whatever the shell quoting around them.
  session.terminalInput(terminalId, `${line.replace(/[\x00-\x1f\x7f]+/g, " ")}\r`);
}
