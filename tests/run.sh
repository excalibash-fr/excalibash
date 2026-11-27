#!/bin/sh
# Bout en bout : serveur jetable + agent réel + deux utilisateurs (voir tests/e2e.mts),
# puis HTTPS par défaut : certificat auto-signé, redirection, épinglage (voir tests/tls.mts).
# Prérequis : `make -C agent dist` (le client MCP est construit ici), `npm install` dans server/ et web/.
set -eu
cd "$(dirname "$0")/.."
(cd web && npm run build:mcp >/dev/null)
DATA=$(mktemp -d)

# Mise à jour des agents : paire de clés jetable, agent v1 (qui porte la clé publique), release v2 signée servie par
# le serveur (AGENT_DIST_DIR), outil de signature. Les autres suites gardent l'agent de agent/dist.
UPD="$DATA/update"
mkdir -p "$UPD"
HOST_PLATFORM="$(cd agent && go env GOOS)/$(cd agent && go env GOARCH)"
(cd agent && go build -o "$UPD/excalibash-sign" ./cmd/excalibash-sign)
UPDATE_PUBKEY=$("$UPD/excalibash-sign" keygen --out "$UPD/release.key" 2>/dev/null)
make -s -C agent dist TARGETS="$HOST_PLATFORM" DIST="$UPD/v1" VERSION=1.0.0 UPDATE_PUBKEY="$UPDATE_PUBKEY" >/dev/null
make -s -C agent dist TARGETS="$HOST_PLATFORM" DIST="$UPD/dist" VERSION=2.0.0 UPDATE_PUBKEY="$UPDATE_PUBKEY" >/dev/null
"$UPD/excalibash-sign" sign --key "$UPD/release.key" --dist "$UPD/dist" --version 2.0.0 >/dev/null
UPDATE_V1_BIN="$UPD/v1/excalibash-agent-$(echo "$HOST_PLATFORM" | tr / -)"
PORT=${PORT:-6797}
PROXY_PORT=${PROXY_PORT:-6799}
# Historique des tableaux : HISTORY_INTERVAL_MIN=0 = une version à chaque enregistrement (pas de délai minimum),
# HISTORY_KEEP=3 pour tester la rétention.
AGENT_DIST_DIR="$UPD/dist" UPDATE_INTERVAL_MS=1500 HISTORY_INTERVAL_MIN=0 HISTORY_KEEP=3 TLS=off SMTP_TRANSPORT=log DATA_DIR="$DATA" PORT=$PORT PROXY_PORT=$PROXY_PORT node --disable-warning=ExperimentalWarning server/src/index.ts >"$DATA/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true; rm -rf "$DATA"' EXIT
sleep 1.5
UPDATE_V1_BIN="$UPDATE_V1_BIN" UPDATE_SIGN="$UPD/excalibash-sign" UPDATE_KEY="$UPD/release.key" UPDATE_DIST="$UPD/dist" BASE="http://127.0.0.1:$PORT" PROXY="http://127.0.0.1:$PROXY_PORT" DB="$DATA/excalibash.db" npx --yes tsx@4 tests/e2e.mts
kill $SERVER 2>/dev/null || true

