// Side dock: every machine icon of the board with its shells and sites, so a hidden window opens
// (or an open one comes to the front) in one click, without hunting for its icon on the canvas.
import { useState, useSyncExternalStore } from "react";
import { Cable, ChevronRight, FileCode2, FilePlus2, FolderOpen, Globe, Maximize2, Minimize2, NotebookPen, NotebookText, PanelRightClose, PanelRightOpen, Plus, Power, Radio, TerminalSquare } from "lucide-react";
import { isRemoteLabel, type BoardSession } from "./collab.ts";
import { confirmDialog } from "../components/ui.tsx";
import { clearBroadcast, liveTargets, useBroadcastGroup } from "./broadcast.ts";
import { localShellIds } from "./machineFiles.ts";
import { readStorage, writeStorage } from "../storage.ts";

export type DockItem = { id: string; open: boolean };
/** `remote`: a Telnet / SSH device, through which nothing else can be reached. */
export type DockGroup = {
  nodeId: string;
  title: string | null;
  shells: DockItem[];
  webs: DockItem[];
  codes: DockItem[];
  notebooks: DockItem[];
  remote?: boolean;
  /** An SSH device: other devices can be reached by bouncing through it. */
  bounce?: boolean;
  machineName?: string;
};
type Kind = "terminal" | "web" | "code" | "notebook";

const COLLAPSED_KEY = "eb-dock-collapsed";

