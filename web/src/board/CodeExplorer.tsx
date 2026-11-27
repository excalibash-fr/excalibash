// The file tree of a code window: folders of the node's machine, listed on demand through the sealed
// file channel of a local shell (FileClient.ls). Local to this user's window, nothing of it is shared.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ChevronRight, File as FileIcon, FileCode2, Folder, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import { MAX_CODE_BYTES, languageForName, splitPath } from "./codeDoc.ts";
import type { FileClient } from "./fileTransfer.ts";
import { childPath, emptyTree, flatten, parentDir, toggled, withError, withListing, withLoading, type TreeState } from "./fileTree.ts";

type Props = {
  /** A client on the node's first running local shell; null when there is none. */
  shell: { terminalId: string; client: FileClient } | null;
  /** Folder to start from (the one of the open file); the shell's own folder when absent. */
  startDir?: string;
  /** Absolute path of the file of this window, highlighted. */
  current?: string;
  readOnly: boolean;
  noShell: string;
  onOpen: (path: string) => void;
};

const message = (e: unknown) => (e as { message?: string } | null)?.message || "Dossier illisible";

export default function CodeExplorer({ shell, startDir, current, readOnly, noShell, onOpen }: Props) {
  const [root, setRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeState>(emptyTree);
  const [fail, setFail] = useState<string | null>(null);
  const clientRef = useRef(shell?.client ?? null);
  clientRef.current = shell?.client ?? null;
  // Answers of an older shell / root must not land in the current tree.
  const epoch = useRef(0);
  const terminalId = shell?.terminalId;

  const list = useCallback(async (dir: string | undefined, e: number): Promise<string | null> => {
    const c = clientRef.current;
    if (!c) return null;
    const key = dir ?? "";
    if (dir) setTree((t) => withLoading(t, dir));
    try {
      const l = await c.ls(dir);
      if (e !== epoch.current) return null;
      const at = dir ?? l.cwd;
      setTree((t) => withListing(t, at, l.entries, l.truncated));
      return at;
    } catch (err) {
      if (e !== epoch.current) return null;
      if (dir) setTree((t) => withError(t, key, message(err)));
      else setFail(message(err));
      return null;
    }
  }, []);

  // (Re)start from the open file's folder, or the shell's, whenever the shell or that folder changes.
  useEffect(() => {
    const e = ++epoch.current;
    setTree(emptyTree());
    setRoot(null);
    setFail(null);
    if (!terminalId) return;
    void list(startDir || undefined, e).then((cwd) => e === epoch.current && cwd && setRoot(cwd));
  }, [terminalId, startDir, list]);

  const rows = useMemo(() => (root ? flatten(root, tree) : []), [root, tree]);

  const go = async (dir: string) => {
    const e = ++epoch.current;
    setTree(emptyTree());
    setFail(null);
    const cwd = await list(dir, e);
    if (e === epoch.current && cwd) setRoot(cwd);
    else if (e === epoch.current) setFail("Dossier illisible");
  };

  const refresh = () => {
    if (!root) return;
    const e = ++epoch.current;
    const open = [...tree.expanded];
    setTree((t) => ({ ...t, folders: new Map() }));
    void list(root, e);
    for (const d of open) void list(d, e);
  };

  const toggle = (dir: string) => {
    if (!tree.folders.has(dir) && !tree.loading.has(dir)) void list(dir, epoch.current);
    setTree((t) => toggled(t, dir));
  };

  const up = root ? parentDir(root) : null;
  const goUp = () => {
    if (!root || !up || up === root) return;
    // The folder we leave stays open in the new view, so the tree does not collapse under the user.
    const e = ++epoch.current;
    const keep = new Set(tree.expanded).add(root);
    setTree((t) => ({ ...t, expanded: keep }));
    void list(up, e).then((at) => e === epoch.current && at && setRoot(at));
  };

  const name = root ? (root === "/" ? "/" : splitPath(root).name) : "…";
  return (
    <div className="code-tree" aria-label="Fichiers de la machine">
      <div className="code-tree-head">
        <button type="button" title={up && up !== root ? "Dossier parent" : "Déjà à la racine"} disabled={!shell || !root || !up || up === root} onClick={goUp}>
          <ArrowUp size={13} />
        </button>
        <span className="code-tree-root" title={root ?? ""}>
          {name}
        </span>
        <button type="button" title={shell ? "Actualiser" : noShell} disabled={!shell || !root} onClick={refresh}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="code-tree-list" role="tree">
        {!shell && <div className="code-tree-note">{noShell}</div>}
        {shell && fail && <div className="code-tree-note">{fail}</div>}
        {shell && !fail && !root && <div className="code-tree-note">Chargement…</div>}
        {rows.map((r) => {
          const pad = { paddingLeft: 6 + r.depth * 12 };
          if (r.note) {
            return (
              <div key={r.path} className="code-tree-note" style={pad}>
                {r.name}
              </div>
            );
          }
          if (r.dir) {
            return (
              <button type="button" key={r.path} role="treeitem" aria-expanded={r.open} className="code-tree-row" style={pad} title={r.path} onClick={() => toggle(r.path)}>
                {r.loading ? <Loader2 size={13} className="spin" /> : r.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {r.open ? <FolderOpen size={14} /> : <Folder size={14} />}
                <span>{r.name}</span>
              </button>
            );
          }
          const size = findSize(tree, r.path);
          const big = size > MAX_CODE_BYTES;
          const isCurrent = r.path === current;
          const why = readOnly ? "Lecture seule" : big ? "Fichier trop volumineux pour l'éditeur" : null;
          return (
            <button
              type="button"
              key={r.path}
              role="treeitem"
              className={`code-tree-row file${isCurrent ? " current" : ""}`}
              style={pad}
              title={why ?? r.path}
              aria-current={isCurrent || undefined}
              disabled={!!why}
              onClick={() => !isCurrent && onOpen(r.path)}
            >
              <span className="code-tree-gap" />
              {languageForName(r.name) === "plaintext" ? <FileIcon size={14} /> : <FileCode2 size={14} />}
              <span>{r.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Size of a listed file, 0 when unknown. */
function findSize(t: TreeState, path: string): number {
  const dir = splitPath(path);
  const f = t.folders.get(dir.dir || "/");
  if (!f || "error" in f) return 0;
  return f.entries.find((e) => childPath(dir.dir || "/", e.name) === path)?.size ?? 0;
}
