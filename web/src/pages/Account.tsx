import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { Bell, Check, Download, EyeOff, Fingerprint, KeyRound, Loader2, MonitorSmartphone, Palette, ShieldCheck, Trash2 } from "lucide-react";
import { api, type User } from "../api.ts";
import { useAuth, useKeys, useUser } from "../auth.tsx";
import { authKeyFor, changePassword, forgetKeys } from "../account.ts";
import { saveBlob } from "../download.ts";
import { QrCode } from "../components/QrCode.tsx";
import { deriveAccountKeys, fingerprint } from "../crypto.ts";
import { confirmDialog, copyText, toast, useTheme } from "../components/ui.tsx";
import { CUSTOM_ID, THEMES, customFrom, customTheme, themeById, type Base, type CustomColors, type Mode, type ThemeDef } from "../themes.ts";

type NotifyEvent = "itemDeleted" | "itemShared" | "accessRevoked" | "itemTransferred" | "newLogin";
type NotifyPrefs = Record<NotifyEvent, boolean>;

const NOTIFICATIONS: { key: NotifyEvent; title: string; help: string }[] = [
  { key: "itemDeleted", title: "Un tableau ou dossier est supprimé", help: "Quand toi ou quelqu'un d'autre met à la corbeille (ou supprime) un élément auquel tu as accès." },
  { key: "itemShared", title: "On me partage quelque chose", help: "Quand quelqu'un te donne accès à un tableau ou un dossier." },
  { key: "accessRevoked", title: "On me retire un accès", help: "Quand le propriétaire arrête de partager un élément avec toi." },
  { key: "itemTransferred", title: "On me donne un élément", help: "Quand quelqu'un te transfère la propriété d'un tableau ou d'un dossier." },
  { key: "newLogin", title: "Nouvelle connexion à mon compte", help: "À chaque connexion avec ton mot de passe, avec la date et l'adresse IP." },
];

type SessionInfo = { id: string; current: boolean; createdAt: number | null; lastUsedAt: number | null; label: string; ipPrefix: string };

