import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowRight,
  CheckSquare,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FolderInput,
  Gift,
  FolderPlus,
  HardDrive,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Share2,
  Square,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { api } from "../api.ts";
import { useUser } from "../auth.tsx";
import { useMoveItems } from "../components/Layout.tsx";
import { ItemCard } from "../components/BoardCard.tsx";
import { ShareModal } from "../components/ShareModal.tsx";
import { Menu, confirmDialog, toast, type MenuAnchor } from "../components/ui.tsx";
import { exportBoard, importFiles } from "../board/files.ts";
import {
  childrenOf,
  createItem,
  duplicateBoard,
  isInTrash,
  MY_ROOT,
  isShared,
  pathOf,
  placedShares,
  renameItem,
  sortNodes,
  useLibrary,
  useLibraryCtx,
  type Node,
} from "../library.tsx";
import { readStorage, writeStorage } from "../storage.ts";

type View = "mine" | "folder" | "shared" | "trash";

export function Dashboard({ view }: { view: View }) {
  const user = useUser();
  const ctx = useLibraryCtx();
  const { nodes, loading, refresh, placements, place } = useLibrary();
  const navigate = useNavigate();
  const { folderId } = useParams();
  const move = useMoveItems();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState(() => readStorage("eb-sort") ?? "updated");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; node?: Node; kind: "card" | "move" } | null>(null);
  const [sharing, setSharing] = useState<Node | null>(null);
  const [giving, setGiving] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** A board or folder being created: the buttons show it (creation waits for the server). */
  const [creating, setCreating] = useState<"folder" | "board" | null>(null);
  /** Items just deleted, hidden right away while the server and the refresh catch up. */
  const [gone, setGone] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastClicked = useRef<string | null>(null);

  const folder = view === "folder" && folderId ? nodes.get(folderId) : undefined;
  const trash = view === "trash";
  const canCreate = view === "mine" || (folder && folder.role !== "viewer");
  const targetParent = folder?.id ?? null;

  useEffect(() => {
    setSelected(new Set());
    setQ("");
  }, [view, folderId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape" && selected.size) setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size]);

  // Links to shared items I filed in my own files: item id -> folder id (null: top of "Mes fichiers").
  const placed = useMemo(() => placedShares(nodes, placements, user.id), [nodes, placements, user.id]);
  const linkHere = !trash && (view === "mine" || (view === "folder" && folder?.ownerId === user.id));

  const items = useMemo(() => {
    const all = [...nodes.values()];
    let list: Node[];
    if (trash) list = all.filter((n) => n.deletedAt && n.ownerId === user.id && !(n.parentId && isInTrash(nodes, nodes.get(n.parentId) ?? n)));
    else if (view === "shared") list = all.filter((n) => n.root && n.role !== "owner" && !n.deletedAt);
    else {
      list = childrenOf(nodes, targetParent, user.id);
      if (linkHere) list = [...list, ...[...placed].filter(([id, f]) => f === targetParent && !list.some((n) => n.id === id)).map(([id]) => nodes.get(id)!)];
    }
    const needle = q.trim().toLowerCase();
    if (needle && !trash) {
      // Search the whole scope (sub-folders included), not just the current level.
      const inFolder = (n: Node) => pathOf(nodes, n.id).some((p) => p.id === folder!.id) && n.id !== folder!.id;
      const placedHere = (n: Node) => {
        const f = placed.get(n.id);
        return placed.has(n.id) && (view !== "folder" || (!!folder && !!f && (f === folder.id || pathOf(nodes, f).some((p) => p.id === folder.id))));
      };
      const scope = view === "shared" ? all.filter((n) => n.ownerId !== user.id) : view === "folder" && folder ? all.filter((n) => inFolder(n) || placedHere(n)) : all.filter((n) => n.ownerId === user.id || placedHere(n));
      list = scope.filter((n) => !isInTrash(nodes, n) && n.name.toLowerCase().includes(needle));
    }
    return sortNodes(gone.size ? list.filter((n) => !gone.has(n.id)) : list, sort);
  }, [nodes, trash, view, targetParent, user.id, q, sort, folder, placed, gone]);

  const childCount = (id: string) => [...nodes.values()].filter((n) => n.parentId === id && !n.deletedAt).length + [...placed.values()].filter((f) => f === id).length;
  // Only meaningful outside "Partagés avec moi": there a share is a plain top-level entry.
  const isPlaced = (id: string) => linkHere && placed.get(id) === targetParent && placed.has(id);
  const ids = useMemo(() => [...selected], [selected]);
  const targets = (n?: Node) => (n && !selected.has(n.id) ? [n.id] : ids);
  const done = async () => {
    setSelected(new Set());
    await refresh();
  };

  const create = async (kind: "folder" | "board") => {
    if (creating) return;
    setCreating(kind);
    try {
      const id = await createItem(ctx, kind, targetParent, kind === "folder" ? "Nouveau dossier" : "Sans titre");
      await refresh();
      if (kind === "board") navigate(`/board/${id}`);
      else toast("Dossier créé — double-clique sur son nom pour le renommer");
    } catch (e) {
      toast.error(e);
    } finally {
      setCreating(null);
    }
  };

  const doImport = async (files: FileList | File[]) => {
    try {
      const n = await importFiles(ctx, files, targetParent);
      toast(n > 1 ? `${n} tableaux importés et chiffrés` : "Tableau importé et chiffré");
      await refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  const toggleSelect = (id: string, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shift && lastClicked.current) {
        const a = items.findIndex((b) => b.id === lastClicked.current);
        const b = items.findIndex((x) => x.id === id);
        const [from, to] = a < b ? [a, b] : [b, a];
        for (const x of items.slice(from, to + 1)) next.add(x.id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastClicked.current = id;
  };

  const trashItems = async (all: string[]) => {
    // A share filed in my folder is only unfiled: nothing is deleted for its owner.
    const unfile = all.filter(isPlaced);
    const list = all.filter((id) => !unfile.includes(id));
    if (unfile.length) {
      for (const id of unfile) await place(id, null).catch(toast.error);
      toast("Lien retiré (l'élément reste dans « Partagés avec moi »)");
      if (!list.length) return done();
    }
    if (trash) {
      const ok = await confirmDialog({
        title: "Supprimer définitivement ?",
        text: `${list.length > 1 ? `${list.length} éléments seront supprimés` : "Cet élément sera supprimé"} pour toujours, avec leur contenu et leurs terminaux.`,
        confirm: "Supprimer",
        danger: true,
      });
      if (!ok) return;
    }
    // Hidden at once; shown again if the server refuses.
    setGone((g) => new Set([...g, ...list]));
    const ok = await Promise.all(list.map((id) => api.del(`/items/${id}${trash ? "?permanent=1" : ""}`)))
      .then(() => true)
      .catch((e) => (toast.error(e), false));
    if (ok) toast(trash ? "Supprimé définitivement" : "Déplacé dans la corbeille");
    await done().finally(() => setGone((g) => new Set([...g].filter((id) => !list.includes(id)))));
  };

  const restore = async (list: string[]) => {
    await Promise.all(list.map((id) => api.post(`/items/${id}/restore`))).catch(toast.error);
    toast("Restauré");
    await done();
  };

  const duplicate = async (list: string[]) => {
    for (const id of list) if (nodes.get(id)?.kind === "board") await duplicateBoard(ctx, id).catch(toast.error);
    toast("Dupliqué");
    await done();
  };

  const rename = async (n: Node, name: string) => {
    await renameItem(ctx, n.id, name).catch(toast.error);
    await refresh();
  };

  const emptyTrash = async () => {
    const ok = await confirmDialog({ title: "Vider la corbeille ?", text: "Tout ce qui est dans la corbeille sera supprimé définitivement.", confirm: "Vider", danger: true });
    if (!ok) return;
    await api.del("/trash").catch(toast.error);
    await refresh();
  };

  const title = trash ? "Corbeille" : view === "shared" ? "Partagés avec moi" : view === "folder" ? (folder?.name ?? "Dossier") : "Mes fichiers";
  const crumbs = folder ? pathOf(nodes, folder.id) : [];

  if (view === "folder" && !loading && !folder) {
    return (
      <div className="empty-state">
        <h3 className="display">Dossier introuvable</h3>
        <p>Il a été supprimé, ou il n'est pas (ou plus) partagé avec toi.</p>
        <Link to="/" className="btn btn-primary">
          Retour
        </Link>
      </div>
    );
  }

  return (
    <div
      onDragEnter={(e) => e.dataTransfer.types.includes("Files") && canCreate && setDragging(true)}
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDragLeave={(e) => e.relatedTarget === null && setDragging(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        if (canCreate) doImport(e.dataTransfer.files);
      }}
      style={{ minHeight: "100%" }}
    >
      {crumbs.length > 0 && (
        <nav className="crumbs">
          <Link to={folder!.ownerId === user.id ? "/" : "/shared"}>
            <HardDrive size={14} /> {folder!.ownerId === user.id ? "Mes fichiers" : "Partagés"}
          </Link>
          {crumbs.slice(0, -1).map((c) => (
            <span key={c.id}>
              <ChevronRight size={14} />
              <Link to={`/folder/${c.id}`}>{c.name}</Link>
            </span>
          ))}
        </nav>
      )}
      <h1 className="page-title display">
        {title}
        {folder && folder.role !== "owner" && <span className="badge title-badge">{folder.role === "viewer" ? "Lecture seule" : "Éditeur"} · {folder.ownerName}</span>}
      </h1>

      <div className="toolbar">
        <div className="toolbar-group" style={{ flex: 1 }}>
          <label className="search">
            <Search size={18} />
            <input ref={searchRef} className="input" placeholder="Rechercher (déchiffré localement)…" value={q} onChange={(e) => setQ(e.target.value)} />
            <kbd>Ctrl K</kbd>
          </label>
          <select
            className="select"
            aria-label="Trier"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              writeStorage("eb-sort", e.target.value);
            }}
          >
            <option value="updated">Modifiés récemment</option>
            <option value="created">Créés récemment</option>
            <option value="name">Nom (A → Z)</option>
          </select>
        </div>

        <div className="toolbar-group">
          {items.length > 0 && (
            <button className="btn btn-icon" title={selected.size ? "Tout désélectionner" : "Tout sélectionner"} onClick={() => setSelected(selected.size ? new Set() : new Set(items.map((b) => b.id)))}>
              {selected.size ? <CheckSquare size={20} /> : <Square size={20} />}
            </button>
          )}
          {selected.size > 0 &&
            (trash ? (
              <button className="btn" onClick={() => restore(ids)}>
                <RotateCcw size={16} /> Restaurer ({selected.size})
              </button>
            ) : (
              <>
                <button className="btn btn-icon" title="Dupliquer les tableaux" onClick={() => duplicate(ids)}>
                  <Copy size={18} />
                </button>
                <button className="btn btn-icon" title="Déplacer" onClick={(e) => setMenu({ anchor: e.currentTarget, kind: "move" })}>
                  <FolderInput size={18} />
                </button>
              </>
            ))}
          {selected.size > 0 && (
            <button className="btn btn-icon" style={{ color: "var(--danger)" }} title={trash ? "Supprimer définitivement" : "Mettre à la corbeille"} onClick={() => trashItems(ids)}>
              <Trash2 size={18} />
            </button>
          )}
          {trash
            ? items.length > 0 && (
                <button className="btn btn-danger" onClick={emptyTrash}>
                  <Trash2 size={16} /> Vider la corbeille
                </button>
              )
            : canCreate && (
                <>
                  {/* The selected item if there is exactly one, else the folder being viewed. */}
                  {(() => {
                    const target = selected.size === 1 ? nodes.get(ids[0]) : selected.size ? undefined : folder;
                    if (!target || target.ownerId !== user.id) return null;
                    return (
                      <button className="btn" title={`Partager « ${target.name} »`} onClick={() => (setGiving(false), setSharing(target))}>
                        <Share2 size={16} /> {target === folder ? "Partager le dossier" : "Partager"}
                      </button>
                    );
                  })()}
                  <button className="btn btn-icon" title="Importer des .excalidraw" onClick={() => fileRef.current?.click()}>
                    <Upload size={18} />
                  </button>
                  <button className="btn" onClick={() => create("folder")} disabled={!!creating}>
                    {creating === "folder" ? <Loader2 size={16} className="spin" /> : <FolderPlus size={16} />} {creating === "folder" ? "Création…" : "Dossier"}
                  </button>
                  <button className="btn btn-primary" onClick={() => create("board")} disabled={!!creating}>
                    {creating === "board" ? <Loader2 size={18} className="spin" /> : <Plus size={18} strokeWidth={2.5} />} {creating === "board" ? "Création…" : "Tableau"}
                  </button>
                </>
              )}
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            accept=".excalidraw,.json,application/json"
            onChange={(e) => {
              if (e.target.files?.length) doImport(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {loading ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--brand)", fontWeight: 700 }}>
          <Loader2 size={18} className="spin" /> Déchiffrement…
        </div>
      ) : items.length === 0 ? (
        <EmptyState view={view} searching={!!q} canCreate={!!canCreate} creating={creating === "board"} onCreate={() => create("board")} />
      ) : (
        <div className={`grid ${selected.size ? "selecting" : ""}`}>
          {items.map((n) => (
            <ItemCard
              key={n.id}
              node={n}
              meId={user.id}
              placed={isPlaced(n.id)}
              childCount={n.kind === "folder" ? childCount(n.id) : undefined}
              selected={selected.has(n.id)}
              selecting={selected.size > 0}
              draggableIds={() => (selected.has(n.id) ? ids : [n.id])}
              onOpen={() => navigate(n.kind === "folder" ? `/folder/${n.id}` : `/board/${n.id}`)}
              onToggleSelect={(shift) => toggleSelect(n.id, shift)}
              onRename={(name) => rename(n, name)}
              onDropItems={(list) => move(list, n.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ anchor: { x: e.clientX, y: e.clientY }, node: n, kind: "card" });
              }}
            />
          ))}
        </div>
      )}

      <p className="e2e-note">
        <Lock size={13} /> Noms, dessins, aperçus et terminaux sont chiffrés dans ton navigateur. Le serveur ne voit que des données illisibles.
      </p>

      {dragging && <div className="drop-overlay display">Dépose tes fichiers .excalidraw</div>}

      {menu?.kind === "move" && (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} align="right">
          <MoveTargets
            items={targets(menu.node).map((id) => nodes.get(id)!).filter(Boolean)}
            onMove={(target) => {
              const list = targets(menu.node);
              setMenu(null);
              setSelected(new Set());
              if (target !== undefined) move(list, target);
            }}
          />
        </Menu>
      )}

      {menu?.kind === "card" && menu.node && (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)}>
          {trash ? (
            <>
              <button className="menu-item" onClick={() => (setMenu(null), restore(targets(menu.node)))}>
                <RotateCcw size={16} /> Restaurer
              </button>
              <div className="menu-sep" />
              <button className="menu-item danger" onClick={() => (setMenu(null), trashItems(targets(menu.node)))}>
                <Trash2 size={16} /> Supprimer définitivement
              </button>
            </>
          ) : (
            <CardMenu
              node={menu.node}
              meId={user.id}
              placed={isPlaced(menu.node.id)}
              close={() => setMenu(null)}
              onOpen={() => navigate(menu.node!.kind === "folder" ? `/folder/${menu.node!.id}` : `/board/${menu.node!.id}`)}
              onShare={() => (setGiving(false), setSharing(menu.node!))}
              onGive={() => (setGiving(true), setSharing(menu.node!))}
              onDuplicate={() => duplicate(targets(menu.node))}
              onMove={(anchor) => setMenu({ anchor, node: menu.node, kind: "move" })}
              onDelete={() => trashItems(targets(menu.node))}
              onRename={() => {
                const name = prompt("Nouveau nom", menu.node!.name);
                if (name?.trim()) rename(menu.node!, name.trim());
              }}
            />
          )}
        </Menu>
      )}

      {sharing && <ShareModal node={sharing} giving={giving} onClose={() => setSharing(null)} />}
    </div>
  );
}

