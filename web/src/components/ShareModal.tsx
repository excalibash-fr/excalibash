import { useCallback, useEffect, useState } from "react";
import { Copy, Gift, Loader2, UserMinus, UserPlus } from "lucide-react";
import { api, type Role } from "../api.ts";
import { pathOf, revokeAccess, shareItem, useLibrary, useLibraryCtx, type Member, type Node } from "../library.tsx";
import { CandidateVerify, ContactSearch, useContactSearch, withFingerprints, type Candidate } from "./ContactPicker.tsx";
import { PublicLinks } from "./PublicLinks.tsx";
import { Avatar, Modal, confirmDialog, copyText, toast } from "./ui.tsx";

const ROLE_LABEL: Record<Role, string> = { owner: "Propriétaire", editor: "Peut modifier", viewer: "Lecture seule" };

/** Sharing, and giving (transfer of ownership) when `giving` is set or from a member's row. */
export function ShareModal({ node, onClose, giving = false }: { node: Node; onClose: () => void; giving?: boolean }) {
  const ctx = useLibraryCtx();
  const { refresh } = useLibrary();
  const owner = node.ownerId === ctx.user.id;
  // Only an item at the top of the owner's files can change hands (its key is sealed to each member).
  const canGive = owner && !node.parentId && !node.deletedAt;
  const [members, setMembers] = useState<(Member & { fingerprint: string })[] | null>(null);
  const search = useContactSearch();
  const { candidate, override } = search;
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState<string | null>(null);

  /** People with access through a parent folder (managed from that folder), nearest folder first. */
  const [inherited, setInherited] = useState<(Member & { via: string })[]>([]);

  const load = useCallback(async () => {
    const r = await api.get<{ grants: Member[] }>(`/items/${node.id}/grants`);
    setMembers(await withFingerprints(r.grants));
    const seen = new Set(r.grants.map((g) => g.userId));
    const out: (Member & { via: string })[] = [];
    for (const parent of pathOf(ctx.nodes, node.id).slice(0, -1).reverse()) {
      const p = await api.get<{ grants: Member[] }>(`/items/${parent.id}/grants`).catch(() => null);
      for (const g of p?.grants ?? []) if (!seen.has(g.userId)) seen.add(g.userId), out.push({ ...g, via: parent.name });
    }
    setInherited(out);
  }, [node.id, ctx.nodes]);

  useEffect(() => {
    load().catch(toast.error);
  }, [load]);

  const share = async () => {
    if (!candidate) return;
    setBusy("share");
    try {
      await shareItem(ctx, node.id, { ...candidate, email: candidate.email ?? "" }, role, search.accepted);
      toast(`Partagé avec ${candidate.name}`);
      search.reset();
      await Promise.all([load(), refresh()]);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const changeRole = async (m: Member, next: Role) => {
    setBusy(m.userId);
    try {
      await shareItem(ctx, node.id, { id: m.userId, email: m.email, publicKey: m.publicKey }, next, false, true);
      await load();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const give = async (m: { userId: string; name: string }, shareFirst?: Candidate) => {
    const ok = await confirmDialog({
      title: `Donner “${node.name}” à ${m.name} ?`,
      text: "Tu deviendras éditeur et ne pourras plus le partager ni le supprimer.",
      confirm: "Donner",
      danger: true,
    });
    if (!ok) return;
    setBusy(m.userId);
    try {
      // Someone without access yet first gets it (their key is checked like for any share).
      if (shareFirst && !members?.some((x) => x.userId === shareFirst.id)) {
        await shareItem(ctx, node.id, { ...shareFirst, email: shareFirst.email ?? "" }, "editor", shareFirst.check === "changed" && override);
      }
      await api.post(`/items/${node.id}/transfer`, { userId: m.userId });
      toast(`« ${node.name} » appartient maintenant à ${m.name}`);
      await refresh();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (m: Member) => {
    const ok = await confirmDialog({
      title: `Retirer ${m.name} ?`,
      text: `Son accès est coupé et toutes les clés de « ${node.name} » (et de son contenu) sont renouvelées puis re-chiffrées dans ton navigateur. Les terminaux qui ne tournent ni sur tes machines ni sur celles qu'on t'a partagées seront fermés.`,
      confirm: "Retirer et renouveler les clés",
      danger: true,
    });
    if (!ok) return;
    setBusy(m.userId);
    try {
      const r = await revokeAccess(ctx, node.id, m.userId, (msg) => setBusy(`${m.userId}:${msg}`));
      // Parts of a shared document that could not be read (corrupted, or planted to block this
      // revocation) were left out of the re-encrypted copy instead of stopping the revocation.
      if (r?.skippedDocParts) toast.error(`${r.skippedDocParts} partie(s) illisible(s) d'un document partagé ont été écartées pendant le renouvellement des clés.`);
      toast(`${m.name} n'a plus accès — clés renouvelées`);
      await Promise.all([load(), refresh()]);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const progress = busy?.includes(":") ? busy.split(":").slice(1).join(":") : null;

  return (
    <Modal onClose={onClose} width={600}>
      <h2 className="display">
        {giving ? "Donner" : "Partager"} « {node.name} »
      </h2>
      {giving ? (
        <p>
          Cherche la personne qui en deviendra propriétaire{node.kind === "folder" ? ", avec tout son contenu" : ""}. Tu resteras éditeur. Une personne qui y a
          déjà accès peut aussi recevoir l'élément avec le bouton « Donner » de sa ligne.
        </p>
      ) : (
        <p>
          {node.kind === "folder" ? "Tout ce que contient ce dossier, sous-dossiers compris, est partagé avec les mêmes droits. " : ""}
          La clé est chiffrée pour la clé publique de chaque membre : le serveur ne peut pas la lire. Les éditeurs peuvent aussi
          <b> taper dans les terminaux</b>.
        </p>
      )}

      {owner && (
        <ContactSearch
          search={search}
          extra={
            !giving && (
              <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="editor">Peut modifier</option>
                <option value="viewer">Lecture seule</option>
              </select>
            )
          }
        />
      )}

      {candidate && (
        <CandidateVerify
          search={search}
          actions={
            <>
              {canGive && (
                <button
                  className={`btn ${giving ? "btn-primary" : ""}`}
                  disabled={!!busy || search.blocked}
                  onClick={() => give({ userId: candidate.id, name: candidate.name }, candidate)}
                >
                  <Gift size={16} /> Donner
                </button>
              )}
              {!giving && (
                <button className="btn btn-primary" disabled={busy === "share" || search.blocked} onClick={share}>
                  {busy === "share" ? <Loader2 size={16} className="spin" /> : <UserPlus size={16} />} Partager ({ROLE_LABEL[role].toLowerCase()})
                </button>
              )}
            </>
          }
        />
      )}

      {members?.length !== 0 && (
        <div className="panel" style={{ marginTop: 8 }}>
          {members === null ? (
            <div className="row">Chargement…</div>
          ) : (
            members.map((m) => (
              <div className="row" key={m.userId}>
                <Avatar name={m.name} color={m.color} />
                <div className="grow">
                  <div className="title">
                    {m.name} {m.userId === ctx.user.id && <span className="badge">toi</span>}
                  </div>
                  <div className="sub mono" title="Empreinte de sa clé publique">
                    {m.email} · {m.fingerprint.slice(0, 19)}…
                  </div>
                  {busy?.startsWith(`${m.userId}:`) && (
                    <div className="sub" style={{ color: "var(--brand)" }}>
                      <Loader2 size={11} className="spin" /> {progress}
                    </div>
                  )}
                </div>
                {owner && m.role !== "owner" ? (
                  <>
                    <select className="select" style={{ height: 32 }} value={m.role} disabled={!!busy} onChange={(e) => changeRole(m, e.target.value as Role)}>
                      <option value="editor">Peut modifier</option>
                      <option value="viewer">Lecture seule</option>
                    </select>
                    {canGive && (
                      <button className="btn btn-sm" title="Donner la propriété" disabled={!!busy} onClick={() => give(m)}>
                        <Gift size={16} /> Donner
                      </button>
                    )}
                    <button className="btn btn-sm btn-icon" title="Retirer l'accès" style={{ color: "var(--danger)" }} disabled={!!busy} onClick={() => revoke(m)}>
                      <UserMinus size={16} />
                    </button>
                  </>
                ) : (
                  <span className="badge">{ROLE_LABEL[m.role]}</span>
                )}
              </div>
            ))
          )}
        </div>
      )}
      {inherited.length > 0 && (
        <>
          <p className="field-help" style={{ margin: "12px 0 6px" }}>
            Ont aussi accès par un dossier parent (à gérer depuis ce dossier) :
          </p>
          <div className="panel">
            {inherited.map((m) => (
              <div className="row" key={m.userId}>
                <Avatar name={m.name} color={m.color} />
                <div className="grow">
                  <div className="title">
                    {m.name} {m.userId === ctx.user.id && <span className="badge">toi</span>}
                  </div>
                  <div className="sub">via « {m.via} »</div>
                </div>
                <span className="badge">{ROLE_LABEL[m.role]}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {!node.direct && node.role !== "owner" && <p style={{ marginTop: 12 }}>Tu as accès via un dossier parent partagé.</p>}
      {owner && !canGive && (
        <p className="field-help" style={{ marginTop: 12 }}>
          Pour donner cet élément à quelqu'un, sors-le d'abord à la racine de « Mes fichiers » (seul un élément à la racine peut changer de propriétaire).
        </p>
      )}

      {node.kind === "board" && !giving && !node.deletedAt && (node.role === "owner" || node.role === "editor") && <PublicLinks node={node} />}

      <div className="modal-actions">
        <button className="btn" onClick={() => copyText(`${location.origin}/${node.kind === "board" ? "board" : "folder"}/${node.id}`)}>
          <Copy size={16} /> Copier le lien
        </button>
        <button className="btn btn-primary" onClick={onClose}>
          Fermer
        </button>
      </div>
    </Modal>
  );
}
