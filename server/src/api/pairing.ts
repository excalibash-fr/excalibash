import { Router, type Request } from "express";
import { randomInt, randomBytes } from "node:crypto";
import { db, isClientId } from "../db.ts";
import { rateLimit, requireUser, sha256 } from "../auth.ts";
import { getMachine } from "../access.ts";
import { assertNotLocked, failed } from "../lockout.ts";
import { HttpError, blob, publicUrl } from "../http.ts";
import { pinFor } from "../tls.ts";
import { pinPreamble } from "../install.ts";

// Pairing a machine with a short code typed on it (no copy-paste). The agent registers the
// public key it generated on the machine; the owner's browser shows its fingerprint, the owner
// checks it against the machine's screen, and only then the browser seals the machine auth key
// to that key. The server just holds the rendezvous; it never sees a secret it could use.

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L
const CODE_LEN = 6;
const TTL = 10 * 60_000;

type Pairing = {
  code: string;
  ownerId: string;
  expires: number;
  agentPub?: string;
  agentName?: string;
  approved?: { token: string; sealedAuth: string };
};

const pairings = new Map<string, Pairing>();

setInterval(() => {
  const now = Date.now();
  for (const [code, p] of pairings) if (p.expires < now) pairings.delete(code);
}, 60_000).unref();