/** `onMove(undefined)` only closes the menu (the change was already made). */
function MoveTargets({ items, onMove }: { items: Node[]; onMove: (target: string | null | undefined) => void }) {
  const user = useUser();
  const { nodes } = useLibrary();
  const { placements, place } = useLibrary();
  if (items.length && items.every((i) => isShared(i, user.id))) {
    // Shared with me: I only choose where to file it among my own folders (private to me).
    const mine = [...nodes.values()]
      .filter((n) => n.kind === "folder" && n.ownerId === user.id && !isInTrash(nodes, n))
      .map((n) => ({ n, label: pathOf(nodes, n.id).map((p) => p.name).join(" / ") }))
      .sort((a, b) => a.label.localeCompare(b.label, "fr"));
    return (
      <div style={{ maxHeight: 360, overflowY: "auto" }}>
        <div className="menu-label">Ajouter un lien dans… (visible par toi seul)</div>
        {items.some((i) => placements[i.id]) && (
          <button className="menu-item" onClick={() => Promise.all(items.map((i) => place(i.id, null))).then(() => onMove(undefined), toast.error)}>
            <Users size={16} /> Retirer le lien
          </button>
        )}
        <button className="menu-item" onClick={() => onMove(MY_ROOT)}>
          <HardDrive size={16} /> Mes fichiers (racine)
        </button>
        {mine.map(({ n, label }) => (
          <button key={n.id} className="menu-item" onClick={() => onMove(n.id)}>
            <ArrowRight size={16} /> {label}
          </button>
        ))}
      </div>
    );
  }
  const owners = new Set(items.map((i) => i.ownerId));
  const owner = owners.size === 1 ? [...owners][0] : null;
  const moving = new Set(items.map((i) => i.id));
  const folders = [...nodes.values()]
    .filter((n) => n.kind === "folder" && n.ownerId === owner && n.role !== "viewer" && !isInTrash(nodes, n))
    .filter((n) => !pathOf(nodes, n.id).some((p) => moving.has(p.id)))
    .map((n) => ({ n, label: pathOf(nodes, n.id).map((p) => p.name).join(" / ") }))
    .sort((a, b) => a.label.localeCompare(b.label, "fr"));
  if (!owner) return <div className="menu-label">Sélection de propriétaires différents</div>;
  return (
    <div style={{ maxHeight: 360, overflowY: "auto" }}>
      <div className="menu-label">Déplacer vers…</div>
      {owner === user.id && (
        <button className="menu-item" onClick={() => onMove(null)}>
          <HardDrive size={16} /> Mes fichiers (racine)
        </button>
      )}
      {folders.map(({ n, label }) => (
        <button key={n.id} className="menu-item" onClick={() => onMove(n.id)}>
          <ArrowRight size={16} /> {label}
        </button>
      ))}
    </div>
  );
}

