import { useEffect, useRef, useState } from "react";
import { ArrowDown, Cable, Plus, X } from "lucide-react";
import type { RemoteHop, RemoteTarget } from "../api.ts";
import { useKeys } from "../auth.tsx";
import { listMachines, type Machine } from "../vault.ts";
import { Modal, toast } from "../components/ui.tsx";
import { HOST_RE, USER_RE, stripBrackets } from "../validators.ts";

/** A form in its own modal, or bare when it is one panel of a larger dialog. */
export function FormFrame({ bare, onClose, children }: { bare?: boolean; onClose: () => void; children: React.ReactNode }) {
  return bare ? <>{children}</> : <Modal onClose={onClose} width={560}>{children}</Modal>;
}

const DEFAULT_PORT: Record<RemoteTarget["kind"], string> = { telnet: "23", ssh: "22", raw: "", jupyter: "" };

/** The machines of the user, with one picked (the given default, else the first one). */
export function useMachineChoice(defaultId: string | null) {
  const keys = useKeys();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [machineId, setMachineId] = useState(defaultId ?? "");
  useEffect(() => {
    listMachines(keys)
      .then((ms) => {
        setMachines(ms);
        setMachineId((id) => (ms.some((m) => m.id === id) || !ms[0] ? id : ms[0].id));
      })
      .catch(toast.error);
  }, [keys]);
  return { machines, machineId, setMachineId, machine: machines?.find((m) => m.id === machineId) };
}

export function MachineField({ label, choice }: { label: string; choice: ReturnType<typeof useMachineChoice> }) {
  return (
    <label className="field">
      {label}
      <select className="select" value={choice.machineId} onChange={(e) => choice.setMachineId(e.target.value)} style={{ width: "100%" }}>
        {choice.machines?.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.ownerName ? ` · de ${m.ownerName}` : ""}
            {m.online ? "" : " (hors ligne)"}
          </option>
        ))}
      </select>
    </label>
  );
}

const hostPort = (h: { host: string; port: number; user?: string }) =>
  `${h.user ? `${h.user}@` : ""}${h.host.includes(":") ? `[${h.host}]` : h.host}:${h.port}`;

/** What the session amounts to, as a command the user could type on the machine. */
function preview(t: RemoteTarget): string {
  const jumps = t.via?.length ? t.via.map(hostPort).join(",") : "";
  if (t.via?.length && t.kind !== "ssh") {
    // Telnet / TCP from the last hop: an SSH session to it, then the command typed there.
    const before = t.via.slice(0, -1).map(hostPort).join(",");
    const then = t.kind === "telnet" ? `telnet ${t.host} ${t.port}` : `nc ${t.host} ${t.port}`;
    return `ssh ${before ? `-J ${before} ` : ""}ssh://${hostPort(t.via.at(-1)!)}   # puis ${then}`;
  }
  if (t.kind === "telnet") return `telnet ${t.host} ${t.port}`;
  if (t.kind === "jupyter") return `jupyter kernel${t.kernel ? ` --kernel=${t.kernel}` : ""}${t.cwd ? ` (dans ${t.cwd})` : ""}`;
  if (t.kind === "raw") return `nc ${t.host} ${t.port}`;
  const opts = [
    t.legacyKex && "-o KexAlgorithms=+diffie-hellman-group1-sha1,diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1",
    t.legacyHostKey && "-o HostKeyAlgorithms=+ssh-rsa,ssh-dss",
    t.legacyCiphers && "-o Ciphers=+aes128-cbc,aes256-cbc,3des-cbc -o MACs=+hmac-sha1",
    t.hostKeyCheck === "off" && "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null",
  ].filter(Boolean);
  return ["ssh", ...(jumps ? ["-J", jumps] : []), `${t.user ? `${t.user}@` : ""}${t.host}`, "-p", t.port, ...opts].join(" ");
}