const normalize = (code: unknown) =>
  String(code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

function live(code: string): Pairing | undefined {
  const p = pairings.get(code);
  return p && p.expires > Date.now() ? p : undefined;
}

export const display = (code: string) => `${code.slice(0, 3)}-${code.slice(3)}`;

// ---- Owner side (signed in) -------------------------------------------------------

export const pairingOwnerApi = Router();
pairingOwnerApi.use(requireUser);

function owned(req: Request): Pairing {
  const p = live(normalize(req.params.code));
  if (!p || p.ownerId !== req.user!.id) throw new HttpError(404, "Code expiré ou inconnu");
  return p;
}

pairingOwnerApi.post("/", (req, res) => {
  let code = "";
  do code = Array.from({ length: CODE_LEN }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  while (pairings.has(code));
  const p: Pairing = { code, ownerId: req.user!.id, expires: Date.now() + TTL };
  pairings.set(code, p);
  const pin = pinFor(req);
  const curl = pin ? `curl -k --pinnedpubkey '${pin}' -fsSL` : "curl -fsSL";
  res.json({ code: display(code), expiresAt: p.expires, command: `${curl} ${publicUrl(req)}/p/${code} | sh` });
});

pairingOwnerApi.get("/:code", (req, res) => {
  const p = owned(req);
  res.json({ status: p.approved ? "approved" : p.agentPub ? "claimed" : "waiting", agentPub: p.agentPub ?? null, agentName: p.agentName ?? null, expiresAt: p.expires });
});

/** The owner checked the fingerprint: create the machine and hand the agent its sealed auth key. */
pairingOwnerApi.post("/:code/approve", (req, res) => {
  const p = owned(req);
  if (!p.agentPub || p.approved) throw new HttpError(409, "Rien à valider");
  if (blob(req.body.agentPub, 100) !== p.agentPub) throw new HttpError(409, "La clé de la machine a changé : recommence");
  if (!isClientId(req.body.id) || getMachine(req.body.id)) throw new HttpError(400, "Identifiant invalide");
  const token = "eba_" + randomBytes(24).toString("base64url");
  db.prepare(
    "INSERT INTO machines (id, owner_id, enc_name, enc_pub, enc_auth, token_hash, created_at, share_boards) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    req.body.id,
    p.ownerId,
    blob(req.body.encName, 1000),
    blob(req.body.encPub, 300),
    blob(req.body.encAuth, 300),
    sha256(token),
    Date.now(),
    req.body.shareBoards === false ? 0 : 1,
  );
  p.approved = { token, sealedAuth: blob(req.body.sealedAuth, 300) };
  res.json({ ok: true });
});

pairingOwnerApi.delete("/:code", (req, res) => {
  const p = owned(req);
  pairings.delete(p.code);
  res.json({ ok: true });
});

// ---- Agent side (public, rate limited) ----------------------------------------------

export const pairingAgentApi = Router();

pairingAgentApi.post("/:code", async (req, res) => {
  if (!rateLimit(`pair:${req.ip}`, 20)) throw new HttpError(429, "Trop de tentatives");
  assertNotLocked("pair", { ip: req.ip! });
  const p = live(normalize(req.params.code));
  if (!p) {
    await failed("pair", { ip: req.ip! });
    throw new HttpError(404, "Code inconnu ou expiré");
  }
  if (p.agentPub) throw new HttpError(410, "Code déjà utilisé");
  const pub = blob(req.body.pub, 60);
  if (Buffer.from(pub, "base64url").length !== 32) throw new HttpError(400, "Clé invalide");
  p.agentPub = pub;
  p.agentName = String(req.body.name ?? "").slice(0, 64);
  res.status(202).json({ ok: true });
});

pairingAgentApi.get("/:code", async (req, res) => {
  if (!rateLimit(`pairpoll:${req.ip}`, 120)) throw new HttpError(429, "Trop de requêtes");
  assertNotLocked("pair", { ip: req.ip! });
  const p = live(normalize(req.params.code));
  if (!p || !p.agentPub || req.query.pub !== p.agentPub) {
    await failed("pair", { ip: req.ip! });
    throw new HttpError(404, "Appairage introuvable");
  }
  if (!p.approved) {
    res.status(202).json({ status: "waiting" });
    return;
  }
  pairings.delete(p.code);
  res.json(p.approved);
});

/** Installer for `curl …/p/<code> | sh`: download the agent, pair, then run it as a service. */
export function pairScript(server: string, code: string, pin: string | null): string {
  const safe = normalize(code).slice(0, 12);
  const download = pin
    ? `curl -k --pinnedpubkey "$PIN" -fsSL "$SERVER/downloads/excalibash-agent-$OS-$ARCH" -o "$BIN.tmp"`
    : `if command -v curl >/dev/null 2>&1; then curl -fsSL "$SERVER/downloads/excalibash-agent-$OS-$ARCH" -o "$BIN.tmp"
else wget -qO "$BIN.tmp" "$SERVER/downloads/excalibash-agent-$OS-$ARCH"; fi`;
  return `#!/bin/sh
set -eu
SERVER='${server.replace(/'/g, "")}'
CODE='${safe}'
${pinPreamble(pin)}case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) echo "OS non supporté : $(uname -s)" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "architecture non supportée : $(uname -m)" >&2; exit 1 ;; esac
BIN_DIR="$HOME/.local/bin"
BIN="$BIN_DIR/excalibash-agent"
mkdir -p "$BIN_DIR"
echo "→ téléchargement de l'agent $OS/$ARCH"
${download}
chmod +x "$BIN.tmp" && mv "$BIN.tmp" "$BIN"
"$BIN" --server "$SERVER"${pin ? ' --pin "$PIN"' : ""} --pair "$CODE" --pair-only --name "$(hostname)"
CONFIG="$HOME/.config/excalibash/agent.json"

# Start with the machine, whatever it runs: system service (root), user service with linger,
# or a @reboot crontab entry. The agent reconnects on its own once started.
if [ "$(id -u)" = 0 ] && [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  cat > /etc/systemd/system/excalibash-agent.service <<UNIT
[Unit]
Description=Excalibash agent
Wants=network-online.target
After=network-online.target

[Service]
Environment=HOME=$HOME
ExecStart=$BIN --config $CONFIG
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now excalibash-agent.service
  echo "✓ agent installé en service système : il démarre avec la machine. Logs : journalctl -u excalibash-agent -f"
elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/excalibash-agent.service" <<UNIT
[Unit]
Description=Excalibash agent
After=network-online.target

[Service]
ExecStart=$BIN --config $CONFIG
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now excalibash-agent.service
  # Without "linger", user services only start once someone logs in.
  if loginctl enable-linger "$(id -un)" 2>/dev/null; then
    echo "✓ agent installé en service : il démarre avec la machine, même sans connexion."
  else
    echo "✓ agent installé en service (il démarre à l'ouverture de session)."
    echo "  Pour qu'il démarre avec la machine sans connexion : sudo loginctl enable-linger $(id -un)"
  fi
  echo "  Logs : journalctl --user -u excalibash-agent -f"
elif command -v crontab >/dev/null 2>&1; then
  ( crontab -l 2>/dev/null | grep -v 'excalibash-agent' ; echo "@reboot $BIN --config $CONFIG >/dev/null 2>&1" ) | crontab -
  nohup "$BIN" --config "$CONFIG" >/dev/null 2>&1 &
  echo "✓ agent lancé en arrière-plan et relancé à chaque démarrage (crontab @reboot)."
else
  echo "✓ agent lancé (Ctrl+C pour arrêter). Après un redémarrage : $BIN"
  exec "$BIN" --config "$CONFIG"
fi
`;
}