function CardMenu(p: {
  node: Node;
  meId: string;
  placed: boolean;
  close: () => void;
  onOpen: () => void;
  onShare: () => void;
  onGive: () => void;
  onDuplicate: () => void;
  onMove: (anchor: MenuAnchor) => void;
  onDelete: () => void;
  onRename: () => void;
}) {
  const act = (fn: () => void) => () => {
    p.close();
    fn();
  };
  const board = p.node.kind === "board";
  const edit = p.node.role !== "viewer";
  const share = isShared(p.node, p.meId);
  return (
    <>
      <button className="menu-item" onClick={act(p.onOpen)}>
        <ArrowRight size={16} /> Ouvrir
      </button>
      {board && (
        <button className="menu-item" onClick={act(() => window.open(`/board/${p.node.id}`, "_blank"))}>
          <ExternalLink size={16} /> Nouvel onglet
        </button>
      )}
      <div className="menu-sep" />
      {p.node.ownerId === p.meId && (
        <button className="menu-item" onClick={act(p.onShare)}>
          <Share2 size={16} /> Partager…
        </button>
      )}
      {p.node.ownerId === p.meId && !p.node.parentId && (
        <button className="menu-item" onClick={act(p.onGive)}>
          <Gift size={16} /> Donner…
        </button>
      )}
      {edit && (
        <button className="menu-item" onClick={act(p.onRename)}>
          <Pencil size={16} /> Renommer
        </button>
      )}
      {board && (
        <button className="menu-item" onClick={act(p.onDuplicate)}>
          <Copy size={16} /> Dupliquer
        </button>
      )}
      {(edit || share) && (
        <button className="menu-item" onClick={(e) => p.onMove({ x: e.clientX, y: e.clientY })}>
          <FolderInput size={16} /> {share ? "Ajouter un lien dans…" : "Déplacer vers…"}
        </button>
      )}
      {board && p.node.key && (
        <button className="menu-item" onClick={act(() => exportBoard(p.node.name, p.node.key!, p.node.id).catch(toast.error))}>
          <Download size={16} /> Exporter (.excalidraw, déchiffré)
        </button>
      )}
      {(edit || p.placed) && (
        <>
          <div className="menu-sep" />
          <button className={`menu-item ${p.placed ? "" : "danger"}`} onClick={act(p.onDelete)}>
            {p.placed ? (
              <>
                <FolderInput size={16} /> Retirer le lien
              </>
            ) : (
              <>
                <Trash2 size={16} /> Mettre à la corbeille
              </>
            )}
          </button>
        </>
      )}
    </>
  );
}

