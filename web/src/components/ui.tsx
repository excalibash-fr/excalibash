import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CUSTOM_ID,
  CUSTOM_KEY,
  MODE_KEY,
  SLOT_KEY,
  applyTheme,
  customTheme,
  readCustom,
  saveBootVars,
  systemDark,
  themeById,
  type Base,
  type CustomColors,
  type Mode,
  type ThemeDef,
} from "../themes.ts";
import { createPortal } from "react-dom";
import { readJson, readStorage, writeStorage } from "../storage.ts";

// ---- Theme ------------------------------------------------------------------------
// One light theme and one dark theme, each chosen in "Mon compte" (built-in or custom); the
// sun / moon button switches between the two, "auto" follows the system. See themes.ts.

export type Theme = Base;

type ThemeCtx = {
  /** Light or dark base of the theme shown (what Excalidraw and icons follow). */
  theme: Theme;
  /** The theme shown. */
  current: ThemeDef;
  mode: Mode;
  setMode: (m: Mode) => void;
  /** The theme chosen for each base (a theme id, or that base's custom one). */
  slots: Record<Base, string>;
  setSlot: (base: Base, id: string) => void;
  /** Colors of the custom theme of each base. */
  custom: Record<Base, CustomColors>;
  setCustom: (base: Base, c: CustomColors) => void;
  /** The theme for an id (built-in or custom). */
  themeFor: (id: string) => ThemeDef | undefined;
  /** Sun / moon button: from the light theme to the dark one, and back. */
  toggle: () => void;
};

const ThemeContext = createContext<ThemeCtx>(null as unknown as ThemeCtx);

