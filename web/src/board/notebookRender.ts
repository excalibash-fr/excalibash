// How notebook outputs are shown, as data: the window turns these items into DOM nodes (text nodes
// and <img>) or sandboxed iframes, never innerHTML. Pure: tested by notebook.test.ts.
//
// Security model (see docs/SECURITY.md): output content is written by the kernel, i.e. by whatever
// code anybody on the board ran, and by every editor through the shared document. So
//   - text and tracebacks only ever become text nodes;
//   - images are <img src="data:image/(png|jpeg|gif);base64,…"> after a strict charset check;
//   - HTML, SVG, Markdown and JavaScript never touch the app's origin: they go to `frame` items,
//     rendered as <iframe sandbox="" srcdoc="…"> (no scripts, no same-origin, no forms, no popups).
import type { NbOutput } from "./notebookDoc.ts";

export const MAX_RENDER_TEXT = 1024 * 1024;

// ---- ANSI ----------------------------------------------------------------------------------------------------

export type AnsiSpan = { text: string; fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean };

// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b\[([0-9;:]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x1b/g;

const BASIC = ["#1e1e1e", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5"];
const BRIGHT = ["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];

/** The CSS colour of a 256-colour palette index (fixed table: nothing from the output reaches CSS as text). */
export function xterm256(n: number): string {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const i = n - 16;
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

/** Text without escape sequences (every kind: colours, cursor moves, OSC). */
export const stripAnsi = (s: string): string => s.replace(ESC_RE, "");

/** Text cut into spans carrying the SGR colours / styles; every other escape sequence is dropped. */
export function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let st: Omit<AnsiSpan, "text"> = {};
  let last = 0;
  const push = (t: string) => {
    if (t) spans.push({ text: t, ...st });
  };
  for (const m of text.matchAll(ESC_RE)) {
    push(text.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[2] !== "m") continue;
    const codes = m[1] === "" ? [0] : m[1].split(/[;:]/).map((x) => (x === "" ? 0 : Number(x)));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (!Number.isFinite(c)) continue;
      if (c === 0) st = {};
      else if (c === 1) st = { ...st, bold: true };
      else if (c === 2) st = { ...st, dim: true };
      else if (c === 3) st = { ...st, italic: true };
      else if (c === 4) st = { ...st, underline: true };
      else if (c === 22) st = { ...st, bold: false, dim: false };
      else if (c === 23) st = { ...st, italic: false };
      else if (c === 24) st = { ...st, underline: false };
      else if (c >= 30 && c <= 37) st = { ...st, fg: BASIC[c - 30] };
      else if (c === 39) st = { ...st, fg: undefined };
      else if (c >= 40 && c <= 47) st = { ...st, bg: BASIC[c - 40] };
      else if (c === 49) st = { ...st, bg: undefined };
      else if (c >= 90 && c <= 97) st = { ...st, fg: BRIGHT[c - 90] };
      else if (c >= 100 && c <= 107) st = { ...st, bg: BRIGHT[c - 100] };
      else if (c === 38 || c === 48) {
        const key = c === 38 ? "fg" : "bg";
        if (codes[i + 1] === 5 && Number.isInteger(codes[i + 2]) && codes[i + 2] >= 0 && codes[i + 2] <= 255) {
          st = { ...st, [key]: xterm256(codes[i + 2]) };
          i += 2;
        } else if (codes[i + 1] === 2 && [2, 3, 4].every((k) => Number.isInteger(codes[i + k]) && codes[i + k] >= 0 && codes[i + k] <= 255)) {
          st = { ...st, [key]: `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})` };
          i += 4;
        }
      }
    }
  }
  push(text.slice(last));
  return spans;
}

/** Terminal-style carriage returns: "abc\rd" shows "dbc" (progress bars rewrite their line). */
export function collapseCarriage(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const buf: string[] = [];
      for (const seg of line.split("\r")) [...seg].forEach((ch, i) => (buf[i] = ch));
      return buf.join("");
    })
    .join("\n");
}

// ---- images and frames -------------------------------------------------------------------------------------------

/** base64 payload: only the base64 alphabet (whitespace aside). Returns it without whitespace, or null. */
export function cleanBase64(s: string): string | null {
  const t = s.replace(/\s+/g, "");
  return t.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(t) ? t : null;
}

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif"] as const;

