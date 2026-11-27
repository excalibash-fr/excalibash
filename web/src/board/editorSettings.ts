// Per-user editor preferences for code windows and notebook cells. Local to the browser: never written to the
// shared document nor sent to the server.
import { useSyncExternalStore } from "react";
import type * as Monaco from "monaco-editor";

export type WhitespaceMode = "none" | "selection" | "all";
export type SuggestMode = "auto" | "on" | "off";

export interface EditorSettings {
  fontSize: number;
  tabSize: 2 | 4 | 8;
  insertSpaces: boolean;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  renderWhitespace: WhitespaceMode;
  /** "auto": what the language gives (on, except Python bound to a kernel, which completes on demand). */
  quickSuggestions: SuggestMode;
  bracketPairColorization: boolean;
}

export const FONT_MIN = 10;
export const FONT_MAX = 24;
export const TAB_SIZES = [2, 4, 8] as const;
export const WHITESPACE_MODES = ["none", "selection", "all"] as const;
export const SUGGEST_MODES = ["auto", "on", "off"] as const;
export const STORAGE_KEY = "excalibash.editorSettings";

export const DEFAULT_SETTINGS: Readonly<EditorSettings> = Object.freeze({
  fontSize: 13,
  tabSize: 4,
  insertSpaces: true,
  wordWrap: false,
  minimap: false,
  lineNumbers: true,
  renderWhitespace: "selection",
  quickSuggestions: "auto",
  bracketPairColorization: true,
});

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** Turns anything (untrusted JSON, an older version) into a complete, in-bounds set of settings. */
export function normalizeSettings(raw: unknown): EditorSettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;
  const size = typeof o.fontSize === "number" && Number.isFinite(o.fontSize) ? Math.round(o.fontSize) : d.fontSize;
  return {
    fontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, size)),
    tabSize: (TAB_SIZES as readonly unknown[]).includes(o.tabSize) ? (o.tabSize as EditorSettings["tabSize"]) : d.tabSize,
    insertSpaces: bool(o.insertSpaces, d.insertSpaces),
    wordWrap: bool(o.wordWrap, d.wordWrap),
    minimap: bool(o.minimap, d.minimap),
    lineNumbers: bool(o.lineNumbers, d.lineNumbers),
    renderWhitespace: (WHITESPACE_MODES as readonly unknown[]).includes(o.renderWhitespace) ? (o.renderWhitespace as WhitespaceMode) : d.renderWhitespace,
    quickSuggestions: (SUGGEST_MODES as readonly unknown[]).includes(o.quickSuggestions) ? (o.quickSuggestions as SuggestMode) : d.quickSuggestions,
    bracketPairColorization: bool(o.bracketPairColorization, d.bracketPairColorization),
  };
}

/** Parses a stored string; a missing or corrupted value gives the defaults. */
export function parseSettings(text: string | null | undefined): EditorSettings {
  if (!text) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function sameSettings(a: EditorSettings, b: EditorSettings): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as (keyof EditorSettings)[]).every((k) => a[k] === b[k]);
}

/**
 * Editor-level options. Notebook cells keep their compact layout (always wrapped, no gutter, no minimap).
 * `autoSuggest` is what "auto" means for this editor: off for Python bound to a kernel (see pyKernel.ts), on otherwise.
 */
export function editorOptions(s: EditorSettings, notebook = false, autoSuggest = true): Monaco.editor.IEditorOptions {
  const suggest = s.quickSuggestions === "auto" ? autoSuggest : s.quickSuggestions === "on";
  return {
    fontSize: s.fontSize,
    renderWhitespace: s.renderWhitespace,
    quickSuggestions: suggest ? { other: true, comments: false, strings: false } : false,
    bracketPairColorization: { enabled: s.bracketPairColorization },
    ...(notebook ? {} : { wordWrap: s.wordWrap ? "on" : "off", minimap: { enabled: s.minimap }, lineNumbers: s.lineNumbers ? "on" : "off" }),
  } as Monaco.editor.IEditorOptions;
}

/** Model-level options (indentation). */
export function modelOptions(s: EditorSettings): Monaco.editor.ITextModelUpdateOptions {
  return { tabSize: s.tabSize, insertSpaces: s.insertSpaces };
}

/** Applies the settings to a live editor without recreating it. */
export function applyEditorSettings(editor: Monaco.editor.IStandaloneCodeEditor, s: EditorSettings, notebook = false, autoSuggest = true): void {
  editor.updateOptions(editorOptions(s, notebook, autoSuggest));
  editor.getModel()?.updateOptions(modelOptions(s));
}

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** A subscribable settings store over an optional storage (which may be missing or throw). */
export function createSettingsStore(getStorage: () => KV | null) {
  const storage = (): KV | null => {
    try {
      return getStorage();
    } catch {
      return null;
    }
  };
  const read = (): EditorSettings => {
    try {
      return parseSettings(storage()?.getItem(STORAGE_KEY));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  };
  let current = read();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const set = (next: EditorSettings) => {
    if (sameSettings(next, current)) return;
    current = next;
    try {
      if (sameSettings(next, DEFAULT_SETTINGS)) storage()?.removeItem(STORAGE_KEY);
      else storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable: the choice stays valid for this session */
    }
    emit();
  };
  return {
    get: () => current,
    update: (patch: Partial<EditorSettings>) => set(normalizeSettings({ ...current, ...patch })),
    reset: () => set({ ...DEFAULT_SETTINGS }),
    /** Re-reads the storage (another tab changed it). */
    refresh: () => {
      const next = read();
      if (!sameSettings(next, current)) {
        current = next;
        emit();
      }
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export const settingsStore = createSettingsStore(() => globalThis.localStorage ?? null);

function subscribe(cb: () => void): () => void {
  const off = settingsStore.subscribe(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === STORAGE_KEY) settingsStore.refresh();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    off();
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function useEditorSettings() {
  const settings = useSyncExternalStore(subscribe, settingsStore.get, settingsStore.get);
  return { settings, update: settingsStore.update, reset: settingsStore.reset };
}
