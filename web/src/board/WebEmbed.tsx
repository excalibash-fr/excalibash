import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ExternalLink, Globe, Minimize2, Power, RotateCw } from "lucide-react";
import type { BoardSession } from "./collab.ts";
import { confirmDialog } from "../components/ui.tsx";
import { api, serverConfig } from "../api.ts";
import { keepFramesOnMove } from "./nodes.ts";

/** Tunnel ids that can be a hostname (see isTunnelId on the server); older ids only work in path mode. */
const isTunnelId = (id: string) => /^[a-z2-7]{26}$/.test(id);

/**
 * Where a tunnel's site lives (separate from Excalibash's own origin, see server/src/proxy.ts): its own
 * subdomain when the instance has TUNNEL_DOMAIN, else /t/<id>/ on the shared proxy origin.
 * `base` is null for a tunnel too old for subdomains.
 */
const tunnelLocation = (webId: string) =>
  serverConfig().then((c): { url: string | null; subdomain: boolean } => {
    if (c.tunnelDomain) return { url: isTunnelId(webId) ? `${c.tunnelScheme}://${webId}.${c.tunnelDomain}/` : null, subdomain: true };
    return { url: `${c.proxyUrl.replace(/\/$/, "")}/t/${webId}/`, subdomain: false };
  });

/**
 * A site reached through an end-to-end encrypted tunnel to one of the board's machines. The page
 * itself runs on the proxy origin; we only hand the tunnel key to the frame or tab we opened.
 */
export function WebEmbed(p: { session: BoardSession; webId: string; active: boolean; title?: string | null; onHide?: () => void; onRemove?: () => void }) {
  const info = useSyncExternalStore(
    (cb) => p.session.on("terminals", cb),
    () => p.session.webs.get(p.webId),
  );
  const [where, setWhere] = useState<{ url: string | null; subdomain: boolean } | null>(null);
  const [nonce, setNonce] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const popups = useRef(new Set<Window>());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tunnelLocation(p.webId).then(setWhere).catch(() => setWhere(null));
    // A reorder of the windows (raised here or by someone else) must not reload this page.
    keepFramesOnMove();
  }, [p.webId]);

  // Key handshake with the proxy origin's boot page. In subdomain mode the page also gets a one-time
  // ticket, which its origin swaps for a cookie session (the server never learns anything else).
  useEffect(() => {
    if (!where?.url) return;
    const origin = new URL(where.url).origin;
    const subdomain = where.subdomain;
    const answering = new Set<Window>();
    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== origin || e.data?.type !== "eb-proxy-ready" || e.data.tunnelId !== p.webId) return;
      const source = e.source as Window | null;
      if (!source || (source !== frame.current?.contentWindow && !popups.current.has(source))) return;
      // The boot page asks again every 250 ms until it gets an answer: one ticket per page, not per ask.
      if (answering.has(source)) return;
      answering.add(source);
      try {
        const key = await p.session.webKey(p.webId);
        const target = p.session.webs.get(p.webId)?.target;
        if (!key || !target) return;
        let ticket: string | undefined;
        if (subdomain) {
          try {
            ticket = (await api.post<{ ticket: string }>(`/tunnels/${p.webId}/ticket`)).ticket;
          } catch {
            return; // no access any more: the boot page keeps waiting and says so
          }
        }
        source.postMessage({ type: "eb-proxy-key", tunnelId: p.webId, key, target: target.url, ...(ticket ? { ticket } : {}) }, origin);
      } finally {
        answering.delete(source);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [where, p.session, p.webId]);

  // Keep wheel and keys inside the page instead of the canvas.
  useEffect(() => {
    const el = rootRef.current!;
    const stop = (e: Event) => e.stopPropagation();
    const events = ["keydown", "keyup", "keypress", "paste", "copy", "cut", "wheel"];
    for (const ev of events) el.addEventListener(ev, stop);
    return () => {
      for (const ev of events) el.removeEventListener(ev, stop);
    };
  }, []);

  const url = where?.url ?? null;
  const target = info?.target;
  const label = p.title || target?.machine || "Site web";

  const openTab = () => {
    if (!url) return;
    const w = window.open(url, "_blank");
    if (w) popups.current.add(w);
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: "Fermer le tunnel ?",
      text: "La fenêtre et le tunnel vers ce site sont supprimés. Les onglets ouverts sur ce site cesseront de fonctionner.",
      confirm: "Fermer",
      danger: true,
    });
    if (ok) p.onRemove?.();
  };

  return (
    <div className="term web" ref={rootRef}>
      <div className="term-head">
        <span className={`dot ${info?.online ? "on" : ""}`} />
        <Globe size={14} />
        <span className="name" title={target?.url}>
          {label.split("\n")[0]}
          {target && <span className="status"> · {target.url.replace(/^https?:\/\//, "")}</span>}
        </span>
        <button title="Recharger" onClick={() => setNonce((n) => n + 1)}>
          <RotateCw size={14} />
        </button>
        <button title="Ouvrir en grand dans un nouvel onglet" onClick={openTab}>
          <ExternalLink size={14} />
        </button>
        {p.onHide && (
          <button title="Masquer (le tunnel reste, l'icône aussi)" onClick={p.onHide}>
            <Minimize2 size={14} />
          </button>
        )}
        {p.onRemove && (
          <button title="Fermer le tunnel" onClick={remove}>
            <Power size={14} />
          </button>
        )}
      </div>
      <div className="term-body web-body">
        {!info ? (
          <div className="term-veil">Tunnel introuvable (fermé, ou appartenant à un autre tableau).</div>
        ) : where && !url ? (
          <div className="term-veil">Ce tunnel date d'avant le passage aux sous-domaines : ferme-le et recrée-le.</div>
        ) : !url ? (
          <div className="term-veil">Chargement…</div>
        ) : (
          <iframe
            key={nonce}
            ref={frame}
            src={url}
            title={label}
            // No top navigation: the site can never take over the Excalibash tab.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
            referrerPolicy="no-referrer"
          />
        )}
        {info && !info.online && <div className="term-veil bottom">La machine est hors ligne.</div>}
      </div>
    </div>
  );
}