function initialState() {
  const raw = readStorage(MODE_KEY);
  // A theme id stored there by an earlier version: it becomes the theme of its base, shown.
  const legacy = raw && raw !== "light" && raw !== "dark" && raw !== "auto" ? themeById(raw) : undefined;
  const mode: Mode = raw === "light" || raw === "dark" ? raw : legacy ? legacy.base : "auto";
  // Rewritten at once (mode and the theme of its base), so that boot.js agrees from the next
  // load on and the first toggle does not lose the theme.
  if (legacy) {
    writeStorage(MODE_KEY, mode);
    if (!readStorage(SLOT_KEY[legacy.base])) writeStorage(SLOT_KEY[legacy.base], legacy.id);
  }
  const slot = (base: Base) => {
    const v = readStorage(SLOT_KEY[base]);
    if (v === CUSTOM_ID[base] || (v && themeById(v)?.base === base)) return v;
    return legacy?.base === base ? legacy.id : base;
  };
  const custom = (base: Base) => readCustom(readJson(CUSTOM_KEY[base]), base);
  return { mode, slots: { light: slot("light"), dark: slot("dark") }, custom: { light: custom("light"), dark: custom("dark") } };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [init] = useState(initialState);
  const [mode, setModeState] = useState<Mode>(init.mode);
  const [slots, setSlots] = useState(init.slots);
  const [custom, setCustomState] = useState(init.custom);
  const [sysDark, setSysDark] = useState(systemDark);
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const on = () => setSysDark(mq.matches);
    // Safari before 14 only has addListener.
    if (mq.addEventListener) mq.addEventListener("change", on);
    else mq.addListener(on);
    return () => (mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on));
  }, []);

  const themeFor = useCallback(
    (id: string) => (id === CUSTOM_ID.light ? customTheme(custom.light, "light") : id === CUSTOM_ID.dark ? customTheme(custom.dark, "dark") : themeById(id)),
    [custom],
  );
  const chosen = useMemo(
    () => ({ light: themeFor(slots.light) ?? themeById("light")!, dark: themeFor(slots.dark) ?? themeById("dark")! }),
    [slots, themeFor],
  );
  const base: Base = mode === "auto" ? (sysDark ? "dark" : "light") : mode;
  const current = chosen[base];
  useLayoutEffect(() => applyTheme(current), [current]);
  useEffect(() => saveBootVars(chosen.light, chosen.dark), [chosen]);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    writeStorage(MODE_KEY, m);
  }, []);
  const setSlot = useCallback((b: Base, id: string) => {
    setSlots((s) => ({ ...s, [b]: id }));
    writeStorage(SLOT_KEY[b], id);
  }, []);
  const setCustom = useCallback((b: Base, c: CustomColors) => {
    const v = readCustom(c, b);
    setCustomState((s) => ({ ...s, [b]: v }));
    writeStorage(CUSTOM_KEY[b], JSON.stringify(v));
  }, []);
  const toggle = useCallback(() => setMode(base === "dark" ? "light" : "dark"), [base, setMode]);
  const value = useMemo(
    () => ({ theme: base, current, mode, setMode, slots, setSlot, custom, setCustom, themeFor, toggle }),
    [base, current, mode, setMode, slots, setSlot, custom, setCustom, themeFor, toggle],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

// ---- Toasts -----------------------------------------------------------------------

type Toast = { id: number; text: string; kind: "info" | "error" };
let pushToast: (t: Omit<Toast, "id">) => void = () => {};

export function toast(text: string) {
  pushToast({ text, kind: "info" });
}
toast.error = (e: unknown) => pushToast({ text: e instanceof Error ? e.message : String(e), kind: "error" });

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    let n = 0;
    pushToast = (t) => {
      const id = ++n;
      setItems((xs) => [...xs, { ...t, id }]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.kind === "error" ? 5000 : 2800);
    };
  }, []);
  return createPortal(
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ---- Modal ------------------------------------------------------------------------

export function Modal({ onClose, children, width }: { onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog">
        {children}
      </div>
    </div>,
    document.body,
  );
}

type ConfirmOpts = { title: string; text: string; confirm: string; danger?: boolean };
let openConfirm: (o: ConfirmOpts) => Promise<boolean> = async () => false;

export const confirmDialog = (o: ConfirmOpts) => openConfirm(o);

export function ConfirmHost() {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  useEffect(() => {
    openConfirm = (o) => new Promise((resolve) => setState({ ...o, resolve }));
  }, []);
  if (!state) return null;
  const done = (v: boolean) => {
    state.resolve(v);
    setState(null);
  };
  return (
    <Modal onClose={() => done(false)}>
      <h2 className="display">{state.title}</h2>
      <p>{state.text}</p>
      <div className="modal-actions">
        <button className="btn" onClick={() => done(false)}>
          Annuler
        </button>
        <button className={`btn ${state.danger ? "btn-danger" : "btn-primary"}`} autoFocus onClick={() => done(true)}>
          {state.confirm}
        </button>
      </div>
    </Modal>
  );
}

// ---- Floating menu ----------------------------------------------------------------

export type MenuAnchor = { x: number; y: number } | HTMLElement;

export function Menu({ anchor, onClose, children, align = "left" }: { anchor: MenuAnchor; onClose: () => void; children: ReactNode; align?: "left" | "right" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });

  useLayoutEffect(() => {
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    let left: number;
    let top: number;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      left = align === "right" ? r.right - width : r.left;
      top = r.bottom + 6;
    } else {
      left = anchor.x;
      top = anchor.y;
    }
    left = Math.max(8, Math.min(left, innerWidth - width - 8));
    if (top + height > innerHeight - 8) top = Math.max(8, innerHeight - height - 8);
    setPos({ left, top });
  }, [anchor, align]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      if (anchor instanceof HTMLElement && anchor.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} className="menu" style={pos} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>,
    document.body,
  );
}

// ---- Small bits -------------------------------------------------------------------

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect x="4" y="6" width="56" height="52" rx="12" fill="#4f46e5" stroke="var(--ink)" strokeWidth="4" />
      <path d="M18 24l10 8-10 8" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M33 42h13" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
      <path d="M44 16c4 1 7 3 9 7" stroke="#fff" strokeWidth="3" strokeLinecap="round" fill="none" opacity=".6" />
    </svg>
  );
}

export function Avatar({ name, color, title }: { name: string; color: string; title?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <div className="avatar" style={{ background: color }} title={title ?? name}>
      {initials || "?"}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" className={`switch ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copié dans le presse-papiers");
  } catch {
    toast.error("Impossible de copier — sélectionne le texte manuellement");
  }
}
