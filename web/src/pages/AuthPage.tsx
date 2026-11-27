import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Download, KeyRound, Loader2, LockKeyhole, MailCheck, ShieldCheck } from "lucide-react";
import { api, ApiError, type User } from "../api.ts";
import { useAuth } from "../auth.tsx";
import { checkCode, login, recover, register, resendCode, unlock, verifyEmail, type MfaStep, type Session } from "../account.ts";
import type { KeyPair } from "../crypto.ts";
import { Logo, copyText } from "../components/ui.tsx";
import { saveBlob } from "../download.ts";
import "./auth.css";

type Status = { needsSetup: boolean; registrationOpen: boolean };
type Mode = "login" | "register" | "recover";

export function AuthPage({ mode }: { mode: Mode }) {
  const { user, keys, signedIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const invite = params.get("invite");
  const [status, setStatus] = useState<Status | null>(null);
  const [inviteValid, setInviteValid] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", password: "", confirm: "", recoveryKey: "", setupCode: "" });
  const [pending, setPending] = useState<(Session & { recoveryKey: string }) | null>(null);
  const [website, setWebsite] = useState("");
  // Email step: after sign-up (keys + recovery key in memory) or after a login refused for an unverified email.
  const [verifying, setVerifying] = useState<{ email: string; keys?: KeyPair; recoveryKey?: string; password?: string } | null>(null);
  // Second-factor step: after the password (or the recovery key) of an account that has one. `to` is where to go next.
  const [mfa, setMfa] = useState<{ step: MfaStep; to: string } | null>(null);

  useEffect(() => {
    api.get<Status>("/auth/status").then(setStatus).catch(() => {});
    if (invite) api.get<{ valid: boolean }>(`/auth/invite/${encodeURIComponent(invite)}`).then((r) => setInviteValid(r.valid)).catch(() => setInviteValid(false));
  }, [invite]);

  const next = params.get("next") || "/";
  if (pending) {
    return (
      <RecoveryKeyScreen
        recoveryKey={pending.recoveryKey}
        email={pending.user.email}
        onDone={() => {
          signedIn(pending.user, pending.keys);
          navigate(next, { replace: true });
        }}
      />
    );
  }
  if (verifying) {
    return (
      <VerifyScreen
        email={verifying.email}
        onSubmit={async (code) => {
          if (verifying.keys && verifying.recoveryKey) {
            const s = await verifyEmail(verifying.email, code, verifying.keys);
            setPending({ ...s, recoveryKey: verifying.recoveryKey });
            setVerifying(null);
          } else {
            await checkCode(verifying.email, code);
            const s = await login(verifying.email, verifying.password ?? "");
            if ("mfaRequired" in s) {
              setMfa({ step: s, to: next });
              setVerifying(null);
              return;
            }
            signedIn(s.user, s.keys);
            navigate(next, { replace: true });
          }
        }}
        onBack={() => setVerifying(null)}
      />
    );
  }
  if (mfa) {
    return (
      <MfaScreen
        onSubmit={async (code) => {
          const s = await mfa.step.finish(code);
          signedIn(s.user, s.keys);
          navigate(mfa.to, { replace: true });
        }}
        onBack={() => setMfa(null)}
      />
    );
  }
  if (user && keys) return <Navigate to={next} replace />;
  if (status?.needsSetup && mode === "login") return <Navigate to="/register" replace />;

  const setup = !!status?.needsSetup;
  const canRegister = setup || status?.registrationOpen || inviteValid;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if ((mode === "register" || mode === "recover") && form.password !== form.confirm) {
      setError("Les deux mots de passe ne correspondent pas");
      return;
    }
    setBusy(true);
    try {
      if (mode === "register") {
        if (website) return;
        const r = await register({ email: form.email, name: form.name, password: form.password, invite, setupCode: setup ? form.setupCode : undefined });
        if ("needsVerification" in r) setVerifying({ email: r.email, keys: r.keys, recoveryKey: r.recoveryKey });
        else setPending(r);
      } else if (mode === "recover") {
        const s = await recover(form.email, form.recoveryKey, form.password);
        if ("mfaRequired" in s) {
          setMfa({ step: s, to: "/" });
          return;
        }
        signedIn(s.user, s.keys);
        navigate("/", { replace: true });
      } else {
        const s = await login(form.email, form.password);
        if ("mfaRequired" in s) {
          setMfa({ step: s, to: next });
          return;
        }
        signedIn(s.user, s.keys);
        navigate(next, { replace: true });
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "EMAIL_NOT_VERIFIED") {
        resendCode(form.email).catch(() => {});
        setVerifying({ email: form.email, password: form.password });
      } else if (err instanceof ApiError && err.code === "SUSPENDED") {
        setError("Compte suspendu. Contacte l'administrateur.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value }),
  });

  const title = setup ? "Bienvenue !" : mode === "register" ? "Créer un compte" : mode === "recover" ? "Récupération" : "Connexion";
  const hint = setup
    ? "Crée le compte administrateur. Tes données sont chiffrées dans ton navigateur : même l'admin du serveur ne peut pas les lire."
    : mode === "register"
      ? "Tableaux + terminaux, chiffrés de bout en bout."
      : mode === "recover"
        ? "Entre ta clé de récupération pour définir un nouveau mot de passe sans rien perdre."
        : "Content de te revoir sur Excalibash.";

  return (
    <div className="auth">
      <div className="auth-card">
        <Logo size={52} />
        <h1 className="display">{title}</h1>
        <p className="hint">{hint}</p>
        {mode === "register" && status && !canRegister ? (
          <p className="form-error" style={{ marginTop: 20 }}>
            {invite ? "Cette invitation est invalide ou expirée." : "Les inscriptions sont fermées. Demande une invitation à un administrateur."}
          </p>
        ) : (
          <form onSubmit={submit}>
            {setup && mode === "register" && (
              <label className="field">
                Code d'installation
                <input className="input mono" required placeholder="XXXX-XXXX" autoComplete="off" spellCheck={false} {...field("setupCode")} />
                <span className="field-help">
                  Affiché dans les logs du serveur au démarrage : <code>docker compose logs excalibash</code>
                </span>
              </label>
            )}
            {mode === "register" && (
              <label className="field">
                Nom
                <input className="input" required autoComplete="name" {...field("name")} />
              </label>
            )}
            <label className="field">
              Email
              <input className="input" type="email" required autoComplete="email" autoFocus {...field("email")} />
            </label>
            {mode === "recover" && (
              <label className="field">
                Clé de récupération
                <input className="input mono" required placeholder="XXXX-XXXX-…" autoComplete="off" spellCheck={false} {...field("recoveryKey")} />
              </label>
            )}
            <label className="field">
              {mode === "recover" ? "Nouveau mot de passe" : "Mot de passe"}
              <input
                className="input"
                type="password"
                required
                minLength={mode === "login" ? undefined : 10}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                {...field("password")}
              />
            </label>
            {mode !== "login" && (
              <label className="field">
                Confirmation
                <input className="input" type="password" required minLength={10} autoComplete="new-password" {...field("confirm")} />
              </label>
            )}
            {mode === "register" && (
              <input
                className="hp"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            )}
            {error && <div className="form-error">{error}</div>}
            <button className="btn btn-primary" disabled={busy} style={{ height: 44 }}>
              {busy ? (
                <>
                  <Loader2 size={16} className="spin" />{" "}
                  {mode === "login" ? "Déchiffrement des clés…" : "Génération des clés et vérification anti-robot…"}
                </>
              ) : mode === "register" ? (
                "Créer le compte"
              ) : mode === "recover" ? (
                "Redéfinir le mot de passe"
              ) : (
                "Se connecter"
              )}
            </button>
          </form>
        )}
        {!setup && (
          <div className="hint" style={{ marginTop: 18, textAlign: "center", display: "grid", gap: 6 }}>
            {mode !== "login" && (
              <span>
                Déjà un compte ? <Link to="/login" className="link">Se connecter</Link>
              </span>
            )}
            {mode === "login" && status?.registrationOpen && (
              <span>
                Pas de compte ? <Link to="/register" className="link">S'inscrire</Link>
              </span>
            )}
            {mode === "login" && (
              <span>
                Mot de passe oublié ? <Link to="/recover" className="link">Utiliser ma clé de récupération</Link>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function VerifyScreen({ email, onSubmit, onBack }: { email: string; onSubmit: (code: string) => Promise<void>; onBack: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(30);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  return (
    <div className="auth">
      <div className="auth-card">
        <MailCheck size={44} style={{ color: "var(--brand)" }} />
        <h1 className="display">Vérifie ton email</h1>
        <p className="hint">
          Nous avons envoyé un code à 6 chiffres à <b>{email}</b>. Il est valable 15 minutes.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await onSubmit(code.trim());
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setBusy(false);
            }
          }}
        >
          <label className="field">
            Code
            <input
              className="input mono"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          {error && <div className="form-error">{error}</div>}
          {info && <p className="hint">{info}</p>}
          <button className="btn btn-primary" disabled={busy || code.length !== 6} style={{ height: 44 }}>
            {busy ? <Loader2 size={16} className="spin" /> : "Valider"}
          </button>
        </form>
        <div className="hint" style={{ marginTop: 16, textAlign: "center", display: "grid", gap: 6 }}>
          <button
            className="link"
            style={{ background: "none", border: 0, cursor: wait > 0 ? "default" : "pointer" }}
            disabled={wait > 0}
            onClick={async () => {
              setWait(30);
              setError("");
              try {
                await resendCode(email);
                setInfo("Un nouveau code vient d'être envoyé.");
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            {wait > 0 ? `Renvoyer le code (${wait} s)` : "Renvoyer le code"}
          </button>
          <button className="link" style={{ background: "none", border: 0, cursor: "pointer" }} onClick={onBack}>
            Retour
          </button>
        </div>
      </div>
    </div>
  );
}

/** Second factor: the 6-digit code of the authenticator app, or one of the backup codes. */
function MfaScreen({ onSubmit, onBack }: { onSubmit: (code: string) => Promise<void>; onBack: () => void }) {
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = backup ? code.replace(/[^A-Za-z0-9]/g, "").length === 10 : code.length === 6;
  return (
    <div className="auth">
      <div className="auth-card">
        <ShieldCheck size={44} style={{ color: "var(--brand)" }} />
        <h1 className="display">Code de vérification</h1>
        <p className="hint">
          {backup
            ? "Entre l'un de tes codes de secours. Chacun ne sert qu'une fois."
            : "Entre le code à 6 chiffres affiché par ton application d'authentification."}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await onSubmit(code.trim());
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setBusy(false);
            }
          }}
        >
          <label className="field">
            {backup ? "Code de secours" : "Code"}
            {backup ? (
              <input
                key="backup"
                className="input mono"
                placeholder="XXXXX-XXXXX"
                autoComplete="off"
                spellCheck={false}
                maxLength={11}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            ) : (
              <input
                key="totp"
                className="input mono"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            )}
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn btn-primary" disabled={busy || !ready} style={{ height: 44 }}>
            {busy ? <Loader2 size={16} className="spin" /> : "Valider"}
          </button>
        </form>
        <div className="hint" style={{ marginTop: 16, textAlign: "center", display: "grid", gap: 6 }}>
          <button
            className="link"
            style={{ background: "none", border: 0, cursor: "pointer" }}
            onClick={() => {
              setBackup(!backup);
              setCode("");
              setError("");
            }}
          >
            {backup ? "Utiliser le code de l'application" : "Utiliser un code de secours"}
          </button>
          <button className="link" style={{ background: "none", border: 0, cursor: "pointer" }} onClick={onBack}>
            Retour
          </button>
        </div>
      </div>
    </div>
  );
}

function RecoveryKeyScreen({ recoveryKey, email, onDone }: { recoveryKey: string; email: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const download = () => {
    const text = `Excalibash — clé de récupération\nCompte : ${email}\nServeur : ${location.origin}\n\n${recoveryKey}\n\nGarde-la hors ligne. Sans elle, un mot de passe oublié = données perdues.\n`;
    saveBlob(new Blob([text], { type: "text/plain" }), "excalibash-cle-de-recuperation.txt");
  };
  return (
    <div className="auth">
      <div className="auth-card" style={{ width: "min(520px, 100%)" }}>
        <KeyRound size={44} style={{ color: "var(--brand)" }} />
        <h1 className="display">Ta clé de récupération</h1>
        <p className="hint">
          Tes données sont chiffrées avec ton mot de passe. Personne, pas même l'administrateur, ne peut le réinitialiser. Si tu l'oublies, cette clé est
          <b> le seul moyen</b> de récupérer ton compte. Elle ne sera plus jamais affichée.
        </p>
        <div className="codebox" style={{ marginTop: 18, fontSize: 15, textAlign: "center", padding: "16px 44px" }}>
          {recoveryKey}
          <button className="btn btn-ghost btn-icon btn-sm" title="Copier" onClick={() => copyText(recoveryKey)}>
            <KeyRound size={15} />
          </button>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button className="btn" onClick={download}>
            <Download size={16} /> Télécharger (.txt)
          </button>
        </div>
        <label style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 18, fontSize: 14, fontWeight: 600 }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          Je l'ai rangée en lieu sûr (gestionnaire de mots de passe, papier…)
        </label>
        <button className="btn btn-primary" style={{ marginTop: 18, width: "100%", height: 44 }} disabled={!saved} onClick={onDone}>
          <ShieldCheck size={18} /> Continuer
        </button>
      </div>
    </div>
  );
}

/** Signed in (cookie) but this browser does not hold the decrypted private key. */
export function UnlockScreen({ user }: { user: User }) {
  const { setKeys, logout } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth">
      <div className="auth-card">
        <LockKeyhole size={44} style={{ color: "var(--brand)" }} />
        <h1 className="display">Déverrouiller</h1>
        <p className="hint">
          Bonjour {user.name}. Entre ton mot de passe pour déchiffrer tes clés sur cet appareil.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              setKeys(await unlock(user, password));
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setBusy(false);
            }
          }}
        >
          <label className="field">
            Mot de passe
            <input className="input" type="password" required autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn btn-primary" disabled={busy} style={{ height: 44 }}>
            {busy ? <Loader2 size={16} className="spin" /> : "Déverrouiller"}
          </button>
        </form>
        <p className="hint" style={{ marginTop: 16, textAlign: "center" }}>
          <button className="link" style={{ background: "none", border: 0, cursor: "pointer" }} onClick={() => logout()}>
            Changer de compte
          </button>
        </p>
      </div>
    </div>
  );
}
