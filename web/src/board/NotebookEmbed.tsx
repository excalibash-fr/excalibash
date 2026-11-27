// A notebook window: a Jupyter notebook edited by several people at once. The cells live in an end-to-end
// encrypted shared Yjs document (sharedDoc.ts, notebookDoc.ts); code runs on a Jupyter kernel session of
// the node's machine that everybody shares (notebookRunner.ts); the .ipynb file itself lives on the
// machine, read and written through the sealed file channel of a local shell.
//
// Outputs are DATA written by whatever code anybody ran: text becomes text nodes, images <img data:>
// after a base64 check, everything else (HTML, SVG, Markdown, JavaScript) a sandboxed iframe
// (sandbox="", no script, no same-origin). Nothing here uses innerHTML or runs notebook-provided code.
import { saveBlob } from "../download.ts";
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowDown,
  ArrowUp,
  Download,
  Eraser,
  FastForward,
  Minimize2,
  NotebookText,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Save,
  SaveAll,
  Square,
  Trash2,
  Type,
} from "lucide-react";
import { MonacoBinding } from "y-monaco";
import type * as Monaco from "monaco-editor";
import { monaco } from "./monacoEnv.ts";
import type { BoardSession } from "./collab.ts";
import type { SharedDoc } from "./sharedDoc.ts";
import { cursorStyleSheet, isDirty, safeColor, safeLabel, sha256Hex } from "./codeDoc.ts";
import { openMachineFile, pickLocalShell, saveMachineFile } from "./machineFiles.ts";
import {
  MAX_NOTEBOOK_BYTES,
  NotebookFormatError,
  cellViews,
  cellsOf,
  orderOf,
  clearOutputs,
  deleteCell,
  exportIpynb,
  fillNotebook,
  initBlankNotebook,
  initFromNotebook,
  insertCell,
  kernelCwd,
  kernelTermOf,
  markSaved,
  metaOf,
  moveCell,
  parseIpynb,
  readCell,
  readMeta,
  removeDuplicates,
  setCellType,
  setKernelTerm,
  takeNotebookInit,
  type Cell,
  type CellType,
  type NotebookMeta,
} from "./notebookDoc.ts";
import { classifyOutputs, frameHeight, markdownFrame } from "./notebookRender.ts";
import { Outputs } from "./OutputView.tsx";
import type { NotebookRunner } from "./notebookRunner.ts";
import { acquireNotebook, sessionEnv } from "./notebookService.ts";
import { bindPythonKernel, type KernelQuery } from "./pyKernel.ts";

/** What the window needs from the app (handed in by the board page: this chunk must not import the UI kit, see BoardPage). */
export type NotebookHost = {
  theme: "light" | "dark";
  confirm: (o: { title: string; text: string; confirm: string; danger?: boolean }) => Promise<boolean>;
  toast: (text: string) => void;
  /** The machine of the node when this user may open a kernel session on it (holds its machine key); null otherwise. */
  kernelMachine: (nodeId: string) => Promise<{ name: string } | null>;
  /** Asks the user, then starts a kernel session on the node's machine. Resolves with the terminal id, null if cancelled. */
  startKernel: (nodeId: string, cwd?: string, purpose?: "code" | "notebook") => Promise<string | null>;
};

type Props = {
  host: NotebookHost;
  session: BoardSession;
  docId: string;
  nodeId: string;
  active: boolean;
  /** The node's shells, the ones whose window is open first: the file goes through the first running local one. */
  shells: string[];
  title?: string | null;
  onHide?: () => void;
  onRemove?: () => void;
  /** The file name changed (opened, saved as): the node remembers it as the label of this window. */
  onLabel?: (name: string) => void;
};

type Person = { clientId: number; name: string; color: string; self: boolean };

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

const WHEEL_AND_KEYS = ["keydown", "keyup", "keypress", "paste", "copy", "cut", "wheel"];
const LINE = 19;

// marked is loaded once, only when a Markdown cell or output shows. Its HTML only ever goes into a sandboxed iframe.
let markedLoad: Promise<(md: string) => string> | null = null;
const loadMarked = () =>
  (markedLoad ??= import("marked").then((m) => (md: string) => {
    const html = m.marked.parse(md, { async: false, gfm: true });
    return typeof html === "string" ? html : "";
  }));

function useMarkdown(): ((md: string) => string) | undefined {
  const [fn, setFn] = useState<((md: string) => string) | undefined>();
  useEffect(() => {
    let live = true;
    loadMarked().then((f) => live && setFn(() => f), () => {});
    return () => {
      live = false;
    };
  }, []);
  return fn;
}

