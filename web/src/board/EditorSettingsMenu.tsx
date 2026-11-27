// Gear button and popover for the local editor preferences (see editorSettings.ts).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Settings } from "lucide-react";
import { FONT_MAX, FONT_MIN, TAB_SIZES, useEditorSettings, type EditorSettings, type SuggestMode, type WhitespaceMode } from "./editorSettings.ts";

const FONT_SIZES = Array.from({ length: FONT_MAX - FONT_MIN + 1 }, (_, i) => FONT_MIN + i);
const WHITESPACE_LABELS: Record<WhitespaceMode, string> = { none: "Jamais", selection: "Sélection", all: "Toujours" };

export function EditorSettingsMenu() {
  const { settings, update, reset } = useEditorSettings();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      if (e.target instanceof Node && (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target))) return;
      setPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPos(null);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [pos]);

  const toggle = () => {
    if (pos) return setPos(null);
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.max(8, Math.min(r.right - 260, window.innerWidth - 268)), y: Math.min(r.bottom + 4, window.innerHeight - 380) });
  };
  const check = (key: keyof EditorSettings, label: string) => (
    <label className="es-row">
      <span>{label}</span>
      <input type="checkbox" checked={settings[key] as boolean} onChange={(e) => update({ [key]: e.target.checked })} />
    </label>
  );

  return (
    <>
      <button ref={btnRef} className={pos ? "on" : ""} title="Réglages de l'éditeur" aria-label="Réglages de l'éditeur" aria-expanded={!!pos} onClick={toggle}>
        <Settings size={14} />
      </button>
      {pos &&
        createPortal(
          <div ref={popRef} className="menu es-menu" role="dialog" aria-label="Réglages de l'éditeur" style={{ left: pos.x, top: pos.y }}>
            <div className="menu-label">Éditeur (cet appareil)</div>
            <label className="es-row">
              <span>Taille de police</span>
              <select value={settings.fontSize} onChange={(e) => update({ fontSize: Number(e.target.value) })}>
                {FONT_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="es-row">
              <span>Tabulation</span>
              <select value={settings.tabSize} onChange={(e) => update({ tabSize: Number(e.target.value) as EditorSettings["tabSize"] })}>
                {TAB_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {check("insertSpaces", "Espaces au lieu de tabulations")}
            {check("wordWrap", "Retour à la ligne")}
            {check("minimap", "Minimap")}
            {check("lineNumbers", "Numéros de ligne")}
            <label className="es-row">
              <span>Espaces visibles</span>
              <select value={settings.renderWhitespace} onChange={(e) => update({ renderWhitespace: e.target.value as WhitespaceMode })}>
                {(Object.keys(WHITESPACE_LABELS) as WhitespaceMode[]).map((m) => (
                  <option key={m} value={m}>
                    {WHITESPACE_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            <label className="es-row">
              <span>Suggestions pendant la frappe</span>
              <select value={settings.quickSuggestions} onChange={(e) => update({ quickSuggestions: e.target.value as SuggestMode })}>
                <option value="auto">Selon le langage</option>
                <option value="on">Toujours</option>
                <option value="off">Jamais</option>
              </select>
            </label>
            {check("bracketPairColorization", "Couleur des paires de crochets")}
            <div className="menu-sep" />
            <button className="menu-item" onClick={reset}>
              Réinitialiser
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