function EmptyState({ view, searching, canCreate, creating, onCreate }: { view: View; searching: boolean; canCreate: boolean; creating: boolean; onCreate: () => void }) {
  const [title, text] = searching
    ? ["Rien trouvé", "Aucun élément ne correspond à ta recherche."]
    : view === "trash"
      ? ["Corbeille vide", "Les éléments supprimés atterrissent ici."]
      : view === "shared"
        ? ["Rien de partagé pour l'instant", "Les dossiers et tableaux que d'autres partagent avec toi apparaissent ici."]
        : view === "folder"
          ? ["Dossier vide", canCreate ? "Crée un tableau ou un sous-dossier, ou glisse des fichiers .excalidraw ici." : "Rien ici pour l'instant."]
          : ["Une page blanche…", "Crée un dossier ou un tableau, dessine ton archi et pose des terminaux directement dessus."];
  return (
    <div className="empty-state">
      <h3 className="display">{title}</h3>
      <p>{text}</p>
      {canCreate && !searching && view !== "trash" && (
        <button className="btn btn-primary" onClick={onCreate} disabled={creating}>
          {creating ? <Loader2 size={18} className="spin" /> : <Plus size={18} strokeWidth={2.5} />} {creating ? "Création…" : "Nouveau tableau"}
        </button>
      )}
    </div>
  );
}
