import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { Ban, Link2, Loader2, Lock, Mail, RotateCcw, Search, Send, Shield, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { api, ApiError } from "../api.ts";
import { useUser } from "../auth.tsx";
import "./admin.css";
import { Avatar, Modal, Switch, confirmDialog, copyText, toast } from "../components/ui.tsx";

type AdminUser = {
  id: string;
  email: string;
  name: string;
  isAdmin: number;
  color: string;
  createdAt: number;
  emailVerified: boolean;
  suspended: boolean;
  mfaEnabled: boolean;
  lastSeenAt: number | null;
  boards: number;
  folders: number;
  items: number;
  machines: number;
  machinesOnline: number;
  terminals: number;
  storageBytes: number;
  storage: { boards: number; images: number; previews: number; library: number; other: number };
};
type Stats = {
  accounts: number;
  verified: number;
  pending: number;
  suspended: number;
  storageBytes: number;
  dbFileBytes: number;
  machinesOnline: number;
  machines: number;
  openBoards: number;
  signupsLast7Days: number;
};
type Invite = { id: string; note: string | null; expiresAt: number; createdAt: number; usedBy: string | null };
type Data = { users: AdminUser[]; invites: Invite[]; stats: Stats; registrationOpen: boolean; emailVerification: boolean; mfaRequiredAdmins: boolean };
type Sort = "storage" | "seen" | "created";
type MailOutcome = { at: number; ok: boolean; error?: string };
type Smtp = {
  mode: "smtp" | "log" | "off";
  host: string | null;
  port: number | null;
  secure: boolean;
  user: string | null;
  from: string | null;
  lastOk: MailOutcome | null;
  lastError: MailOutcome | null;
};

function bytes(n: number): string {
  if (n < 1000) return `${n} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(".", ",")} ${units[i]}`;
}

const ago = (t: number) => formatDistanceToNow(t, { addSuffix: true, locale: fr });

export function Admin() {
  const me = useUser();
  const [data, setData] = useState<Data | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("created");

  const [smtp, setSmtp] = useState<Smtp | null>(null);
  const [testTo, setTestTo] = useState(me.email);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // MFA required for admins and none on this account: the account page explains how to turn it on.
  const [needMfa, setNeedMfa] = useState(false);
  const fail = useCallback((e: unknown) => (e instanceof ApiError && e.code === "MFA_REQUIRED" ? setNeedMfa(true) : toast.error(e)), []);

  const load = useCallback(() => {
    api.get<Data>("/admin").then(setData).catch(fail);
    api.get<Smtp>("/admin/smtp").then(setSmtp).catch(fail);
  }, [fail]);
  useEffect(load, [load]);

  const users = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (data?.users ?? []).filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    const key = (u: AdminUser) => (sort === "storage" ? u.storageBytes : sort === "seen" ? (u.lastSeenAt ?? 0) : u.createdAt);
    return list.sort((a, b) => key(b) - key(a));
  }, [data, query, sort]);

  if (!me.isAdmin) return <Navigate to="/" replace />;
  if (needMfa) return <Navigate to="/account?mfa=required" replace />;

  const setRegistration = async (open: boolean) => {
    await api.patch("/admin/settings", { registrationOpen: open }).catch(toast.error);
    load();
  };

  const setVerification = async (on: boolean) => {
    await api.patch("/admin/settings", { emailVerification: on }).catch(toast.error);
    load();
  };

  const setMfaRequired = async (on: boolean) => {
    await api.patch("/admin/settings", { mfaRequiredAdmins: on }).catch(toast.error);
    load();
  };

  const resetMfa = async (u: AdminUser) => {
    const ok = await confirmDialog({
      title: `Réinitialiser la double authentification de ${u.name} ?`,
      text: "Elle est désactivée et ses codes de secours sont supprimés : la personne ne se connecte plus qu'avec son mot de passe, jusqu'à ce qu'elle la réactive. À faire seulement si elle a perdu son appareil et ses codes.",
      confirm: "Réinitialiser",
      danger: true,
    });
    if (!ok) return;
    await api.post(`/admin/users/${u.id}/mfa-reset`).catch(toast.error);
    toast("Double authentification réinitialisée");
    load();
  };

  const invite = async () => {
    const note = prompt("Pour qui ? (note facultative, visible des admins)") ?? "";
    try {
      const r = await api.post<{ url: string }>("/admin/invites", { note, days: 7 });
      setInviteUrl(r.url);
      load();
    } catch (e) {
      toast.error(e);
    }
  };

  const testMail = async (e: React.FormEvent) => {
    e.preventDefault();
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.post<{ to: string; ms: number; status: Smtp }>("/admin/smtp/test", { to: testTo });
      setSmtp(r.status);
      setTestResult({
        ok: true,
        text:
          smtp?.mode === "log"
            ? `Email écrit dans les journaux du serveur (mode log), rien n'est réellement envoyé.`
            : `Accepté par le serveur SMTP en ${(r.ms / 1000).toFixed(1).replace(".", ",")} s. Vérifie la boîte de ${r.to} (et les indésirables).`,
      });
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
      api.get<Smtp>("/admin/smtp").then(setSmtp).catch(() => {});
    } finally {
      setTesting(false);
    }
  };

  const toggleAdmin = async (u: AdminUser) => {
    await api.patch(`/admin/users/${u.id}`, { isAdmin: !u.isAdmin }).catch(toast.error);
    load();
  };

  const toggleSuspend = async (u: AdminUser) => {
    const ok = await confirmDialog({
      title: u.suspended ? `Réactiver ${u.name} ?` : `Suspendre ${u.name} ?`,
      text: u.suspended
        ? "La personne pourra de nouveau se connecter."
        : "La personne est déconnectée tout de suite et ne peut plus se connecter. Ses données restent intactes.",
      confirm: u.suspended ? "Réactiver" : "Suspendre",
      danger: !u.suspended,
    });
    if (!ok) return;
    await api.patch(`/admin/users/${u.id}`, { suspended: !u.suspended }).catch(toast.error);
    load();
  };

  const remove = async (u: AdminUser) => {
    const ok = await confirmDialog({
      title: `Supprimer ${u.name} ?`,
      text: `Son compte, ses ${u.items} élément(s) (${bytes(u.storageBytes)}) et ses ${u.machines} machine(s) seront supprimés définitivement. Tu ne peux pas lire ces données : seulement les effacer.`,
      confirm: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    await api.del(`/admin/users/${u.id}`).catch(toast.error);
    load();
  };

  return (
    <>
      <h1 className="page-title display">Administration</h1>
      <p className="page-sub">
        <Lock size={14} /> Les admins gèrent les comptes, jamais le contenu : impossible de lire, réinitialiser ou se faire passer pour quelqu'un.
      </p>

      {data && (
        <p className="admin-summary">
          <b>{data.stats.accounts}</b> comptes ({data.stats.verified} vérifiés
          {data.stats.pending > 0 && `, ${data.stats.pending} en attente`}
          {data.stats.suspended > 0 && `, ${data.stats.suspended} suspendus`}) · <b>{bytes(data.stats.storageBytes)}</b> de données chiffrées ·{" "}
          base {bytes(data.stats.dbFileBytes)} · <b>{data.stats.machinesOnline}</b>/{data.stats.machines} machines en ligne ·{" "}
          <b>{data.stats.openBoards}</b> tableau(x) ouvert(s) · <b>{data.stats.signupsLast7Days}</b> inscription(s) sur 7 jours
        </p>
      )}

      <div className="panel">
        <div className="panel-head">
          <h3>Inscriptions</h3>
          <button className="btn btn-primary btn-sm" onClick={invite}>
            <Link2 size={16} /> Créer une invitation
          </button>
        </div>
        <div className="row">
          <div className="grow">
            <div className="title">Inscriptions ouvertes à tous</div>
            <div className="sub">Sinon, il faut un lien d'invitation (usage unique, 7 jours).</div>
          </div>
          {data && <Switch on={data.registrationOpen} onChange={setRegistration} label="Inscriptions ouvertes" />}
        </div>
        {data?.invites.map((i) => (
          <div className="row" key={i.id}>
            <Link2 size={16} style={{ color: "var(--muted)" }} />
            <div className="grow">
              <div className="title">{i.note || "Invitation"}</div>
              <div className="sub">
                {i.usedBy
                  ? `Utilisée par ${i.usedBy}`
                  : i.expiresAt < Date.now()
                    ? "Expirée"
                    : `Expire ${formatDistanceToNow(i.expiresAt, { addSuffix: true, locale: fr })}`}
              </div>
            </div>
            <button
              className="btn btn-sm btn-icon"
              title="Supprimer"
              onClick={async () => {
                await api.del(`/admin/invites/${i.id}`).catch(toast.error);
                load();
              }}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <ShieldCheck size={16} /> Sécurité
          </h3>
        </div>
        <div className="row">
          <div className="grow">
            <div className="title">MFA obligatoire pour les administrateurs</div>
            <div className="sub">
              Un administrateur sans double authentification garde son compte mais perd l'accès à cette page tant qu'il ne l'a pas activée. Il faut l'avoir
              activée soi-même pour pouvoir allumer ce réglage.
            </div>
          </div>
          {data && <Switch on={data.mfaRequiredAdmins} onChange={setMfaRequired} label="MFA obligatoire pour les administrateurs" />}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <Mail size={16} /> Emails (SMTP)
          </h3>
          {smtp && (
            <span className={`badge${smtp.mode === "off" ? " admin-badge-off" : smtp.mode === "smtp" ? " admin-badge-on" : ""}`}>
              {smtp.mode === "smtp" ? "configuré" : smtp.mode === "log" ? "mode log" : "désactivé"}
            </span>
          )}
        </div>
        {smtp && (
          <>
            <div className="row">
              <div className="grow">
                {smtp.mode === "smtp" ? (
                  <>
                    <div className="title mono">
                      {smtp.host}:{smtp.port} {smtp.secure ? "(TLS)" : "(STARTTLS si proposé)"}
                    </div>
                    <div className="sub">
                      Expéditeur : {smtp.from ?? "non défini"}
                      {smtp.user && ` · compte ${smtp.user}`}
                    </div>
                  </>
                ) : smtp.mode === "log" ? (
                  <>
                    <div className="title">Les emails sont écrits dans les journaux du serveur</div>
                    <div className="sub">SMTP_TRANSPORT=log : pratique en développement, personne ne reçoit rien.</div>
                  </>
                ) : (
                  <>
                    <div className="title">Aucun email n'est envoyé</div>
                    <div className="sub">
                      Sans SMTP_HOST, les comptes ne sont pas vérifiés par email et les notifications sont indisponibles. Configure SMTP_HOST, SMTP_PORT,
                      SMTP_USER, SMTP_PASS et SMTP_FROM puis redémarre le serveur.
                    </div>
                  </>
                )}
              </div>
            </div>
            {smtp.mode !== "off" && data && (
              <div className="row">
                <div className="grow">
                  <div className="title">Vérifier l'email à l'inscription</div>
                  <div className="sub">Un code à 6 chiffres est envoyé à chaque nouveau compte, qui ne peut se connecter qu'après l'avoir saisi.</div>
                </div>
                <Switch on={data.emailVerification} onChange={setVerification} label="Vérifier l'email à l'inscription" />
              </div>
            )}
            {smtp.mode === "smtp" && (smtp.lastOk || smtp.lastError) && (
              <p className="admin-note">
                {smtp.lastOk && <>Dernier envoi réussi {ago(smtp.lastOk.at)}. </>}
                {smtp.lastError && (!smtp.lastOk || smtp.lastError.at > smtp.lastOk.at) && (
                  <span className="admin-error">
                    Dernier échec {ago(smtp.lastError.at)} : {smtp.lastError.error}
                  </span>
                )}
              </p>
            )}
            {smtp.mode !== "off" && (
              <form className="row" onSubmit={testMail}>
                <label className="field grow">
                  Envoyer un email de test à
                  <input className="input" type="email" required value={testTo} onChange={(e) => setTestTo(e.target.value)} />
                </label>
                <button className="btn" style={{ alignSelf: "flex-end" }} disabled={testing}>
                  {testing ? <Loader2 size={16} className="spin" /> : <Send size={16} />} Tester
                </button>
              </form>
            )}
            {testResult && <p className={`admin-note ${testResult.ok ? "admin-ok" : "admin-error"}`}>{testResult.text}</p>}
          </>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Utilisateurs</h3>
          <div className="admin-tools">
            <label className="admin-search">
              <Search size={15} />
              <input className="input" placeholder="Nom ou email" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <select className="input" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Trier par">
              <option value="created">Plus récents</option>
              <option value="seen">Dernière activité</option>
              <option value="storage">Stockage</option>
            </select>
          </div>
        </div>
        <p className="admin-note">Tu vois des tailles et des dates, jamais le contenu.</p>
        {users.map((u) => (
          <div className={`row admin-user${u.suspended ? " is-suspended" : ""}`} key={u.id}>
            <Avatar name={u.name} color={u.color} />
            <div className="grow">
              <div className="title">
                {u.name} {!!u.isAdmin && <span className="badge">admin</span>}
                {!u.emailVerified && <span className="badge">non vérifié</span>}
                {u.suspended && <span className="badge admin-badge-off">suspendu</span>}
                {u.mfaEnabled && <span className="badge" title="Double authentification activée">MFA</span>}
              </div>
              <div className="sub">{u.email}</div>
            </div>
            <dl className="admin-facts">
              <div>
                <dt>Inscrit</dt>
                <dd>{ago(u.createdAt)}</dd>
              </div>
              <div>
                <dt>Activité</dt>
                <dd>{u.lastSeenAt ? ago(u.lastSeenAt) : "jamais"}</dd>
              </div>
              <div
                title={`Tableaux ${bytes(u.storage.boards)} · images ${bytes(u.storage.images)} · aperçus ${bytes(u.storage.previews)} · bibliothèque ${bytes(u.storage.library)} · autre ${bytes(u.storage.other)}`}
              >
                <dt>Stockage</dt>
                <dd>{bytes(u.storageBytes)}</dd>
              </div>
              <div>
                <dt>Machines</dt>
                <dd>
                  {u.machinesOnline}/{u.machines} en ligne
                </dd>
              </div>
            </dl>
            {u.id !== me.id && (
              <div className="admin-actions">
                <button className="btn btn-sm btn-icon" title={u.suspended ? "Réactiver" : "Suspendre"} onClick={() => toggleSuspend(u)}>
                  {u.suspended ? <RotateCcw size={16} /> : <Ban size={16} />}
                </button>
                {u.mfaEnabled && (
                  <button className="btn btn-sm btn-icon" title="Réinitialiser la double authentification" onClick={() => resetMfa(u)}>
                    <ShieldOff size={16} />
                  </button>
                )}
                <button className="btn btn-sm btn-icon" title={u.isAdmin ? "Retirer admin" : "Rendre admin"} onClick={() => toggleAdmin(u)}>
                  <Shield size={16} />
                </button>
                <button className="btn btn-sm btn-icon" style={{ color: "var(--danger)" }} title="Supprimer le compte" onClick={() => remove(u)}>
                  <Trash2 size={16} />
                </button>
              </div>
            )}
          </div>
        ))}
        {data && users.length === 0 && <p className="admin-note">Aucun compte ne correspond.</p>}
      </div>

      {inviteUrl && (
        <Modal onClose={() => setInviteUrl(null)}>
          <h2 className="display">Lien d'invitation</h2>
          <p>Envoie-le à la personne : elle choisira son mot de passe et ses clés seront générées chez elle. Usage unique, valable 7 jours.</p>
          <div className="codebox">
            {inviteUrl}
            <button className="btn btn-ghost btn-icon btn-sm" onClick={() => copyText(inviteUrl)}>
              <Link2 size={15} />
            </button>
          </div>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={() => setInviteUrl(null)}>
              Fermer
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
