import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { Cable, ChevronDown, ChevronUp, Download, FolderOpen, Lock, LockOpen, Maximize2, Minimize2, Monitor, Palette, Power, Radio, RotateCcw, Search, TerminalSquare, X } from "lucide-react";
import { isRemoteLabel, type BoardSession } from "./collab.ts";
import { confirmDialog, toast, useTheme } from "../components/ui.tsx";
import type { TermColors } from "../themes.ts";
import { iconUrl, type TileIcon } from "./personalLibrary.ts";
import { TileCustomizer, type TilePatch } from "./TileCustomizer.tsx";
import { CastRecorder, bufferToText, exportName } from "./termTools.ts";
import { saveBlob } from "../download.ts";
import { fmtBytes } from "../format.ts";
import { FileClient, type Signal } from "./fileTransfer.ts";
import { FilesPanel } from "./FilesPanel.tsx";
import { clearBroadcast, fanOut, liveTargets, setBroadcast, toggleBroadcast, useBroadcastGroup } from "./broadcast.ts";

const FONT = '"Cascadia Code", ui-monospace, Menlo, monospace';

/** xterm colors of a theme (the cursor's text takes the background color). */
const termTheme = (c: TermColors) => ({ ...c, cursorAccent: c.background });

function useTerminalInfo(session: BoardSession, id: string) {
  return useSyncExternalStore(
    (cb) => session.on("terminals", cb),
    () => session.terminals.get(id),
  );
}

const STATUS_LABEL = {
  starting: "démarrage…",
  running: "en cours",
  exited: "terminé",
  offline: "machine hors ligne",
};

/**
 * A live shell rendered inside an Excalidraw embeddable. Excalidraw only routes
 * pointer events to it once the user clicks the element ("active" state).
 */
type Props = {
  session: BoardSession;
  terminalId: string;
  active: boolean;
  /** Shown as a small machine tile; the shell keeps running and its grid is untouched. */
  collapsed: boolean;
  /** Custom label and library icon shown on the tile. */
  title?: string | null;
  icon?: TileIcon | null;
  onToggleCollapsed?: () => void;
  /** Tooltip of the header's reduce button (windows of a node are hidden, not collapsed). */
  toggleTitle?: string;
  onCustomize?: (patch: TilePatch, collapse: boolean) => void;
  /** Replaces the plain close: the shell of a machine icon is also removed from it. */
  onKill?: () => void;
  /** Window locked in place (can't be moved or resized); the shell stays usable. */
  locked?: boolean;
  onToggleLock?: () => void;
};

export function useIconUrl(icon: TileIcon | null | undefined) {
  const { theme } = useTheme();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!icon) return setUrl(null);
    let live = true;
    iconUrl(icon, theme === "dark").then((u) => live && setUrl(u)).catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [icon, theme]);
  return url;
}

