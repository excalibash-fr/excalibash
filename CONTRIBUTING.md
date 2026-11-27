# Contribuer à Excalibash

Les contributions sont les bienvenues : corrections, nouvelles fonctionnalités, documentation, traductions.

## Signaler un bug ou proposer une idée

Ouvrir une [issue](https://github.com/excalibash-fr/excalibash/issues/new/choose) avec le modèle adapté. Pour un bug, indiquer la version (commit ou image Docker), le navigateur, et les étapes pour le reproduire.

Une faille de sécurité ne se signale pas dans une issue publique, mais par une [alerte de sécurité privée](https://github.com/excalibash-fr/excalibash/security/advisories/new).

## Préparer l'environnement

Prérequis : Node 24+ et Go 1.24+.

```bash
make -C agent dist
(cd server && npm ci)
(cd web && npm ci && npm run build)
PORT=6767 DATA_DIR=./data-dev node server/src/index.ts
```

Le code d'installation du premier compte s'affiche dans la console au démarrage. `npm run dev` dans `web/` lance Vite avec rechargement à chaud (port 5173, proxifié vers 6767).

## Avant d'ouvrir une pull request

Les pull requests visent la branche **`experimental`**, jamais `master` : une pull request ouverte vers `master` est redirigée automatiquement. Les changements y sont testés avant d'être fusionnés dans `master`, qui reste la version stable.

Les mêmes vérifications tournent automatiquement sur chaque pull request :

```bash
(cd agent && go vet ./... && go test ./...)
(cd server && npx tsc --noEmit -p .)
(cd web && npx tsc --noEmit -p . && npm run build)
./tests/run.sh
```

`./tests/run.sh` lance un serveur jetable, un agent réel et deux utilisateurs : partage, terminaux chiffrés, tunnels web, droits de l'admin et rotation des clés. Il doit se terminer par `TOUT EST OK`. Il lance aussi `tests/tunnel-host.mts` (tunnels web en mode sous-domaine, avec un second serveur jetable ; compter une minute d'attente) et `tests/tls.mts`.

Il enchaîne ensuite `tests/browser.mts` : l'application construite (`web/dist`) est pilotée dans un vrai Chrome (Playwright, `playwright-core` sans téléchargement de navigateur) contre un second serveur jetable et l'agent réel. Il couvre l'inscription, le tableau de bord, l'appairage d'une machine, un terminal, une fenêtre de code et un notebook à deux navigateurs, la diffusion de saisie, l'historique et le lien public ; toute erreur console ou exception de page fait échouer le test. Chrome est cherché dans `CHROME_PATH` puis dans le `PATH` (ignoré en local s'il manque, obligatoire en CI) ; le notebook demande `ipykernel` et `jupyter_client`. Les captures d'écran d'un échec sont écrites dans le dossier `shots` affiché.

## Règles du projet

- **Le serveur ne doit jamais voir de clair.** Tout contenu (noms, dessins, terminaux, sites des tunnels) est chiffré dans le navigateur ou dans l'agent. Une modification qui ferait passer des données lisibles par le serveur ne sera pas acceptée. Le modèle est décrit dans [docs/SECURITY.md](docs/SECURITY.md) ; un changement de protocole doit y être reflété.
- **Pas de ressource externe.** Aucun script, police ou style chargé depuis un CDN : la CSP l'interdit.
- **Une pull request, un sujet.** Les messages de commit sont en français, courts, à l'infinitif ou au présent (« Corrige… », « Ajoute… »).
- **Style.** Suivre le code existant : TypeScript strict, `gofmt` pour l'agent, commentaires utiles et rares.

## Licence

En contribuant, vous acceptez que votre contribution soit distribuée sous la licence du projet, la [GNU AGPL-3.0](LICENSE).
