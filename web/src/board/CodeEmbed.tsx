// A code window: Monaco (open-source core of VS Code) bound to an end-to-end encrypted shared
// Yjs document (sharedDoc.ts). The text and the cursors travel sealed; the file itself lives on
// the node's machine, read and written through the sealed file channel of a local shell.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronUp, Download, FileCode2, FolderOpen, Minimize2, Play, Power, RefreshCw, RotateCw, Save, SaveAll, Square, TerminalSquare } from "lucide-react";
import { MonacoBinding } from "y-monaco";
import type * as Monaco from "monaco-editor";
import { monaco } from "./monacoEnv.ts";
import type { BoardSession } from "./collab.ts";
import type { SharedDoc } from "./sharedDoc.ts";
import {
  LANGUAGES,
  cursorStyleSheet,
  initBlank,
  initFromFile,
  isDirty,
  kernelTermOf,
  markSaved,
  outputsOf,
  readMeta,
  readOutputs,
  setKernelTerm,
  runCommand,
  safeColor,
  safeLabel,
  sha256Hex,
  takeInit,
  type CodeMeta,
} from "./codeDoc.ts";
import { openMachineFile, pickLocalShell, saveMachineFile, sendCommand } from "./machineFiles.ts";
import { acquireCode, peekNotebookRunner, sessionEnv } from "./notebookService.ts";
import type { CodeRunner } from "./codeRunner.ts";
import { kernelCwd } from "./notebookDoc.ts";
import { classifyOutputs } from "./notebookRender.ts";
import { Outputs } from "./OutputView.tsx";
import { bindPythonKernel } from "./pyKernel.ts";
import { applyEditorSettings, useEditorSettings } from "./editorSettings.ts";
import { EditorSettingsMenu } from "./EditorSettingsMenu.tsx";

/** What the window needs from the app's UI kit, handed in by the board page (this chunk must not import it: see BoardPage). */
export type CodeHost = {
  theme: "light" | "dark";
  confirm: (o: { title: string; text: string; confirm: string; danger?: boolean }) => Promise<boolean>;
  toast: (text: string) => void;
  /** The machine of the node when this user may open a kernel session on it (holds its machine key); null otherwise. */
  kernelMachine?: (nodeId: string) => Promise<{ name: string } | null>;
  /** Asks the user, then starts a kernel session on the node's machine. Resolves with the terminal id, null if cancelled. */
  startKernel?: (nodeId: string, cwd?: string, purpose?: "code" | "notebook") => Promise<string | null>;
};

type Props = {
  host: CodeHost;
  session: BoardSession;
  docId: string;
  nodeId?: string;
  active: boolean;
  /** The node's shells, the ones whose window is open first: the file goes through the first running local one. */
  shells: string[];
  /** The node's notebooks: a running kernel session of one of them answers completion in a Python file. */
  notebookDocs?: string[];
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

/**
 * The code service of this window (document + kernel runner, see notebookService.ts): joined with the
 * window, released with it. The service outlives the window while a run is in flight.
 */
function useDoc(session: BoardSession, docId: string) {
  const [doc, setDoc] = useState<SharedDoc | null>(null);
  const [runner, setRunner] = useState<CodeRunner | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const h = acquireCode(session, sessionEnv(session), docId);
    const d = h.doc;
    setDoc(d);
    setRunner(h.runner);
    setReady(false);
    const off = d.onError((m) => live && setError(m));
    d.synced.then(() => {
      if (!live) return;
      // A file opened from the machine (or a new blank one) fills the document once, here.
      if (!d.readOnly) {
        const init = takeInit(docId);
        if (init === "blank") initBlank(d.ydoc);
        else if (init) initFromFile(d.ydoc, { ...init, by: session.you?.name });
      }
      setReady(true);
    });
    return () => {
      live = false;
      off();
      h.release();
    };
  }, [session, docId]);
  return { doc, runner, ready, error };
}

