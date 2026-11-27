// Boot page of a web tunnel (proxy origin): installs the service worker, then asks the
// Excalibash page that opened or embeds us for the tunnel key. The key never goes into a URL.
"use strict";

const MAIN_ORIGIN = "__MAIN_ORIGIN__";
const CERT_URL = "__CERT_URL__"; // set when the instance uses its self-signed certificate
// Subdomain mode: the id of the tunnel this origin belongs to, written by the server (empty in path mode).
const HOST_ID = "__TUNNEL_ID__";
const LAST_BOOT = "eb-boot-at";
const status = document.getElementById("status");
const say = (t) => (status.textContent = t);
const id = HOST_ID || (location.pathname.match(/^\/t\/([A-Za-z0-9_-]{16,43})/) || [])[1];

// A handshake that works is followed by a reload; if this page comes back right away the relay is
// refusing us for another reason: say so instead of looping.
function justShookHands() {
  try {
    return HOST_ID && Date.now() - Number(sessionStorage.getItem(LAST_BOOT)) < 5000;
  } catch {
    return false;
  }
}

(async () => {
  if (!id) return say("Lien de tunnel invalide.");
  if (justShookHands()) return say("Le tunnel ne répond pas : rouvre ce site depuis le tableau.");
  if (!("serviceWorker" in navigator)) return say("Ce navigateur ne permet pas les tunnels chiffrés (Service Worker indisponible).");
  try {
    await navigator.serviceWorker.register("/eb-proxy/sw.js", { scope: "/" });
  } catch (e) {
    // Browsers refuse service workers on a certificate they do not trust, even after an exception.
    if (!CERT_URL || location.protocol !== "https:") throw e;
    say("Le navigateur refuse d'ouvrir les tunnels sur un certificat non reconnu. Installer le certificat de cette instance dans le navigateur ou le système, puis recharger : ");
    const a = document.createElement("a");
    a.href = CERT_URL;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "télécharger le certificat";
    a.style.color = "#93c5fd";
    status.append(a);
    return;
  }
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
  }
  const peer = window.opener || (window.parent !== window ? window.parent : null);
  if (!peer) return say("Ouvre ce site depuis son tableau Excalibash (la clé de chiffrement vient de là).");

  let done = false;
  window.addEventListener("message", async (e) => {
    if (done || e.origin !== MAIN_ORIGIN || !e.data || e.data.type !== "eb-proxy-key" || e.data.tunnelId !== id) return;
    done = true;
    if (HOST_ID) {
      // The one-time ticket from Excalibash becomes this tunnel's cookie session. No retry, no reload on failure.
      say("Ouverture de la session…");
      let ok = false;
      try {
        const r = await fetch("/eb-proxy/session", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket: e.data.ticket }),
        });
        ok = r.status === 204;
      } catch {
        /* network error: same message */
      }
      if (!ok) return say("Session refusée : rouvre ce site depuis le tableau.");
    }
    say("Déchiffrement…");
    navigator.serviceWorker.addEventListener("message", (m) => {
      if (m.data && m.data.type === "key-ok" && m.data.tunnelId === id) {
        try {
          window.opener = null; // the site must not get a handle on Excalibash
        } catch {
          /* not an opened tab */
        }
        try {
          sessionStorage.setItem(LAST_BOOT, String(Date.now()));
        } catch {
          /* storage unavailable: no loop guard */
        }
        location.reload();
      }
    });
    navigator.serviceWorker.controller.postMessage({ type: "key", tunnelId: id, key: e.data.key, target: e.data.target });
  });
  say("Connexion sécurisée au tunnel…");
  // The opener may still be attaching its listener: ask a few times.
  for (let i = 0; i < 40 && !done; i++) {
    peer.postMessage({ type: "eb-proxy-ready", tunnelId: id }, MAIN_ORIGIN);
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!done) say("Pas de réponse d'Excalibash : rouvre ce site depuis le tableau.");
})().catch((e) => say(`Erreur : ${e.message}`));