export function TerminalEmbed({ session, terminalId, active, collapsed, title, icon, onToggleCollapsed, toggleTitle, onCustomize, onKill, locked, onToggleLock }: Props) {
  const info = useTerminalInfo(session, terminalId);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // Terminal colors follow the interface theme, also while the terminal is open.
  const { current: uiTheme } = useTheme();
  const themeRef = useRef(uiTheme);
  themeRef.current = uiTheme;
  // Before the first paint, so a light terminal never flashes the default dark background.
  useLayoutEffect(() => {
    if (termRef.current) termRef.current.options.theme = termTheme(uiTheme.term);
    rootRef.current?.style.setProperty("--term-bg", uiTheme.term.background);
  }, [uiTheme]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  // New output while reduced to a tile: show an activity badge.
  const [unread, setUnread] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const iconSrc = useIconUrl(icon);
  // Scrollback search bar.
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  // asciinema recording: output is appended to the recorder, React only sees start/stop.
  const recRef = useRef<CastRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const nameRef = useRef("terminal");
  // File transfers (agent/files.go): only on a running local shell, for editors.
  const [filesOpen, setFilesOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [xfer, setXfer] = useState<{ name: string; done: number; total?: number } | null>(null);
  const xferSignal = useRef<Signal | null>(null);
  const client = useMemo(() => new FileClient(session, terminalId), [session, terminalId]);

  useEffect(() => {
    const body = bodyRef.current!;
    const term = new Terminal({
      fontFamily: FONT,
      fontSize: 13,
      lineHeight: 1.15,
      theme: termTheme(themeRef.current.term),
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    const resultsSub = search.onDidChangeResults((r) => setResults({ index: r.resultIndex, count: r.resultCount }));
    // Ctrl+Shift+F opens the search bar instead of reaching the shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === "KeyF") {
        e.preventDefault();
        setSearchOpen(true);
        searchInput.current?.select();
        return false;
      }
      return true;
    });
    const resizeSub = term.onResize((e) => recRef.current?.resize(e.cols, e.rows));
    termRef.current = term;

    let disposed = false;
    let unsubscribe = () => {};
    let observer: ResizeObserver | undefined;

    const refit = () => {
      if (disposed || !body.offsetWidth || !body.offsetHeight) return;
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      const cols = Math.max(10, dims.cols);
      const rows = Math.max(3, dims.rows);
      if (cols !== term.cols || rows !== term.rows) {
        term.resize(cols, rows);
        session.resizeTerminal(terminalId, cols, rows);
      }
    };

    // Metrics must use the real font, or every client computes a different grid.
    document.fonts.load(`13px ${FONT}`).finally(() => {
      if (disposed) return;
      term.open(body);
      term.onData((d) => {
        session.terminalInput(terminalId, d);
        fanOut(session, terminalId, d);
      });
      term.onBinary((d) => {
        const bytes = Uint8Array.from(d, (c) => c.charCodeAt(0));
        session.terminalInput(terminalId, bytes);
        fanOut(session, terminalId, bytes);
      });
      unsubscribe = session.subscribeTerminal(terminalId, {
        onReplay: (data) => {
          term.reset();
          term.write(data);
          if (recRef.current && !recRef.current.output(data, true)) stopRecordingRef.current(true);
        },
        onData: (data) => {
          term.write(data);
          if (recRef.current && !recRef.current.output(data)) stopRecordingRef.current(true);
          if (collapsedRef.current && data.length) setUnread(true);
        },
      });
      observer = new ResizeObserver(refit);
      observer.observe(body);
      refit();
      if (activeRef.current) term.focus();
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      unsubscribe();
      // A window that goes away must not keep receiving keystrokes it can't show.
      setBroadcast(terminalId, false);
      recRef.current = null;
      resultsSub.dispose();
      resizeSub.dispose();
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
  }, [session, terminalId]);

  // Someone else resized the window: follow the PTY's grid.
  useEffect(() => {
    const term = termRef.current;
    if (term && info && (info.cols !== term.cols || info.rows !== term.rows) && term.element) term.resize(info.cols, info.rows);
  }, [info?.cols, info?.rows]);

  useEffect(() => {
    if (active && !collapsed) termRef.current?.focus();
    else termRef.current?.blur();
  }, [active, collapsed]);

  // Clicking a selected tile activates it: that is the "open" gesture.
  useEffect(() => {
    if (active && collapsed) onToggleCollapsed?.();
  }, [active, collapsed, onToggleCollapsed]);

  useEffect(() => {
    if (!collapsed) setUnread(false);
  }, [collapsed]);

  // Dropping files on a local shell uploads them into its working directory.
  const canFilesRef = useRef(false);
  const dropRef = useRef<(e: DragEvent) => void>(() => {});
  useEffect(() => {
    const el = rootRef.current!;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation(); // not for the canvas, which would import the file into the drawing
      if (e.dataTransfer) e.dataTransfer.dropEffect = canFilesRef.current ? "copy" : "none";
      setDropping(canFilesRef.current);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget || !el.contains(e.relatedTarget as Node)) setDropping(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropping(false);
      if (canFilesRef.current) dropRef.current(e);
    };
    el.addEventListener("dragover", over);
    el.addEventListener("dragleave", leave);
    el.addEventListener("drop", drop);
    return () => {
      el.removeEventListener("dragover", over);
      el.removeEventListener("dragleave", leave);
      el.removeEventListener("drop", drop);
    };
  }, []);

  // Keep keys, clipboard and wheel inside the terminal instead of reaching the canvas.
  useEffect(() => {
    const el = rootRef.current!;
    const stop = (e: Event) => e.stopPropagation();
    const events = ["keydown", "keyup", "keypress", "paste", "copy", "cut", "wheel"];
    for (const ev of events) el.addEventListener(ev, stop);
    return () => {
      for (const ev of events) el.removeEventListener(ev, stop);
    };
  }, []);

  // Right-click anywhere on the window (title bar or shell) opens Excalidraw's menu for it (lock,
  // layers, copy, delete…): an active window catches the clicks itself, so pass this one to the
  // canvas at the same spot. Copy / paste in the shell stay on the keyboard (Ctrl+Shift+C / V).
  useEffect(() => {
    const el = rootRef.current!;
    const toCanvas = (e: MouseEvent) => {
      const canvas = el.closest(".excalidraw")?.querySelector("canvas.interactive");
      if (!canvas) return;
      e.preventDefault();
      e.stopPropagation();
      canvas.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 2, buttons: 2 }),
      );
    };
    el.addEventListener("contextmenu", toCanvas, true);
    return () => el.removeEventListener("contextmenu", toCanvas, true);
  }, []);

  // Broadcast input: Alt+B toggles the terminal that has the keyboard focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.code !== "KeyB" || e.ctrlKey || e.metaKey || !session.canEdit) return;
      if (!rootRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      toggleBroadcast(terminalId);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [session, terminalId]);

  // Pasting several lines into a group is dangerous (each line runs everywhere): ask first.
  useEffect(() => {
    const el = rootRef.current!;
    const onPaste = async (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (!/[\r\n]/.test(text.replace(/[\r\n]+$/, ""))) return;
      const n = liveTargets(session).length;
      if (n < 2 || !liveTargets(session).includes(terminalId)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const lines = text.replace(/[\r\n]+$/, "").split(/\r\n|\r|\n/).length;
      const ok = await confirmDialog({
        title: `Coller ${lines} lignes dans ${n} terminaux ?`,
        text: "La saisie est diffusée : ce texte sera collé, et donc exécuté ligne par ligne, dans tous les terminaux de la diffusion.",
        confirm: "Coller partout",
        danger: true,
      });
      if (ok) termRef.current?.paste(text);
      else termRef.current?.focus();
    };
    el.addEventListener("paste", onPaste, true);
    return () => el.removeEventListener("paste", onPaste, true);
  }, [session, terminalId]);

  const cancelTransfer = () => {
    if (xferSignal.current) xferSignal.current.aborted = true;
  };
  // Runs one transfer at a time; the shell's own state is never touched.
  const runTransfer = async (name: string, job: (signal: Signal, progress: (done: number, total?: number) => void) => Promise<void>) => {
    const signal: Signal = { aborted: false };
    xferSignal.current = signal;
    setXfer({ name, done: 0 });
    try {
      await job(signal, (done, total) => setXfer({ name, done, total }));
    } catch (e) {
      toast.error(e);
    } finally {
      xferSignal.current = null;
      setXfer(null);
    }
  };
  const sendFiles = async (files: File[], dir?: string) => {
    if (xferSignal.current) return toast.error(new Error("Un transfert est déjà en cours"));
    for (const file of files) {
      await runTransfer(file.name, async (signal, progress) => {
        const send = (overwrite: boolean) => client.upload(file, { dir, overwrite, signal, onProgress: progress });
        let path: string;
        try {
          path = await send(false);
        } catch (e: any) {
          if (e?.code !== "exists") throw e;
          const ok = await confirmDialog({
            title: `Remplacer « ${file.name} » ?`,
            text: "Un fichier de ce nom existe déjà dans le dossier du shell. Il sera remplacé par le fichier envoyé.",
            confirm: "Remplacer",
            danger: true,
          });
          if (!ok) return;
          path = await send(true);
        }
        toast(`Envoyé : ${path}`);
      });
    }
  };
  const fetchFile = (path: string) => {
    if (xferSignal.current) return toast.error(new Error("Un transfert est déjà en cours"));
    runTransfer(path.split("/").pop() || path, async (signal, progress) => {
      const { name, blob } = await client.download(path, { signal, onProgress: progress });
      saveBlob(blob, name);
    });
  };
  const onDropFiles = (e: DragEvent) => {
    const files = [...(e.dataTransfer?.items ?? [])].filter((i) => i.kind === "file");
    if (files.some((i) => i.webkitGetAsEntry?.()?.isDirectory)) return toast.error(new Error("Les dossiers ne sont pas pris en charge : envoie les fichiers un à un"));
    sendFiles([...(e.dataTransfer?.files ?? [])]);
  };

  dropRef.current = onDropFiles;

  const stopRecording = (auto = false) => {
    const rec = recRef.current;
    recRef.current = null;
    setRecording(false);
    if (!rec) return;
    saveBlob(rec.blob(), exportName(nameRef.current, "cast"));
    toast(auto ? "Enregistrement arrêté : la limite de 20 Mio est atteinte. Le fichier .cast est téléchargé." : "Enregistrement terminé : fichier .cast téléchargé");
  };
  const stopRecordingRef = useRef(stopRecording);
  stopRecordingRef.current = stopRecording;
  const toggleRecording = () => {
    const term = termRef.current;
    if (recRef.current) return stopRecording();
    if (!term) return;
    recRef.current = new CastRecorder(term.cols, term.rows, nameRef.current);
    setRecording(true);
    toast("Enregistrement démarré : la sortie reste dans ce navigateur jusqu'à l'arrêt");
  };
  const downloadHistory = () => {
    const term = termRef.current;
    if (!term) return;
    saveBlob(new Blob([bufferToText(term)], { type: "text/plain;charset=utf-8" }), exportName(nameRef.current, "txt"));
  };

  const searchOpts = (incremental = false) => ({
    caseSensitive: matchCase,
    incremental,
    decorations: {
      matchBackground: "#4f46e5",
      matchBorder: "#818cf8",
      matchOverviewRuler: "#818cf8",
      activeMatchBackground: "#f59e0b",
      activeMatchBorder: "#fbbf24",
      activeMatchColorOverviewRuler: "#f59e0b",
    },
  });
  const find = (dir: "next" | "prev", q = query, incremental = false) => {
    const s = searchRef.current;
    if (!s) return;
    if (!q) {
      s.clearDecorations();
      setResults(null);
      return;
    }
    if (dir === "next") s.findNext(q, searchOpts(incremental));
    else s.findPrevious(q, searchOpts());
  };
  const closeSearch = () => {
    searchRef.current?.clearDecorations();
    setResults(null);
    setSearchOpen(false);
    termRef.current?.focus();
  };
  useEffect(() => {
    if (searchOpen) searchInput.current?.select();
  }, [searchOpen]);
  // Re-run the search when the case option changes.
  useEffect(() => {
    if (searchOpen && query) find("next");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchCase]);

  const group = useBroadcastGroup();
  const broadcasting = group.has(terminalId);
  const groupSize = liveTargets(session).length + (broadcasting && info?.status !== "running" ? 1 : 0);

  const status = info?.status;
  const kill = async () => {
    const ok = await confirmDialog({
      title: "Fermer le terminal ?",
      text: `Le shell et les programmes qui tournent dedans seront arrêtés${onKill ? ", et le shell retiré de la machine" : ""}.`,
      confirm: "Fermer",
      danger: true,
    });
    if (!ok) return;
    if (onKill) onKill();
    else session.closeTerminal(terminalId);
  };

  const isLocal = !isRemoteLabel(info?.label ?? "");
  const canFiles = session.canEdit && isLocal && status === "running";
  canFilesRef.current = canFiles;
  useEffect(() => {
    if (!canFiles) setFilesOpen(false);
  }, [canFiles]);
  const filesHint = !session.canEdit
    ? "Transfert de fichiers indisponible en lecture seule"
    : !isLocal
      ? "Transfert de fichiers disponible seulement sur un shell local (pas en Telnet, SSH ou TCP)"
      : status !== "running"
        ? "Transfert de fichiers : le shell doit être en cours d'exécution"
        : "Fichiers : parcourir le dossier du shell, télécharger, envoyer (ou glisse des fichiers sur la fenêtre)";

  const dot = `dot ${status === "running" ? "on" : status === "starting" ? "warn" : ""}`;
  const label = info?.label ?? "Terminal";
  const name = title || label;
  nameRef.current = name.split("\n")[0];

  return (
    <div className={`term ${collapsed ? "collapsed" : ""} ${broadcasting ? "broadcasting" : ""}`} ref={rootRef}>
      {collapsed && (
        <div className={`term-tile ${unread ? "unread" : ""} ${iconSrc ? "custom" : ""}`} title={`${name} (${label}) — clique pour ouvrir le shell`}>
          {iconSrc ? (
            <div className="tile-art">
              <img src={iconSrc} alt="" draggable={false} />
              <span className={dot} />
            </div>
          ) : (
            <div className="tile-icon">
              <Monitor size={40} strokeWidth={1.6} />
              <span className="prompt">&gt;_</span>
              <span className={dot} />
            </div>
          )}
          <div className="tile-name">{name}</div>
          {!iconSrc && <div className="tile-status">{unread ? "nouvelle sortie" : status ? STATUS_LABEL[status] : "introuvable"}</div>}
          {onToggleCollapsed && (
            <span className="tile-expand">
              <Maximize2 size={12} />
            </span>
          )}
        </div>
      )}
      <div className="term-head">
        <span className={dot} />
        {isRemoteLabel(label) ? <Cable size={14} /> : <TerminalSquare size={14} />}
        <span className="name" title={label}>
          {name.split("\n")[0]}
          {title && <span className="status"> · {label}</span>}
        </span>
        {broadcasting && (
          <span className="term-bcast" title="La saisie de ce terminal est envoyée à tous les terminaux de la diffusion">
            Diffusion · {groupSize}
            <button title="Tout arrêter (retire tous les terminaux de la diffusion)" onClick={clearBroadcast}>
              <X size={11} />
            </button>
          </span>
        )}
        {xfer && (
          <span className="term-xfer" title={xfer.name}>
            <progress max={xfer.total ?? undefined} value={xfer.total ? xfer.done : undefined} />
            <span>{xfer.total ? `${Math.floor((xfer.done / Math.max(xfer.total, 1)) * 100)} %` : fmtBytes(xfer.done)}</span>
            <button title="Annuler le transfert" onClick={cancelTransfer}>
              <X size={11} />
            </button>
          </span>
        )}
        {!session.canEdit && <span className="status">lecture seule</span>}
        <span className="status">{status ? STATUS_LABEL[status] : "introuvable"}</span>
        {status === "exited" && session.canEdit && (
          <button title="Relancer" onClick={() => session.restartTerminal(terminalId)}>
            <RotateCcw size={14} />
          </button>
        )}
        {session.canEdit && (
          <button
            className={broadcasting ? "on" : undefined}
            aria-pressed={broadcasting}
            title={broadcasting ? "Ne plus diffuser la saisie (Alt+B)" : "Diffuser la saisie : ce que tu tapes ici est envoyé à tous les terminaux de la diffusion (Alt+B)"}
            onClick={() => toggleBroadcast(terminalId)}
          >
            <Radio size={14} />
          </button>
        )}
        <button className={filesOpen ? "on" : undefined} aria-pressed={filesOpen} disabled={!canFiles} title={filesHint} onClick={() => setFilesOpen((v) => !v)}>
          <FolderOpen size={14} />
        </button>
        <button title="Rechercher dans l'historique (Ctrl+Maj+F)" aria-pressed={searchOpen} className={searchOpen ? "on" : undefined} onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}>
          <Search size={14} />
        </button>
        <button title="Télécharger l'historique (.txt)" onClick={downloadHistory}>
          <Download size={14} />
        </button>
        <button
          className={recording ? "on rec" : undefined}
          aria-pressed={recording}
          title={recording ? "Arrêter l'enregistrement et télécharger le .cast" : "Enregistrer la sortie (.cast, format asciinema) : rien ne quitte ce navigateur"}
          onClick={toggleRecording}
        >
          <span className="rec-dot" />
        </button>
        {onToggleLock && (
          <button
            className={locked ? "on" : undefined}
            aria-pressed={!!locked}
            title={locked ? "Déverrouiller (la fenêtre pourra de nouveau être déplacée)" : "Verrouiller la fenêtre en place (le shell reste utilisable)"}
            onClick={onToggleLock}
          >
            {locked ? <Lock size={14} /> : <LockOpen size={14} />}
          </button>
        )}
        {onCustomize && (
          <button title="Icône et libellé de la tuile" onClick={() => setCustomizing(true)}>
            <Palette size={14} />
          </button>
        )}
        {onToggleCollapsed && (
          <button title={toggleTitle ?? "Réduire en tuile"} onClick={onToggleCollapsed}>
            <Minimize2 size={14} />
          </button>
        )}
        {(status === "running" || status === "starting" || onKill) && session.canEdit && (
          <button title="Fermer le shell" onClick={kill}>
            <Power size={14} />
          </button>
        )}
      </div>
      {customizing && onCustomize && (
        <TileCustomizer machineLabel={label} title={title ?? null} icon={icon ?? null} onSave={onCustomize} onClose={() => setCustomizing(false)} />
      )}
      <div className="term-body" ref={bodyRef}>
        {dropping && <div className="term-drop">Dépose pour envoyer dans le dossier du shell</div>}
        {filesOpen && canFiles && <FilesPanel client={client} busy={!!xfer} onDownload={fetchFile} onUpload={sendFiles} onClose={() => setFilesOpen(false)} />}
        {searchOpen && (
          <div className="term-search" role="search">
            <input
              ref={searchInput}
              autoFocus
              value={query}
              placeholder="Rechercher…"
              spellCheck={false}
              onChange={(e) => {
                setQuery(e.target.value);
                find("next", e.target.value, true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearch();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  find(e.shiftKey ? "prev" : "next");
                }
              }}
            />
            <span className="count">{query && results ? (results.count ? `${Math.max(results.index, 0) + 1}/${results.count}` : "0") : ""}</span>
            <button className={matchCase ? "on" : undefined} aria-pressed={matchCase} title="Respecter la casse" onClick={() => setMatchCase((v) => !v)}>
              Aa
            </button>
            <button title="Précédent (Maj+Entrée)" onClick={() => find("prev")}>
              <ChevronUp size={14} />
            </button>
            <button title="Suivant (Entrée)" onClick={() => find("next")}>
              <ChevronDown size={14} />
            </button>
            <button title="Fermer (Échap)" onClick={closeSearch}>
              <X size={14} />
            </button>
          </div>
        )}
        {(!info || status === "exited" || status === "offline") && (
          <div className={`term-veil ${status === "exited" ? "bottom" : ""}`}>
            {!info ? (
              <span>Terminal introuvable (fermé, supprimé ou appartenant à un autre tableau).</span>
            ) : status === "offline" ? (
              <span>
                {info.label} est hors ligne.
                <br />
                <small style={{ opacity: 0.7 }}>Le shell reprendra dès que l'agent se reconnecte.</small>
              </span>
            ) : (
              <>
                <span>Session terminée{info.exitCode !== null ? ` (code ${info.exitCode})` : ""}</span>
                {session.canEdit && (
                  <button className="btn btn-sm btn-primary" onClick={() => session.restartTerminal(terminalId)}>
                    <RotateCcw size={14} /> Relancer
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
