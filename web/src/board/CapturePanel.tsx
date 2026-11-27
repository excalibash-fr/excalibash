import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AgentOutdatedNotice } from "../components/AgentOutdated.tsx";
import { FileClient, filterProblem, type MachineIface } from "./fileTransfer.ts";
import { IFACE_RE } from "../validators.ts";
import { fmtBytes } from "../format.ts";
import { splitDetails } from "./errorDetails.ts";
import { exportName } from "./termTools.ts";
import type { CaptureManager } from "./captureManager.ts";

/** A persistent, red error with tcpdump's own line folded under it. */
export function InlineError({ text }: { text: string }) {
  const { message, details } = splitDetails(text);
  return (
    <div className="inline-error" role="alert" data-testid="capture-error">
      <b>{message}</b>
      {details && (
        <details>
          <summary>Détails</summary>
          <pre style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{details}</pre>
        </details>
      )}
    </div>
  );
}

/**
 * The machine's real interfaces, for the capture select. null while loading, "unknown" when the
 * agent cannot list them (too old for it, or no answer): the panel then falls back to a text field.
 */
function useMachineIfaces(client: FileClient): MachineIface[] | null | "unknown" {
  const [list, setList] = useState<MachineIface[] | null | "unknown">(null);
  const latest = useRef(client);
  latest.current = client;
  const skip = !!client.refusal("capture") || !!client.refusal("ifaces");
  useEffect(() => {
    if (skip) return setList("unknown");
    let live = true;
    setList(null);
    latest.current.ifaces().then(
      (l) => live && setList(l),
      () => live && setList("unknown"),
    );
    return () => {
      live = false;
    };
  }, [client.terminal, skip]);
  return list;
}

/**
 * Packet capture on an interface of the machine at this cable end, run by the agent through its
 * local shell (tcpdump). The pcap goes straight to the browser, sealed with the shell's key.
 * `cableIface` is the interface written on the cable: preselected when the machine has it.
 */