export default function CodeEmbed({ host, session, docId, nodeId, active, shells, notebookDocs, title, onHide, onRemove, onLabel }: Props) {
  const { doc, runner, ready, error } = useDoc(session, docId);
  const { theme, confirm: confirmDialog, toast } = host;
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [meta, setMeta] = useState<CodeMeta>({ name: "sans-titre", language: "plaintext" });
  const [sha, setSha] = useState<string | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const readOnly = !session.canEdit || !!doc?.readOnly;
  // The dock shows the file name: editors keep it in the node (a no-op when it is already there).
  const labelRef = useRef(onLabel);
  labelRef.current = onLabel;
  useEffect(() => {
    if (ready && !readOnly) labelRef.current?.(meta.name);
  }, [ready, readOnly, meta.name]);

  // Shell statuses live in the session: re-render when they change.
  useSyncExternalStore(
    (cb) => session.on("terminals", cb),
    () => [...session.terminals.values()].map((t) => t.status).join(),
  );
  const shell = pickLocalShell(session, { shells: shells.map((terminalId) => ({ terminalId })) });
  const noShell = "Aucun shell local en cours sur cette machine";

  // Keep keys, clipboard and wheel inside the editor instead of reaching the canvas.
  useEffect(() => {
    const el = rootRef.current!;
    const stop = (e: Event) => e.stopPropagation();
    for (const ev of WHEEL_AND_KEYS) el.addEventListener(ev, stop);
    return () => {
      for (const ev of WHEEL_AND_KEYS) el.removeEventListener(ev, stop);
    };
  }, []);

  // Metadata, content hash (for the dirty state) and people, from the document.
  useEffect(() => {
    if (!doc || !ready) return;
    const text = doc.ydoc.getText("content");
    const map = doc.ydoc.getMap("meta");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gen = 0;
    const hash = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const g = ++gen;
        const h = await sha256Hex(text.toString());
        if (g === gen) setSha(h);
      }, 120);
    };
    const readM = () => setMeta(readMeta(map));
    readM();
    hash();
    map.observe(readM);
    text.observe(hash);
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
      gen++;
      map.unobserve(readM);
      text.unobserve(hash);
      aw.off("change", readP);
    };
  }, [doc, ready]);

  // Remote cursors: y-monaco tags them with per-client classes; colour and name come from awareness.
  const styleRef = useRef<HTMLStyleElement | null>(null);
  useEffect(() => {
    const style = document.createElement("style");
    document.head.appendChild(style);
    styleRef.current = style;
    return () => style.remove();
  }, []);
  useEffect(() => {
    if (styleRef.current) styleRef.current.textContent = cursorStyleSheet(people.filter((p) => !p.self));
  }, [people]);

  // The editor itself.
  useEffect(() => {
    if (!doc || !ready || !hostRef.current) return;
    const model = monaco.editor.createModel("", readMeta(doc.ydoc.getMap("meta")).language);
    const editor = monaco.editor.create(hostRef.current, {
      model,
      readOnly,
      theme: theme === "dark" ? "vs-dark" : "vs",
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      tabSize: 4,
      domReadOnly: readOnly,
    });
    editorRef.current = editor;
    const binding = new MonacoBinding(doc.ydoc.getText("content"), model, new Set([editor]), doc.awareness);
    return () => {
      binding.destroy();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
    // `theme` and `readOnly` are applied by the effects below, without rebuilding the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, ready]);
  useEffect(() => {
    monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
  }, [theme]);
  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly, domReadOnly: readOnly });
  }, [readOnly, ready]);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getLanguageId() !== meta.language) monaco.editor.setModelLanguage(model, meta.language);
  }, [meta.language, ready]);

  // Python files complete and show docstrings through a kernel session, when the node has one (Ctrl+Espace, ".", Maj+Tab).
  const notebooksRef = useRef(notebookDocs ?? []);
  notebooksRef.current = notebookDocs ?? [];
  useEffect(() => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model || !ready || meta.language !== "python") return;
    // The file's own kernel first, else a kernel a notebook of the node already follows.
    return bindPythonKernel(ed, model, () => (runner?.term && runner.status !== "dead" ? runner : peekNotebookRunner(session, notebooksRef.current)));
  }, [ready, doc, meta.language, session, runner]);

  // Local editor preferences; declared after the kernel binding so they win over its suggestion defaults.
  const { settings: editorPrefs } = useEditorSettings();
  useEffect(() => {
    if (editorRef.current) applyEditorSettings(editorRef.current, editorPrefs, false, meta.language !== "python");
  }, [editorPrefs, doc, ready, meta.language, runner]);

  const dirty = sha !== null && isDirty(sha, meta.savedSha);
  const text = () => doc!.ydoc.getText("content").toString();

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


  // ---- running the file in a kernel (Python) ----------------------------------------------------------------
  const isPython = meta.language === "python";
  // Only a Jupyter kernel session counts (notebookService refuses to run cells in anything else).
  const named = meta.kernelTerm ?? null;
  const namedTerm = named ? session.terminals.get(named) : undefined;
  const kernelTerm = named && (!namedTerm || namedTerm.label.startsWith("Noyau Jupyter ")) ? named : null;
  const kTerm = kernelTerm ? namedTerm : undefined;
  const termGone = !!kernelTerm && (kTerm ? !(kTerm.status === "running" || kTerm.status === "starting") : session.state === "online");
  const [kStatus, setKStatus] = useState<{ status: string; fatal: string | null }>({ status: "absent", fatal: null });
  const [panel, setPanel] = useState(true);
  const [machine, setMachine] = useState<{ name: string } | null>(null);
  const [outRev, bumpOut] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!runner) return;
    const sync = () => setKStatus({ status: runner.status, fatal: runner.fatal });
    sync();
    return runner.on(sync);
  }, [runner]);
  useEffect(() => {
    if (!doc || !ready) return;
    const outs = outputsOf(doc.ydoc);
    outs.observe(bumpOut);
    bumpOut();
    return () => outs.unobserve(bumpOut);
  }, [doc, ready]);
  const shellKey = shells.join();
  useEffect(() => {
    let live = true;
    if (!nodeId || !host.kernelMachine) return;
    host.kernelMachine(nodeId).then((m) => live && setMachine(m), () => live && setMachine(null));
    return () => {
      live = false;
    };
  }, [host, nodeId, shellKey]);
  const outputItems = useMemo(
    () => (doc && ready ? classifyOutputs(readOutputs(doc.ydoc), { dark: theme === "dark" }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, ready, outRev, theme],
  );
  const running = !!meta.running;
  const hasKernel = !!kernelTerm && !termGone && kStatus.status !== "dead" && kStatus.status !== "absent";
  const canStartKernel = !!machine && !!host.startKernel && !!nodeId;
  const kernelLabel = !kernelTerm ? "Aucun noyau" : termGone || kStatus.status === "dead" ? "Noyau arrêté" : kStatus.status === "busy" ? "Exécution…" : kStatus.status === "restarting" ? "Redémarrage…" : "Noyau prêt";

  /** Starts the kernel of this file (asking first), unless somebody else has just done it. */
  const ensureKernel = async (): Promise<boolean> => {
    if (!doc || !host.startKernel || !nodeId) return false;
    if (hasKernel) return true;
    const old = kernelTermOf(doc.ydoc);
    const id = await host.startKernel(nodeId, kernelCwd(meta.path), "code");
    if (!id) return false;
    const cur = kernelTermOf(doc.ydoc);
    const curT = cur && cur !== old ? session.terminals.get(cur) : undefined;
    if (curT && (curT.status === "running" || curT.status === "starting")) {
      // Somebody started one while we were asking: one kernel for everybody.
      session.closeTerminal(id);
      toast("Un noyau vient d'être démarré par quelqu'un d'autre : il est partagé");
      return true;
    }
    setKernelTerm(doc.ydoc, id);
    if (old && old !== id) session.closeTerminal(old);
    return true;
  };

  /** Runs the CURRENT content of the window (saved or not) on the file's kernel. */
  const runInKernel = () =>
    guard("run", async () => {
      if (!doc || !runner || readOnly) return;
      if (running) return toast("Ce fichier est déjà en cours d'exécution");
      if (!(await ensureKernel())) return;
      setPanel(true);
      const r = runner.run(text());
      if (!r.ok) toast(r.reason);
    });
  const interrupt = () => {
    if (!runner?.interrupt()) toast("Rien à interrompre");
  };
  const restartKernel = async () => {
    if (!(await confirmDialog({ title: "Redémarrer le noyau ?", text: "Les variables et l'état du noyau sont perdus, pour tout le monde. Les exécutions en file sont abandonnées.", confirm: "Redémarrer", danger: true }))) return;
    runner?.restart();
  };

  /** The path this tab chose itself (saved to, or typed in « enregistrer sous »). */
  const ownPath = useRef<string | null>(null);

  /** Writes the document to the machine; resolves true once it is saved. */
  const write = async (path: string): Promise<boolean> => {
    if (!doc || !shell) return false;
    // The path is in the shared document: any editor can change it. Writing on our machine, under
    // our name, to a path someone else picked asks first.
    if (path !== ownPath.current) {
      const ok = await confirmDialog({
        title: "Enregistrer sur la machine ?",
        text: `Le fichier sera écrit dans « ${path} » (chemin choisi par un participant du tableau).`,
        confirm: "Enregistrer",
      });
      if (!ok) return false;
    }
    const r = await saveMachineFile(shell.client, path, text(), {
      baseSha: path === meta.path ? meta.savedSha : undefined,
      confirm: (reason) =>
        confirmDialog({
          title: "Écraser le fichier ?",
          text:
            reason === "changed"
              ? `« ${path} » a été modifié sur la machine depuis l'ouverture — écraser ?`
              : `« ${path} » existe déjà sur la machine — écraser ?`,
          confirm: "Écraser",
          danger: true,
        }),
    });
    if (!r) return false;
    ownPath.current = r.path;
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

  // Ctrl+S, from the editor or from anywhere in the window.
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
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !ready) return;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current(false));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => void saveRef.current(true));
  }, [ready, doc]);

  const submitSaveAs = (path: string) => {
    const p = path.trim();
    setSaveAs(null);
    ownPath.current = p; // typed here: no need to ask again
    if (!p || /[\0]/.test(p) || p.endsWith("/")) return toast("Chemin invalide");
    void guard("save", async () => void (await write(p)));
  };

  const reload = async () => {
    if (!doc || !shell || !meta.path || readOnly) return;
    if (dirty && !(await confirmDialog({ title: "Recharger depuis la machine ?", text: "Les modifications non enregistrées du document, pour tout le monde, seront perdues.", confirm: "Recharger", danger: true }))) return;
    await guard("reload", async () => {
      const f = await openMachineFile(shell.client, meta.path!);
      const t = doc.ydoc.getText("content");
      doc.ydoc.transact(() => {
        t.delete(0, t.length);
        t.insert(0, f.text);
        const m = doc.ydoc.getMap("meta");
        m.set("savedSha", f.sha);
        m.set("savedAt", Date.now());
        if (session.you?.name) m.set("savedBy", session.you.name);
      });
    });
  };

  const download = () => {
    if (!doc) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text()], { type: "text/plain;charset=utf-8" }));
    a.download = meta.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const cmd = meta.path ? runCommand(meta.path, meta.language) : runCommand(meta.name, meta.language);
  const runnable = !!runCommand(meta.name, meta.language);
  const run = async () => {
    if (!doc || !shell || !runnable) return;
    // Save first (the file on the machine must be what is on screen), then run what it became.
    if (!meta.path || dirty) {
      if (!meta.path) return void setSaveAs(meta.name);
      if (!(await saveRef.current(false))) return;
    }
    const path = doc.ydoc.getMap("meta").get("path");
    const line = typeof path === "string" ? runCommand(path, meta.language) : cmd;
    if (!line) return;
    const ok = await confirmDialog({
      title: "Exécuter dans le terminal ?",
      text: `La ligne suivante sera tapée dans le shell « ${session.terminals.get(shell.terminalId)?.label ?? "local"} » : ${line}`,
      confirm: "Exécuter",
    });
    if (ok) sendCommand(session, shell.terminalId, line);
  };

  const label = title || meta.name;
  const needsShell = (action: string) => (readOnly ? "Lecture seule" : shell ? action : noShell);
  const bg = theme === "dark" ? "#1e1e1e" : "#ffffff";

  return (
    <div className={`term code ${active ? "active" : ""}`} ref={rootRef} style={{ ["--term-bg" as any]: bg }}>
      <div className="term-head">
        <FileCode2 size={14} />
        <span className="name" title={meta.path ?? meta.name}>
          {meta.name}
          {dirty && <span className="code-dirty" title="Modifications non enregistrées sur la machine" />}
          {title && <span className="status"> · {title.split("\n")[0]}</span>}
        </span>
        <select
          className="code-lang"
          value={meta.language}
          disabled={readOnly || !ready}
          title="Langage"
          aria-label="Langage"
          onChange={(e) => doc?.ydoc.getMap("meta").set("language", e.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
        <EditorSettingsMenu />
        <div className="code-people" aria-label="Personnes dans le document">
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
          title={!meta.path ? "Ce document n'est lié à aucun fichier de la machine" : needsShell("Recharger depuis la machine")}
          disabled={readOnly || !shell || !meta.path || !!busy || !ready}
          onClick={() => void reload()}
        >
          <RefreshCw size={14} />
        </button>
        <button title="Télécharger" disabled={!ready} onClick={download}>
          <Download size={14} />
        </button>
        {isPython && host.startKernel && (
          <>
            <button
              title={readOnly ? "Lecture seule" : running ? "Exécution en cours" : hasKernel || canStartKernel ? "Exécuter le contenu actuel dans le noyau Python" : "Il faut l'accès à la machine pour démarrer un noyau"}
              disabled={readOnly || !ready || !!busy || running || (!hasKernel && !canStartKernel)}
              onClick={() => void runInKernel()}
            >
              <Play size={14} />
            </button>
            {running && (
              <button title="Interrompre l'exécution" onClick={interrupt}>
                <Square size={14} />
              </button>
            )}
          </>
        )}
        {runnable && (
          <button title={needsShell("Enregistrer puis exécuter dans le terminal")} disabled={readOnly || !shell || !!busy || !ready} onClick={() => void run()}>
            {isPython && host.startKernel ? <TerminalSquare size={14} /> : <Play size={14} />}
          </button>
        )}
        {onHide && (
          <button title="Masquer (le document reste partagé, l'icône aussi)" onClick={onHide}>
            <Minimize2 size={14} />
          </button>
        )}
        {onRemove && (
          <button
            title="Retirer ce fichier de la machine"
            onClick={async () => {
              if (await confirmDialog({ title: "Retirer ce fichier du schéma ?", text: `« ${label} » disparaît du schéma pour tout le monde, avec son document partagé. Le fichier sur la machine n'est pas touché.`, confirm: "Retirer", danger: true })) onRemove();
            }}
          >
            <Power size={14} />
          </button>
        )}
      </div>
      {saveAs !== null && (
        <form
          className="code-saveas"
          onSubmit={(e) => {
            e.preventDefault();
            submitSaveAs(saveAs);
          }}
        >
          <FolderOpen size={14} />
          <input
            autoFocus
            value={saveAs}
            spellCheck={false}
            placeholder="chemin/fichier.py (relatif au dossier du shell, ou absolu)"
            aria-label="Chemin du fichier sur la machine"
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
      <div className="term-body code-body">
        <div className="code-main">
          <div ref={hostRef} className="code-host" />
          {!ready && <div className="term-veil">{error ?? "Connexion au document…"}</div>}
          {ready && error && <div className="term-veil bottom">{error}</div>}
        </div>
        {isPython && host.startKernel && ready && (
          <div className={`code-out ${panel ? "open" : ""}`}>
            <div className="code-out-head">
              <button className="code-out-toggle" onClick={() => setPanel(!panel)} title={panel ? "Replier la sortie" : "Déplier la sortie"}>
                {panel ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                <span>Sortie</span>
              </button>
              <span className={`code-out-state ${hasKernel ? (kStatus.status === "busy" ? "busy" : "on") : "off"}`}>{kernelLabel}</span>
              {kStatus.fatal && kernelTerm && <span className="code-out-fatal" title={kStatus.fatal}>{kStatus.fatal}</span>}
              <span style={{ flex: 1 }} />
              <button title={running ? "Interrompre l'exécution" : "Aucune exécution en cours"} disabled={readOnly || !running} onClick={interrupt}>
                <Square size={13} /> <span>Interrompre</span>
              </button>
              <button title={readOnly ? "Lecture seule" : "Redémarrer le noyau"} disabled={readOnly || !hasKernel} onClick={() => void restartKernel()}>
                <RotateCw size={13} /> <span>Redémarrer</span>
              </button>
            </div>
            {panel && (
              <div className="code-out-body">
                {outputItems.length ? <Outputs items={outputItems} /> : <div className="nb-empty">{running ? "Exécution en cours…" : "Aucune sortie : lance le fichier avec ▶."}</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