/**
 * The notebook service of this window (document + kernel runner, see notebookService.ts): joined with the
 * window, released with it. The service itself outlives the window while a run is in flight.
 */
function useDoc(session: BoardSession, docId: string, toast: (t: string) => void) {
  const [doc, setDoc] = useState<SharedDoc | null>(null);
  const [runner, setRunner] = useState<NotebookRunner | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const h = acquireNotebook(session, sessionEnv(session), docId);
    const d = h.doc;
    setDoc(d);
    setRunner(h.runner);
    setReady(false);
    const off = d.onError((m) => live && setError(m));
    d.synced.then(async () => {
      if (!live) return;
      // A notebook opened from the machine (or a new blank one) fills the document once, here.
      if (!d.readOnly) {
        const init = takeNotebookInit(docId);
        try {
          if (init === "blank") initBlankNotebook(d.ydoc);
          else if (init) {
            const r = await initFromNotebook(d.ydoc, { ...init, by: session.you?.name });
            if (r.warnings.length) toast(`Notebook ouvert avec réserves : ${r.warnings.slice(0, 3).join(" ; ")}`);
          }
        } catch (e: any) {
          toast(e?.message ?? "Notebook illisible");
        }
      }
      if (live) setReady(true);
    });
    return () => {
      live = false;
      off();
      h.release();
    };
  }, [session, docId, toast]);
  return { doc, runner, ready, error };
}

// ---- one cell -----------------------------------------------------------------------------------------------------------

type CellApi = {
  select: (id: string) => void;
  /** The cell took the focus request (it is not repeated). */
  focused: () => void;
  run: (id: string) => void;
  runNext: (id: string) => void;
  insert: (id: string, where: "before" | "after", type: CellType) => void;
  remove: (id: string) => void;
  move: (id: string, delta: -1 | 1) => void;
  setType: (id: string, type: CellType) => void;
  clear: (id: string) => void;
  /** The kernel that answers completion and docstring requests, if there is one. */
  kernel: () => KernelQuery | null;
};

type CellProps = {
  map: Cell;
  id: string;
  index: number;
  selected: boolean;
  /** Bumped to ask this cell to focus its editor. */
  focus: number;
  readOnly: boolean;
  theme: "light" | "dark";
  awareness: SharedDoc["awareness"];
  markdown: ((md: string) => string) | undefined;
  api: CellApi;
};

