// Sharing one of the user's machines: with people directly (they can open shells and sites on it
// from any of their boards), and through boards (the editors of a board where the machine has a
// shell or a site can use it there). See docs/SECURITY.md, « Partage de machines ».
import { useCallback, useEffect, useState } from "react";
import { LayoutDashboard, Loader2, UserMinus, UserPlus } from "lucide-react";
import { useKeys, useUser } from "../auth.tsx";
import { useLibrary } from "../library.tsx";
import { machineShares, setShareBoards, shareMachine, unshareMachine, type Machine, type MachineShare } from "../vault.ts";
import { CandidateVerify, ContactSearch, useContactSearch, withFingerprints } from "./ContactPicker.tsx";
import { Avatar, Modal, Switch, confirmDialog, toast } from "./ui.tsx";

export function ShareMachineModal({ machine, onClose, onChanged }: { machine: Machine; onClose: () => void; onChanged?: () => void }) {
  const user = useUser();
  const keys = useKeys();
  const { nodes } = useLibrary();
  const [shares, setShares] = useState<(MachineShare & { fingerprint: string })[] | null>(null);
  const [boards, setBoards] = useState<string[]>([]);
  const [viaBoards, setViaBoards] = useState(!!machine.shareBoards);
  const search = useContactSearch();
  const { candidate } = search;
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await machineShares(machine.id);
    setShares(await withFingerprints(r.shares));
    setBoards(r.boards);
  }, [machine.id]);

  useEffect(() => {
    load().catch(toast.error);
  }, [load]);

  const toggleBoards = async (on: boolean) => {
    if (
      !on &&
      boards.length &&
      !(await confirmDialog({
        title: "Ne plus partager par les tableaux ?",
        text: `${boards.length > 1 ? `Les ${boards.length} tableaux liés perdent` : "Le tableau lié perd"} l'accès à « ${machine.name} » : les shells et les sites que d'autres y ont ouverts sur cette machine sont fermés.`,
        confirm: "Désactiver",
        danger: true,
      }))
    )
      return;
    setBusy("boards");
    try {
      await setShareBoards(machine.id, on);
      setViaBoards(on);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const share = async () => {
    if (!candidate) return;
    setBusy("share");
    try {
      await shareMachine(user, keys, machine, candidate, search.accepted);
      toast(`« ${machine.name} » partagée avec ${candidate.name}`);
      search.reset();
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (s: MachineShare) => {
    const ok = await confirmDialog({
      title: `Retirer ${s.name} ?`,
      text: `${s.name} ne pourra plus ouvrir de shell ni de site sur « ${machine.name} », et ceux qu'il ou elle y a ouverts sont fermés. Sa copie de la clé de la machine n'est pas effaçable à distance : pour une coupure complète, supprime la machine puis appaire-la de nouveau.`,
      confirm: "Retirer",
      danger: true,
    });
    if (!ok) return;
    setBusy(s.userId);
    try {
      await unshareMachine(machine.id, s.userId);
      await load();
      onChanged?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const boardName = (id: string) => nodes.get(id)?.name ?? "Tableau";

  return (
    <Modal onClose={onClose} width={600}>
      <h2 className="display">Partager « {machine.name} »</h2>
      <p>
        Les personnes qui ont accès à la machine peuvent y ouvrir des shells, des sessions Telnet / SSH et des sites, <b>avec les droits du compte de l'agent</b>.
        Sa clé est chiffrée pour elles : le serveur ne peut pas la lire.
      </p>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="row">
          <LayoutDashboard size={18} style={{ color: "var(--muted)" }} />
          <div className="grow">
            <div className="title">Partager via les tableaux</div>
            <div className="sub">
              Quand tu ouvres un shell ou un site sur cette machine dans un tableau partagé, ses éditeurs peuvent l'utiliser depuis ce tableau.
            </div>
          </div>
          {busy === "boards" ? <Loader2 size={16} className="spin" /> : <Switch on={viaBoards} onChange={toggleBoards} label="Partager via les tableaux" />}
        </div>
        {viaBoards &&
          boards.map((id) => (
            <div className="row" key={id} style={{ paddingLeft: 42 }}>
              <div className="grow sub">Liée à « {boardName(id)} »</div>
            </div>
          ))}
      </div>

      <ContactSearch search={search} />

      <CandidateVerify
        search={search}
        actions={
          <button className="btn btn-primary" disabled={busy === "share" || search.blocked} onClick={share}>
            {busy === "share" ? <Loader2 size={16} className="spin" /> : <UserPlus size={16} />} Partager la machine
          </button>
        }
      />

      <div className="panel" style={{ marginTop: 8 }}>
        {shares === null ? (
          <div className="row">Chargement…</div>
        ) : shares.length === 0 ? (
          <div className="row sub">Partagée avec personne directement.</div>
        ) : (
          shares.map((s) => (
            <div className="row" key={s.userId}>
              <Avatar name={s.name} color={s.color} />
              <div className="grow">
                <div className="title">{s.name}</div>
                <div className="sub mono" title="Empreinte de sa clé publique">
                  {s.email} · {s.fingerprint.slice(0, 19)}…
                </div>
              </div>
              <button className="btn btn-sm btn-icon" title="Retirer l'accès" style={{ color: "var(--danger)" }} disabled={!!busy} onClick={() => revoke(s)}>
                {busy === s.userId ? <Loader2 size={16} className="spin" /> : <UserMinus size={16} />}
              </button>
            </div>
          ))
        )}
      </div>

      <div className="modal-actions">
        <button className="btn btn-primary" onClick={onClose}>
          Fermer
        </button>
      </div>
    </Modal>
  );
}
