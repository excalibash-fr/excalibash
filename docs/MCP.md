# Client MCP

Un petit programme Node (`excalibash-mcp.mjs`, un seul fichier, aucune dépendance, Node 22 ou plus) qui
expose tes tableaux et tes terminaux à n'importe quel client MCP (Model Context Protocol). Aucun modèle
n'est embarqué : c'est le client MCP que tu choisis qui parle à son modèle.

Il se comporte comme le navigateur : il se connecte avec ton compte, **déchiffre sur ta machine** et parle
au serveur avec le même protocole chiffré. Le serveur voit une session de plus, rien de plus (voir
[SECURITY.md](SECURITY.md#client-mcp)).

## Modèle de menace

- **Déchiffrement local.** Le mot de passe, la clé privée et le contenu en clair ne quittent jamais ta
  machine, sauf ce que les outils renvoient au client MCP, donc à son modèle. Ne branche que des clients
  et des modèles auxquels tu fais confiance pour ces données.
- **Fichier de clé sur disque.** `~/.config/excalibash/mcp.json` (dossier 0700, fichier 0600) contient
  l'adresse, le cookie de session et la clé privée du compte. C'est l'équivalent du trousseau du navigateur
  ou de `agent.json` pour l'agent. Le programme refuse de démarrer si le fichier est lisible par le groupe
  ou les autres, comme ssh. Qui lit ce fichier a accès à tes tableaux : protège-le comme une clé SSH.
- **Session révocable.** C'est une session normale : `logout`, un changement de mot de passe ou la
  suppression du compte la coupent.
- **Lecture seule par défaut.** Deux options à activer explicitement :
  - `--autoriser-saisie` : outil `ecrire_terminal` (taper dans un terminal, avec les droits de son utilisateur sur la machine) ;
  - `--autoriser-edition` : outil `ajouter_note` (ajouter un texte sur un tableau).
- **Journal d'audit.** Chaque saisie et chaque note est ajoutée à `~/.config/excalibash/mcp-audit.log`
  (0600) et à stderr : date, tableau, terminal, longueur. **Jamais le texte tapé**, qui peut contenir un secret.
- **Sorties non fiables.** Ce qu'affiche un terminal et ce qu'écrit un tableau peuvent contenir des
  instructions destinées à tromper un modèle (injection de prompt). Les sorties de terminal sont précédées
  d'un avertissement, mais la parade réelle est de garder `--autoriser-saisie` éteint, ou de valider chaque
  appel à `ecrire_terminal` dans ton client MCP.
- **Restriction par tableau.** `--tableaux <id,id>` limite tous les outils à ces tableaux (et retire
  `lister_machines`, qui n'est lié à aucun tableau).
- **Limites de débit.** 4 saisies par seconde au plus, 4096 caractères par saisie.
- Les rôles du compte s'appliquent : un lecteur ne peut ni taper ni modifier (le serveur refuse aussi).

## Installation

```sh
curl -fsSL https://<instance>/downloads/excalibash-mcp.mjs -o excalibash-mcp.mjs
node excalibash-mcp.mjs login
```

`login` demande l'adresse de l'instance, l'email et le mot de passe (saisi sans écho). Pour un script ou
une CI : `EXCALIBASH_URL`, `EXCALIBASH_EMAIL` et `EXCALIBASH_PASSWORD`. Si l'email n'est pas encore vérifié,
termine la vérification dans le navigateur puis relance `login`. Si le compte a la double authentification,
`login` demande aussi « Code à deux facteurs » (un code de l'application ou un code de secours) ; en mode non
interactif, donne-le dans `EXCALIBASH_TOTP`. Un code ne sert qu'une fois : il faut en attendre un nouveau pour chaque connexion.

**Instance au certificat auto-signé** : télécharge `https://<instance>/certificate.pem`, vérifie son
empreinte comme pour le navigateur, puis lance les commandes avec `NODE_EXTRA_CA_CERTS=/chemin/certificate.pem`.
La vérification TLS n'est jamais désactivée.

Autres commandes : `node excalibash-mcp.mjs statut` (état de la connexion) et `node excalibash-mcp.mjs logout`
(ferme la session sur le serveur et supprime le fichier). `--config <chemin>` choisit un autre fichier.

## Configuration du client MCP

Le programme parle MCP sur stdin/stdout (`serve`, commande par défaut). Dans la configuration de ton client :

```json
{
  "mcpServers": {
    "excalibash": {
      "command": "node",
      "args": ["/chemin/vers/excalibash-mcp.mjs", "serve"]
    }
  }
}
```

Options à ajouter à `args` selon le besoin : `"--tableaux", "id1,id2"`, `"--autoriser-saisie"`,
`"--autoriser-edition"`, `"--config", "/chemin/mcp.json"`.

## Outils

| Outil | Rôle |
|---|---|
| `lister_tableaux` | Identifiant, nom, chemin et rôle des tableaux (corbeille exclue) |
| `lire_tableau` | Résumé : textes, machines et leurs terminaux, câbles avec interface, IP et VLAN |
| `lister_terminaux` | Terminaux d'un tableau : identifiant, titre, type (shell, ssh, telnet, raw), statut |
| `lire_terminal` | Dernières lignes d'un terminal (200 par défaut, 2000 au plus), échappements retirés |
| `lister_machines` | Machines du compte : nom, en ligne, système, dernière connexion |
| `ecrire_terminal` | Saisie dans un terminal et sortie reçue ensuite. Seulement avec `--autoriser-saisie` |
| `ajouter_note` | Ajoute un texte sur un tableau. Seulement avec `--autoriser-edition` |

Un tableau se désigne par son identifiant ou son nom exact ; un nom ambigu renvoie la liste des candidats.
Les connexions aux tableaux sont ouvertes à la demande et fermées après 10 minutes d'inactivité.