const NotebookCell = memo(function NotebookCell(p: CellProps) {
  const { map, id, api } = p;
  const [rev, bump] = useReducer((n: number) => n + 1, 0);
  const [outRev, bumpOut] = useReducer((n: number) => n + 1, 0);
  const [near, setNear] = useState(p.index < 8);
  const [editing, setEditing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const mountedRef = useRef(false);

  const view = readCell(map, p.index);
  const type = view?.type ?? "raw";
  const source = view?.source;

  // This cell's own changes: typing in a mounted editor is Monaco's business, everything else re-renders.
  useEffect(() => {
    const h = (events: any[]) => {
      const onlySource = mountedRef.current && events.every((e) => e.target === source);
      if (!onlySource) bump();
      if (events.some((e) => e.target !== source)) bumpOut();
    };
    map.observeDeep(h);
    return () => map.unobserveDeep(h);
  }, [map, source]);

  // Only cells near the viewport get an editor: the others show their text as a static block.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return setNear(true);
    // Relative to the notebook's own scroller: a margin on the page viewport would not reach past its clipping.
    const io = new IntersectionObserver((es) => setNear(es.some((e) => e.isIntersecting)), { root: el.closest(".nb-body"), rootMargin: "700px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const wantEditor = near && !!source && (type !== "markdown" || editing);
  const language = type === "code" ? "python" : type === "markdown" ? "markdown" : "plaintext";

  useEffect(() => {
    mountedRef.current = false;
    if (!wantEditor || !hostRef.current || !source) return;
    const model = monaco.editor.createModel("", language);
    const editor = monaco.editor.create(hostRef.current, {
      model,
      readOnly: p.readOnly,
      domReadOnly: p.readOnly,
      theme: p.theme === "dark" ? "vs-dark" : "vs",
      automaticLayout: true,
      minimap: { enabled: false },
      lineNumbers: "off",
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 6,
      lineNumbersMinChars: 0,
      fontSize: 13,
      lineHeight: LINE,
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      scrollbar: { vertical: "hidden", horizontal: "auto", alwaysConsumeMouseWheel: false, handleMouseWheel: false },
      wordWrap: "on",
      tabSize: 4,
      padding: { top: 4, bottom: 4 },
      renderWhitespace: "selection",
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;
    const binding = new MonacoBinding(source, model, new Set([editor]), p.awareness);
    mountedRef.current = true;
    const size = () => setHeight(Math.max(LINE + 8, Math.min(editor.getContentHeight(), 900)));
    size();
    const d1 = editor.onDidContentSizeChange(size);
    const d2 = editor.onDidFocusEditorText(() => api.select(id));
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => (type === "markdown" ? (setEditing(false), api.runNext(id)) : api.runNext(id)));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => (type === "markdown" ? setEditing(false) : api.run(id)));
    if (type === "markdown") editor.addCommand(monaco.KeyCode.Escape, () => setEditing(false));
    if (type === "markdown" && editing) editor.focus();
    // Completion and docstrings of a code cell come from the notebook's kernel (Ctrl+Espace, ".", Maj+Tab).
    const unbind = type === "code" ? bindPythonKernel(editor, model, api.kernel) : undefined;
    return () => {
      unbind?.();
      mountedRef.current = false;
      d1.dispose();
      d2.dispose();
      binding.destroy();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
    // The editor is rebuilt for another cell kind or when it scrolls in / out of range; theme and read-only are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantEditor, source, language, editing]);
  useEffect(() => {
    monaco.editor.setTheme(p.theme === "dark" ? "vs-dark" : "vs");
  }, [p.theme]);
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: p.readOnly, domReadOnly: p.readOnly });
  }, [p.readOnly]);
  useEffect(() => {
    if (p.focus > 0) {
      if (type === "markdown" && !editing) setEditing(true);
      else editorRef.current?.focus();
      api.focused();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focus]);

  const text = !wantEditor && source ? source.toString() : "";
  const lines = !wantEditor && source ? Math.max(1, text.split("\n").length) : 1;
  const items = useMemo(
    () => (view && view.type === "code" ? classifyOutputs(view.outputs, { markdown: p.markdown, dark: p.theme === "dark" }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outRev, p.markdown, p.theme, view?.type],
  );
  const mdDoc = useMemo(
    () => (view && view.type === "markdown" && !editing ? markdownFrame(view.source.toString(), p.markdown, p.theme === "dark") : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rev, p.markdown, p.theme, editing, view?.type],
  );
  if (!view) return null;
  const running = view.running !== undefined;
  const mdHeight = frameHeight("text", view.source.toString());

  return (
    <div
      ref={rootRef}
      className={`nb-cell ${view.type} ${p.selected ? "selected" : ""} ${running ? "running" : ""}`}
      onMouseDownCapture={() => api.select(id)}
      onDoubleClick={() => view.type === "markdown" && !p.readOnly && setEditing(true)}
    >
      <div className="nb-gutter" title={running ? "En cours d'exécution" : undefined}>
        {view.type === "code" ? (running ? "[*]" : `[${view.executionCount ?? " "}]`) : ""}
      </div>
      <div className="nb-main">
        <div className="nb-cell-tools" role="toolbar" aria-label="Cellule">
          {view.type === "code" && (
            <button title="Exécuter (Ctrl+Entrée)" disabled={p.readOnly || running} onClick={() => api.run(id)}>
              <Play size={12} />
            </button>
          )}
          {view.type === "markdown" && !p.readOnly && (
            <button title={editing ? "Afficher le rendu" : "Modifier (double-clic)"} onClick={() => setEditing((e) => !e)}>
              <Pencil size={12} />
            </button>
          )}
          <select
            title="Type de cellule"
            aria-label="Type de cellule"
            value={view.type}
            disabled={p.readOnly}
            onChange={(e) => (setEditing(false), api.setType(id, e.target.value as CellType))}
          >
            <option value="code">Code</option>
            <option value="markdown">Markdown</option>
            <option value="raw">Brut</option>
          </select>
          <button title="Monter" disabled={p.readOnly || p.index === 0} onClick={() => api.move(id, -1)}>
            <ArrowUp size={12} />
          </button>
          <button title="Descendre" disabled={p.readOnly} onClick={() => api.move(id, 1)}>
            <ArrowDown size={12} />
          </button>
          <button title="Insérer une cellule de code au-dessus" disabled={p.readOnly} onClick={() => api.insert(id, "before", "code")}>
            <Plus size={12} />
            <ArrowUp size={9} />
          </button>
          <button title="Insérer une cellule de code au-dessous" disabled={p.readOnly} onClick={() => api.insert(id, "after", "code")}>
            <Plus size={12} />
            <ArrowDown size={9} />
          </button>
          {view.type === "code" && (
            <button title="Effacer les sorties" disabled={p.readOnly || running || !view.outputs.length} onClick={() => api.clear(id)}>
              <Eraser size={12} />
            </button>
          )}
          <button title="Supprimer la cellule" disabled={p.readOnly} onClick={() => api.remove(id)}>
            <Trash2 size={12} />
          </button>
        </div>
        {view.type === "markdown" && !editing ? (
          <iframe className="nb-md" sandbox="" srcDoc={mdDoc} title="Markdown" style={{ height: mdHeight }} referrerPolicy="no-referrer" />
        ) : wantEditor ? (
          <div className="nb-editor" style={{ height: height ?? Math.max(lines, 1) * LINE + 8 }}>
            <div ref={hostRef} className="nb-editor-host" />
          </div>
        ) : (
          <pre className="nb-static" style={{ height: height ?? lines * LINE + 8 }}>
            {text}
          </pre>
        )}
        {items.length > 0 && (
          <div className="nb-outputs">
            <Outputs items={items} />
          </div>
        )}
      </div>
    </div>
  );
});

// ---- the window --------------------------------------------------------------------------------------------------------

export default function NotebookEmbed({ host, session, docId, nodeId, active, shells, title, onHide, onRemove, onLabel }: Props) {
  const { theme, confirm: confirmDialog, toast } = host;
  const { doc, runner, ready, error } = useDoc(session, docId, toast);
  const rootRef = useRef<HTMLDivElement>(null);
  const [meta, setMeta] = useState<NotebookMeta>(() => ({ name: "sans-titre.ipynb", language: "python", nbformatMinor: 5 }));
  const [cellMaps, setCellMaps] = useState<{ id: string; map: Cell }[]>([]);
  const [sha, setSha] = useState<string | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusReq, setFocusReq] = useState<{ id: string | null; n: number }>({ id: null, n: 0 });
  const [kStatus, setKStatus] = useState<{ status: string; fatal: string | null }>({ status: "absent", fatal: null });
  const [machine, setMachine] = useState<{ name: string } | null>(null);
  const readOnly = !session.canEdit || !!doc?.readOnly;
  // The dock shows the file name: editors keep it in the node (a no-op when it is already there).
  const labelRef = useRef(onLabel);
  labelRef.current = onLabel;
  useEffect(() => {
    if (ready && !readOnly) labelRef.current?.(meta.name);
  }, [ready, readOnly, meta.name]);
  const markdown = useMarkdown();

  // Terminal statuses (the kernel session among them) live in the session.
  useSyncExternalStore(
    (cb) => session.on("terminals", cb),
    () => [...session.terminals.values()].map((t) => `${t.id}:${t.status}`).join(),
  );
  const shell = pickLocalShell(session, { shells: shells.map((terminalId) => ({ terminalId })) });
  const noShell = "Aucun shell local en cours sur cette machine";

  // Keep keys, clipboard and wheel inside the window instead of reaching the canvas.
  useEffect(() => {
    const el = rootRef.current!;
    const stop = (e: Event) => e.stopPropagation();
    for (const ev of WHEEL_AND_KEYS) el.addEventListener(ev, stop);
    return () => {
      for (const ev of WHEEL_AND_KEYS) el.removeEventListener(ev, stop);
    };
  }, []);

  // Metadata, cell list, content hash (dirty state) and people, from the document.
  useEffect(() => {
    if (!doc || !ready) return;
    const ydoc = doc.ydoc;
    const mmap = metaOf(ydoc);
    const cells = cellsOf(ydoc);
    const order = orderOf(ydoc);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dupTimer: ReturnType<typeof setTimeout> | undefined;
    let gen = 0;
    const hash = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const g = ++gen;
        const h = await sha256Hex(exportIpynb(ydoc));
        if (g === gen) setSha(h);
      }, 700);
    };
    const readM = () => setMeta(readMeta(mmap));
    const readC = () => {
      setCellMaps((prev) => {
        const next = cellViews(ydoc).map((c) => ({ id: c.id, map: c.map }));
        return prev.length === next.length && prev.every((p, i) => p.id === next[i].id && p.map === next[i].map) ? prev : next;
      });
      // Two simultaneous moves leave a duplicate: editors clean it up (idempotent).
      if (!readOnly) {
        clearTimeout(dupTimer);
        dupTimer = setTimeout(() => removeDuplicates(ydoc), 400);
      }
    };
    readM();
    readC();
    hash();
    mmap.observe(readM);
    cells.observe(readC);
    order.observe(readC);
    ydoc.on("update", hash);
    const aw = doc.awareness;
    const readP = () => {
      const list: Person[] = [];
      aw.getStates().forEach((s: any, clientId) => {
        if (s?.user) list.push({ clientId, name: safeLabel(s.user.name), color: safeColor(s.user.color), self: clientId === aw.clientID });
      });
      setPeople((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list));
    };
    readP();
    aw.on("change", readP);
    return () => {
      clearTimeout(timer);
      clearTimeout(dupTimer);
      gen++;
      mmap.unobserve(readM);
      cells.unobserve(readC);
      order.unobserve(readC);
      ydoc.off("update", hash);
      aw.off("change", readP);
    };
  }, [doc, ready, readOnly]);

  // Remote cursors: colour and name come from the presence, filtered before they reach a style sheet.
  useEffect(() => {
    const style = document.createElement("style");
    document.head.appendChild(style);
    style.textContent = cursorStyleSheet(people.filter((p) => !p.self));
    return () => style.remove();
  }, [people]);

  // The kernel session of the notebook, shared by everybody through the document.
  // Any editor can write kernelTerm: only a terminal that is a Jupyter kernel session counts, never a
  // shell (cells would be typed into it as JSON lines, and the shell would expand $(…) in them).
  const named = meta.kernelTerm ?? null;
  const namedTerm = named ? session.terminals.get(named) : undefined;
  const kernelTerm = named && (!namedTerm || namedTerm.label.startsWith("Noyau Jupyter ")) ? named : null;
  const term = kernelTerm ? namedTerm : undefined;
  const termAlive = !!term && (term.status === "running" || term.status === "starting");
  const termGone = !!kernelTerm && (term ? !termAlive : session.state === "online");
  const runnerRef = useRef<NotebookRunner | null>(null);
  runnerRef.current = runner;
  // The runner belongs to the service (it follows the kernel session and the outputs even when this window is
  // hidden): the window only mirrors its status.
  useEffect(() => {
    if (!runner) return;
    const sync = () => setKStatus({ status: runner.status, fatal: runner.fatal });
    sync();
    return runner.on(sync);
  }, [runner]);

  // May this user start a kernel on the node's machine? (Holding its machine key, like for a remote session.)
  const shellKey = shells.join();
  useEffect(() => {
    let live = true;
    host.kernelMachine(nodeId).then((m) => live && setMachine(m), () => live && setMachine(null));
    return () => {
      live = false;
    };
  }, [host, nodeId, shellKey]);

  const dirty = sha !== null && isDirty(sha, meta.savedSha);

  const guard = async (what: string, f: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    try {
      await f();
    } catch (e: any) {
      toast(e?.message ?? "Erreur");
    } finally {
      setBusy(null);
    }
  };

  // ---- cell actions ------------------------------------------------------------------------------------------------------
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const docRef = useRef(doc);
  docRef.current = doc;

  const cellApi = useMemo<CellApi>(() => {
    const ydoc = () => docRef.current!.ydoc;
    const run = (id: string) => {
      const r = runnerRef.current?.run(id);
      if (r && !r.ok) toast(r.reason);
    };
    return {
      select: (id) => setSelected(id),
      focused: () => setFocusReq({ id: null, n: 0 }),
      run,
      runNext: (id) => {
        run(id);
        const list = cellViews(ydoc());
        const i = list.findIndex((c) => c.id === id);
        let next = list[i + 1]?.id;
        try {
          next ??= insertCell(ydoc(), { type: "code", at: "end" });
        } catch (e: any) {
          toast(e.message);
        }
        if (next) {
          setSelected(next);
          setFocusReq({ id: next, n: Date.now() });
        }
      },
      insert: (id, where, type) => {
        try {
          const nid = insertCell(ydoc(), { type, at: where === "before" ? { before: id } : { after: id } });
          setSelected(nid);
          setFocusReq({ id: nid, n: Date.now() });
        } catch (e: any) {
          toast(e.message);
        }
      },
      remove: (id) => void deleteCell(ydoc(), id),
      move: (id, delta) => void moveCell(ydoc(), id, delta),
      setType: (id, type) => void setCellType(ydoc(), id, type),
      clear: (id) => void clearOutputs(ydoc(), id),
      kernel: () => runnerRef.current,
    };
  }, [toast]);

  const addCell = (type: CellType) => {
    if (!doc || readOnly) return;
    try {
      const sel = selectedRef.current;
      const id = insertCell(doc.ydoc, { type, at: sel && cellViews(doc.ydoc).some((c) => c.id === sel) ? { after: sel } : "end" });
      setSelected(id);
      setFocusReq({ id, n: Date.now() });
    } catch (e: any) {
      toast(e.message);
    }
  };

  const runSelected = () => selectedRef.current && cellApi.run(selectedRef.current);
  const runAll = () => {
    if (!doc) return;
    const r = runnerRef.current;
    const ids = cellViews(doc.ydoc)
      .filter((c) => c.type === "code" && !c.running)
      .map((c) => c.id);
    if (r && ids.length) {
      const first = r.run(ids[0]);
      if (!first.ok) return toast(first.reason);
      r.runMany(ids.slice(1));
    }
  };

  // ---- kernel ------------------------------------------------------------------------------------------------------------------
  const startKernel = () =>
    guard("kernel", async () => {
      if (!doc) return;
      const cwd = kernelCwd(meta.path);
      const old = kernelTermOf(doc.ydoc);
      const id = await host.startKernel(nodeId, cwd);
      if (!id) return;
      const cur = kernelTermOf(doc.ydoc);
      const curT = cur && cur !== old ? session.terminals.get(cur) : undefined;
      if (curT && (curT.status === "running" || curT.status === "starting")) {
        // Somebody started one while we were asking: one kernel for everybody.
        session.closeTerminal(id);
        toast("Un noyau vient d'être démarré par quelqu'un d'autre : il est partagé");
        return;
      }
      setKernelTerm(doc.ydoc, id);
      if (old && old !== id) session.closeTerminal(old);
    });
  const stopKernel = async () => {
    if (!doc || !kernelTerm) return;
    if (!(await confirmDialog({ title: "Arrêter le noyau ?", text: "Les variables et l'état du noyau sont perdus, pour tout le monde.", confirm: "Arrêter", danger: true }))) return;
    session.closeTerminal(kernelTerm);
    setKernelTerm(doc.ydoc, null);
  };
  const restartKernel = async () => {
    if (!(await confirmDialog({ title: "Redémarrer le noyau ?", text: "Les variables et l'état du noyau sont perdus, pour tout le monde. Les exécutions en file sont abandonnées.", confirm: "Redémarrer", danger: true }))) return;
    runnerRef.current?.restart();
  };

  // ---- files -------------------------------------------------------------------------------------------------------------------
  const write = async (path: string): Promise<boolean> => {
    if (!doc || !shell) return false;
    const r = await saveMachineFile(shell.client, path, exportIpynb(doc.ydoc), {
      baseSha: path === meta.path ? meta.savedSha : undefined,
      limit: MAX_NOTEBOOK_BYTES,
      confirm: (reason) =>
        confirmDialog({
          title: "Écraser le fichier ?",
          text: reason === "changed" ? `« ${path} » a été modifié sur la machine depuis l'ouverture — écraser ?` : `« ${path} » existe déjà sur la machine — écraser ?`,
          confirm: "Écraser",
          danger: true,
        }),
    });
    if (!r) return false;
    markSaved(doc.ydoc, { path: r.path, sha: r.sha, by: session.you?.name });
    toast(`Enregistré : ${r.path}`);
    return true;
  };

  const save = useCallback(
    (as = false) => {
      if (!doc || readOnly) return Promise.resolve(false);
      if (!shell) {
        toast(noShell);
        return Promise.resolve(false);
      }
      if (!meta.path || as) {
        setSaveAs(meta.path ?? meta.name);
        return Promise.resolve(false);
      }
      let saved = false;
      return guard("save", async () => void (saved = await write(meta.path!))).then(() => saved);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, readOnly, shell?.terminalId, meta.path, meta.name, meta.savedSha, busy],
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  // Ctrl+S, from anywhere in the window (Monaco's own handler would not see it through the capture of keys).
  useEffect(() => {
    const el = rootRef.current!;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key.toLowerCase() !== "s" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      e.preventDefault();
      void saveRef.current(e.shiftKey);
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  const submitSaveAs = (path: string) => {
    const p = path.trim();
    setSaveAs(null);
    if (!p || /[\0]/.test(p) || p.endsWith("/")) return toast("Chemin invalide");
    void guard("save", async () => void (await write(p.endsWith(".ipynb") ? p : `${p}.ipynb`)));
  };

  const reload = async () => {
    if (!doc || !shell || !meta.path || readOnly) return;
    if (dirty && !(await confirmDialog({ title: "Recharger depuis la machine ?", text: "Les modifications non enregistrées du notebook, pour tout le monde, seront perdues.", confirm: "Recharger", danger: true }))) return;
    await guard("reload", async () => {
      const f = await openMachineFile(shell.client, meta.path!, MAX_NOTEBOOK_BYTES);
      let nb;
      try {
        nb = parseIpynb(f.text);
      } catch (e) {
        throw e instanceof NotebookFormatError ? e : new Error("Notebook illisible");
      }
      await fillNotebook(doc.ydoc, nb, { name: meta.name, path: meta.path, sha: f.sha, by: session.you?.name, replace: true });
      if (nb.warnings.length) toast(`Rechargé avec réserves : ${nb.warnings.slice(0, 3).join(" ; ")}`);
    });
  };

  const download = () => {
    if (!doc) return;
    saveBlob(new Blob([exportIpynb(doc.ydoc)], { type: "application/x-ipynb+json" }), meta.name.endsWith(".ipynb") ? meta.name : `${meta.name}.ipynb`);
  };

  // ---- render ------------------------------------------------------------------------------------------------------------------
  const label = title || meta.name;
  const needsShell = (action: string) => (readOnly ? "Lecture seule" : shell ? action : noShell);
  const bg = theme === "dark" ? "#1e1e1e" : "#ffffff";
  const canRun = !readOnly && !!kernelTerm && !termGone && kStatus.status !== "dead" && kStatus.status !== "absent";
  const kernelText = !kernelTerm
    ? "Aucun noyau"
    : termGone
      ? "Noyau arrêté"
      : ({ idle: "Noyau inactif", busy: "Noyau occupé", starting: "Démarrage du noyau…", restarting: "Redémarrage du noyau…", dead: "Noyau arrêté", absent: "Aucun noyau" } as Record<string, string>)[kStatus.status] ?? kStatus.status;
  const kernelClass = !kernelTerm || termGone || kStatus.status === "dead" ? "off" : kStatus.status === "busy" || kStatus.status === "restarting" || kStatus.status === "starting" ? "busy" : "on";
  const kernelTitle = machine ? `Noyau Python sur ${machine.name}` : "Tu n'as pas accès à la clé de cette machine : seuls ceux qui y ont accès peuvent démarrer un noyau";
  const startLabel = kernelTerm ? "Redémarrer le noyau" : "Démarrer le noyau";
  // The bridge is alive but its kernel is not (failed restart): a new kernel session replaces it.
  const kernelDead = !!kernelTerm && !termGone && kStatus.status === "dead";

  return (
    <div className={`term notebook ${active ? "active" : ""}`} ref={rootRef} style={{ ["--term-bg" as any]: bg }}>
      <div className="term-head">
        <NotebookText size={14} />
        <span className="name" title={meta.path ?? meta.name}>
          {meta.name}
          {dirty && <span className="code-dirty" title="Modifications non enregistrées sur la machine" />}
          {title && <span className="status"> · {title.split("\n")[0]}</span>}
        </span>
        <div className="code-people" aria-label="Personnes dans le notebook">
          {people.slice(0, 5).map((p) => (
            <div key={p.clientId} className="avatar" style={{ background: p.color }} title={p.self ? `${p.name} (vous)` : p.name}>
              {initials(p.name)}
            </div>
          ))}
          {people.length > 5 && <span className="code-more">+{people.length - 5}</span>}
        </div>
        <button title={needsShell("Enregistrer sur la machine (Ctrl+S)")} disabled={readOnly || !shell || !!busy || !ready} onClick={() => void save(false)}>
          <Save size={14} />
        </button>
        <button title={needsShell("Enregistrer sous… (Ctrl+Maj+S)")} disabled={readOnly || !shell || !!busy || !ready} onClick={() => void save(true)}>
          <SaveAll size={14} />
        </button>
        <button
          title={!meta.path ? "Ce notebook n'est lié à aucun fichier de la machine" : needsShell("Recharger depuis la machine")}
          disabled={readOnly || !shell || !meta.path || !!busy || !ready}
          onClick={() => void reload()}
        >
          <RefreshCw size={14} />
        </button>
        <button title="Télécharger le .ipynb" disabled={!ready} onClick={download}>
          <Download size={14} />
        </button>
        {onHide && (
          <button title="Masquer (le notebook reste partagé, l'icône aussi)" onClick={onHide}>
            <Minimize2 size={14} />
          </button>
        )}
        {onRemove && (
          <button
            title="Retirer ce notebook de la machine"
            onClick={async () => {
              if (await confirmDialog({ title: "Retirer ce notebook du schéma ?", text: `« ${label} » disparaît du schéma pour tout le monde, avec son noyau. Le fichier sur la machine n'est pas touché.`, confirm: "Retirer", danger: true })) onRemove();
            }}
          >
            <Power size={14} />
          </button>
        )}
      </div>
      <div className="nb-toolbar" role="toolbar" aria-label="Notebook">
        <button title="Exécuter la cellule (Maj+Entrée : et passer à la suivante, Ctrl+Entrée : sans passer)" disabled={!canRun || !selected} onClick={runSelected}>
          <Play size={13} /> Exécuter
        </button>
        <button title="Tout exécuter" disabled={!canRun || !ready} onClick={runAll}>
          <FastForward size={13} /> Tout
        </button>
        <button title="Interrompre l'exécution en cours" disabled={!canRun || kStatus.status !== "busy"} onClick={() => runnerRef.current?.interrupt()}>
          <Square size={12} />
        </button>
        <button title="Redémarrer le noyau (l'état est perdu)" disabled={!canRun} onClick={() => void restartKernel()}>
          <RotateCw size={13} />
        </button>
        <span className="nb-sep" />
        <button title="Ajouter une cellule de code" disabled={readOnly || !ready} onClick={() => addCell("code")}>
          <Plus size={13} /> Code
        </button>
        <button title="Ajouter une cellule Markdown" disabled={readOnly || !ready} onClick={() => addCell("markdown")}>
          <Type size={13} /> Markdown
        </button>
        <span className="nb-grow" />
        <span className={`nb-kernel ${kernelClass}`} title={kStatus.fatal ?? kernelTitle}>
          <span className="dot" />
          {kernelText}
        </span>
        {(!kernelTerm || termGone || kernelDead) && !readOnly && (
          <button className="nb-start" title={machine ? `${startLabel} sur ${machine.name}` : kernelTitle} disabled={!machine || !!busy || !ready} onClick={() => void startKernel()}>
            <Power size={13} /> {kernelTerm ? "Redémarrer le noyau" : "Démarrer le noyau"}
          </button>
        )}
        {kernelTerm && !termGone && !readOnly && (
          <button title="Arrêter le noyau" onClick={() => void stopKernel()}>
            <Power size={13} />
          </button>
        )}
      </div>
      {(termGone || kernelDead || kStatus.fatal) && kernelTerm && (
        <div className="nb-banner">
          Noyau arrêté{kStatus.fatal ? ` : ${kStatus.fatal}` : ""}
          {!machine && " — seuls ceux qui ont accès à la machine peuvent le relancer"}
        </div>
      )}
      {saveAs !== null && (
        <form
          className="code-saveas"
          onSubmit={(e) => {
            e.preventDefault();
            submitSaveAs(saveAs);
          }}
        >
          <input
            autoFocus
            value={saveAs}
            spellCheck={false}
            placeholder="chemin/notebook.ipynb (relatif au dossier du shell, ou absolu)"
            aria-label="Chemin du notebook sur la machine"
            onChange={(e) => setSaveAs(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setSaveAs(null)}
          />
          <button type="submit" className="btn btn-sm btn-primary">
            Enregistrer
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setSaveAs(null)}>
            Annuler
          </button>
        </form>
      )}
      <div className="term-body nb-body">
        {ready && doc && (
          <div className="nb-cells">
            {cellMaps.map((c, i) => (
              <NotebookCell
                key={c.id}
                map={c.map}
                id={c.id}
                index={i}
                selected={selected === c.id}
                focus={focusReq.id === c.id ? focusReq.n : 0}
                readOnly={readOnly}
                theme={theme}
                awareness={doc.awareness}
                markdown={markdown}
                api={cellApi}
              />
            ))}
            {!cellMaps.length && <div className="nb-empty">Notebook vide.</div>}
            {!readOnly && cellMaps.length > 0 && (
              <div className="nb-add">
                <button className="btn btn-sm" onClick={() => addCell("code")}>
                  <Plus size={12} /> Code
                </button>
                <button className="btn btn-sm" onClick={() => addCell("markdown")}>
                  <Plus size={12} /> Markdown
                </button>
              </div>
            )}
          </div>
        )}
        {!ready && <div className="term-veil">{error ?? "Connexion au notebook…"}</div>}
        {ready && error && <div className="term-veil bottom">{error}</div>}
      </div>
    </div>
  );
}