export function Account() {
  const user = useUser();
  const keys = useKeys();
  const { setUser, logout } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [delPw, setDelPw] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [fp, setFp] = useState("");
  const [name, setName] = useState(user.name);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [vis, setVis] = useState<{ findableName: boolean; findableEmail: boolean } | null>(null);
  const [notif, setNotif] = useState<{ prefs: NotifyPrefs; emailEnabled: boolean } | null>(null);

  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);

  const loadSessions = () => api.get<SessionInfo[]>("/account/sessions").then(setSessions).catch(toast.error);
  useEffect(() => {
    loadSessions();
  }, []);

  const revokeSession = async (id: string) => {
    try {
      await api.del(`/account/sessions/${id}`);
      toast("Appareil déconnecté");
      await loadSessions();
    } catch (err) {
      toast.error(err);
    }
  };

  const revokeOthers = async () => {
    const ok = await confirmDialog({
      title: "Déconnecter les autres appareils ?",
      text: "Toutes les autres sessions sont fermées ; il faudra s'y reconnecter avec ton mot de passe.",
      confirm: "Déconnecter",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post("/account/sessions/revoke-others");
      toast("Les autres appareils sont déconnectés");
      await loadSessions();
    } catch (err) {
      toast.error(err);
    }
  };

  useEffect(() => {
    fingerprint(keys.pub).then(setFp);
  }, [keys]);

  useEffect(() => {
    api
      .get<{ findableName: boolean; findableEmail: boolean; notifications: NotifyPrefs; emailEnabled: boolean }>("/account")
      .then((r) => {
        setVis({ findableName: r.findableName, findableEmail: r.findableEmail });
        setNotif({ prefs: r.notifications, emailEnabled: r.emailEnabled });
      })
      .catch(toast.error);
  }, []);

  const setNotification = async (key: NotifyEvent, on: boolean) => {
    if (!notif) return;
    const prev = notif;
    const prefs = { ...notif.prefs, [key]: on };
    setNotif({ ...notif, prefs });
    try {
      await api.put("/account/notifications", prefs);
      toast(on ? "Notification activée" : "Notification désactivée");
    } catch (err) {
      setNotif(prev);
      toast.error(err);
    }
  };

  const setVisibility = async (next: { findableName: boolean; findableEmail: boolean }) => {
    const prev = vis;
    setVis(next);
    try {
      await api.put("/account/visibility", next);
      toast("Visibilité enregistrée");
    } catch (err) {
      setVis(prev);
      toast.error(err);
    }
  };

  const deleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await confirmDialog({
      title: "Supprimer ton compte ?",
      text: "C'est définitif. Tes dossiers disparaissent pour tout le monde, et tes machines sont déconnectées.",
      confirm: "Supprimer mon compte",
      danger: true,
    });
    if (!ok) return;
    setDelBusy(true);
    try {
      const { salt } = await api.post<{ salt: string }>("/auth/prelogin", { email: user.email });
      const { authKey } = await deriveAccountKeys(delPw, salt);
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ authKey }),
        credentials: "same-origin",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? (res.status === 401 || res.status === 403 ? "Mot de passe incorrect" : `Erreur ${res.status}`));
      }
      await forgetKeys();
      await logout();
      navigate("/");
    } catch (err) {
      toast.error(err);
      setDelBusy(false);
    }
  };

  return (
    <>
      <h1 className="page-title display">Mon compte</h1>

      {params.get("mfa") === "required" && !user.mfaEnabled && (
        <div className="panel" role="alert">
          <div className="row">
            <ShieldCheck size={20} style={{ color: "var(--brand)" }} />
            <div className="grow">
              <div className="title">L'administration exige la double authentification</div>
              <div className="sub">Active-la dans la section « Double authentification » ci-dessous : tu retrouveras ensuite l'accès à l'administration.</div>
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h3>
            <Fingerprint size={16} /> Empreinte de ma clé
          </h3>
        </div>
        <div className="row">
          <div className="grow">
            <div className="title mono" style={{ fontSize: 15 }}>
              {fp}
            </div>
            <div className="sub">
              Quand quelqu'un te partage un dossier pour la première fois, il voit cette empreinte. Comparez-la (de vive voix, par message…) pour être sûrs que
              personne ne s'est glissé entre vous.
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => copyText(fp)}>
            Copier
          </button>
        </div>
      </div>

      <Appearance />

      <div className="panel">
        <div className="panel-head">
          <h3>Profil</h3>
        </div>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await api.patch<{ user: User }>("/auth/me", { name });
              setUser(r.user);
              toast("Nom mis à jour");
            } catch (err) {
              toast.error(err);
            }
          }}
        >
          <label className="field grow">
            Nom affiché (visible par les personnes avec qui tu partages, et par le serveur)
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn" style={{ alignSelf: "flex-end" }}>
            Enregistrer
          </button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <EyeOff size={16} /> Visibilité
          </h3>
        </div>
        <div style={{ padding: 20 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={!!vis?.findableName}
              disabled={!vis}
              onChange={(e) => vis && setVisibility({ ...vis, findableName: e.target.checked })}
            />
            <span>
              Trouvable par mon nom
              <small>Quelqu'un qui cherche ton nom (début du nom compris) au moment d'un partage te voit dans les résultats, avec ton nom seulement.</small>
            </span>
          </label>
          <label className="check" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={!!vis?.findableEmail}
              disabled={!vis}
              onChange={(e) => vis && setVisibility({ ...vis, findableEmail: e.target.checked })}
            />
            <span>
              Trouvable par mon email
              <small>
                Décoché, taper ton email donne « Aucun compte trouvé », comme si tu n'existais pas. Coché, ton email est aussi montré à qui te trouve.
              </small>
            </span>
          </label>
          <p className="field-help" style={{ margin: "12px 0 0" }}>
            Les personnes qui partagent déjà quelque chose avec toi te trouvent toujours, quels que soient ces réglages.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <Bell size={16} /> Notifications par email
          </h3>
        </div>
        <div style={{ padding: 20 }}>
          {notif && !notif.emailEnabled && (
            <p className="field-help" style={{ margin: "0 0 12px" }}>
              Ce serveur n'envoie pas d'emails pour l'instant : tes choix sont enregistrés et serviront dès qu'un administrateur aura configuré l'envoi.
            </p>
          )}
          {NOTIFICATIONS.map((n, i) => (
            <label className="check" key={n.key} style={i ? { marginTop: 12 } : undefined}>
              <input type="checkbox" checked={!!notif?.prefs[n.key]} disabled={!notif} onChange={(e) => setNotification(n.key, e.target.checked)} />
              <span>
                {n.title}
                <small>{n.help}</small>
              </span>
            </label>
          ))}
          <p className="field-help" style={{ margin: "12px 0 0" }}>
            Envoyées à {user.email}. Par défaut, seuls les partages sont annoncés. Les noms des tableaux sont chiffrés : le serveur ne les connaît pas, les emails disent
            seulement de quel type d'élément il s'agit.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <MonitorSmartphone size={16} /> Appareils connectés
          </h3>
          {sessions && sessions.length > 1 && (
            <button className="btn btn-sm btn-danger" onClick={revokeOthers}>
              Déconnecter les autres appareils
            </button>
          )}
        </div>
        {(sessions ?? []).map((s) => (
          <div className="row" key={s.id}>
            <div className="grow">
              <div className="title">
                {s.label || "Appareil inconnu"} {s.current && <span className="badge live">cet appareil</span>}
              </div>
              <div className="sub">
                {s.ipPrefix || "adresse inconnue"}
                {s.lastUsedAt ? ` · actif ${formatDistanceToNow(s.lastUsedAt, { addSuffix: true, locale: fr })}` : ""}
              </div>
            </div>
            {!s.current && (
              <button className="btn btn-sm" onClick={() => revokeSession(s.id)}>
                Déconnecter
              </button>
            )}
          </div>
        ))}
        <p className="field-help" style={{ padding: "0 20px 16px", margin: 0 }}>
          Le serveur ne garde que le navigateur et le système approximatifs, le début de l'adresse IP (les derniers chiffres sont écartés) et la date de dernière
          activité. Jamais le texte complet envoyé par ton navigateur.
        </p>
      </div>

      <TwoFactor />

      <div className="panel">
        <div className="panel-head">
          <h3>
            <KeyRound size={16} /> Mot de passe
          </h3>
        </div>
        <form
          style={{ padding: 20, display: "grid", gap: 12, maxWidth: 420 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (pw.next !== pw.confirm) return toast.error("Les deux mots de passe ne correspondent pas");
            setBusy(true);
            try {
              await changePassword(user, pw.current, pw.next);
              setPw({ current: "", next: "", confirm: "" });
              toast("Mot de passe changé — les autres appareils sont déconnectés");
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="sub" style={{ margin: 0 }}>
            Ta clé privée est re-chiffrée avec le nouveau mot de passe. Ta clé de récupération reste valable.
          </p>
          <label className="field">
            Mot de passe actuel
            <input className="input" type="password" required autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </label>
          <label className="field">
            Nouveau mot de passe
            <input className="input" type="password" required minLength={10} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </label>
          <label className="field">
            Confirmation
            <input className="input" type="password" required minLength={10} autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </label>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : "Changer le mot de passe"}
          </button>
        </form>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>
            <Trash2 size={16} /> Supprimer mon compte
          </h3>
        </div>
        <form style={{ padding: 20, display: "grid", gap: 12, maxWidth: 420 }} onSubmit={deleteAccount}>
          <p className="sub" style={{ margin: 0 }}>
            La suppression est définitive. Tes données sont chiffrées avec tes clés : une fois le compte supprimé, elles sont irrécupérables. Les dossiers que tu
            possèdes, même partagés, disparaissent pour tout le monde. Tes machines sont déconnectées.
          </p>
          <label className="field">
            Mot de passe
            <input className="input" type="password" required autoComplete="current-password" value={delPw} onChange={(e) => setDelPw(e.target.value)} />
          </label>
          <button className="btn btn-danger" disabled={delBusy || !delPw}>
            {delBusy ? <Loader2 size={16} className="spin" /> : "Supprimer mon compte"}
          </button>
        </form>
      </div>

      <p className="sub" style={{ marginTop: 8 }}>
        <Link to="/confidentialite">Confidentialité</Link>
      </p>
    </>
  );
}

type MfaInfo = { enabled: boolean; backupCodesLeft: number; required: boolean };
type MfaStage =
  | { step: "idle" }
  | { step: "password" }
  | { step: "scan"; authKey: string; secret: string; uri: string }
  | { step: "codes"; codes: string[] }
  | { step: "regen" }
  | { step: "disable" };

/** Second factor: turn it on (QR code, first code, backup codes), regenerate the backup codes, turn it off. */
function TwoFactor() {
  const user = useUser();
  const { setUser } = useAuth();
  const [info, setInfo] = useState<MfaInfo | null>(null);
  const [stage, setStage] = useState<MfaStage>({ step: "idle" });
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .get<{ mfa: MfaInfo }>("/account")
      .then((r) => setInfo(r.mfa))
      .catch(toast.error);
  useEffect(() => {
    load();
  }, []);

  const go = (next: MfaStage) => {
    setStage(next);
    setPw("");
    setCode("");
  };
  /** Runs one action with the busy flag; errors are shown as a toast and the form stays open. */
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const startSetup = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const authKey = await authKeyFor(user.email, pw);
      const r = await api.post<{ secret: string; uri: string }>("/account/mfa/setup", { authKey });
      go({ step: "scan", ...r, authKey });
    });
  };
  const enable = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const r = await api.post<{ backupCodes: string[] }>("/account/mfa/enable", { code });
      setUser({ ...user, mfaEnabled: true });
      go({ step: "codes", codes: r.backupCodes });
      load();
    });
  };
  const regenerate = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const r = await api.post<{ backupCodes: string[] }>("/account/mfa/backup-codes", { code });
      go({ step: "codes", codes: r.backupCodes });
      load();
    });
  };
  const disable = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const authKey = await authKeyFor(user.email, pw);
      await api.post("/account/mfa/disable", { authKey, code });
      setUser({ ...user, mfaEnabled: false });
      go({ step: "idle" });
      toast("Double authentification désactivée");
      load();
    });
  };

  const codeField = (backupAllowed: boolean) => (
    <label className="field">
      Code à 6 chiffres{backupAllowed ? " (ou code de secours)" : ""}
      <input
        className="input mono"
        required
        autoFocus
        autoComplete="one-time-code"
        inputMode={backupAllowed ? "text" : "numeric"}
        maxLength={backupAllowed ? 11 : 6}
        value={code}
        onChange={(e) => setCode(backupAllowed ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ""))}
      />
    </label>
  );
  const passwordField = (
    <label className="field">
      Mot de passe
      <input className="input" type="password" required autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
    </label>
  );
  const cancel = (
    <button type="button" className="btn" onClick={() => go({ step: "idle" })}>
      Annuler
    </button>
  );
  const formStyle = { padding: 20, display: "grid", gap: 12, maxWidth: 420 } as const;
  const on = user.mfaEnabled;

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>
          <ShieldCheck size={16} /> Double authentification
        </h3>
        {on && <span className="badge live">activée</span>}
      </div>

      {stage.step === "idle" && (
        <div className="row" style={{ display: "block" }}>
          <div className="sub" style={{ marginBottom: 12 }}>
            {on
              ? `À chaque connexion, un code de ton application d'authentification est demandé en plus du mot de passe. Codes de secours restants : ${info?.backupCodesLeft ?? "…"}.`
              : "Ajoute un code à 6 chiffres, généré par une application d'authentification (FreeOTP, Aegis, Google Authenticator, un gestionnaire de mots de passe…), à demander après ton mot de passe. Ce code est vérifié par le serveur : il protège l'accès au compte, pas le chiffrement de tes données, qui reste fait dans ton navigateur."}
          </div>
          {on ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => go({ step: "regen" })}>
                Régénérer les codes de secours
              </button>
              <button className="btn btn-danger" onClick={() => go({ step: "disable" })} disabled={info?.required}>
                Désactiver
              </button>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={() => go({ step: "password" })}>
              Activer
            </button>
          )}
          {on && info?.required && (
            <p className="field-help" style={{ margin: "12px 0 0" }}>
              Les administrateurs doivent garder la double authentification : elle est obligatoire sur cette instance.
            </p>
          )}
        </div>
      )}

      {stage.step === "password" && (
        <form style={formStyle} onSubmit={startSetup}>
          <p className="sub" style={{ margin: 0 }}>
            Pour commencer, entre ton mot de passe.
          </p>
          {passwordField}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" disabled={busy || !pw}>
              {busy ? <Loader2 size={16} className="spin" /> : "Continuer"}
            </button>
            {cancel}
          </div>
        </form>
      )}

      {stage.step === "scan" && (
        <form style={formStyle} onSubmit={enable}>
          <p className="sub" style={{ margin: 0 }}>
            1. Scanne ce QR code avec ton application d'authentification (il est dessiné ici, dans ton navigateur). 2. Entre le code à 6 chiffres qu'elle affiche.
          </p>
          <QrCode text={stage.uri} label="QR code à scanner avec l'application d'authentification" />
          <div>
            <div className="sub">Pas de caméra ? Entre ce secret à la main :</div>
            <div className="codebox" data-testid="mfa-secret" style={{ marginTop: 6 }}>
              {stage.secret.replace(/(.{4})/g, "$1 ").trim()}
              <button type="button" className="btn btn-ghost btn-icon btn-sm" title="Copier" onClick={() => copyText(stage.secret)}>
                <KeyRound size={15} />
              </button>
            </div>
          </div>
          {codeField(false)}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" disabled={busy || code.length !== 6}>
              {busy ? <Loader2 size={16} className="spin" /> : "Activer"}
            </button>
            {cancel}
          </div>
        </form>
      )}

      {stage.step === "codes" && <BackupCodes codes={stage.codes} email={user.email} onDone={() => go({ step: "idle" })} />}

      {stage.step === "regen" && (
        <form style={formStyle} onSubmit={regenerate}>
          <p className="sub" style={{ margin: 0 }}>
            Les 10 nouveaux codes remplacent les anciens, qui ne marcheront plus. Entre un code de l'application (ou un code de secours) pour confirmer.
          </p>
          {codeField(true)}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" disabled={busy || !code}>
              {busy ? <Loader2 size={16} className="spin" /> : "Régénérer"}
            </button>
            {cancel}
          </div>
        </form>
      )}

      {stage.step === "disable" && (
        <form style={formStyle} onSubmit={disable}>
          <p className="sub" style={{ margin: 0 }}>
            Ton compte ne sera plus protégé que par ton mot de passe. Entre-le, avec un code de l'application (ou un code de secours).
          </p>
          {passwordField}
          {codeField(true)}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-danger" disabled={busy || !pw || !code}>
              {busy ? <Loader2 size={16} className="spin" /> : "Désactiver"}
            </button>
            {cancel}
          </div>
        </form>
      )}
    </div>
  );
}