/** One jump host as edited in the form. */
type HopRow = { host: string; port: string; user: string; legacy: boolean };
const hopRow = (h: RemoteHop): HopRow => ({
  host: typeof h.host === "string" ? h.host : "",
  port: Number.isInteger(h.port) ? String(h.port) : "22",
  user: typeof h.user === "string" ? h.user : "",
  legacy: !!(h.legacyKex || h.legacyHostKey || h.legacyCiphers),
});
const hopOk = (h: HopRow) => {
  const p = Number(h.port);
  return HOST_RE.test(stripBrackets(h.host.trim())) && USER_RE.test(h.user.trim()) && Number.isInteger(p) && p > 0 && p < 65536;
};
const hopOf = (h: HopRow): RemoteHop => ({
  host: stripBrackets(h.host.trim()),
  port: Number(h.port),
  ...(h.user.trim() ? { user: h.user.trim() } : {}),
  ...(h.legacy ? { legacyKex: true, legacyHostKey: true, legacyCiphers: true } : {}),
});
export const MAX_HOPS = 8;

/** A Telnet / SSH / TCP session to a device reachable from one of the user's machines (lab switches, routers…). */
export function RemoteForm({
  defaultMachineId,
  onClose,
  onCreate,
  bare,
  defaultHost,
  defaultTarget,
  defaultVia,
}: {
  defaultMachineId: string | null;
  /** Prefilled jump hosts (bouncing from a device icon: its own hops, then the device itself). */
  defaultVia?: RemoteHop[];
  /** Prefilled device (the icon's own device, when adding a session to it). */
  defaultHost?: string;
  /**
   * Prefilled session (a device icon's own target, from the board: anyone editing the board could
   * have written it). Only its protocol, host, port and user are taken, and the user submits it.
   */
  defaultTarget?: RemoteTarget;
  /** Rendered without its modal: a panel of the "add" dialog. */
  bare?: boolean;
  onClose: () => void;
  onCreate: (m: Machine, target: RemoteTarget) => void;
}) {
  const choice = useMachineChoice(defaultMachineId);
  const pre = defaultTarget && (["telnet", "ssh", "raw"] as string[]).includes(defaultTarget.kind) ? defaultTarget : undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const [kind, setKind] = useState<RemoteTarget["kind"]>(pre?.kind ?? "ssh");
  const [host, setHost] = useState(str(pre?.host) || defaultHost || "");
  const [port, setPort] = useState(pre && Number.isInteger(pre.port) ? String(pre.port) : DEFAULT_PORT[pre?.kind ?? "ssh"]);
  const [portEdited, setPortEdited] = useState(!!pre);
  const [user, setUser] = useState(str(pre?.user));
  const [legacy, setLegacy] = useState({ legacyKex: false, legacyHostKey: false, legacyCiphers: false });
  const [hostKeyCheck, setHostKeyCheck] = useState<"tofu" | "off">("tofu");
  const [hops, setHops] = useState<HopRow[]>(() => (defaultVia ?? pre?.via ?? []).slice(0, MAX_HOPS).map(hopRow));
  const setHop = (i: number, patch: Partial<HopRow>) => setHops((hs) => hs.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const legacyAll = useRef<HTMLInputElement>(null);

  const legacyCount = Object.values(legacy).filter(Boolean).length;
  useEffect(() => {
    if (legacyAll.current) legacyAll.current.indeterminate = legacyCount > 0 && legacyCount < 3;
  }, [legacyCount]);

  const ssh = kind === "ssh";
  const cleanHost = stripBrackets(host.trim());
  const cleanUser = user.trim();
  const portNum = Number(port);
  const hostOk = HOST_RE.test(cleanHost);
  const userOk = !ssh || USER_RE.test(cleanUser);
  const portOk = Number.isInteger(portNum) && portNum > 0 && portNum < 65536;
  const hopsOk = hops.every(hopOk);
  const valid = !!choice.machine && hostOk && userOk && portOk && hopsOk;
  const via = hops.map(hopOf);
  const target: RemoteTarget = ssh
    ? { kind, host: cleanHost, port: portNum, user: cleanUser, ...legacy, hostKeyCheck, ...(via.length ? { via } : {}) }
    : { kind, host: cleanHost, port: portNum, ...(via.length ? { via } : {}) };

  const legacyOption = (key: keyof typeof legacy, label: string, help: string) => (
    <label className="check sub">
      <input type="checkbox" checked={legacy[key]} onChange={(e) => setLegacy({ ...legacy, [key]: e.target.checked })} />
      <span>
        {label}
        <small>{help}</small>
      </span>
    </label>
  );

  return (
    <FormFrame bare={bare} onClose={onClose}>
      <h2 className="display">Connexion à un équipement</h2>
      <p>
        Un switch, un routeur ou un PC joint <b>depuis la machine</b> en Telnet ou SSH. La session s'ouvre dans un terminal du tableau, chiffrée de bout en
        bout jusqu'à l'agent.
      </p>
      <form
        style={{ display: "grid", gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onCreate(choice.machine!, target);
        }}
      >
        <MachineField label="Machine relais" choice={choice} />
        <div className="field hops">
          {hops.length > 0 && <span>Rebonds SSH, dans l'ordre depuis la machine</span>}
          {hops.map((h, i) => (
            <div key={i}>
              <div className="hop-row">
                <ArrowDown size={14} className="hop-arrow" aria-hidden />
                <input className="input" value={h.host} onChange={(e) => setHop(i, { host: e.target.value })} placeholder="routeur, 10.0.0.1" aria-label={`Hôte du rebond ${i + 1}`} spellCheck={false} />
                <input className="input hop-port" value={h.port} inputMode="numeric" onChange={(e) => setHop(i, { port: e.target.value.replace(/\D/g, "") })} aria-label={`Port du rebond ${i + 1}`} />
                <input className="input hop-user" value={h.user} onChange={(e) => setHop(i, { user: e.target.value })} placeholder="utilisateur" aria-label={`Utilisateur du rebond ${i + 1}`} autoComplete="off" spellCheck={false} />
                <button type="button" className="btn btn-sm btn-icon" title="Retirer ce rebond" onClick={() => setHops((hs) => hs.filter((_, j) => j !== i))}>
                  <X size={14} />
                </button>
              </div>
              <label className="check sub hop-legacy">
                <input type="checkbox" checked={h.legacy} onChange={(e) => setHop(i, { legacy: e.target.checked })} />
                <span>Équipement ancien</span>
              </label>
              {(h.host.trim() || h.user.trim()) && !hopOk(h) && <span className="form-warn">Rebond {i + 1} invalide : hôte, port (1 à 65535) ou utilisateur.</span>}
            </div>
          ))}
          {hops.length < MAX_HOPS && (
            <button type="button" className="btn btn-sm hop-add" onClick={() => setHops((hs) => [...hs, { host: "", port: "22", user: "", legacy: false }])}>
              <Plus size={14} /> {hops.length ? "Ajouter un rebond" : "Rebondir par un équipement SSH"}
            </button>
          )}
          {hops.length > 0 && (
            <span className="field-help">
              La session passe par chaque rebond en SSH, puis l'équipement ci-dessous est joint depuis le dernier. Les mots de passe des rebonds se tapent dans le
              terminal, l'un après l'autre.
            </span>
          )}
        </div>
        <div className="web-form">
          <label className="field">
            Protocole
            <select
              className="select"
              value={kind}
              onChange={(e) => {
                const k = e.target.value as RemoteTarget["kind"];
                setKind(k);
                if (!portEdited) setPort(DEFAULT_PORT[k]);
              }}
            >
              <option value="telnet">Telnet</option>
              <option value="ssh">SSH</option>
              <option value="raw">TCP brut</option>
            </select>
          </label>
          <label className="field">
            {hops.length ? "Hôte (vu depuis le dernier rebond)" : "Hôte (vu depuis la machine)"}
            <input className="input" value={host} autoFocus onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.1" spellCheck={false} />
          </label>
          <label className="field">
            Port
            <input
              className="input"
              value={port}
              inputMode="numeric"
              placeholder={kind === "raw" ? "2001" : undefined}
              onChange={(e) => {
                setPort(e.target.value.replace(/\D/g, ""));
                setPortEdited(true);
              }}
            />
          </label>
        </div>
        {host.trim() && !hostOk && <span className="form-warn">Hôte invalide : un nom ou une adresse IP, sans espace ni schéma.</span>}
        {ssh && (
          <label className="field">
            Utilisateur
            <input className="input" value={user} onChange={(e) => setUser(e.target.value)} placeholder="admin" autoComplete="off" spellCheck={false} />
            <span className="field-help">
              {userOk ? "Facultatif : vide, il est demandé dans le terminal. Le mot de passe se tape dans le terminal, jamais ici." : "Utilisateur invalide (lettres, chiffres, . _ @ -)."}
            </span>
          </label>
        )}
        {kind === "telnet" && <span className="field-help">Telnet n'est pas chiffré entre la machine et l'équipement : à réserver au réseau du TP.</span>}
        {kind === "raw" && <span className="field-help">Aucun protocole : utile pour une console série derrière un serveur de terminaux.</span>}
        {ssh && (
          <details className="advanced">
            <summary>Configuration avancée</summary>
            <div className="advanced-body">
              <label className="check">
                <input
                  ref={legacyAll}
                  type="checkbox"
                  checked={legacyCount === 3}
                  onChange={(e) => setLegacy({ legacyKex: e.target.checked, legacyHostKey: e.target.checked, legacyCiphers: e.target.checked })}
                />
                <span>
                  Équipement ancien
                  <small>Vieux switch ou routeur qui refuse la connexion avec « no matching key exchange method found ». Active les trois options ci-dessous.</small>
                </span>
              </label>
              {legacyOption("legacyKex", "Échange de clés", "diffie-hellman-group1 / group14 en SHA-1 : corrige « no matching key exchange method found ».")}
              {legacyOption("legacyHostKey", "Clé d'hôte", "ssh-rsa (SHA-1) et ssh-dss : corrige « no matching host key type found ».")}
              {legacyOption("legacyCiphers", "Chiffrements", "aes-cbc, 3des-cbc et hmac-sha1 : corrige « no matching cipher found ».")}
              <div className="field">
                Vérification de la clé d'hôte
                <label className="check">
                  <input type="radio" name="hostKeyCheck" checked={hostKeyCheck === "tofu"} onChange={() => setHostKeyCheck("tofu")} />
                  <span>
                    À la première connexion (recommandé)
                    <small>L'empreinte est retenue par l'agent ; une clé différente ensuite bloque la connexion.</small>
                  </span>
                </label>
                <label className="check">
                  <input type="radio" name="hostKeyCheck" checked={hostKeyCheck === "off"} onChange={() => setHostKeyCheck("off")} />
                  <span>
                    Désactivée
                    <small>Pour un équipement réinitialisé à chaque TP.</small>
                  </span>
                </label>
                {hostKeyCheck === "off" && <span className="form-warn">Sans vérification, rien ne garantit que tu parles au bon équipement.</span>}
              </div>
            </div>
          </details>
        )}
        {valid && (
          <>
            <span className="field-help">Équivaut à taper, sur {choice.machine!.name} :</span>
            <div className="codebox" style={{ paddingRight: 14 }}>
              {preview(target)}
            </div>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button className="btn btn-primary" disabled={!valid}>
            <Cable size={16} /> Se connecter
          </button>
        </div>
      </form>
    </FormFrame>
  );
}