export function WindowDock(p: {
  session: BoardSession;
  groups: DockGroup[];
  onOpen: (nodeId: string, kind: Kind, id: string) => void;
  onHide: (kind: Kind, id: string) => void;
  onToggleAll: (nodeId: string) => void;
  /** "Add" dialog of a machine: Telnet / SSH or web view. */
  onAdd: (nodeId: string) => void;
  /** Machine picker for a new shell on this machine, anchored to the button. */
  onAddShell: (nodeId: string, anchor: HTMLElement) => void;
  /** A new blank code file on this machine's icon. */
  onNewCode: (nodeId: string) => void;
  /** File picker on the machine (needs a running local shell). */
  onOpenCode: (nodeId: string) => void;
  /** A new blank notebook on this machine's icon. */
  onNewNotebook: (nodeId: string) => void;
  /** .ipynb picker on the machine (needs a running local shell). */
  onOpenNotebook: (nodeId: string) => void;
  /** Stops a shell, closes a site's tunnel or removes a code file or notebook (after confirmation, done here). */
  onKill: (nodeId: string, kind: Kind, id: string) => void;
}) {
  const kill = async (nodeId: string, kind: Kind, id: string, name: string) => {
    const ok = await confirmDialog(
      kind === "notebook"
        ? { title: "Retirer ce notebook du schéma ?", text: `${name} disparaît du schéma pour tout le monde, avec son noyau. Le fichier sur la machine n'est pas touché.`, confirm: "Retirer", danger: true }
        : kind === "code"
        ? { title: "Retirer ce fichier du schéma ?", text: `${name} disparaît du schéma pour tout le monde, avec son document partagé. Le fichier sur la machine n'est pas touché.`, confirm: "Retirer", danger: true }
        : kind === "terminal"
        ? { title: `Fermer ${name} ?`, text: "Le shell et les programmes qui tournent dedans sont arrêtés, et le shell est retiré de la machine.", confirm: "Fermer", danger: true }
        : { title: "Fermer le tunnel ?", text: `La fenêtre et le tunnel vers ${name} sont supprimés.`, confirm: "Fermer", danger: true },
    );
    if (ok) p.onKill(nodeId, kind, id);
  };
  // Labels and statuses live in the session, not in the scene.
  useSyncExternalStore(
    (cb) => p.session.on("terminals", cb),
    () => p.session.terminals.size + p.session.webs.size + [...p.session.terminals.values()].map((t) => t.status).join(),
  );
  const [collapsed, setCollapsed] = useState(() => readStorage(COLLAPSED_KEY) === "1");
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const setDockCollapsed = (v: boolean) => {
    setCollapsed(v);
    writeStorage(COLLAPSED_KEY, v ? "1" : "0");
  };

  const bcast = useBroadcastGroup();
  const bcastLive = bcast.size ? liveTargets(p.session).length : 0;
  const hidden = p.groups.reduce((n, g) => n + [...g.shells, ...g.webs, ...g.codes, ...g.notebooks].filter((i) => !i.open).length, 0);

  if (collapsed)
    return (
      <button className="dock-tab" title="Afficher les fenêtres du tableau" onClick={() => setDockCollapsed(false)}>
        <PanelRightOpen size={16} />
        {hidden > 0 && <span className="dock-badge">{hidden}</span>}
      </button>
    );

  return (
    <aside className="dock" aria-label="Fenêtres du tableau">
      <div className="dock-head">
        <span>Fenêtres</span>
        {hidden > 0 && <span className="dock-sub">{hidden} masquée{hidden > 1 ? "s" : ""}</span>}
        <button title="Replier" onClick={() => setDockCollapsed(true)}>
          <PanelRightClose size={15} />
        </button>
      </div>
      {bcast.size > 0 && (
        <div className="dock-bcast">
          <Radio size={13} />
          <span>Diffusion · {bcastLive}</span>
          <button className="btn btn-sm" title="Retire tous les terminaux de la diffusion de saisie" onClick={clearBroadcast}>
            Tout arrêter
          </button>
        </div>
      )}
      <div className="dock-body">
        {p.groups.map((g) => {
          const firstShell = g.shells[0] && p.session.terminals.get(g.shells[0].id);
          const name = g.title || firstShell?.label || g.machineName || "Machine";
          const isFolded = folded.has(g.nodeId);
          const anyOpen = [...g.shells, ...g.webs, ...g.codes, ...g.notebooks].some((i) => i.open);
          const hasLocalShell = localShellIds(p.session, { shells: g.shells.map((sh) => ({ terminalId: sh.id })) }).length > 0;
          return (
            <section key={g.nodeId} className="dock-group">
              <div className="dock-group-head">
                <button
                  className="dock-fold"
                  aria-expanded={!isFolded}
                  onClick={() =>
                    setFolded((s) => {
                      const n = new Set(s);
                      if (n.has(g.nodeId)) n.delete(g.nodeId);
                      else n.add(g.nodeId);
                      return n;
                    })
                  }
                >
                  <ChevronRight size={14} className="chev" />
                  <span className="dock-name" title={name}>
                    {name}
                  </span>
                </button>
                <button title="Nouveau shell sur cette machine" onClick={(e) => p.onAddShell(g.nodeId, e.currentTarget)}>
                  <TerminalSquare size={14} />
                </button>
                {!g.remote && (
                  <button title="Nouveau fichier de code" onClick={() => p.onNewCode(g.nodeId)}>
                    <FilePlus2 size={14} />
                  </button>
                )}
                {!g.remote && (
                  <button
                    title={hasLocalShell ? "Ouvrir un fichier de la machine…" : "Ouvrir un fichier de la machine (il faut un shell local en cours)"}
                    disabled={!hasLocalShell}
                    onClick={() => p.onOpenCode(g.nodeId)}
                  >
                    <FolderOpen size={14} />
                  </button>
                )}
                {!g.remote && (
                  <button title="Nouveau notebook" onClick={() => p.onNewNotebook(g.nodeId)}>
                    <NotebookPen size={14} />
                  </button>
                )}
                {!g.remote && (
                  <button
                    title={hasLocalShell ? "Ouvrir un notebook de la machine…" : "Ouvrir un notebook de la machine (il faut un shell local en cours)"}
                    disabled={!hasLocalShell}
                    onClick={() => p.onOpenNotebook(g.nodeId)}
                  >
                    <NotebookText size={14} />
                  </button>
                )}
                {(!g.remote || g.bounce) && (
                  <button title={g.remote ? "Rebondir depuis cet équipement vers un autre" : "Ajouter : Telnet / SSH ou site web"} onClick={() => p.onAdd(g.nodeId)}>
                    <Plus size={14} />
                  </button>
                )}
                <button title={anyOpen ? "Tout masquer" : "Tout ouvrir"} onClick={() => p.onToggleAll(g.nodeId)}>
                  {anyOpen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </button>
              </div>
              {!isFolded && (
                <ul>
                  {g.shells.map((sh, i) => {
                    const t = p.session.terminals.get(sh.id);
                    const label = t?.label ?? "shell";
                    return (
                      <DockRow
                        key={sh.id}
                        open={sh.open}
                        icon={isRemoteLabel(label) ? <Cable size={13} /> : <TerminalSquare size={13} />}
                        dot={t?.status === "running" ? "on" : t?.status === "starting" ? "warn" : ""}
                        label={`Shell ${i + 1}`}
                        sub={label}
                        onOpen={() => p.onOpen(g.nodeId, "terminal", sh.id)}
                        onHide={() => p.onHide("terminal", sh.id)}
                        onKill={() => kill(g.nodeId, "terminal", sh.id, `le shell ${i + 1}`)}
                        killTitle="Fermer le shell"
                      />
                    );
                  })}
                  {g.webs.map((w) => {
                    const info = p.session.webs.get(w.id);
                    const url = info?.target?.url.replace(/^https?:\/\//, "") ?? "site";
                    return (
                      <DockRow
                        key={w.id}
                        open={w.open}
                        icon={<Globe size={13} />}
                        dot={info?.online ? "on" : ""}
                        label={url}
                        onOpen={() => p.onOpen(g.nodeId, "web", w.id)}
                        onHide={() => p.onHide("web", w.id)}
                        onKill={() => kill(g.nodeId, "web", w.id, url)}
                        killTitle="Fermer le tunnel"
                      />
                    );
                  })}
                  {g.codes.map((c, i) => (
                    <DockRow
                      key={c.id}
                      open={c.open}
                      icon={<FileCode2 size={13} />}
                      dot=""
                      label={`Code ${i + 1}`}
                      onOpen={() => p.onOpen(g.nodeId, "code", c.id)}
                      onHide={() => p.onHide("code", c.id)}
                      onKill={() => kill(g.nodeId, "code", c.id, `le fichier de code ${i + 1}`)}
                      killTitle="Retirer ce fichier du schéma"
                    />
                  ))}
                  {g.notebooks.map((c, i) => (
                    <DockRow
                      key={c.id}
                      open={c.open}
                      icon={<NotebookText size={13} />}
                      dot=""
                      label={`Notebook ${i + 1}`}
                      onOpen={() => p.onOpen(g.nodeId, "notebook", c.id)}
                      onHide={() => p.onHide("notebook", c.id)}
                      onKill={() => kill(g.nodeId, "notebook", c.id, `le notebook ${i + 1}`)}
                      killTitle="Retirer ce notebook du schéma"
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function DockRow(p: {
  open: boolean;
  icon: React.ReactNode;
  dot: string;
  label: string;
  sub?: string;
  onOpen: () => void;
  onHide: () => void;
  onKill?: () => void;
  killTitle: string;
}) {
  return (
    <li className={`dock-row ${p.open ? "open" : ""}`}>
      <button className="dock-main" title={p.open ? "Afficher au premier plan" : "Ouvrir"} onClick={p.onOpen}>
        <span className={`dot ${p.dot}`} />
        {p.icon}
        <span className="dock-lbl">
          {p.label}
          {p.sub && <small>{p.sub}</small>}
        </span>
      </button>
      {p.open && (
        <button className="dock-hide" title="Masquer (le shell continue)" onClick={p.onHide}>
          <Minimize2 size={12} />
        </button>
      )}
      {p.onKill && (
        <button className="dock-hide dock-kill" title={p.killTitle} onClick={p.onKill}>
          <Power size={12} />
        </button>
      )}
    </li>
  );
}