export function CapturePanel({ client, manager, captureKey, cableIface }: { client: FileClient; manager: CaptureManager; captureKey: string; cableIface: string }) {
  const [seconds, setSeconds] = useState(30);
  const [filter, setFilter] = useState("");
  const [mib, setMib] = useState(20);
  const [picked, setPicked] = useState<string | null>(null);
  // The capture lives in the board's manager, not here: closing this window leaves it running.
  const entry = useSyncExternalStore(manager.subscribe, () => manager.get(captureKey));
  const ifaces = useMachineIfaces(client);
  const wanted = cableIface.trim();
  const names = Array.isArray(ifaces) ? ifaces.filter((i) => IFACE_RE.test(i.name)) : null;
  const missing = !!names && !!wanted && !names.some((i) => i.name === wanted);
  const iface = picked ?? (names ? (names.some((i) => i.name === wanted) ? wanted : "") : wanted);
  const ifaceOk = IFACE_RE.test(iface.trim());
  const problem = filterProblem(filter);
  const valid = ifaceOk && !problem && seconds >= 1 && seconds <= 300 && mib >= 1 && mib <= 50;

  const refusal = client.refusal("capture");
  if (refusal)
    return (
      <fieldset className="capture-box">
        <legend>Capturer (pcap)</legend>
        <AgentOutdatedNotice error={refusal} />
      </fieldset>
    );

  const start = () =>
    manager.start(captureKey, client, { iface: iface.trim(), filter: filter.trim() || undefined, seconds, maxBytes: Math.round(mib * 1024 * 1024) }, (name) =>
      exportName(name.replace(/\.pcap$/, ""), "pcap"),
    );

  return (
    // Enter in a capture field must not submit the cable form: that would close it and cancel the capture.
    <fieldset className="capture-box" onKeyDown={(e) => e.key === "Enter" && e.target instanceof HTMLInputElement && e.preventDefault()}>
      <legend>Capturer (pcap)</legend>
      {entry?.phase !== "running" ? (
        <>
          {entry?.phase === "error" && (
            <>
              <InlineError text={entry.details ? `${entry.message}\nDétail : ${entry.details}` : entry.message} />
              <button type="button" className="btn btn-sm" style={{ justifySelf: "start" }} onClick={() => manager.dismiss(captureKey)}>
                Fermer le message
              </button>
            </>
          )}
          {entry?.phase === "done" && (
            <div className="field-help" role="status" data-testid="capture-done">
              Capture sur {entry.iface} terminée : {fmtBytes(entry.bytes)}, téléchargés dans {entry.file}.
            </div>
          )}
          {names ? (
            <label className="field">
              Interface à capturer
              <select className="input" aria-label="Interface à capturer" value={iface} onChange={(e) => setPicked(e.target.value)}>
                <option value="" disabled>
                  Choisis une interface…
                </option>
                {names.map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.name}
                    {i.up ? "" : " (down)"} — {i.addrs[0] ?? "sans adresse"}
                  </option>
                ))}
              </select>
              {missing && (
                <span className="field-help" role="alert" style={{ color: "var(--danger)" }} data-testid="capture-iface-missing">
                  L'interface du câble ({wanted}) n'existe pas sur la machine : choisis-en une dans la liste.
                </span>
              )}
            </label>
          ) : (
            <label className="field">
              Interface à capturer
              <input className="input" aria-label="Interface à capturer" value={iface} onChange={(e) => setPicked(e.target.value)} placeholder="eth0, enp3s0, br-lan…" spellCheck={false} maxLength={32} />
              <span className="field-help">{ifaces === null ? "Recherche des interfaces de la machine…" : "La liste des interfaces n'est pas disponible : saisis le nom à la main."}</span>
            </label>
          )}
          <div className="capture-row">
            <label className="field">
              Durée (s)
              <input className="input" type="number" min={1} max={300} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
            </label>
            <label className="field">
              Taille max (Mio)
              <input className="input" type="number" min={1} max={50} value={mib} onChange={(e) => setMib(Number(e.target.value))} />
            </label>
          </div>
          <label className="field">
            Filtre BPF (facultatif)
            <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="tcp port 80 and host 10.0.0.1" spellCheck={false} />
            {problem && <span className="field-help">{problem}</span>}
          </label>
          <button type="button" className="btn" disabled={!valid} onClick={start} title={ifaceOk ? undefined : "Choisis une interface de la machine (eth0, enp3s0, br-lan…)"}>
            Capturer sur {iface.trim() || "…"}
          </button>
          <span className="field-help">
            tcpdump tourne sur la machine : l'agent doit être root (ou tcpdump avoir CAP_NET_RAW). La connexion de l'agent au serveur est exclue de la capture.
            Le fichier .pcap arrive chiffré de bout en bout. La capture continue si tu fermes cette fenêtre ; le fichier est téléchargé à la fin.
          </span>
        </>
      ) : (
        <div className="capture-row" data-testid="capture-running">
          <span>
            Capture sur {entry.iface} : {fmtBytes(entry.bytes)} capturés…
          </span>
          <button type="button" className="btn" disabled={entry.stopping} onClick={() => manager.stop(captureKey)}>
            Arrêter
          </button>
          <button type="button" className="btn" onClick={() => manager.cancel(captureKey)}>
            Annuler
          </button>
          <span className="field-help" style={{ flexBasis: "100%" }}>
            Tu peux fermer cette fenêtre : la capture continue et le fichier est téléchargé à la fin.
          </span>
        </div>
      )}
    </fieldset>
  );
}

/** Floating reminder of the captures running (or failed) on this board, whatever windows are open. */
export function CaptureDock({ manager }: { manager: CaptureManager }) {
  const list = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const shown = list.filter((e) => e.phase === "running" || e.phase === "error");
  if (!shown.length) return null;
  return (
    <div className="capture-dock" data-testid="capture-dock">
      {shown.map((e) =>
        e.phase === "running" ? (
          <div key={e.key} className="capture-chip" data-testid="capture-chip">
            <span className="dot on" />
            <span>
              Capture {e.iface} · {fmtBytes(e.bytes)}
            </span>
            <button className="btn btn-sm" disabled={e.stopping} onClick={() => manager.stop(e.key)}>
              Arrêter
            </button>
          </div>
        ) : e.phase === "error" ? (
          <div key={e.key} className="capture-chip capture-chip-error" role="alert" data-testid="capture-chip-error">
            <span>
              Capture {e.iface} : {e.message}
            </span>
            <button className="btn btn-sm" onClick={() => manager.dismiss(e.key)}>
              Fermer
            </button>
          </div>
        ) : null,
      )}
    </div>
  );
}