# Tunnels web par sous-domaine (TUNNEL_DOMAIN) : serveur jetable à part, requêtes telles que les enverrait un reverse proxy
# (X-Tunnel-Host, X-Tunnel-Auth), agent réel. Une minute d'attente pour l'expiration d'un ticket et la revérification des accès.
TDATA=$(mktemp -d)
TPORT=${TUNNEL_HOST_PORT:-6795}
TPROXY_PORT=${TUNNEL_HOST_PROXY_PORT:-6796}
TUNNEL_SECRET=$(head -c 36 /dev/urandom | od -An -tx1 | tr -d ' \n')
TUNNEL_DOMAIN=tunnel.localhost TUNNEL_SCHEME=http TUNNEL_PROXY_SECRET="$TUNNEL_SECRET" PUBLIC_URL="http://127.0.0.1:$TPORT" TLS=off SMTP_TRANSPORT=log DATA_DIR="$TDATA" PORT=$TPORT PROXY_PORT=$TPROXY_PORT node --disable-warning=ExperimentalWarning server/src/index.ts >"$TDATA/server.log" 2>&1 &
TSERVER=$!
trap 'kill $SERVER $TSERVER 2>/dev/null || true; rm -rf "$DATA" "$TDATA"' EXIT
sleep 1.5
status=0
TUNNEL_SECRET="$TUNNEL_SECRET" BASE="http://127.0.0.1:$TPORT" PROXY="http://127.0.0.1:$TPROXY_PORT" DB="$TDATA/excalibash.db" npx --yes tsx@4 tests/tunnel-host.mts || status=$?
kill $TSERVER 2>/dev/null || true
[ "$status" -eq 0 ] || exit "$status"

# Navigateur réel (Chrome piloté par Playwright) : serveur neuf (premier compte créé par l'interface), même agent.
# Chrome : CHROME_PATH, sinon google-chrome / chromium du PATH. Absent : ignoré en local, échec en CI (variable CI).
CHROME_PATH=${CHROME_PATH:-$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true)}
if [ -n "$CHROME_PATH" ]; then
  BDATA=$(mktemp -d)
  BPORT=${BROWSER_PORT:-$((PORT + 1))}
  BPROXY_PORT=${BROWSER_PROXY_PORT:-$((PROXY_PORT + 1))}
  UPDATE_INTERVAL_MS=1000 HISTORY_INTERVAL_MIN=0 HISTORY_KEEP=3 TLS=off SMTP_TRANSPORT=log DATA_DIR="$BDATA" PORT=$BPORT PROXY_PORT=$BPROXY_PORT node --disable-warning=ExperimentalWarning server/src/index.ts >"$BDATA/server.log" 2>&1 &
  BSERVER=$!
  trap 'kill $SERVER $BSERVER 2>/dev/null || true; rm -rf "$DATA" "$TDATA" "$BDATA"' EXIT
  sleep 1.5
  # Captures d'écran en cas d'échec : $BDATA/shots (copiées dans $SHOTS_DIR si défini, pour les artefacts de CI).
  status=0
  CHROME_PATH="$CHROME_PATH" BASE="http://127.0.0.1:$BPORT" DB="$BDATA/excalibash.db" npx --yes tsx@4 tests/browser.mts || status=$?
  if [ "$status" -ne 0 ] && [ -n "${SHOTS_DIR:-}" ] && [ -d "$BDATA/shots" ]; then mkdir -p "$SHOTS_DIR" && cp "$BDATA"/shots/* "$SHOTS_DIR"/; fi
  kill $BSERVER 2>/dev/null || true
  [ "$status" -eq 0 ] || exit "$status"
elif [ -n "${CI:-}" ]; then
  echo "Chrome introuvable : la suite navigateur est obligatoire en CI" >&2
  exit 1
else
  echo "⚠ Chrome introuvable (CHROME_PATH) : suite navigateur ignorée"
fi

# Export de topologie, génération de config, vérification du schéma, protocole du noyau, fenêtres de code et notebooks (fonctions pures, sans serveur).
node --disable-warning=ExperimentalWarning --experimental-strip-types server/src/lockout.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/agentCaps.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/agentUpdate.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/board/topology.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/board/captureManager.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/board/configGen.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/board/schemaCheck.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/board/kernelProtocol.test.ts
node --disable-warning=ExperimentalWarning --experimental-strip-types web/src/board/code.test.ts
node --disable-warning=ExperimentalWarning --experimental-transform-types web/src/board/notebook.test.ts
TLS_PORT=${TLS_PORT:-6791} TLS_PROXY_PORT=${TLS_PROXY_PORT:-6792} node --disable-warning=ExperimentalWarning tests/tls.mts
