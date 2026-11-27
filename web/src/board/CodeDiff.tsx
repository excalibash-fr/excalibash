// Side-by-side diff of the machine's version of a file (left, read-only) and the shared document
// (right, a read-only snapshot), laid over the code window. Used to compare on demand and to
// settle a save conflict. Models are owned here and disposed with the view.
import { useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type * as Monaco from "monaco-editor";
import { monaco } from "./monacoEnv.ts";
import type { DiffChoice } from "./codeDoc.ts";

type Props = {
  name: string;
  language: string;
  theme: "light" | "dark";
  /** The file as read from the machine. */
  machine: string;
  /** The shared document as it was when the view opened. */
  local: string;
  /** "conflict" offers the three save actions; "compare" only closes. */
  mode: "compare" | "conflict";
  /** Why the view is shown (a line of text under the title). */
  note?: string;
  /** Offers "take the machine's version": only when the file is the document's own (not a "save as" target). */
  canTake?: boolean;
  onChoose: (c: DiffChoice) => void;
};

export default function CodeDiff({ name, language, theme, machine, local, mode, note, canTake = true, onChoose }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const original = monaco.editor.createModel(machine, language);
    const modified = monaco.editor.createModel(local, language);
    const editor = monaco.editor.createDiffEditor(el, {
      theme: theme === "dark" ? "vs-dark" : "vs",
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      ignoreTrimWhitespace: false,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
    });
    editor.setModel({ original, modified });
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
      editor.setModel(null);
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
    // Snapshots: the view is rebuilt only when it is opened again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
  }, [theme]);

  const go = (t: "next" | "previous") => editorRef.current?.goToDiff(t);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onChoose("cancel");
    } else if (e.key === "F7") {
      e.preventDefault();
      go(e.shiftKey ? "previous" : "next");
    }
  };

  return (
    <div className="code-diff" role="dialog" aria-label={`Différences de ${name}`} onKeyDown={onKeyDown}>
      <div className="code-diff-head">
        <strong>{mode === "conflict" ? "Écraser le fichier ?" : "Comparaison avec la machine"}</strong>
        <span className="code-diff-sides">à gauche : machine · à droite : document partagé</span>
        <span style={{ flex: 1 }} />
        <button title="Différence précédente (Maj+F7)" aria-label="Différence précédente" onClick={() => go("previous")}>
          <ArrowUp size={14} />
        </button>
        <button title="Différence suivante (F7)" aria-label="Différence suivante" onClick={() => go("next")}>
          <ArrowDown size={14} />
        </button>
        {mode === "compare" && (
          <button title="Fermer (Échap)" aria-label="Fermer" onClick={() => onChoose("cancel")}>
            <X size={14} />
          </button>
        )}
      </div>
      {note && <div className="code-diff-note">{note}</div>}
      <div ref={hostRef} className="code-diff-body" />
      {mode === "conflict" && (
        <div className="code-diff-actions">
          <button className="btn btn-sm btn-danger" onClick={() => onChoose("overwrite")}>
            Écraser la machine
          </button>
          {canTake && (
            <button className="btn btn-sm" onClick={() => onChoose("take")}>
              Prendre la version de la machine
            </button>
          )}
          <button className="btn btn-sm" autoFocus onClick={() => onChoose("cancel")}>
            Annuler
          </button>
        </div>
      )}
    </div>
  );
}
