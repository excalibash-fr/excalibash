// Color themes of the interface (and of the terminals). Each one is a light or dark base (what
// Excalidraw and the `html.dark` rules follow) plus overrides of the CSS variables of styles.css.
// The user picks one light and one dark theme (built-in or custom); both are kept in this browser
// (localStorage) and applied before the app loads by public/boot.js, so the page never flashes.
import { writeStorage } from "./storage.ts";

export type Base = "light" | "dark";

/** xterm.js colors of a theme's terminals. */
export type TermColors = {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export type ThemeDef = {
  id: string;
  name: string;
  base: Base;
  /** CSS variables of styles.css (without the leading --). */
  vars: Record<string, string>;
  term: TermColors;
};

/** Colors a palette is made of; the CSS variables are derived from them. */
type Palette = { bg: string; dots: string; surface: string; surface2: string; ink: string; text: string; text2: string; muted: string; line: string; brand: string; brandHover: string; brandText: string; danger?: string; success?: string; warn?: string };

const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

function vars(p: Palette, base: Base): Record<string, string> {
  return {
    bg: p.bg,
    dots: p.dots,
    surface: p.surface,
    "surface-2": p.surface2,
    ink: p.ink,
    text: p.text,
    "text-2": p.text2,
    muted: p.muted,
    line: p.line,
    brand: p.brand,
    "brand-hover": p.brandHover,
    "brand-soft": alpha(p.brand, base === "dark" ? 0.16 : 0.1),
    "brand-softer": alpha(p.brand, base === "dark" ? 0.26 : 0.18),
    "brand-text": p.brandText,
    ...(p.danger ? { danger: p.danger, "danger-bg": p.danger } : {}),
    ...(p.success ? { success: p.success } : {}),
    ...(p.warn ? { warn: p.warn } : {}),
    "shadow-color": base === "dark" ? alpha(p.text, 0.15) : alpha(p.ink, 0.9),
  };
}

/** The terminal colors of Excalibash's own themes. */
const DEFAULT_TERM: TermColors = {
  background: "#0b1020",
  foreground: "#e2e8f0",
  cursor: "#a5b4fc",
  selectionBackground: "#4f46e580",
  black: "#1e293b",
  red: "#f43f5e",
  green: "#10b981",
  yellow: "#f59e0b",
  blue: "#6366f1",
  magenta: "#d946ef",
  cyan: "#06b6d4",
  white: "#e2e8f0",
  brightBlack: "#64748b",
  brightRed: "#fb7185",
  brightGreen: "#34d399",
  brightYellow: "#fbbf24",
  brightBlue: "#818cf8",
  brightMagenta: "#e879f9",
  brightCyan: "#22d3ee",
  brightWhite: "#f8fafc",
};

/** A terminal palette from its 16 colors (normal then bright: black red green yellow blue magenta cyan white). */
function term(background: string, foreground: string, cursor: string, c: string[]): TermColors {
  const [black, red, green, yellow, blue, magenta, cyan, white, bBlack, bRed, bGreen, bYellow, bBlue, bMagenta, bCyan, bWhite] = c;
  return {
    background,
    foreground,
    cursor,
    selectionBackground: alpha(cursor, 0.35),
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack: bBlack,
    brightRed: bRed,
    brightGreen: bGreen,
    brightYellow: bYellow,
    brightBlue: bBlue,
    brightMagenta: bMagenta,
    brightCyan: bCyan,
    brightWhite: bWhite,
  };
}

function theme(id: string, name: string, base: Base, p: Palette, t: TermColors): ThemeDef {
  return { id, name, base, vars: vars(p, base), term: t };
}

export const THEMES: ThemeDef[] = [
  // Excalibash's own: the colors of styles.css, no override.
  { id: "light", name: "Clair", base: "light", vars: {}, term: DEFAULT_TERM },
  { id: "dark", name: "Sombre", base: "dark", vars: {}, term: DEFAULT_TERM },
  theme(
    "github-light",
    "GitHub clair",
    "light",
    { bg: "#f6f8fa", dots: "#d0d7de", surface: "#ffffff", surface2: "#f6f8fa", ink: "#24292f", text: "#1f2328", text2: "#59636e", muted: "#8c959f", line: "#d0d7de", brand: "#0969da", brandHover: "#218bff", brandText: "#0a3069", danger: "#cf222e", success: "#1a7f37", warn: "#9a6700" },
    term("#ffffff", "#1f2328", "#0969da", ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"]),
  ),
  theme(
    "github-dark",
    "GitHub sombre",
    "dark",
    { bg: "#0d1117", dots: "#21262d", surface: "#161b22", surface2: "#21262d", ink: "#30363d", text: "#e6edf3", text2: "#c9d1d9", muted: "#7d8590", line: "#30363d", brand: "#2f81f7", brandHover: "#58a6ff", brandText: "#a5d6ff", danger: "#f85149", success: "#3fb950", warn: "#d29922" },
    term("#0d1117", "#e6edf3", "#2f81f7", ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"]),
  ),
  theme(
    "solarized-light",
    "Solarized clair",
    "light",
    { bg: "#fdf6e3", dots: "#e4dcc4", surface: "#fffbf0", surface2: "#eee8d5", ink: "#073642", text: "#073642", text2: "#586e75", muted: "#93a1a1", line: "#e4dcc4", brand: "#268bd2", brandHover: "#2aa198", brandText: "#0b4f7c", danger: "#dc322f", success: "#859900", warn: "#b58900" },
    term("#fdf6e3", "#586e75", "#268bd2", ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]),
  ),
  theme(
    "solarized-dark",
    "Solarized sombre",
    "dark",
    { bg: "#002b36", dots: "#0a3a47", surface: "#073642", surface2: "#0a4352", ink: "#2a5562", text: "#eee8d5", text2: "#93a1a1", muted: "#657b83", line: "#0e4655", brand: "#268bd2", brandHover: "#2aa198", brandText: "#9ccbf0", danger: "#dc322f", success: "#859900", warn: "#b58900" },
    term("#002b36", "#93a1a1", "#268bd2", ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#586e75", "#cb4b16", "#859900", "#b58900", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]),
  ),
  theme(
    "gruvbox-light",
    "Gruvbox clair",
    "light",
    { bg: "#fbf1c7", dots: "#e0d3a8", surface: "#fdf8e1", surface2: "#f2e5bc", ink: "#3c3836", text: "#282828", text2: "#504945", muted: "#928374", line: "#d5c4a1", brand: "#af3a03", brandHover: "#d65d0e", brandText: "#7c2d02", danger: "#9d0006", success: "#79740e", warn: "#b57614" },
    term("#fbf1c7", "#3c3836", "#af3a03", ["#fbf1c7", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64", "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836"]),
  ),
  theme(
    "gruvbox-dark",
    "Gruvbox sombre",
    "dark",
    { bg: "#1d2021", dots: "#32302f", surface: "#282828", surface2: "#3c3836", ink: "#504945", text: "#ebdbb2", text2: "#d5c4a1", muted: "#928374", line: "#3c3836", brand: "#fe8019", brandHover: "#fabd2f", brandText: "#fbd7a8", danger: "#fb4934", success: "#b8bb26", warn: "#fabd2f" },
    term("#282828", "#ebdbb2", "#fe8019", ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]),
  ),
  theme(
    "catppuccin-latte",
    "Catppuccin Latte",
    "light",
    { bg: "#eff1f5", dots: "#ccd0da", surface: "#ffffff", surface2: "#e6e9ef", ink: "#4c4f69", text: "#4c4f69", text2: "#5c5f77", muted: "#9ca0b0", line: "#ccd0da", brand: "#8839ef", brandHover: "#7287fd", brandText: "#5a1fb0", danger: "#d20f39", success: "#40a02b", warn: "#df8e1d" },
    term("#eff1f5", "#4c4f69", "#dc8a78", ["#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be", "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc"]),
  ),
  theme(
    "catppuccin-mocha",
    "Catppuccin Mocha",
    "dark",
    { bg: "#11111b", dots: "#262637", surface: "#1e1e2e", surface2: "#313244", ink: "#45475a", text: "#cdd6f4", text2: "#bac2de", muted: "#7f849c", line: "#313244", brand: "#cba6f7", brandHover: "#b4befe", brandText: "#e4d4fb", danger: "#f38ba8", success: "#a6e3a1", warn: "#f9e2af" },
    term("#1e1e2e", "#cdd6f4", "#f5e0dc", ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"]),
  ),
  theme(
    "rose-pine-dawn",
    "Rosé Pine Dawn",
    "light",
    { bg: "#faf4ed", dots: "#e4dcd4", surface: "#fffaf3", surface2: "#f2e9e1", ink: "#575279", text: "#575279", text2: "#797593", muted: "#9893a5", line: "#dfdad9", brand: "#907aa9", brandHover: "#d7827e", brandText: "#5b4a73", danger: "#b4637a", success: "#286983", warn: "#ea9d34" },
    term("#faf4ed", "#575279", "#cecacd", ["#f2e9e1", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279", "#9893a5", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279"]),
  ),
  theme(
    "rose-pine",
    "Rosé Pine",
    "dark",
    { bg: "#191724", dots: "#26233a", surface: "#1f1d2e", surface2: "#26233a", ink: "#403d52", text: "#e0def4", text2: "#c4c0e0", muted: "#6e6a86", line: "#26233a", brand: "#c4a7e7", brandHover: "#ebbcba", brandText: "#e2d3f4", danger: "#eb6f92", success: "#9ccfd8", warn: "#f6c177" },
    term("#191724", "#e0def4", "#524f67", ["#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4", "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4"]),
  ),
  theme(
    "nord",
    "Nord",
    "dark",
    { bg: "#242933", dots: "#353c4a", surface: "#2e3440", surface2: "#3b4252", ink: "#4c566a", text: "#eceff4", text2: "#d8dee9", muted: "#7b88a1", line: "#3b4252", brand: "#88c0d0", brandHover: "#81a1c1", brandText: "#cfe9f0", danger: "#bf616a", success: "#a3be8c", warn: "#ebcb8b" },
    term("#2e3440", "#d8dee9", "#d8dee9", ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"]),
  ),
  theme(
    "dracula",
    "Dracula",
    "dark",
    { bg: "#191a21", dots: "#2b2d3a", surface: "#282a36", surface2: "#343746", ink: "#44475a", text: "#f8f8f2", text2: "#e2e2dc", muted: "#7f86ad", line: "#343746", brand: "#bd93f9", brandHover: "#ff79c6", brandText: "#e3d1ff", danger: "#ff5555", success: "#50fa7b", warn: "#f1fa8c" },
    term("#282a36", "#f8f8f2", "#f8f8f2", ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"]),
  ),
  theme(
    "tokyo-night",
    "Tokyo Night",
    "dark",
    { bg: "#16161e", dots: "#24253a", surface: "#1a1b26", surface2: "#24283b", ink: "#3b4261", text: "#c0caf5", text2: "#a9b1d6", muted: "#565f89", line: "#292e42", brand: "#7aa2f7", brandHover: "#bb9af7", brandText: "#c6d6fb", danger: "#f7768e", success: "#9ece6a", warn: "#e0af68" },
    term("#1a1b26", "#c0caf5", "#c0caf5", ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"]),
  ),
  theme(
    "one-dark",
    "One Dark",
    "dark",
    { bg: "#21252b", dots: "#2f343d", surface: "#282c34", surface2: "#2f343f", ink: "#3e4451", text: "#dcdfe4", text2: "#abb2bf", muted: "#7f848e", line: "#323842", brand: "#61afef", brandHover: "#c678dd", brandText: "#b9dcf8", danger: "#e06c75", success: "#98c379", warn: "#e5c07b" },
    term("#282c34", "#abb2bf", "#528bff", ["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"]),
  ),
  theme(
    "monokai",
    "Monokai",
    "dark",
    { bg: "#1e1f1c", dots: "#33342e", surface: "#272822", surface2: "#3e3d32", ink: "#49483e", text: "#f8f8f2", text2: "#e6e6dc", muted: "#90908a", line: "#3e3d32", brand: "#a6e22e", brandHover: "#e6db74", brandText: "#d9f3a9", danger: "#f92672", success: "#a6e22e", warn: "#fd971f" },
    term("#272822", "#f8f8f2", "#f8f8f0", ["#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2", "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5"]),
  ),
  theme(
    "everforest",
    "Everforest",
    "dark",
    { bg: "#232a2e", dots: "#343f44", surface: "#2d353b", surface2: "#343f44", ink: "#475258", text: "#d3c6aa", text2: "#c5b99d", muted: "#859289", line: "#3d484d", brand: "#a7c080", brandHover: "#83c092", brandText: "#d6e4c0", danger: "#e67e80", success: "#a7c080", warn: "#dbbc7f" },
    term("#2d353b", "#d3c6aa", "#d3c6aa", ["#475258", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa", "#859289", "#e67e80", "#a7c080", "#dbbc7f", "#7fbbb3", "#d699b6", "#83c092", "#d3c6aa"]),
  ),
  theme(
    "high-contrast",
    "Contraste élevé",
    "dark",
    { bg: "#000000", dots: "#262626", surface: "#0a0a0a", surface2: "#1a1a1a", ink: "#ffffff", text: "#ffffff", text2: "#ffffff", muted: "#c0c0c0", line: "#ffffff", brand: "#ffd400", brandHover: "#ffe55c", brandText: "#ffe55c", danger: "#ff4d4d", success: "#3dff8b", warn: "#ffb84d" },
    term("#000000", "#ffffff", "#ffd400", ["#000000", "#ff4d4d", "#3dff8b", "#ffd400", "#5cb3ff", "#ff7af5", "#4df3ff", "#ffffff", "#808080", "#ff8080", "#80ffb3", "#ffe55c", "#99ceff", "#ffadf9", "#8cf7ff", "#ffffff"]),
  ),
];

// ---- Custom themes -----------------------------------------------------------------------

/** "Sur mesure": a few colors picked by the user, the others derived from them. One light, one dark. */
export type CustomColors = { bg: string; surface: string; text: string; brand: string; termBg: string; termFg: string };
export const CUSTOM_ID: Record<Base, string> = { light: "custom-light", dark: "custom-dark" };
const HEX = /^#[0-9a-f]{6}$/i;

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** `a` moved toward `b` by `k` (0..1). */
export function mix(a: string, b: string, k: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, "0")).join("");
}

export const DEFAULT_CUSTOM: Record<Base, CustomColors> = {
  light: { bg: "#f4f7f5", surface: "#ffffff", text: "#13201a", brand: "#15803d", termBg: "#0f1a14", termFg: "#d7e6dc" },
  dark: { bg: "#101418", surface: "#1a2027", text: "#e6edf3", brand: "#22c55e", termBg: "#0b0f14", termFg: "#d6deeb" },
};

/** Stored custom colors, checked (anything malformed falls back to the defaults). */
export function readCustom(raw: unknown, base: Base): CustomColors {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_CUSTOM[base] };
  for (const k of ["bg", "surface", "text", "brand", "termBg", "termFg"] as const) if (typeof v[k] === "string" && HEX.test(v[k] as string)) out[k] = (v[k] as string).toLowerCase();
  return out;
}

/** Custom colors as a full theme of that base: the missing shades are mixes of the chosen colors. */
export function customTheme(c: CustomColors, base: Base): ThemeDef {
  const dark = base === "dark";
  const p: Palette = {
    bg: c.bg,
    dots: mix(c.bg, c.text, 0.12),
    surface: c.surface,
    surface2: mix(c.surface, c.text, 0.06),
    ink: dark ? mix(c.surface, c.text, 0.25) : mix(c.text, c.surface, 0.1),
    text: c.text,
    text2: mix(c.text, c.surface, 0.28),
    muted: mix(c.text, c.surface, 0.5),
    line: mix(c.surface, c.text, 0.12),
    brand: c.brand,
    brandHover: mix(c.brand, dark ? "#ffffff" : "#000000", 0.18),
    brandText: mix(c.brand, dark ? "#ffffff" : "#000000", 0.45),
  };
  return {
    id: CUSTOM_ID[base],
    name: dark ? "Sur mesure sombre" : "Sur mesure clair",
    base,
    vars: vars(p, base),
    term: { ...DEFAULT_TERM, background: c.termBg, foreground: c.termFg, cursor: c.brand, selectionBackground: alpha(c.brand, 0.35) },
  };
}

/** A theme's colors as a starting point for a custom one. */
export function customFrom(t: ThemeDef): CustomColors {
  const dark = t.base === "dark";
  const read = (k: string, fallback: string) => {
    const v = t.vars[k] ?? fallback;
    return HEX.test(v) ? v : fallback;
  };
  return {
    bg: read("bg", dark ? "#0a0a0a" : "#f8fafc"),
    surface: read("surface", dark ? "#171717" : "#ffffff"),
    text: read("text", dark ? "#fafafa" : "#0f172a"),
    brand: read("brand", dark ? "#6366f1" : "#4f46e5"),
    termBg: HEX.test(t.term.background) ? t.term.background : DEFAULT_CUSTOM[t.base].termBg,
    termFg: HEX.test(t.term.foreground) ? t.term.foreground : DEFAULT_CUSTOM[t.base].termFg,
  };
}

const byId = new Map(THEMES.map((t) => [t.id, t]));
export const themeById = (id: string | null | undefined): ThemeDef | undefined => (id ? byId.get(id) : undefined);

// ---- The user's choice -----------------------------------------------------------------

/** Which of the two themes is shown: the light one, the dark one, or the system's preference. */
export type Mode = Base | "auto";
/** Stored in this browser. `eb-theme` holds the mode (it held "light" / "dark" before, which still reads). */
export const MODE_KEY = "eb-theme";
export const SLOT_KEY: Record<Base, string> = { light: "eb-theme-light", dark: "eb-theme-dark" };
export const CUSTOM_KEY: Record<Base, string> = { light: "eb-theme-custom-light", dark: "eb-theme-custom-dark" };
/** The CSS variables of both chosen themes, read by public/boot.js before the app loads. */
export const THEME_VARS_KEY = "eb-theme-vars";

export const systemDark = () => {
  try {
    return matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
};

/** Puts a theme on the page: base class and CSS variables. */
export function applyTheme(t: ThemeDef) {
  const root = document.documentElement;
  root.classList.toggle("dark", t.base === "dark");
  root.dataset.theme = t.id;
  for (const name of [...root.style]) if (name.startsWith("--")) root.style.removeProperty(name);
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(`--${k}`, v);
}

/** Keeps the variables of the light and dark themes for boot.js (the page never flashes another theme). */
export function saveBootVars(light: ThemeDef, dark: ThemeDef) {
  writeStorage(THEME_VARS_KEY, JSON.stringify({ light: light.vars, dark: dark.vars }));
}
