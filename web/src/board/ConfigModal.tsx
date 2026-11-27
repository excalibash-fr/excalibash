import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Copy, Download, Send, X } from "lucide-react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { BoardSession } from "./collab.ts";
import { extractTopology } from "./topology.ts";
import { nodeInterfaces, toCiscoIOS, toLinuxIproute, toNetplan, type Generated } from "./configGen.ts";
import { nodeDataOf } from "./nodeData.ts";
import { saveBlob } from "../download.ts";
import { Modal, Switch, confirmDialog, copyText, toast } from "../components/ui.tsx";

type Format = "cisco-switch" | "cisco-routeur" | "linux" | "netplan";
const FORMATS: Record<Format, { label: string; ext: string; type: string }> = {
  "cisco-switch": { label: "Cisco IOS · switch", ext: "txt", type: "text/plain" },
  "cisco-routeur": { label: "Cisco IOS · routeur", ext: "txt", type: "text/plain" },
  linux: { label: "Linux ip (iproute2)", ext: "sh", type: "text/x-shellscript" },
  netplan: { label: "netplan (YAML)", ext: "yaml", type: "application/yaml" },
};
/** Pause between two lines sent to a terminal: IOS consoles drop input when flooded. */
const LINE_DELAY_MS = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * « Générer la config » for one node of the diagram: the configuration of its cable ends (Cisco IOS,
 * Linux ip, netplan), to copy, download or type into one of its terminals. All in the browser.
 */
