// Browser-side terminal tools: plain-text history export and asciinema recording. Nothing here
// touches the network; the decrypted output is only kept in memory until the user saves it.
import type { Terminal } from "@xterm/xterm";

/** A recording stops by itself past this size (characters kept in memory). */
export const CAST_MAX_BYTES = 20 * 1024 * 1024;

const pad = (n: number) => String(n).padStart(2, "0");

/** `<title>-YYYYMMDD-HHMMSS.<ext>`, safe as a file name. */
export function exportName(title: string, ext: string, now = new Date()) {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const slug = title.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "terminal";
  return `${slug}-${stamp}.${ext}`;
}

/** The whole buffer (scrollback and screen) as plain text; wrapped rows are joined back. */
export function bufferToText(term: Terminal): string {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const next = i + 1 < buf.length ? buf.getLine(i + 1) : undefined;
    // Keep the trailing blanks of a row that continues on the next one.
    const text = line.translateToString(!next?.isWrapped);
    if (line.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join("\n") + "\n";
}

/** asciinema v2 (.cast): a JSON header, then one `[elapsed, code, data]` event per line. */
export class CastRecorder {
  private lines: string[];
  private size = 0;
  private decoder = new TextDecoder();
  private t0 = performance.now();

  constructor(cols: number, rows: number, title: string) {
    this.lines = [JSON.stringify({ version: 2, width: cols, height: rows, timestamp: Math.floor(Date.now() / 1000), title })];
  }

  private push(code: "o" | "r", data: string): boolean {
    const line = JSON.stringify([Number(((performance.now() - this.t0) / 1000).toFixed(6)), code, data]);
    this.lines.push(line);
    this.size += line.length;
    return this.size < CAST_MAX_BYTES;
  }

  /** Appends output; false once the size cap is reached. `reset` marks a replay (screen cleared first). */
  output(data: Uint8Array, reset = false): boolean {
    if (reset) this.decoder = new TextDecoder();
    const text = this.decoder.decode(data, { stream: true });
    if (!text && !reset) return true;
    return this.push("o", reset ? "\x1bc" + text : text);
  }

  resize(cols: number, rows: number) {
    this.push("r", `${cols}x${rows}`);
  }

  blob() {
    return new Blob([this.lines.join("\n") + "\n"], { type: "application/x-asciicast" });
  }
}
