// Finding someone to share with and checking their public key before sealing anything to it.
// Shared by ShareModal (boards and folders) and ShareMachineModal.
import { useState, type ReactNode } from "react";
import { AlertTriangle, Fingerprint, ShieldCheck } from "lucide-react";
import { api } from "../api.ts";
import { useKeys, useUser } from "../auth.tsx";
import { fingerprint, fromB64 } from "../crypto.ts";
import { checkContact } from "../vault.ts";
import { Avatar, toast } from "./ui.tsx";

export type Found = { id: string; name: string; email?: string; publicKey: string; color: string };
export type Candidate = Found & { fingerprint: string; check: "new" | "match" | "changed" };

/** Adds the fingerprint of each entry's public key (members, machine shares…). */
export function withFingerprints<T extends { publicKey: string }>(list: T[]): Promise<(T & { fingerprint: string })[]> {
  return Promise.all(list.map(async (x) => ({ ...x, fingerprint: await fingerprint(fromB64(x.publicKey)) })));
}

/** Search state: the query, its results, the picked candidate and the "I checked the key" override. */
export function useContactSearch() {
  const user = useUser();
  const keys = useKeys();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Found[] | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [override, setOverride] = useState(false);

  const lookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setCandidate(null);
    setResults(null);
    setOverride(false);
    try {
      const { users } = await api.get<{ users: Found[] }>(`/auth/lookup?q=${encodeURIComponent(query.trim())}`);
      setResults(users.filter((u) => u.id !== user.id));
      if (users.length && users.every((u) => u.id === user.id)) throw new Error("C'est toi !");
    } catch (err) {
      toast.error(err);
    }
  };

  const pick = async (u: Found) => {
    try {
      setCandidate({ ...u, fingerprint: await fingerprint(fromB64(u.publicKey)), check: await checkContact(user, keys, u.id, u.email, u.publicKey) });
      setResults(null);
    } catch (err) {
      toast.error(err);
    }
  };

  /** After a successful share: forget the candidate and clear the search field. */
  const reset = () => {
    setCandidate(null);
    setQuery("");
  };

  /** A changed key blocks sharing until the user ticks the override. */
  const blocked = candidate?.check === "changed" && !override;
  /** Whether to accept a changed key when sealing (only once the user confirmed it). */
  const accepted = candidate?.check === "changed" && override;

  return { query, setQuery, results, setResults, candidate, setCandidate, override, setOverride, lookup, pick, reset, blocked, accepted };
}

export type ContactSearchState = ReturnType<typeof useContactSearch>;

/** The search form (with an optional `extra` control before the button) and its results. */
export function ContactSearch({ search, extra }: { search: ContactSearchState; extra?: ReactNode }) {
  const { query, setQuery, results, setResults, candidate, lookup, pick } = search;
  return (
    <>
      <form onSubmit={lookup} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          className="input"
          required
          minLength={2}
          placeholder="Nom ou email"
          aria-label="Nom ou email"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setResults(null);
          }}
        />
        {extra}
        <button className="btn">Chercher</button>
      </form>

      {results && !candidate && (
        <div className="panel" style={{ marginBottom: 12 }}>
          {results.length === 0 ? (
            <div className="row sub">
              Aucun compte trouvé. La personne n'est peut-être pas trouvable par son nom : demande-lui son email (ou qu'elle active « Trouvable par mon email »).
            </div>
          ) : (
            results.map((u) => (
              <button type="button" className="row" key={u.id} style={{ width: "100%", textAlign: "left" }} onClick={() => pick(u)}>
                <Avatar name={u.name} color={u.color} />
                <div className="grow">
                  <div className="title">{u.name}</div>
                  {u.email && <div className="sub">{u.email}</div>}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </>
  );
}

/** The picked person, their key fingerprint and its check, then Cancel plus the given `actions`. */
export function CandidateVerify({ search, actions }: { search: ContactSearchState; actions: ReactNode }) {
  const { candidate, setCandidate, override, setOverride } = search;
  if (!candidate) return null;
  return (
    <div className={`verify ${candidate.check === "changed" ? "danger" : ""}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Avatar name={candidate.name} color="var(--brand)" />
        <div style={{ flex: 1 }}>
          <b>{candidate.name}</b>
          {candidate.email && <div className="sub">{candidate.email}</div>}
        </div>
      </div>
      <div className="fp">
        <Fingerprint size={14} /> {candidate.fingerprint}
      </div>
      {candidate.check === "changed" ? (
        <p className="warn">
          <AlertTriangle size={14} /> La clé de cette personne a <b>changé</b> depuis ton dernier partage. Ça peut être une réinitialisation de son compte… ou
          une tentative d'interception. Vérifie l'empreinte avec elle (en vrai, par téléphone…) avant de continuer.
        </p>
      ) : candidate.check === "match" ? (
        <p className="ok">
          <ShieldCheck size={14} /> Même clé que lors de vos précédents partages.
        </p>
      ) : (
        <p className="sub" style={{ margin: "6px 0 0" }}>
          Premier partage avec cette personne : pour une sécurité maximale, comparez cette empreinte avec celle affichée dans son onglet « Mon compte ».
        </p>
      )}
      {candidate.check === "changed" && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, fontWeight: 600, marginTop: 8 }}>
          <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> J'ai vérifié l'empreinte avec cette personne
        </label>
      )}
      <div className="modal-actions" style={{ marginTop: 12 }}>
        <button className="btn" onClick={() => setCandidate(null)}>
          Annuler
        </button>
        {actions}
      </div>
    </div>
  );
}