export function ConfigModal({ session, api, nodeKey, nameOf, onClose }: { session: BoardSession; api: ExcalidrawImperativeAPI; nodeKey: string; nameOf: (id: string) => string; onClose: () => void }) {
  const topo = useMemo(() => extractTopology(api.getSceneElements(), nameOf), [api, nameOf]);
  const node = topo.nodes.find((n) => n.id === nodeKey);
  const nd = nodeDataOf(api.getSceneElements().find((e) => e.id === nodeKey && !e.isDeleted));
  const conf = useMemo(() => nodeInterfaces(topo, nodeKey), [topo, nodeKey]);

  const [format, setFormat] = useState<Format>(() => {
    const k = nd?.remote?.target.kind;
    if (k === "telnet" || k === "ssh") return conf.ifaces.some((i) => i.ip || Object.keys(i.vlanIps).length) ? "cisco-routeur" : "cisco-switch";
    return "linux";
  });
  const [hostname, setHostname] = useState(false);
  const [wrap, setWrap] = useState(true);
  const cisco = format.startsWith("cisco");

  const gen: Generated = useMemo(() => {
    const ref = { name: node?.name ?? "noeud" };
    if (format === "linux") return toLinuxIproute(ref, conf.ifaces, { hostname });
    if (format === "netplan") return toNetplan(ref, conf.ifaces);
    return toCiscoIOS(ref, conf.ifaces, { mode: format === "cisco-switch" ? "switch" : "routeur", hostname, wrap });
  }, [format, hostname, wrap, conf, node]);
  const warnings = [...conf.warnings, ...gen.warnings];

  // Terminals of the node that can be written to now (live: a shell can exit while the dialog is open).
  const ids = (nd?.shells ?? []).map((s) => s.terminalId);
  const statusKey = useSyncExternalStore(
    (cb) => session.on("terminals", cb),
    () => ids.map((id) => `${id}=${session.terminals.get(id)?.status ?? ""}`).join(","),
  );
  const terminals = useMemo(
    () => ids.map((id) => ({ id, info: session.terminals.get(id) })).filter((t) => t.info?.status === "running"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statusKey, session],
  );
  const [target, setTarget] = useState("");
  const chosen = terminals.find((t) => t.id === target)?.id ?? terminals[0]?.id ?? "";

  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelled = useRef(false);
  const confirming = useRef(false);
  useEffect(() => () => void (cancelled.current = true), []);

  const lines = gen.text.split("\n").filter((l) => l.trim());
  const canSend = session.canEdit && !!chosen && format !== "netplan" && lines.length > 0 && !progress;
  const sendHint = !session.canEdit ? "Lecture seule : envoi impossible" : format === "netplan" ? "netplan est un fichier : copie-le ou télécharge-le" : !terminals.length ? "Aucun terminal ouvert sur cette icône" : "";

  async function send() {
    const t = terminals.find((x) => x.id === chosen);
    if (!t) return;
    confirming.current = true;
    const ok = await confirmDialog({
      title: "Envoyer dans le terminal ?",
      text: `${lines.length} ligne${lines.length > 1 ? "s" : ""} seront tapées dans « ${t.info!.label} », une toutes les ${LINE_DELAY_MS} ms, comme si tu les saisissais. Vérifie que c'est le bon équipement et que la console est au bon niveau (ex. enable).`,
      confirm: "Envoyer",
    });
    confirming.current = false;
    if (!ok) return;
    cancelled.current = false;
    setProgress({ done: 0, total: lines.length });
    let done = 0;
    for (const line of lines) {
      if (cancelled.current) break;
      if (!session.canEdit || session.terminals.get(chosen)?.status !== "running") {
        toast.error("Le terminal n'est plus disponible : envoi interrompu.");
        break;
      }
      session.terminalInput(chosen, `${line}\r`);
      setProgress({ done: ++done, total: lines.length });
      await sleep(LINE_DELAY_MS);
    }
    setProgress(null);
    if (done === lines.length) toast(`${done} ligne${done > 1 ? "s" : ""} envoyée${done > 1 ? "s" : ""}.`);
    else if (cancelled.current) toast(`Envoi annulé après ${done} ligne${done > 1 ? "s" : ""}.`);
  }

  return (
    <Modal onClose={() => !confirming.current && onClose()} width={720}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h2 className="display" style={{ flex: 1, margin: 0 }}>
          Générer la config · {node?.label ?? "?"}
        </h2>
        <button className="btn btn-icon btn-sm" title="Fermer" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {!node || !conf.ifaces.length ? (
        <p style={{ color: "var(--muted)" }}>Aucun câble avec une interface sur cet élément : trace des câbles et renseigne leurs interfaces, IP et VLAN.</p>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end", margin: "14px 0" }}>
        <label className="field">
          Format
          <select className="select" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
            {(Object.keys(FORMATS) as Format[]).map((f) => (
              <option key={f} value={f}>
                {FORMATS[f].label}
              </option>
            ))}
          </select>
        </label>
        {format !== "netplan" && (
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Switch on={hostname} onChange={setHostname} label="Inclure le nom d'hôte" /> Nom d'hôte
          </label>
        )}
        {cisco && (
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Switch on={wrap} onChange={setWrap} label="configure terminal … end" /> configure terminal … end
          </label>
        )}
      </div>
      <textarea className="input" readOnly rows={14} value={gen.text} spellCheck={false} style={{ width: "100%", fontFamily: '"Cascadia Code", ui-monospace, Menlo, monospace', fontSize: 12, whiteSpace: "pre", resize: "vertical" }} />
      {warnings.length > 0 && (
        <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--muted)" }}>
          {warnings.slice(0, 8).map((w, i) => (
            <li key={i}>{w}</li>
          ))}
          {warnings.length > 8 && <li>… et {warnings.length - 8} autre{warnings.length - 8 > 1 ? "s" : ""}.</li>}
        </ul>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 14 }}>
        <button className="btn btn-sm" disabled={!lines.length} onClick={() => void copyText(gen.text)}>
          <Copy size={14} /> Copier
        </button>
        <button
          className="btn btn-sm"
          disabled={!lines.length}
          onClick={() => saveBlob(new Blob([gen.text], { type: `${FORMATS[format].type};charset=utf-8` }), `${node?.name ?? "config"}-${format}.${FORMATS[format].ext}`)}
        >
          <Download size={14} /> Télécharger
        </button>
        <span style={{ flex: 1 }} />
        {terminals.length > 1 && (
          <select className="select" style={{ height: 32, maxWidth: 220 }} value={chosen} onChange={(e) => setTarget(e.target.value)} disabled={!!progress} aria-label="Terminal de destination">
            {terminals.map((t, i) => (
              <option key={t.id} value={t.id}>
                {i + 1}. {t.info!.label}
              </option>
            ))}
          </select>
        )}
        {progress ? (
          <>
            <span style={{ fontSize: 12 }}>
              Envoi {progress.done}/{progress.total}
            </span>
            <button className="btn btn-sm btn-danger" onClick={() => (cancelled.current = true)}>
              Annuler l'envoi
            </button>
          </>
        ) : (
          <button className="btn btn-primary btn-sm" disabled={!canSend} title={sendHint || `Taper ces lignes dans ${terminals.find((t) => t.id === chosen)?.info?.label ?? "le terminal"}`} onClick={() => void send()}>
            <Send size={14} /> Envoyer dans un terminal
          </button>
        )}
      </div>
    </Modal>
  );
}
