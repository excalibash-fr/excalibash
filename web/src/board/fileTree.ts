// Pure rules of the code window's file explorer: paths, ordering and the flattened rows of the
// tree. The component (CodeExplorer.tsx) only fetches listings and draws what this returns.
import { joinPath } from "./codeDoc.ts";
import type { Entry } from "./fileTransfer.ts";

/** The folder above `dir` ("/" stays "/"; a relative or empty path has none: null). */
export function parentDir(dir: string): string | null {
  if (!dir.startsWith("/")) return null;
  const d = dir.replace(/\/+$/, "");
  const i = d.lastIndexOf("/");
  return i <= 0 ? "/" : d.slice(0, i);
}

/** Path of a child, given the listing path of its folder. */
export const childPath = (dir: string, name: string): string => joinPath(dir === "/" ? "" : dir, name).replace(/^(?!\/)/, "/");

/** Folders first, then files; each group alphabetical, case-insensitively and with numbers in order. */
export function sortEntries(entries: readonly Entry[]): Entry[] {
  const collate = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  return [...entries].sort((a, b) => Number(b.dir) - Number(a.dir) || collate.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** What is known of one folder: its sorted entries, or why it could not be listed. */
export type Folder = { entries: Entry[]; truncated: boolean } | { error: string };

export type TreeState = {
  /** Listed folders by absolute path (the cache: a folder is fetched once until refreshed). */
  folders: Map<string, Folder>;
  /** Folders being fetched. */
  loading: Set<string>;
  /** Folders opened (their children shown). */
  expanded: Set<string>;
};

export const emptyTree = (): TreeState => ({ folders: new Map(), loading: new Set(), expanded: new Set() });

export type Row = {
  path: string;
  name: string;
  dir: boolean;
  depth: number;
  open: boolean;
  loading: boolean;
  /** Set on a pseudo-row that explains an unreadable, empty or cut-short folder. */
  note?: string;
};

/** The visible rows under `root`, depth first, following the expanded folders. */
export function flatten(root: string, t: TreeState): Row[] {
  const out: Row[] = [];
  const walk = (dir: string, depth: number) => {
    const f = t.folders.get(dir);
    if (!f) return;
    const note = (text: string) => out.push({ path: `${dir}\0note`, name: text, dir: false, depth, open: false, loading: false, note: text });
    if ("error" in f) return note(f.error);
    if (!f.entries.length) return note("Dossier vide");
    for (const e of f.entries) {
      const path = childPath(dir, e.name);
      const open = e.dir && t.expanded.has(path);
      out.push({ path, name: e.name, dir: e.dir, depth, open, loading: e.dir && t.loading.has(path) });
      if (open) walk(path, depth + 1);
    }
    if (f.truncated) note("Liste tronquée");
  };
  walk(root, 0);
  return out;
}

const without = (s: Set<string>, v: string) => {
  const n = new Set(s);
  n.delete(v);
  return n;
};

/** Stores a fresh listing in the cache (entries sorted); returns a new state. */
export const withListing = (t: TreeState, dir: string, entries: readonly Entry[], truncated: boolean): TreeState => ({
  ...t,
  folders: new Map(t.folders).set(dir, { entries: sortEntries(entries), truncated }),
  loading: without(t.loading, dir),
});

export const withError = (t: TreeState, dir: string, error: string): TreeState => ({
  ...t,
  folders: new Map(t.folders).set(dir, { error }),
  loading: without(t.loading, dir),
});

export const withLoading = (t: TreeState, dir: string): TreeState => ({ ...t, loading: new Set(t.loading).add(dir) });

export function toggled(t: TreeState, dir: string): TreeState {
  const expanded = new Set(t.expanded);
  if (!expanded.delete(dir)) expanded.add(dir);
  return { ...t, expanded };
}