/**
 * Removes every <meta> tag. Repeated until nothing changes: one pass over "<me<meta>ta …>" would
 * leave a whole "<meta …>" behind. An unclosed one at the end goes too (the closing tags we add
 * after the body would otherwise end it).
 */
export function stripMeta(html: string): string {
  for (;;) {
    // <link> (dns-prefetch, preload…) and <base> go too: the frame's CSP does not cover every one of them.
    const next = html.replace(/<\/?\s*(meta|link|base)\b[^>]*(>|$)/gi, "");
    if (next === html) return html;
    html = next;
  }
}

/**
 * The document inside a sandboxed frame. The sandbox attribute (empty) is what protects; the CSP meta
 * is a second wall (no script, no network, only data: images) and the page can't loosen it.
 */
export function frameDoc(body: string, dark: boolean): string {
  const fg = dark ? "#e5e7eb" : "#111827";
  // CSP doesn't govern <meta http-equiv="refresh">: an output could otherwise send every viewer's
  // frame to an outside URL on its own (leaking their IP). Notebook content gets no <meta> at all,
  // and links can't navigate the frame either: <base> sends them to a new window, which the sandbox refuses.
  body = stripMeta(body);
  return (
    `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">` +
    `<style>html,body{margin:0;padding:6px;font:13px/1.45 system-ui,sans-serif;color:${fg};background:transparent}` +
    `img,svg{max-width:100%}table{border-collapse:collapse}th,td{border:1px solid #8885;padding:2px 6px}pre,code{font-family:ui-monospace,monospace}` +
    `a{color:inherit}h1,h2,h3,h4{margin:.3em 0 .3em}p{margin:.4em 0}</style></head><body>${body}</body></html>`
  );
}

/**
 * A height for a frame, in pixels: a sandboxed frame without script can't report its content size, so
 * it is guessed from the markup (rows of a table, blocks, lines, the declared height of an SVG) and
 * bounded; what does not fit scrolls, and the frame can be resized by hand.
 */
export function frameHeight(kind: "html" | "svg" | "text", content: string): number {
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));
  if (kind === "svg") {
    const m = /<svg\b[^>]*?\sheight\s*=\s*["']?(\d{1,5})/i.exec(content);
    return m ? clamp(Number(m[1]) + 36, 48, 480) : 240;
  }
  if (kind === "text") {
    const rows = content.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 80)), 0);
    const headings = (content.match(/^#{1,6}\s/gm) ?? []).length;
    return clamp(rows * 22 + headings * 22 + 44, 56, 460);
  }
  const trs = (content.match(/<tr[\s>]/gi) ?? []).length;
  const blocks = (content.match(/<(p|div|li|h[1-6]|br|pre|ul|ol|table|img)[\s>/]/gi) ?? []).length;
  const rows = Math.max(trs, blocks, 1) + Math.floor(content.replace(/<[^>]*>/g, "").length / 120);
  return clamp(rows * 26 + 24, 48, 420);
}

// ---- classification --------------------------------------------------------------------------------------------

export type RenderItem =
  | { kind: "text"; text: string; stream?: "stdout" | "stderr" }
  | { kind: "error"; ename: string; evalue: string; traceback: string }
  | { kind: "image"; mime: (typeof IMAGE_MIMES)[number]; src: string }
  /** To be rendered ONLY as <iframe sandbox="" srcdoc={srcdoc}>. */
  | { kind: "frame"; label: string; srcdoc: string; height: number }
  | { kind: "note"; text: string };

