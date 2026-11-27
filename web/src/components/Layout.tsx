import { useCallback, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ChevronRight, Folder, FolderOpen, HardDrive, LogOut, Moon, Server, Shield, Sun, Trash2, UserCog, Users } from "lucide-react";
import { useAuth, useUser } from "../auth.tsx";
import { MY_ROOT, childrenOf, isShared, moveItem, useLibrary, useLibraryCtx, type Node } from "../library.tsx";
import { Avatar, Logo, toast, useTheme } from "./ui.tsx";
import { Onboarding } from "./Onboarding.tsx";
import { readJson, writeStorage } from "../storage.ts";

export const DRAG_TYPE = "application/x-excalibash-items";

/** Moves dragged items into a folder (or the root), re-wrapping their keys. */
export function useMoveItems() {
  const ctx = useLibraryCtx();
  const { refresh, place } = useLibrary();
  return useCallback(
    async (ids: string[], to: string | null) => {
      const target = to === MY_ROOT ? null : to;
      const t = target ? ctx.nodes.get(target) : null;
      let linked = 0;
      let moved = 0;
      for (const id of ids) {
        const n = ctx.nodes.get(id);
        if (!n || id === target) continue;
        if (isShared(n, ctx.user.id) && (!t || t.ownerId === ctx.user.id)) {
          // Shared with me, dropped in my own files: a private link, nothing changes for its owner.
          try {
            await place(id, target ?? MY_ROOT);
            linked++;
          } catch (e) {
            toast.error(e);
          }
          continue;
        }
        if (n.parentId === target) continue;
        if (t && t.ownerId !== n.ownerId) {
          toast.error("On ne peut déplacer qu'entre dossiers du même propriétaire");
          continue;
        }
        if (!t && n.ownerId !== ctx.user.id) {
          toast.error("Seul le propriétaire peut placer un élément à la racine");
          continue;
        }
        try {
          await moveItem(ctx, id, target);
          moved++;
        } catch (e) {
          toast.error(e);
        }
      }
      const where = `« ${t?.name ?? "Mes fichiers"} »`;
      if (moved) toast(`${moved > 1 ? `${moved} éléments déplacés` : "Déplacé"} vers ${where}`);
      if (linked) toast(`${linked > 1 ? `${linked} liens ajoutés` : "Lien ajouté"} dans ${where} (visible par toi seul)`);
      await refresh();
    },
    [ctx, refresh, place],
  );
}

function useExpanded() {
  const [open, setOpen] = useState<Set<string>>(() => {
    const v = readJson<unknown>("eb-expanded");
    return new Set(Array.isArray(v) ? v : []);
  });
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeStorage("eb-expanded", JSON.stringify([...next]));
      return next;
    });
  return { open, toggle };
}

export function Layout() {
  return (
    <div className="layout">
      <Sidebar />
      <main className="main">
        <Outlet />
      </main>
      <Onboarding />
    </div>
  );
}

function Sidebar() {
  const user = useUser();
  const { logout } = useAuth();
  const { theme, toggle } = useTheme();
  const { nodes } = useLibrary();
  const navigate = useNavigate();
  const location = useLocation();
  const move = useMoveItems();
  const { open, toggle: toggleOpen } = useExpanded();
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const myRoots = childrenOf(nodes, null, user.id).filter((n) => n.kind === "folder");
  const sharedRoots = [...nodes.values()].filter((n) => n.root && n.role !== "owner" && n.kind === "folder" && !n.deletedAt);

  const dropProps = (key: string, target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      setDropTarget(key);
    },
    onDragLeave: () => setDropTarget((t) => (t === key ? null : t)),
    onDrop: (e: React.DragEvent) => {
      setDropTarget(null);
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      if (raw) move(JSON.parse(raw), target);
    },
  });

  const cls = (active: boolean, key?: string) => `side-item ${active ? "active" : ""} ${key && dropTarget === key ? "drop-target" : ""}`;

  const renderFolder = (n: Node, depth: number) => {
    const kids = [...nodes.values()].filter((c) => c.parentId === n.id && c.kind === "folder" && !c.deletedAt);
    const active = location.pathname === `/folder/${n.id}`;
    const expanded = open.has(n.id);
    return (
      <div key={n.id}>
        <NavLink to={`/folder/${n.id}`} className={cls(active, n.id)} style={{ paddingLeft: 6 + depth * 14 }} {...(n.role !== "viewer" ? dropProps(n.id, n.id) : {})}>
          <span
            className={`chev ${kids.length ? "" : "hidden"} ${expanded ? "open" : ""}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleOpen(n.id);
            }}
          >
            <ChevronRight size={14} />
          </span>
          {active ? <FolderOpen size={17} /> : <Folder size={17} />}
          <span className="grow">{n.name}</span>
          {n.shares > 0 && n.role === "owner" && <Users size={13} style={{ color: "var(--muted)" }} />}
        </NavLink>
        {expanded && kids.sort((a, b) => a.name.localeCompare(b.name, "fr")).map((k) => renderFolder(k, depth + 1))}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <NavLink to="/" className="brand display">
        <Logo size={40} />
        Excalibash
      </NavLink>

      <div className="side-scroll">
        <section className="side-section">
          <h4>Mes fichiers</h4>
          <NavLink to="/" end className={({ isActive }) => cls(isActive, "root")} {...dropProps("root", null)}>
            <HardDrive size={18} /> <span className="grow">Tout</span>
          </NavLink>
          {myRoots.sort((a, b) => a.name.localeCompare(b.name, "fr")).map((n) => renderFolder(n, 0))}
        </section>

        <section className="side-section">
          <h4>Partagés avec moi</h4>
          <NavLink to="/shared" className={({ isActive }) => cls(isActive)}>
            <Users size={18} /> <span className="grow">Tous les partages</span>
          </NavLink>
          {sharedRoots.sort((a, b) => a.name.localeCompare(b.name, "fr")).map((n) => renderFolder(n, 0))}
        </section>
      </div>

      <div className="side-footer">
        <NavLink to="/machines" className={({ isActive }) => cls(isActive)}>
          <Server size={18} /> <span className="grow">Machines</span>
        </NavLink>
        {user.isAdmin && (
          <NavLink to="/admin" className={({ isActive }) => cls(isActive)}>
            <Shield size={18} /> <span className="grow">Administration</span>
          </NavLink>
        )}
        <NavLink to="/trash" className={({ isActive }) => cls(isActive)}>
          <Trash2 size={18} /> <span className="grow">Corbeille</span>
        </NavLink>
        <div className="user-chip">
          <Avatar name={user.name} color={user.color} />
          <NavLink to="/account" className="who" title="Mon compte et sécurité">
            <b>{user.name}</b>
            <span>{user.email}</span>
          </NavLink>
          <button className="btn btn-ghost btn-icon btn-sm" title="Mon compte" onClick={() => navigate("/account")}>
            <UserCog size={16} />
          </button>
          <button className="btn btn-ghost btn-icon btn-sm" title={theme === "dark" ? "Thème clair" : "Thème sombre"} onClick={toggle}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            className="btn btn-ghost btn-icon btn-sm"
            title="Se déconnecter (efface les clés de cet appareil)"
            onClick={async () => {
              await logout();
              navigate("/login");
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}