/** The backup codes, shown once: copy or download them before closing. */
function BackupCodes({ codes, email, onDone }: { codes: string[]; email: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const text = codes.join("\n");
  const download = () =>
    saveBlob(
      new Blob([`Excalibash : codes de secours\nCompte : ${email}\nServeur : ${location.origin}\n\n${text}\n\nChaque code ne sert qu'une fois. Garde-les hors ligne.\n`], { type: "text/plain" }),
      "excalibash-codes-de-secours.txt",
    );
  return (
    <div style={{ padding: 20, display: "grid", gap: 12, maxWidth: 420 }}>
      <p className="sub" style={{ margin: 0 }}>
        Voici tes 10 codes de secours. Si tu perds ton application, chacun te laisse te connecter une fois. <b>Ils ne seront plus jamais affichés.</b>
      </p>
      <div className="codebox" data-testid="mfa-backup-codes" style={{ whiteSpace: "pre-line", fontSize: 14 }}>
        {text}
        <button type="button" className="btn btn-ghost btn-icon btn-sm" title="Copier" onClick={() => copyText(text)}>
          <KeyRound size={15} />
        </button>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button className="btn" onClick={() => copyText(text)}>
          Copier
        </button>
        <button className="btn" onClick={download}>
          <Download size={16} /> Télécharger (.txt)
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>Je les ai rangés en lieu sûr</span>
      </label>
      <button className="btn btn-primary" disabled={!saved} onClick={onDone}>
        Terminé
      </button>
    </div>
  );
}

/** Themes of the interface and terminals: one light, one dark, kept in this browser. */
function Appearance() {
  const { mode, setMode, slots, setSlot, custom, setCustom } = useTheme();
  const modes: [Mode, string][] = [
    ["light", "Clair"],
    ["dark", "Sombre"],
    ["auto", "Automatique (système)"],
  ];
  const card = (t: ThemeDef, base: Base) => {
    const on = slots[base] === t.id;
    const v = (k: string, fallback: string) => t.vars[k] ?? fallback;
    const dark = t.base === "dark";
    return (
      <button
        key={t.id}
        type="button"
        className={`theme-card ${on ? "on" : ""}`}
        aria-pressed={on}
        title={t.name}
        onClick={() => {
          setSlot(base, t.id);
          // Picking a theme shows it, unless the system decides which one is shown.
          if (mode !== "auto") setMode(base);
        }}
      >
        <span className="theme-swatch" style={{ background: v("bg", dark ? "#0a0a0a" : "#f8fafc") }}>
          <span className="theme-swatch-panel" style={{ background: v("surface", dark ? "#171717" : "#ffffff"), borderColor: v("line", dark ? "#262626" : "#e2e8f0") }}>
            <span style={{ background: v("text", dark ? "#fafafa" : "#0f172a") }} />
            <span style={{ background: v("muted", "#94a3b8") }} />
            <span className="theme-swatch-brand" style={{ background: v("brand", dark ? "#6366f1" : "#4f46e5") }} />
          </span>
          <span className="theme-swatch-term" style={{ background: t.term.background }}>
            {[t.term.green, t.term.blue, t.term.red, t.term.yellow].map((c, i) => (
              <span key={i} style={{ background: c }} />
            ))}
          </span>
        </span>
        <span className="theme-name">
          {on && <Check size={13} />} {t.name}
        </span>
      </button>
    );
  };
  const group = (base: Base, title: string) => {
    const mine = customTheme(custom[base], base);
    return (
      <>
        <div className="theme-group">{title}</div>
        <div className="theme-grid">
          {THEMES.filter((t) => t.base === base).map((t) => card(t, base))}
          {card(mine, base)}
        </div>
        {slots[base] === CUSTOM_ID[base] && <CustomEditor base={base} colors={custom[base]} onChange={(c) => setCustom(base, c)} />}
      </>
    );
  };
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>
          <Palette size={16} /> Apparence
        </h3>
      </div>
      <div className="row" style={{ display: "block" }}>
        <div className="sub" style={{ marginBottom: 10 }}>
          Choisis ton thème clair et ton thème sombre (interface et terminaux, gardés dans ce navigateur). Le bouton soleil / lune passe de l'un à l'autre.
        </div>
        <div className="theme-custom-base" role="radiogroup" aria-label="Thème affiché">
          {modes.map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={`btn btn-sm ${mode === m ? "btn-primary" : ""}`} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
        {group("light", "Thème clair")}
        {group("dark", "Thème sombre")}
      </div>
    </div>
  );
}

const CUSTOM_FIELDS: [keyof CustomColors, string][] = [
  ["bg", "Fond"],
  ["surface", "Panneaux"],
  ["text", "Texte"],
  ["brand", "Accent"],
  ["termBg", "Fond des terminaux"],
  ["termFg", "Texte des terminaux"],
];

/** The colors of a custom theme, applied as they are picked. */
function CustomEditor({ base, colors, onChange }: { base: Base; colors: CustomColors; onChange: (c: CustomColors) => void }) {
  return (
    <div className="theme-custom">
      <div className="theme-custom-grid">
        {CUSTOM_FIELDS.map(([k, label]) => (
          <label key={k} className="theme-color">
            <input type="color" value={colors[k]} onChange={(e) => onChange({ ...colors, [k]: e.target.value })} />
            <span>
              {label}
              <small className="mono">{colors[k]}</small>
            </span>
          </label>
        ))}
      </div>
      <label className="theme-from">
        Partir des couleurs de
        <select
          className="select"
          value=""
          onChange={(e) => {
            const t = themeById(e.target.value);
            if (t) onChange(customFrom(t));
          }}
        >
          <option value="">un thème…</option>
          {THEMES.filter((t) => t.base === base).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