export type RenderOptions = {
  /** Markdown → HTML (marked); without it markdown is shown as plain text. The result only goes into a sandboxed frame. */
  markdown?: (md: string) => string;
  dark?: boolean;
  maxText?: number;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** One MIME bundle → the item that shows it best, never anything that runs. */
export function classifyBundle(data: Record<string, unknown>, o: RenderOptions = {}): RenderItem | null {
  const dark = !!o.dark;
  const has = (k: string) => typeof data[k] === "string" && (data[k] as string).length > 0;
  if (has("text/html")) return { kind: "frame", label: "HTML", srcdoc: frameDoc(str(data["text/html"]), dark), height: frameHeight("html", str(data["text/html"])) };
  if (has("text/markdown")) {
    const md = str(data["text/markdown"]);
    return { kind: "frame", label: "Markdown", srcdoc: frameDoc(o.markdown ? o.markdown(md) : `<pre>${escapeHtml(md)}</pre>`, dark), height: frameHeight("text", md) };
  }
  if (has("image/svg+xml")) return { kind: "frame", label: "SVG", srcdoc: frameDoc(str(data["image/svg+xml"]), dark), height: frameHeight("svg", str(data["image/svg+xml"])) };
  for (const mime of IMAGE_MIMES) {
    if (!has(mime)) continue;
    const b64 = cleanBase64(str(data[mime]));
    if (b64) return { kind: "image", mime, src: `data:${mime};base64,${b64}` };
    return { kind: "note", text: `[image invalide ignorée : ${mime}]` };
  }
  if (has("text/latex")) return { kind: "text", text: str(data["text/latex"]) };
  if (has("application/json")) {
    try {
      return { kind: "text", text: JSON.stringify(JSON.parse(str(data["application/json"])), null, 2) };
    } catch {
      return { kind: "text", text: str(data["application/json"]) };
    }
  }
  if (has("text/plain")) return { kind: "text", text: str(data["text/plain"]) };
  if (has("application/javascript")) {
    // Never executed: the code is only displayed, in a frame, with the others of its kind.
    return { kind: "frame", label: "JavaScript (non exécuté)", srcdoc: frameDoc(`<pre>${escapeHtml(str(data["application/javascript"]))}</pre>`, dark), height: frameHeight("text", str(data["application/javascript"])) };
  }
  if (Object.keys(data).some((k) => k.startsWith("application/vnd.jupyter.widget"))) return { kind: "note", text: "[widget Jupyter : non pris en charge]" };
  return null;
}

/** The list of outputs of a cell as render items; text is capped (and said so). */
export function classifyOutputs(outputs: readonly NbOutput[], o: RenderOptions = {}): RenderItem[] {
  const max = o.maxText ?? MAX_RENDER_TEXT;
  const items: RenderItem[] = [];
  let budget = max;
  let truncated = false;
  const take = (text: string): string => {
    if (text.length <= budget) {
      budget -= text.length;
      return text;
    }
    const cut = text.slice(0, Math.max(0, budget));
    budget = 0;
    truncated = true;
    return cut;
  };
  // Consecutive streams of one name read as one text, like in Jupyter.
  let cur = null as { stream: "stdout" | "stderr"; text: string } | null;
  const flush = () => {
    if (cur) {
      const t = take(collapseCarriage(cur.text));
      if (t) items.push({ kind: "text", text: t, stream: cur.stream });
      cur = null;
    }
  };
  for (const out of outputs) {
    if (truncated) break;
    switch (out.output_type) {
      case "stream": {
        const name = out.name === "stderr" ? "stderr" : "stdout";
        const text = str(out.text);
        if (cur && cur.stream === name) cur.text += text;
        else (flush(), (cur = { stream: name, text }));
        break;
      }
      case "error": {
        flush();
        const tb = Array.isArray(out.traceback) ? out.traceback.map(String).join("\n") : "";
        const text = stripAnsi(tb);
        items.push({ kind: "error", ename: stripAnsi(str(out.ename)), evalue: stripAnsi(str(out.evalue)), traceback: take(text) });
        break;
      }
      case "display_data":
      case "execute_result": {
        flush();
        const item = classifyBundle(out.data && typeof out.data === "object" ? out.data : {}, o);
        if (!item) break;
        if (item.kind === "text") item.text = take(item.text);
        items.push(item);
        break;
      }
    }
  }
  flush();
  if (truncated) items.push({ kind: "note", text: "[sortie tronquée]" });
  return items;
}

/** Markdown cell → the document of its sandboxed frame. */
export function markdownFrame(md: string, render: ((md: string) => string) | undefined, dark: boolean): string {
  const capped = md.length > MAX_RENDER_TEXT ? md.slice(0, MAX_RENDER_TEXT) : md;
  return frameDoc(render ? render(capped) : `<pre style="white-space:pre-wrap">${escapeHtml(capped)}</pre>`, dark);
}
