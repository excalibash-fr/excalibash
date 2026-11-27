# Excalibash — modèle de sécurité (chiffrement de bout en bout)

Objectif : **le serveur, l'hébergeur et les administrateurs ne peuvent ni lire ni modifier
silencieusement** les tableaux, noms, aperçus, images, curseurs et terminaux. Ils ne peuvent
pas non plus se faire passer pour un utilisateur afin d'obtenir ses données.

## Ce que le serveur voit (métadonnées)

Emails et noms d'affichage, la forme de l'arbre (qui est parent de qui, qui a accès à quoi),
les dates (dont la dernière activité de chaque compte), les liens publics d'un tableau (créateur, dates, expiration), pour chaque session ouverte la date de dernière
utilisation, un libellé approximatif du navigateur et du système (« Firefox · Linux », 40 caractères au plus,
déduit de l'User-Agent qui n'est jamais conservé tel quel) et un préfixe d'adresse IP (IPv4 en /24 « 192.168.1.x »,
IPv6 en /48), les tailles, le nombre d'éléments, les ids
et versions des éléments (dont l'empreinte SHA-1 de chaque image), qui est connecté, les dimensions et le rythme d'activité des terminaux, et pour chaque machine ce que l'agent annonce de lui-même (nom d'hôte, système, architecture, **version et liste des fonctions** qu'il connaît : `files`, `capture`…). Cette dernière liste est aussi donnée aux membres d'un tableau, dans l'état de chaque terminal, pour qu'ils sachent quoi proposer ; rien d'autre sur la machine. **Il ne voit jamais** : les noms de
dossiers et de tableaux, les dessins, les images, les aperçus, les positions de curseur, ni ce qui
est tapé ou affiché dans les terminaux.

Limite propre à toute application web chiffrée de bout en bout : le serveur fournit le JavaScript. Un hébergeur malveillant
qui modifie le code servi peut tout compromettre. On réduit la surface (CSP stricte, aucune
dépendance chargée d'un CDN), mais seul un code auditable et un hébergeur de confiance
règlent ce point.

## Primitives (WebCrypto côté navigateur, stdlib côté Go)

Encodage binaire → texte : **base64url sans padding** partout.
AAD = chaîne UTF-8 qui lie chaque chiffré à son emplacement : le serveur ne peut pas déplacer
un chiffré d'un objet à un autre.

| Nom | Format |
|---|---|
| `box(K, pt, aad)` | `0x01 ‖ iv(12) ‖ AES-256-GCM(K, iv, pt, aad)` — iv aléatoire |
| `seal(pub, pt, aad)` | `0x02 ‖ ephPub(32) ‖ iv(12) ‖ AES-256-GCM(k, iv, pt, aad)` où `k = HKDF-SHA256(ikm = X25519(ephPriv, pub), salt = ephPub ‖ pub, info = "excalibash/seal/v1", 32)` |
| Clé symétrique | 32 octets aléatoires |
| Clé asymétrique | X25519, publique = 32 octets bruts |
| Empreinte | `SHA-256(pub)`, 20 premiers octets en hex majuscule par groupes de 4 : `AB12 CD34 …` |

## Comptes

- Dérivation : `Argon2id(password, salt 16 o, m = 64 Mio, t = 3, p = 1) → 32 o`, puis HKDF :
  `authKey` (`info = "excalibash/auth"`) et `masterKey` (`info = "excalibash/master"`).
- Le serveur ne reçoit que `authKey` et en stocke `scrypt(authKey)`. Il ne voit jamais le mot de passe.
  Argon2id côté serveur serait redondant : le client dérive déjà le mot de passe avec Argon2id, et ce que le serveur
  hache est une clé de 256 bits, qu'on ne peut pas deviner. Le scrypt n'est là que pour qu'une base volée ne serve pas telle quelle.
- À l'inscription, le navigateur génère l'id utilisateur, la paire X25519 et une **clé de
  récupération** (32 o, affichée en base32 par groupes). Le serveur stocke :
  - `encPrivateKey = box(masterKey, pkcs8, "eb:priv:<userId>")` ;
  - `recoveryEncPrivateKey = box(HKDF(recovery, "excalibash/recovery-enc"), pkcs8, "eb:priv:<userId>")` ;
  - `recoveryAuthHash = scrypt(HKDF(recovery, "excalibash/recovery-auth"))`.
- `vaultKey = HKDF(X25519(priv, pub), info = "excalibash/vault")` : clé que seul le titulaire
  de la clé privée peut calculer. Elle sert à protéger l'intégrité de ses données à lui
  (clés publiques épinglées de ses machines et de ses contacts).
- `prelogin` renvoie un sel factice déterministe pour un email inconnu (pas d'énumération).
- La clé privée déchiffrée est importée **non extractible** et gardée dans IndexedDB jusqu'à la
  déconnexion. Sa clé publique est **recalculée localement** : celle que fournit le serveur doit
  correspondre, sinon on refuse la connexion. Une clé publique substituée amènerait sinon le client
  à sceller ses propres clés pour quelqu'un d'autre.
- **Premier compte** : il devient administrateur. Pour qu'un inconnu ne le crée pas avant le
  propriétaire d'une instance neuve, il exige un code d'installation affiché dans les logs du
  serveur au démarrage (ou fixé par `SETUP_CODE`).
- **Admin** : il peut inviter, ouvrir ou fermer les inscriptions, suspendre ou supprimer un compte,
  nommer d'autres admins, et voir les métadonnées ci-dessus (stockage, machines, dernière
  activité). Il **ne peut pas** changer le mot de passe d'un autre, se connecter à sa place,
  ni s'ajouter à un partage. L'API ne le permet pas, et même en trafiquant la base il n'obtiendrait
  que des chiffrés.
- **Force brute** (en plus des limites par minute) : les échecs sont comptés par compte et par adresse (`req.ip`), pour la
  connexion et la vérification du code email (« login »), la récupération par clé (« recover »), le changement de mot de passe
  et la suppression du compte (« reauth »), l'appairage d'une machine (« pair ») et le code d'installation. Le compte est
  verrouillé 15 minutes après 10 échecs en 15 minutes, et une adresse après 30 échecs (tous comptes confondus, par fonction).
  Dès le 4e échec sur un compte, la réponse est retardée (250 ms, doublés à chaque échec, 4 s au plus). Pendant un verrou,
  le serveur ne vérifie rien : un 429 « Trop de tentatives, réessaie plus tard » identique, que le compte existe ou non et que le
  mot de passe soit juste ou non. Un succès remet à zéro le compteur du compte, mais pas celui de l'adresse ni un verrou en cours.
  Journal (`excalibash-security`, sans email ni secret ; `account` est l'identifiant du compte, ou `unknown`) :
  `event=auth_failed scope=<…> ip=<ip> account=<id|unknown>`, `event=account_locked scope=<…> account=<id|unknown> ip=<ip> minutes=15`
  et `event=ip_locked scope=<…> ip=<ip> minutes=15`. Limites : les compteurs sont en mémoire (un redémarrage les efface) et un
  tiers qui connaît un email peut verrouiller ce compte 15 minutes : compromis assumé, qu'une authentification à deux facteurs ne
  change pas.
- Mot de passe perdu : la clé de récupération permet d'en redéfinir un. Sans elle, les données sont perdues.
- Déconnexion, changement de mot de passe, récupération ou suppression du compte : les sessions
  concernées sont supprimées et les connexions temps réel ouvertes sont coupées.
- **Sessions actives** (« Mon compte → Appareils connectés ») : chaque session stocke sa date de création, sa
  dernière utilisation (écrite au plus une fois toutes les 5 minutes), un libellé approximatif navigateur / système
  et un préfixe d'IP grossier. Ni l'User-Agent brut ni l'adresse IP complète ne sont enregistrés (celle-ci figure
  seulement dans l'email de nouvelle connexion, si tu l'actives). Chaque session a un identifiant public aléatoire,
  distinct du hachage du jeton. Le titulaire peut déconnecter un appareil ou tous les autres : la session est supprimée
  et ses connexions temps réel sont coupées aussitôt. Personne d'autre, administrateurs compris, ne peut lister ni
  révoquer les sessions d'un compte par l'API.
- **Inscription** : quand un serveur SMTP est configuré, l'email est vérifié par un code à 6 chiffres
  (stocké haché, 5 essais, 15 min). Une preuve de travail calculée par le navigateur, un champ piège
  et un plafond horaire limitent les inscriptions automatiques. Ces mesures protègent le serveur,
  pas les données : elles n'ont aucun rôle dans le chiffrement.
- **Notifications par email** : seuls les partages sont annoncés par défaut, chacun choisit lesquelles recevoir. Les noms des
  tableaux et dossiers étant chiffrés, un email dit seulement le type d'élément (« un tableau »), le nom
  affiché de la personne à l'origine et, pour une connexion, la date et l'adresse IP.

## Arbre de dossiers et partages

Chaque dossier et chaque tableau a sa propre clé `K` et un `id` généré par le client.

- `encName = box(K_item, nom, "eb:name:<id>")`
- Enfant d'un dossier : `keyWrap = box(K_parent, K_item, "eb:wrap:<id>:<parentId>")`
- Élément à la racine ou partagé : une **grant** `wrappedKey = seal(pub_user, K_item, "eb:grant:<id>:<userId>")`,
  avec un rôle `owner | editor | viewer`. Le propriétaire a une grant `owner` sur chacun de ses éléments racine.
- Accès à un élément = une grant sur lui ou sur un ancêtre. On déroule la chaîne de `keyWrap`
  vers le bas : **les sous-dossiers d'un dossier partagé sont donc partagés aussi**. Le rôle effectif
  est le plus fort trouvé sur le chemin.
- Seul le propriétaire (`owner_id`) partage ou révoque. On ne peut déplacer un élément qu'entre
  éléments du même propriétaire ; le client re-wrappe alors la clé sous celle du nouveau parent.
- **Révocation = rotation** : le navigateur du propriétaire génère de nouvelles clés pour tout le
  sous-arbre, re-chiffre noms, wraps, éléments, fichiers, aperçus et clés de terminaux, puis
  ré-émet les grants des membres restants. Le serveur applique le tout en une transaction et
  incrémente `key_epoch`. Les écritures portant un ancien epoch sont refusées.
  - Les terminaux qui tournent sur les machines du propriétaire reçoivent une nouvelle clé (`rekey`).
  - Les autres terminaux du sous-arbre sont fermés : le propriétaire ne peut pas authentifier la
    clé d'une machine qui ne lui appartient pas.
- Épinglage (TOFU) : la clé publique de chaque destinataire est épinglée dans le coffre de
  l'utilisateur (`box(vaultKey, …)`), **par id de compte et par email**. On détecte ainsi un compte
  supprimé puis recréé avec la même adresse.
  - Une clé qui ne correspond plus à l'épingle est refusée, sauf vérification explicite de l'empreinte.
  - Lors d'une rotation, les nouvelles clés ne vont **qu'aux membres épinglés** : un membre ou une
    clé glissés par le serveur font échouer la rotation au lieu de recevoir les clés.
  - Une personne trouvée **par son nom** n'a pas d'email affiché : l'épingle se fait alors par id de
    compte seul (l'email n'est ajouté que quand on le connaît).
- **Recherche de personnes** : par défaut un compte est trouvable par son nom (exact ou début du nom,
  2 caractères minimum, 8 résultats, limitée en débit) et pas par son email ; chacun peut changer
  l'un et l'autre dans « Mon compte ». La recherche renvoie nom, couleur et clé publique, jamais
  l'email d'une personne qui ne s'est pas rendue trouvable par email (sauf à ceux qui partagent déjà
  avec elle). Les noms sont donc énumérables par un compte connecté ; le serveur les connaissait déjà.
  Un email non trouvable répond comme un compte inexistant.
- **Donner un élément** (`POST /items/:id/transfer`) : le propriétaire d'un élément à sa racine peut
  le donner à quelqu'un qui y a déjà un accès direct. `owner_id` change pour tout le sous-arbre, le
  destinataire devient `owner` (sa grant, scellée pour lui, reste valable) et l'ancien propriétaire
  `editor`. Aucune clé ne change : l'ancien propriétaire garde donc ce qu'il a déjà pu lire, comme
  un membre dont l'accès serait retiré sans rotation ; le nouveau propriétaire peut faire pivoter
  les clés (en retirant l'ancien) s'il le veut. Les terminaux et tunnels restent liés aux machines
  de leurs propriétaires.

## Contenu d'un tableau (clé `K_b`)

| Donnée | AAD |
|---|---|
| Élément : `{id, v, n, c}` avec `c = box(K_b, JSON(element))` | `eb:el:<boardId>:<id>:<version>:<versionNonce>` |
| Fichier (image) | `eb:file:<boardId>:<fileId>` |
| Aperçu SVG | `eb:preview:<boardId>` |
| Curseur | `eb:ptr:<boardId>` |
| Clé de terminal pour le tableau | `eb:termkey:<boardId>:<termId>` |

`id`, `version` et `versionNonce` restent en clair : c'est ce qui permet au serveur de fusionner
les modifications concurrentes (règle Excalidraw) sans rien lire du contenu.

## Historique des tableaux

Le serveur garde des versions passées d'un tableau **sans jamais rien déchiffrer** : il copie les
chiffrés d'éléments qu'il détient déjà (`{id, v, n, c}`), tels quels.

- Stockage par tableau, adressé par le contenu : `board_entries(board_id, hash, data)` avec
  `hash = SHA-256(chiffré sérialisé)`, et `board_versions` qui liste les empreintes dans l'ordre de la
  scène. Un élément inchangé n'est stocké qu'une fois, quel que soit le nombre de versions.
- Une version au plus toutes les `HISTORY_INTERVAL_MIN` minutes, à l'enregistrement du tableau, et une à
  la fin de la session (départ du dernier client), seulement si la scène a changé. Rétention : les
  `HISTORY_KEEP` dernières, la dernière de chacun des `HISTORY_DAYS` derniers jours, puis les plus
  anciennes sautent au-delà de `HISTORY_MAX_MB` ; les chiffrés plus référencés sont supprimés.
  `HISTORY_KEEP=0` désactive tout.
- Lecture : `GET /api/items/:id/versions` et `/versions/:vid`, réservées à qui peut lire le tableau (un
  lecteur peut consulter). Le déchiffrement, l'aperçu et la restauration se font dans le navigateur. Restaurer
  est une modification de scène comme une autre : seuls les éditeurs peuvent l'écrire, le serveur le refuse
  sinon.
- Ce que cela révèle au serveur : les dates des versions, le nombre et la taille des éléments, ce qui a
  changé d'une version à l'autre (ids et versions déjà visibles). Rien du contenu.
- **Rotation des clés** : les versions sont chiffrées avec l'ancienne clé, que le serveur ne peut pas
  remplacer. Elles sont donc **supprimées** avec la rotation (compromis : une personne révoquée ne peut plus rien lire
  d'ancien, mais l'historique repart de zéro). La suppression définitive du tableau supprime aussi son historique.
- Images : elles ne sont pas copiées. Une version renvoie les fichiers actuels du tableau ; une image retirée du
  stockage de fichiers peut donc manquer dans une version ancienne.
- La restauration laisse intacts les terminaux et sites (fenêtres) et les liens des machines, pour ne jamais
  couper un shell en cours.

## Documents partagés (code et notebooks)

Un document partagé est un document Yjs (CRDT) identifié par un `docId` de 128 bits tiré au hasard par le navigateur, rattaché
à **un** tableau. Le serveur ne comprend rien à son contenu : il ordonne, stocke et relaie des chiffrés.

| Donnée | AAD |
|---|---|
| Mise à jour ou instantané Yjs : `box(K_b, octets)` | `eb:doc:<boardId>:<docId>:<epoch>` |
| Présence (curseurs, noms, sélections) : `box(K_b, octets)` | `eb:doc-aw:<boardId>:<docId>:<epoch>` |

- Sur la socket du tableau : `doc.sub` (tout membre, lecteurs compris) → `doc.state {snap?, ups}` puis la socket reste abonnée ;
  `doc.up` (éditeurs) est numéroté (`seq` strictement croissant par document), relayé aux autres abonnés et acquitté
  (`doc.ack`) ; `doc.aw` (tout membre) est relayé sans être stocké, au plus 10 messages par seconde et par socket ;
  `doc.snap` (éditeurs) est une compaction faite par le navigateur : l'instantané remplace l'ancien et toutes les mises à
  jour jusqu'à `upto`, en une transaction. Le serveur demande la compaction (`doc.compact`) à un éditeur quand un document
  dépasse 200 mises à jour ou 1 Mio de mises à jour.
- Plafonds : une trame de mise à jour 512 Kio, la présence 32 Kio, un instantané 4 Mio, un document 8 Mio
  (instantané compris, au-delà `doc.up` est refusé), 64 documents par tableau, 64 documents ouverts par socket.
  Les identifiants sont validés strictement (22 caractères base64url).
- **Ce que le serveur voit** : le nombre de documents d'un tableau, la taille et la date de chaque mise à jour, leur rythme
  et le nombre de mises à jour en attente de compaction, qui est abonné. **Il ne voit jamais** le texte, le code, les
  cellules, les curseurs ni les noms affichés dans la présence.
- **Lecteurs** : ils reçoivent l'état et la présence, mais le serveur refuse leurs `doc.up` et `doc.snap`
  (« Lecture seule ») sans rien changer au document stocké. Comme pour les terminaux, ils ont la clé : c'est une
  restriction d'accès, pas une garantie cryptographique.
- **Intégrité** : un chiffré déplacé vers un autre document, un autre tableau ou une autre génération de clés
  ne s'authentifie pas (AAD). Une mise à jour qui échoue à l'authentification est ignorée par le navigateur, qui renonce
  alors à compacter ce document plutôt que d'effacer ce qu'il n'a pas pu lire. Le serveur peut en revanche **retenir,
  retarder ou supprimer** des mises à jour (déni de service) ; il ne peut pas en fabriquer. Comme pour l'historique,
  une mise à jour authentique rejouée est sans effet (Yjs est idempotent).
- **Rotation des clés** : les documents contiennent le travail des gens, ils ne sont donc **pas supprimés**. Le navigateur du
  propriétaire récupère chaque document (`GET /api/items/:id/docs`), le déchiffre avec l'ancienne clé, fusionne instantané
  et mises à jour en un seul état et le re-chiffre en instantané sous la nouvelle clé et le nouvel epoch. Le serveur remplace
  les lignes de tous les documents du tableau dans la transaction de rotation, et seulement si l'ensemble des documents et
  le dernier `seq` de chacun n'ont pas bougé depuis la lecture (sinon 409 et le navigateur recommence, aucune modification
  n'est perdue). Les abonnés sont déconnectés par le code 4409 comme pour le reste du tableau.
- La suppression définitive d'un tableau supprime ses documents.
- **Duplication d'un tableau** : le navigateur de la personne qui duplique récupère les documents du tableau source
  (`GET /api/items/:id/docs`, lecteur au moins), garde ceux que le schéma référence (icônes de code et de notebook),
  les déchiffre avec la clé du tableau source, fusionne chaque document en un état, **efface les références vivantes**
  (`meta.kernelTerm` : la session de noyau est un terminal du tableau source, dont la copie n'a pas la clé ; marques
  « en cours ») et le chiffre en instantané sous la clé du **nouveau** tableau, son identifiant et l'epoch 0. Les `docId` restent
  les mêmes (ils ne sont uniques que par tableau, le schéma copié n'a donc pas à être réécrit). Les instantanés partent dans
  le corps de la création du tableau (`POST /api/items`, champ `board.docs`) : aucune route d'écriture de plus, la création
  est atomique, et le serveur ne fait que valider les identifiants (22 caractères base64url, sans doublon), 64 documents
  au plus et 4 Mio par instantané. Le serveur ne voit que des chiffrés ; l'ancienne clé ne lit pas la copie (clé, tableau et
  epoch sont dans l'AAD). Un chiffré qui ne s'authentifie pas interrompt la copie.
- **Fenêtres de code** : le document est un `Y.Text` (contenu) et un `Y.Map` (nom, langage, chemin sur la machine, empreinte
  SHA-256 du dernier état lu ou écrit), donc chiffré comme n'importe quel document : le serveur ne voit ni le code, ni le
  nom du fichier, ni son chemin. Monaco et ses workers sont servis par l'application elle-même (fichiers du même
  domaine, sans `eval` ni `blob:` : la CSP est inchangée). Un fichier de la machine est lu et écrit par le canal de fichiers du
  shell local (voir « Fichiers et captures »), jamais par le serveur : « Enregistrer » relit d'abord le fichier de la
  machine et demande confirmation s'il a changé depuis l'ouverture. « Exécuter dans le terminal » ne tape dans un shell
  qu'une ligne affichée et confirmée, avec le chemin protégé. Les noms et couleurs de la présence, écrits par n'importe quel
  membre, sont filtrés avant d'entrer dans une feuille de style. Comme pour tous les documents, les lecteurs ont la clé
  du tableau : lecture seule côté client et refus par le serveur des écritures, pas une garantie cryptographique.
- **Nom affiché** : l'entrée d'une fenêtre de code ou de notebook dans la liste de son icône peut porter un `label`
  (le nom de base du fichier, jamais le chemin ; 80 caractères au plus, sans caractère de contrôle ni `/`), pour que le
  dock affiche « demo.py » au lieu de « Code 1 ». Il vit dans le tableau, donc chiffré avec lui ; chaque lecture le
  revalide et l'écarte s'il est invalide.
- **Migration de l'ordre des cellules** : un ancien notebook (sans `order`) se lit tel quel, dans l'ordre de stockage ; la
  première modification de structure par un éditeur (insérer, déplacer, supprimer) écrit l'ordre. L'opération est idempotente
  et sans copie de cellule ; deux éditeurs qui la font en même temps laissent des identifiants répétés, ignorés à la
  lecture et supprimés ensuite par les éditeurs. L'export `.ipynb` est identique.
- **Suppression définitive** : quand une fenêtre de code ou de notebook est retirée pour de bon (icône supprimée, ou fenêtre
  « retirée », pas seulement masquée), l'éditeur qui l'a fait envoie `doc.del {doc}`. Le serveur applique les mêmes
  contrôles que `doc.up` (éditeur, génération de clés courante ; il n'exige pas d'être abonné puisque la fenêtre est
  déjà fermée), supprime les lignes de ce document, pour ce tableau seulement, et prévient les abonnés (`doc.gone {doc}`,
  qui cessent d'envoyer). Annuler la suppression d'une icône (Ctrl+Z) la ramène avec un document vide.
- **Notebooks** : un document de notebook est un `Y.Array` de cellules (`Y.Text` du source, sorties au format nbformat 4,
  compteur d'exécution), un `Y.Array` `order` d'identifiants (l'ordre d'affichage : déplacer une cellule ne touche
  que lui, jamais la cellule, donc une frappe simultanée n'est pas perdue) et un `Y.Map` de métadonnées (nom, chemin, empreinte, session de noyau) : le serveur ne voit ni
  le code, ni les sorties, ni les images, ni le nom du fichier. Une sortie trop grosse pour une mise à jour
  (256 Kio) est remplacée par une note, un flux est plafonné à 1 Mio et un total à 3 Mio par cellule. Le fichier `.ipynb`
  lui-même est lu et écrit par le canal de fichiers du shell local, comme pour le code (même contrôle de modification).
- **Affichage des sorties de notebook (modèle de rendu).** Les sorties sont des *données* écrites par le noyau, donc par
  n'importe quel code que n'importe quel éditeur a lancé, et par tout éditeur à travers le document partagé. Elles ne
  s'exécutent jamais dans l'origine de l'application : le texte, les flux et les tracebacks (codes ANSI convertis en
  styles par une table fixe, ou retirés) deviennent des nœuds texte (jamais `innerHTML`) ; une image PNG, JPEG ou GIF
  devient un `<img src="data:…">` après contrôle strict de l'alphabet base64 ; tout le reste (`text/html`, SVG,
  Markdown, JavaScript) ne s'affiche que dans un `<iframe sandbox="" srcdoc="…">` : aucun script, aucune origine commune,
  ni formulaire, ni fenêtre, ni navigation du haut. Le document du cadre porte en plus une CSP
  (`default-src 'none'; img-src data:`) et hérite de celle de l'application ; le JavaScript d'une sortie n'est pas exécuté,
  seulement affiché. Le Markdown des cellules est converti par `marked` (sans assainisseur : il n'en a pas besoin, son
  résultat n'entre que dans un cadre isolé). Le texte affiché est plafonné (1 Mio, « sortie tronquée »). Les widgets
  Jupyter ne sont pas pris en charge. Reste possible dans un cadre isolé : un lien ou une redirection `meta refresh` fait
  charger une adresse (comme ouvrir un lien), sans rien lire de l'application.

## Machines et terminaux

- Ajout d'une machine : **le navigateur** génère la clé privée X25519 de l'agent (32 octets). Elle
  n'apparaît que dans la commande d'installation affichée à l'utilisateur.
  - Clé d'autorisation : `machineAuth = HKDF(priv, "excalibash/machine-auth")`. Seuls le propriétaire,
    l'agent et les personnes avec qui il partage la machine la connaissent (voir « Partage de machines »).
  - Le serveur ne reçoit que des chiffrés du coffre, qu'il ne peut pas forger : la clé publique
    (`eb:machine:<id>`, pour l'empreinte), `machineAuth` (`eb:machine-auth:<id>`) et le nom.
  - Le jeton d'authentification à `/agent` est distinct et ne sert qu'à la connexion.
- **Appairage par code** (sans copier-coller) :
  - le serveur crée un rendez-vous de 10 minutes, à usage unique, avec un code de 6 caractères ;
  - l'agent **génère sa propre paire X25519 sur la machine** et dépose sa clé publique ;
  - le navigateur du propriétaire affiche l'empreinte de cette clé, que l'humain compare avec celle affichée par la machine ;
  - la machine affiche aussi un **code de confirmation** de 8 caractères (7 aléatoires, ≈ 34 bits, et une lettre de contrôle qui fait repérer une faute de frappe dans le navigateur), que l'humain recopie dans le navigateur ; il ne passe jamais par le serveur ;
  - après validation seulement, le navigateur scelle un `machineAuth` aléatoire pour cette clé, suivi d'une étiquette `HMAC-SHA256(Argon2id(confirmation, sel = agentPub), machineAuth ‖ agentPub)` (`seal(agentPub, machineAuth ‖ tag, "eb:pair:<code>")`), et l'agent l'enregistre dans `~/.config/excalibash/agent.json` (0600) ;
  - le sceau seul est anonyme : le serveur connaît la clé publique de l'agent et le code, il pourrait donc sceller un `machineAuth` de son choix. Sans le code de confirmation, son étiquette est fausse et l'agent annule l'appairage. Il n'a qu'un essai par appairage. Les deux vérifications vont ensemble : un serveur qui substituerait sa clé (empreinte non comparée) obtiendrait une étiquette, mais l'Argon2id (64 Mio, 3 passes) rend la recherche du code hors ligne impraticable dans les 10 minutes de l'appairage ;
  - un serveur qui substituerait sa propre clé ferait apparaître une empreinte différente de celle de l'écran de la machine. Deviner un code n'apporte rien d'autre que ce même risque : le dépôt de clé est limité en débit, et un code n'accepte qu'une seule machine.
- Chaque terminal a une clé `K_t` générée par le navigateur **de qui l'ouvre**, qui doit détenir `machineAuth` (le propriétaire de la machine, ou une personne à qui il l'a partagée).
  Le serveur stocke :
  - `keyForBoard = box(K_b, K_t, "eb:termkey:<boardId>:<termId>")` ;
  - `keyForAgent = box(machineAuth, K_t, "eb:term:<termId>")`. Une clé simplement scellée avec la clé
    publique de l'agent est refusée : connaître la clé publique ne suffit donc pas pour lui faire
    ouvrir un shell.
- Agent ⇄ serveur :
  - `open {id, cols, rows, key}` : `key = keyForAgent` (aussi renvoyé tel quel lors d'un redémarrage) ;
  - `rekey {id, key}` ;
  - `output {id, gen, seq, d}` avec `d = box(K_t, octets, "eb:term-out:<id>:<gen>:<seq>")`.
    `gen` (chaîne aléatoire) change à chaque lancement de PTY ou rekey ; `seq` part de 1 et croît
    strictement. Le navigateur rejette `seq ≤ dernier` pour une même `gen`. L'agent annonce chaque
    nouvelle `gen` par une trame vide authentifiée, envoyée au lancement, au rekey et à la reconnexion.
  - `input {id, s, k, ts, d}` avec `d = box(K_t, octets, "eb:term-in:<id>:<gen>:<s>:<k>:<ts>")`.
    Une frappe capturée ne peut donc pas être rejouée dans un shell relancé ou re-clé.
    `s` = id aléatoire d'un émetteur (onglet), `k` = compteur strictement croissant par émetteur,
    `ts` = horodatage en ms. L'agent rejette `|now − ts| > 5 min` et `k ≤ dernier k vu pour s`.
    Le serveur ne peut donc pas rejouer des frappes.
- Le serveur garde l'historique de sortie **chiffré** (morceaux `{gen, seq, d}`) pour le rejouer
  aux nouveaux arrivants.
- Les lecteurs (rôle viewer) reçoivent la sortie mais le serveur rejette leurs entrées.
  Ils ont la clé : c'est une restriction d'accès, pas une garantie cryptographique.
- Toute machine est un agent avec ses propres clés : le serveur n'exécute aucun shell lui-même.
- L'agent choisit seul le shell et le répertoire de départ (ceux de son compte) : le serveur ne
  peut pas lui faire lancer un autre programme.

## Sessions Telnet, SSH et TCP brut

- Une session vers un équipement (switch, routeur, PC joignable depuis la machine) est un terminal
  comme les autres : même clé de terminal, mêmes trames chiffrées, même anti-rejeu. Seule la source
  change : une connexion réseau ouverte par l'agent au lieu d'un shell local.
- La cible (`kind`, hôte, port, utilisateur, options) est scellée avec la clé du terminal sous
  `machineAuth` (AAD `eb:term:<id>`) : seuls ceux qui détiennent cette clé (propriétaire, personnes à qui la
  machine est partagée) peuvent la fixer, et le serveur ne peut ni la lire ni la remplacer. Une nouvelle clé (rotation) ne change jamais la cible.
- L'agent valide chaque champ (hôte, port, utilisateur) avant de se connecter ; tout champ invalide
  ferme la session.
- **Telnet et TCP brut** ne sont chiffrés que jusqu'à l'agent : entre la machine et l'équipement, le
  trafic circule en clair sur le réseau local, comme avec n'importe quel client Telnet.
- **SSH** : client intégré à l'agent. La clé d'hôte est épinglée à la première connexion dans
  `known_hosts`, à côté de la configuration de l'agent ; une clé différente bloque la connexion.
  La vérification peut être désactivée par session (option avancée, déconseillée). Les mots de passe
  se tapent dans le terminal : ils voyagent chiffrés jusqu'à l'agent et ne sont jamais stockés.
- **Rebonds** : la cible peut passer par une chaîne de rebonds SSH (au plus 8, comme `ssh -J`). La liste est
  scellée avec la cible, sous `machineAuth` : le serveur ne peut ni la lire ni la changer. L'agent ouvre une
  connexion SSH vers le premier rebond, puis un canal `direct-tcpip` vers le suivant à travers elle, et ainsi de
  suite ; la cible (SSH, Telnet ou TCP) est jointe depuis le dernier. Chaque rebond est authentifié dans le
  terminal (les invites indiquent l'hôte qui les pose) et sa clé d'hôte est épinglée comme pour une cible. Les
  clés sont retenues par adresse (`hôte:port`), quel que soit le chemin : une même adresse jointe par deux rebonds
  différents (deux labos) partage son épingle, et un rebond malveillant pourrait faire épingler une fausse clé
  pour une adresse encore jamais vue. La vérification de clé d'hôte ne peut pas être désactivée sur un rebond
  depuis les données du tableau. Un rebond voit l'adresse du saut suivant ; il ne
  voit pas le contenu d'une session SSH qui le traverse, mais voit en clair une session Telnet ou TCP qu'il relaie
  vers la cible.
- Un rebond proposé depuis l'icône d'un équipement vient des données du tableau (que tout éditeur peut écrire) :
  il pré-remplit le formulaire, que l'utilisateur relit et valide, comme la cible d'un équipement.
- L'option « Équipement ancien » n'ajoute des algorithmes faibles (`diffie-hellman-group1-sha1`,
  `ssh-rsa`, `ssh-dss`, CBC, `hmac-sha1`) qu'à la session qui la demande.

## Noyau Jupyter (carnets collaboratifs)

- Un troisième genre de session distante, `jupyter`, ne se connecte à aucun équipement : l'agent lance sur
  la machine un pont Python (embarqué dans le binaire, `python3 -u -I -c`) qui pilote un noyau Jupyter
  (`jupyter_client` + `ipykernel` du Python de la machine) et dialogue avec lui en lignes JSON sur
  l'entrée et la sortie standard (tubes, sans terminal). Ces lignes circulent dans le même flux
  chiffré qu'un terminal : même clé de terminal, mêmes trames, même anti-rejeu.
- **Autorité : celle d'un shell local.** Le noyau exécute du code Python arbitraire avec les droits de
  l'utilisateur de l'agent. La cible `{kind:"jupyter", cwd?, kernel?}` n'est donc acceptée que dans une clé
  de terminal scellée sous `machineAuth` (AAD `eb:term:<id>`), comme les autres cibles distantes : seuls le
  propriétaire de la machine et ceux à qui elle est partagée peuvent en créer une. Le serveur ne peut ni la
  fabriquer, ni la modifier, ni lire le code, les résultats ou les images ; une rotation de clé ne change pas la
  cible. Les données d'un tableau (que tout éditeur écrit) ne suffisent jamais à lancer un noyau.
- Validation par l'agent : `cwd` absolu ou en `~/…` (512 octets au plus, sans NUL ni saut de ligne), `kernel`
  limité à `[A-Za-z0-9._-]{1,64}` (défaut `python3`), aucun hôte, port, utilisateur ni rebond. Ces valeurs
  sont passées comme arguments (jamais interprétées par un shell).
- Tous les participants de la session partagent un seul noyau (état, variables, file d'exécution). Les
  lignes d'entrée sont limitées à 2 Mio ; une sortie unique à 8 Mio et le total d'une exécution à 32 Mio
  (le surplus est remplacé par un message). Le pont ne lance rien d'autre que ce que le noyau exécute.
- À la fermeture de la session (ou du pont), le noyau est arrêté ; il ne survit pas à son pont. Le serveur ne
  voit que la taille et le rythme des trames.
- **Notebooks : un noyau partagé, choix assumé.** Le notebook garde l'identifiant de la session de noyau dans son
  document (`meta.kernelTerm`) : tous les participants utilisent le même noyau, comme ils se partagent un shell.
  *Démarrer* un noyau exige `machineAuth` (la même condition que pour une session distante : le navigateur demande
  d'abord confirmation) ; en revanche **tout éditeur du tableau peut ensuite exécuter du code dans ce noyau**, avec
  les droits de l'agent de la machine, exactement comme un éditeur peut taper dans un shell local partagé. Les lecteurs
  reçoivent les sorties (ils ont la clé) mais le serveur refuse leurs frappes. Écrire un autre identifiant dans
  `meta.kernelTerm` ne donne rien de plus : la clé du terminal n'est donnée qu'aux membres du tableau, et le navigateur
  ne ferme que des sessions dont le libellé est celui d'un noyau. Une cellule est exécutée par un seul client, celui de la personne
  qui a cliqué (identifiant `<cellule>:<aléa>` gardé en mémoire locale) : lui seul écrit les sorties de cet identifiant dans
  le document, les autres lisent le même flux et n'écrivent rien. Si l'exécuteur disparaît en cours de route, tout
  éditeur qui voit une cellule « en cours » dont l'identifiant n'est dans la présence de personne depuis 5 s la termine
  (compteur du `done` vu, ou noyau au repos) ; les sorties produites après le départ de l'exécuteur ne sont pas conservées.
  Les clients MCP qui savent écrire dans un terminal peuvent aussi parler à ce noyau, comme à n'importe quel shell.
- **Exécuter un fichier Python (fenêtre de code).** « ▶ Exécuter » envoie le contenu **actuel** de la fenêtre (enregistré
  ou non) à un noyau Jupyter propre au fichier, dont l'identifiant de session est gardé dans le document de code
  (`meta.kernelTerm`, même modèle que le notebook : *démarrer* exige `machineAuth` et une confirmation, ensuite tout
  éditeur du tableau peut y exécuter du code, avec les droits de l'agent). Le dossier de travail est celui du fichier
  quand son chemin est absolu. Mêmes règles que les cellules : un seul exécuteur (celui qui a cliqué) écrit les sorties
  de son exécution, au format nbformat, dans le `Y.Array` `outputs` du document (tout le monde voit la dernière exécution),
  `meta.running` marque l'exécution en cours, et un exécuteur disparu est remplacé au bout de 5 s. « Exécuter dans le
  terminal » reste pour le shell et JavaScript, et en action secondaire pour Python. La session de noyau est fermée avec
  le document quand la fenêtre est retirée.
- **Complétion et documentation.** Les requêtes `complete` / `inspect` du pont sont des lignes écrites dans le même
  terminal chiffré : le navigateur les envoie à la demande (« . », Ctrl+Espace, survol, Maj+Tab), avec abandon à 3 s et
  annulation. Elles ne sont jamais envoyées pour un lecteur (le serveur refuse sa saisie) ni quand le noyau est occupé
  (elles attendraient derrière la cellule en cours). Les réponses sont des données du noyau : la documentation s'affiche
  en texte dans un bloc de code Markdown, ANSI retiré, sans HTML ni lien interprété.
- **L'exécuteur survit à la fenêtre.** L'exécution d'un notebook (abonnement au flux du noyau, écriture des sorties,
  reprise des exécuteurs disparus) appartient à un objet par tableau et par notebook, pas à la fenêtre : masquer la
  fenêtre en pleine exécution ne perd plus rien. Il est libéré quand le document est supprimé, quand le tableau est
  fermé, ou 60 s après la dernière exécution quand aucune fenêtre ne l'affiche. Rien ne change pour le serveur.

## Tunnels web

- Le navigateur de qui ouvre le tunnel (propriétaire de la machine ou personne à qui elle est partagée) génère `K_w`. Il dépose `box(machineAuth, {k: K_w, url, insecure}, "eb:web:<id>")`
  pour l'agent : la **cible est scellée avec la clé**, et le serveur ne peut ni la lire ni la changer
  (pas de redirection vers un autre port ou un autre hôte). Il dépose aussi `box(K_b, K_w, "eb:webkey:…")` pour les membres
  du tableau, et la cible chiffrée dans le libellé.
- Le site s'exécute sur une **origine séparée** (`PROXY_URL`, port 6768 par défaut). Il n'a donc aucun accès au
  stockage d'Excalibash (clés de compte). La clé du tunnel n'est remise par `postMessage` qu'à l'iframe ou à l'onglet
  ouvert par Excalibash pour ce tunnel. Elle n'apparaît jamais dans une URL.
- Un Service Worker de cette origine chiffre chaque requête : `box(K_w, {m, p, h, b}, "eb:http-req:<id>:<rid>:<ts>")`.
  L'agent rejette les horodatages à plus de 5 min et les `rid` déjà vus, déchiffre, appelle la cible et renvoie
  `box(K_w, {s, h, b}, "eb:http-res:<id>:<rid>")`. Le serveur ne relaie que des chiffrés.
- **WebSocket** : le Service Worker ne voit pas les connexions WebSocket, donc il ajoute aux pages HTML du site un script
  (`/eb-proxy/ws-shim.js`) qui remplace `WebSocket` pour les adresses du site (l'origine proxy ou la cible). Chaque socket du
  site ouvre une socket vers `/eb-proxy/ws/<id>` sur l'origine proxy, que le serveur apparie à l'agent sans la lire :
  - ouverture : `box(K_w, {p, protos, cookie}, "eb:ws-open:<id>:<sid>:<ts>")`, avec les mêmes contrôles que pour une requête
    (horodatage à moins de 5 min, `sid` jamais vu). L'agent ouvre la socket vers la **cible scellée** ; l'`Origin` est celle de
    la cible et l'en-tête Host du navigateur est ignoré. La réponse est `box(K_w, {ok, proto}, "eb:ws-ack:<id>:<sid>")` ;
  - messages : `box(K_w, type ‖ données, "eb:ws-msg:<id>:<sid>:<c2a|a2c>:<n>")`, avec un compteur par sens. Le serveur ne peut
    ni rejouer, ni réordonner, ni supprimer, ni injecter un message : le premier écart ferme la socket ;
  - fermeture : scellée aussi (`eb:ws-close:…`, avec le dernier compteur) et porte le code du site. Une fermeture sans
    authentification (serveur, réseau, erreur d'intégrité) apparaît comme une fermeture anormale (1006) ;
  - limites : 32 sockets par tunnel côté agent, 256 au total, 64 par tunnel côté serveur, messages de 16 Mo au plus. Fermer,
    renouveler la clé d'un tunnel ou perdre la machine coupe ses sockets ;
  - le serveur voit les tailles et les moments des messages, pas leur contenu ni la cible. Les sockets vers d'autres hôtes
    que le site ne passent pas par le tunnel. Une page dont la CSP interdit le script du shim garde les WebSocket natives, qui
    échouent. Les WebSocket ouvertes depuis un Worker ne sont pas prises en charge.
- Options avancées, scellées avec la cible : `hostHeader` (en-tête Host et nom SNI envoyés à la cible, pour les
  hôtes virtuels) et `legacyTls` (TLS 1.0/1.1 et suites anciennes, pour les interfaces web de vieux équipements).
  L'en-tête Host envoyé par le navigateur est toujours ignoré.
- Le Service Worker tient un jar de cookies par tunnel. Les en-têtes `Set-Cookie` ne deviennent jamais de vrais cookies du navigateur.
- Seul Excalibash peut intégrer un site tunnelisé en iframe (`frame-ancestors`). L'iframe ne peut pas faire naviguer
  l'onglet Excalibash, et l'onglet plein écran perd `window.opener`.
- La révocation renouvelle aussi les clés des tunnels qui passent par les machines du propriétaire.
- Limites actuelles :
  - pas de streaming dans le site tunnelisé (les réponses HTTP font au plus 48 Mo, d'où pas de SSE ; les WebSocket, elles, passent) ;
  - les sites ouverts partagent l'origine proxy entre eux, mais pas avec Excalibash (voir les
    risques résiduels) ;
  - en mode chemin, l'origine proxy n'a pas de session : une requête vers un tunnel inconnu est refusée avant que
    son corps soit lu (le mode sous-domaine ci-dessous ajoute un secret, une session et des réponses uniformes) ;
  - en local, `localhost:6767` et `localhost:6768` partagent leurs cookies (les cookies ne dépendent pas du port), et
    sont « same-site ». Le cookie de session est `HttpOnly` et `SameSite=Strict` ; en HTTPS il s'appelle
    `__Host-eb_session`, que le navigateur n'accepte que `Secure`, pour cet hôte exact : une page de l'origine proxy ne
    peut ni le poser (pour connecter quelqu'un à un autre compte) ni l'écraser. L'API refuse toute modification dont
    l'en-tête `Sec-Fetch-Site` n'est pas `same-origin`, et exige du JSON. En production, un nom d'hôte distinct reste
    préférable.

## État des câbles (ping)

- Une IP saisie au bout d'un câble est testée depuis la machine à l'autre bout, seulement si l'utilisateur
  qui regarde le tableau peut utiliser cette machine (la sienne, ou une machine partagée avec lui, voir « Partage de machines »). Son navigateur dépose
  `box(machineAuth, {targets}, "eb:probe:<rid>:<ts>")` via `POST /api/machines/<id>/probe`. Le serveur vérifie
  que l'utilisateur a accès à la machine, limite à une sonde en cours et une toutes les 2 s par machine, et relaie
  le chiffré à l'agent.
- L'agent rejette les horodatages à plus de 5 min, les `rid` déjà vus et tout ce qui n'est pas scellé sous
  `machineAuth`. Il ne teste que de vraies adresses IP (au plus 32), une à une, avec le `ping` du système, l'adresse
  étant passée comme simple argument (jamais via un shell). Il répond `box(machineAuth, {r}, "eb:probe-res:<rid>")`.
- Le serveur ne voit ni les adresses ni les résultats, et ne peut pas faire sonder quoi que ce soit : il ne
  détient pas `machineAuth`. Les résultats restent dans le navigateur de qui a demandé la sonde et ne sont pas
  partagés avec les autres membres du tableau.
- **« Vérifier le schéma »** : la même requête de sonde peut porter `kind: "ifaces"` (absent = ping, comme avant). L'agent
  répond alors `box(machineAuth, {ifaces}, "eb:probe-res:<rid>")` avec, pour chaque interface (au plus 256, 64 adresses
  chacune), son nom, ses drapeaux up/running, son MTU, sa MAC et ses adresses `IP/préfixe`, lus par `net.Interfaces()` :
  aucune commande n'est lancée. Même chemin que le ping : horodatage, `rid` à usage unique, `machineAuth`, une sonde à la fois
  par machine. Cette réponse révèle la configuration réseau de la machine (noms, adresses, MAC) à qui peut déjà la sonder
  (propriétaire, partage direct, ou membre du tableau si la machine y est partagée), pas plus que ce que ces personnes
  obtiendraient avec un shell sur elle ; le serveur n'en voit rien. Il ne limite que la taille de la requête (8 ko, minuscule) ;
  la réponse, bornée par les plafonds de l'agent (de l'ordre de quelques ko, au pire quelques centaines de ko), passe par le
  même relais sans plafond propre au-delà de celui du WebSocket de l'agent. Le navigateur la compare au schéma ; le résultat
  reste éphémère, n'est pas écrit dans le tableau et n'est pas partagé. Un ancien agent ignore `kind` et répond au format ping :
  le navigateur le détecte (champ `ifaces` absent) et demande de mettre l'agent à jour. Le seul effet sur le tableau est la
  correction rapide d'une extrémité, faite par l'éditeur à la main (annulable).
- La machine mémorisée par une icône est une donnée du tableau, que tout éditeur peut écrire. Elle n'est retenue
  que si cette machine a un terminal ou un tunnel ouvert sur ce tableau, d'après le serveur. Un éditeur ne peut
  donc pas faire envoyer des pings depuis la machine d'un autre en trafiquant une icône.

## Partage de machines

Ouvrir un shell, un tunnel ou une sonde exige `machineAuth` : partager une machine revient à confier cette clé.

- **Partage direct** : le navigateur du propriétaire scelle `{auth: machineAuth, name, pub}` pour la clé publique du
  destinataire (`seal(pub_user, …, "eb:machine-share:<machineId>")`). Cette clé est vérifiée contre l'épingle du coffre
  (TOFU), exactement comme pour un partage de tableau : une clé changée est refusée sauf vérification de l'empreinte. Le
  destinataire peut alors utiliser la machine depuis n'importe quel tableau dont il est éditeur.
- **Partage via les tableaux** (option par machine, activée par défaut à la création, désactivée pour les machines
  antérieures) : quand le propriétaire ouvre lui-même un shell ou un site sur une de ses machines dans un tableau
  qu'il peut modifier, son navigateur dépose `box(K_b, {auth, name, pub}, "eb:machine-link:<boardId>:<machineId>")`.
  Les membres du tableau peuvent le déchiffrer avec la clé du tableau.
  - Le lien n'est **créé que sur une action du propriétaire** (ouvrir une session). Ni une icône (donnée du tableau que
    tout éditeur peut écrire), ni la liste des sessions (fournie par le serveur), ni une session ouverte par quelqu'un
    à qui la machine est partagée directement ne suffisent : personne ne peut faire remettre la machine aux membres
    d'un tableau à la place du propriétaire. Après une rotation des clés, le navigateur ne recrée que les liens qu'il
    avait créés lui-même (mémorisés localement).
  - Le lien est retiré quand la machine n'a plus de session sur le tableau.
  - Le serveur n'accepte un lien que du propriétaire, éditeur du tableau, avec l'option activée, hors corbeille ; il ne
    le sert qu'aux éditeurs, et plus du tout si le propriétaire perd ses droits d'édition ou si le tableau part à la corbeille.
- **Contrôle du serveur** : `term.create`, `web.create` et la sonde ne sont acceptés que pour le propriétaire, un
  destinataire direct, ou (depuis ce tableau seulement) un éditeur du tableau lié, tant que le propriétaire en est encore
  éditeur, que l'option est activée et que le tableau n'est pas à la corbeille. Le serveur ne sert pas les liens aux
  lecteurs, mais ils ont la clé du tableau : comme pour la lecture seule, c'est une restriction du serveur, pas une
  garantie cryptographique.
- **Retrait** : retirer une personne, retirer un lien, désactiver l'option, changer un rôle, mettre le tableau à la
  corbeille, le donner ou renouveler ses clés ferme les shells et les sites ouverts par ceux qui perdent l'accès. Une rotation des clés d'un tableau supprime ses liens (ils étaient chiffrés sous l'ancienne
  clé) ; ses terminaux sont rafraîchis par quiconque détient `machineAuth` en propre (propriétaire ou partage direct).
- Le serveur voit qui a accès à quelle machine et à quels tableaux elle est liée. Il ne voit ni la clé, ni le nom donné
  à la machine dans Excalibash (chiffré). Il voit en revanche ce que l'agent annonce en clair : le nom d'hôte du système,
  l'OS et l'architecture (et le nom d'hôte, à l'appairage).
- **Limite** : `machineAuth` ne change pas quand on retire un accès. Quelqu'un qui l'a reçue et qui s'entendrait avec
  le serveur pourrait encore ouvrir des sessions ; le serveur seul ne le peut pas. Pour une coupure complète, supprimer
  la machine et l'appairer de nouveau (nouvelle clé).
- **Origine non authentifiée** : comme pour les dossiers, un partage direct est scellé de façon anonyme. Un serveur
  malveillant pourrait présenter à quelqu'un une « machine partagée par Alice » qui est en fait la sienne, et lire ce
  qui y serait tapé. Un lien de tableau, lui, est chiffré sous la clé du tableau, que le serveur n'a pas.

## Mise à jour des agents

Un agent peut se mettre à jour seul (« Mettre à jour » sur la page Machines, « Mettre à jour les agents » sur un tableau).
Règle d'or : **le serveur ne peut pas faire exécuter de code à un agent**, même compromis.

- **Ancre de confiance = une clé publique Ed25519 compilée dans l'agent** (`-X main.updatePubKey=…`, voir
  [RELEASE.md](RELEASE.md)). La clé privée reste hors ligne chez la personne qui publie : ni le serveur, ni la CI, ni le dépôt
  ne la détiennent. Un agent compilé sans clé refuse toute mise à jour (message clair) et se met à jour à la main (`update.sh`).
- **Le serveur ne fait que distribuer** : `agent-manifest.json` (`{version, date, files: {<os>-<arch>: {sha256, size}}}`) et
  `agent-manifest.json.sig` (signature Ed25519 des octets exacts du manifeste) sont servis avec les binaires, par une liste
  blanche stricte de noms. `GET /api/agent/latest` (public) annonce `{version, signed}` : simple métadonnée, le serveur ne
  vérifie rien, c'est l'agent qui juge.
- **La demande** est scellée sous `machineAuth` comme une sonde : `POST /api/machines/:id/update {rid, ts, d}` avec
  `d = box(machineAuth, {op:"update"}, "eb:update:<rid>:<ts>")`. Qui peut ouvrir un shell sur la machine peut la demander
  (propriétaire, partage direct, éditeur d'un tableau lié) : cela ne donne rien, puisque la charge est un binaire officiel
  signé. Le serveur limite à une demande par minute et par machine (une à la fois), relaie le chiffré et renvoie, ligne par
  ligne, les trames de progression `update.res` scellées sous `eb:update-res:<rid>` (phases `check`, `download`, `install`,
  `restarting`, `error`, numérotées : le navigateur ignore une trame rejouée ou mal authentifiée). Il ne voit ni la
  phase ni les messages.
- **Procédure de l'agent** : horodatage à ±5 min et `rid` à usage unique (comme les sondes) ; refus si aucune clé n'est
  intégrée ; téléchargement du manifeste et de sa signature par le même chemin HTTP que la connexion de l'agent (même
  épinglage TLS, redirections vers un autre hôte refusées) ; **vérification de la signature avant de lire le manifeste** ;
  `version` strictement supérieure à la version courante (comparaison semver : **ni retour en arrière, ni réinstallation** ;
  un agent « dev » refuse) ; entrée de sa plateforme présente ; téléchargement dans `.excalibash-agent.new` (0700) borné à la
  taille signée (et à 64 Mio) ; SHA-256 comparé à celui signé ; puis remplacement atomique (l'exécutable devient
  `.excalibash-agent.old`, le nouveau le remplace) et `exec` sur place : même PID, donc systemd, crontab ou lancement manuel ne
  voient rien. Si l'`exec` échoue, l'ancien binaire est remis en place.
- **Retour arrière** : le processus lancé par une mise à jour (variable `EXCALIBASH_UPDATE_TRIAL`) doit se connecter au
  serveur et envoyer son `hello` en moins de 120 s ; sinon il remet `.excalibash-agent.old` à sa place et le relance, avec une
  note « mise à jour annulée » dans son `hello` (affichée sur la page Machines). Une fois connecté, l'ancien binaire est supprimé.
  Ces variables sont retirées de l'environnement du processus pour ne pas être héritées par les shells.
- **Sessions** : la mise à jour redémarre l'agent, ce qui met fin aux shells ouverts. L'interface le dit et demande confirmation,
  en comptant les sessions ouvertes (nombre donné par le serveur, qui connaît l'état des terminaux).
- **Limites** : le serveur (ou quiconque contrôle le réseau) peut empêcher une mise à jour, ou proposer une version signée plus
  ancienne que la dernière mais plus récente que celle de l'agent (jamais un retour en arrière). Un défaut qui empêche le
  nouveau binaire de démarrer du tout, avant d'avoir pu se surveiller, n'est pas rattrapé par le retour arrière si le
  superviseur relance le processus sans la variable d'essai. La compromission de la clé privée de publication permet de signer
  une version malveillante : voir la procédure dans [RELEASE.md](RELEASE.md#6-rotation-et-compromission-de-la-clé).

## Fichiers et captures

Envoyer un fichier dans le dossier d'un shell, en télécharger un, ou capturer le trafic d'une interface (pcap)
passe par un terminal **local** déjà ouvert et est autorisé par sa clé `K_t`.

- **Autorité = la clé du terminal.** Qui détient `K_t` peut déjà taper dans ce shell : le transfert ne donne aucun pouvoir
  de plus. Les sessions Telnet, SSH et TCP brut sont refusées par l'agent (« transfert disponible seulement sur un shell
  local »). Les lecteurs (viewer) sont refusés par le serveur, comme pour la saisie. Les captures sont lancées par
  l'agent, donc avec les droits du compte de l'agent, comme le shell.
- Trames : `file.req {term, rid, ts, d}` avec `d = box(K_t, opération, "eb:file-req:<term>:<rid>:<ts>")` ; réponses
  `file.res {id, rid, n, d, end}` avec `d = box(K_t, corps, "eb:file-res:<term>:<rid>:<n>")`. `rid` est un identifiant
  aléatoire de 128 bits. L'agent applique la clé **courante** du terminal (elle change au `rekey`), rejette
  `|now − ts| > 5 min` et tout `(terminal, rid)` déjà vu : l'identifiant n'est enregistré qu'**après** authentification,
  en une seule section critique (comme pour les tunnels web), dans une table bornée.
- **Ce que voit le serveur** : la taille et le rythme des trames, la machine et le terminal concernés, le fait qu'un
  transfert a lieu. **Il ne voit jamais** : noms de fichiers, chemins, contenus, noms d'interfaces, filtres. Il ne
  renvoie une réponse qu'au socket qui a fait la requête (jamais en diffusion), ignore les `rid` inconnus, oublie une
  requête sans réponse après 90 s, plafonne les requêtes en attente (32 par tableau) et la taille d'une trame
  (400 Kio en base64), et annule un transfert si le socket du demandeur accumule plus de 8 Mio non lus.
- **Limites** : 200 Mio par fichier, 192 Kio par morceau, 4 transferts simultanés par machine, 500 entrées par
  listage, 60 s sans activité = abandon. Le flux est à fenêtre : l'agent n'envoie qu'une petite avance (8 morceaux)
  avant les accusés du navigateur, ce qui borne la mémoire et arrête un téléchargement dont le demandeur a disparu.
  Chaque fichier est vérifié par SHA-256 de bout en bout.
- **Envoi** : le nom doit être un simple nom de fichier (ni `/`, `\`, NUL, ni `.` ou `..`, 255 octets au plus).
  Le fichier est écrit dans `.<nom>.excalibash-part-<aléa>` (0600, `O_EXCL`) puis `fsync` et renommé ; un fichier existant
  n'est jamais écrasé sans confirmation explicite (`overwrite`), et sans écrasement le renommage se fait par lien dur
  pour qu'un fichier créé entre-temps ne soit pas remplacé. Un envoi abandonné ou expiré supprime son fichier temporaire.
  Le fichier final est en 0600 (ou garde les droits du fichier remplacé). Le dossier de destination est celui du
  shell (lu dans `/proc/<pid>/cwd` sous Linux ; sous macOS, faute de mieux, le dossier personnel du compte).
- **Téléchargement** : fichiers ordinaires seulement (ni dossier, ni périphérique, ni tube).

- **Agent trop ancien** : un agent d'avant ces fonctions ignore sans réponse les trames `file`. Le `hello` de l'agent
  porte `version` et `caps` (liste de mots courts, métadonnée en clair) ; sans `caps`, l'agent est traité comme ancien. Le
  navigateur refuse alors la fonction avec « L'agent de <machine> est trop ancien pour… : mets-le à jour » et la commande
  de mise à jour, et sans réponse à une première trame il abandonne au bout de 10 s (« agent hors ligne ou trop ancien »).
  `/update.sh` (ou, si l'instance publie des versions signées, le bouton « Mettre à jour » : voir « Mise à jour des agents ») remplace le programme et redémarre le service ; il ne touche ni à `agent.json` ni à `agent.env` : la
  machine garde son identité. Le script est le même pour tout le monde et ne contient aucun secret.
- **Capture** : l'agent lance `tcpdump -i <interface> -U -n -s 0 -w - -- <filtre>` directement, jamais via un shell.
  L'interface doit correspondre à `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,31}$` ; le filtre est découpé en mots (32 au plus) de
  `[A-Za-z0-9._:/!()&|<>=-]{1,64}` dont aucun ne commence par `-` (aucune option ne peut être injectée). Durée de 1 à
  300 s, taille de 50 Mio au plus ; le groupe de processus est arrêté à la fin, à l'annulation ou à l'abandon. Il faut
  que l'agent tourne en root, ou que `tcpdump` ait `CAP_NET_RAW` : sinon l'agent renvoie un message clair (avec la commande
  `setcap`) et la ligne d'origine de tcpdump en détail ; toutes les lignes d'erreur sont lues, pas seulement la première.
  « Arrêter » termine la capture proprement et livre ce qui a été capturé. Dans le tableau, la capture se lance depuis
  l'extrémité d'un câble, sur une icône qui a un shell local en cours ; l'interface se choisit dans la liste de celles de la
  machine (opération `ifaces` du canal de fichiers : noms, état et adresses lus par `net.Interfaces`, sans rien exécuter,
  scellés comme le reste ; le serveur ne les voit pas). Les erreurs de tcpdump restent affichées dans le panneau. Une capture appartient au tableau ouvert (pas à la fenêtre de l'extrémité) : elle continue si on ferme la fenêtre, un indicateur flottant permet de l'arrêter, le fichier est enregistré à la fin, et elle est abandonnée quand on quitte le tableau.

## Client MCP

Le client MCP (`excalibash-mcp.mjs`, voir [MCP.md](MCP.md)) est un programme local qui ouvre une session
comme le navigateur : même connexion (`prelogin`, `authKey`), même déchiffrement de la clé privée, même
vérification de la clé publique, mêmes websockets de tableau et mêmes trames chiffrées.

- **Le serveur ne voit rien de nouveau** : c'est une session de plus du compte (visible comme un pair
  du tableau quand elle est ouverte). Aucun contenu en clair, aucune nouvelle clé, aucun nouveau point d'API.
- Le déchiffrement a lieu sur la machine de l'utilisateur. Le résultat des outils est ensuite remis au
  client MCP choisi par l'utilisateur, et à travers lui à son modèle : ce que l'utilisateur lui confie
  sort donc du périmètre du chiffrement de bout en bout, par son choix.
- Le fichier `~/.config/excalibash/mcp.json` (0600, dossier 0700, refusé s'il est lisible par d'autres)
  contient le cookie de session et la clé privée : même modèle de confiance que le trousseau du navigateur
  ou `agent.json`. La session se révoque (déconnexion, changement de mot de passe) comme les autres.
- Lecture seule par défaut. La saisie dans un terminal (`--autoriser-saisie`) et l'ajout de notes
  (`--autoriser-edition`) sont des options explicites, journalisées sans leur contenu. Les droits sont ceux
  du compte : le serveur refuse toujours la saisie à un lecteur.
- Les sorties de terminal et le contenu des tableaux sont des données non fiables (injection de prompt) ;
  `--tableaux` limite les outils à des tableaux précis.
- Le certificat d'une instance auto-signée se fait confiance via `NODE_EXTRA_CA_CERTS`, jamais en
  désactivant la vérification TLS.

## Liens publics

Un **lien public** donne la lecture d'**un seul tableau** à quiconque possède l'adresse
`https://<instance>/v/<jeton>#<cléDuLien>`, sans compte. Seuls le propriétaire et les éditeurs du tableau
peuvent en créer, lister et supprimer (les lecteurs et les administrateurs non membres n'ont aucun accès).
Un tableau a 20 liens au plus.

- `jeton` : 128 bits aléatoires (base64url), généré par le serveur et renvoyé **une seule fois** à la création.
  Le serveur n'en stocke que le `SHA-256`. `cléDuLien` `K_l` : 256 bits aléatoires, générés par le navigateur du
  créateur, **uniquement dans le fragment de l'URL**. Un navigateur n'envoie jamais le fragment (ni dans la requête,
  ni dans `Referer`, d'ailleurs `Referrer-Policy: no-referrer`) : le serveur ne voit jamais `K_l`. La page publique
  lit `location.hash`, ne l'écrit dans aucun stockage et ne le met dans aucune requête.
- Le serveur stocke, par lien : `wrappedKey = box(K_l, K_b, "eb:link:<boardId>:<epoch>")`, le libellé
  `box(K_b, libellé, "eb:link-label:<boardId>:<publicId>")` (vu par les éditeurs, ex. « Pour le jury »), le titre
  `box(K_b, nom, "eb:link-title:<boardId>:<publicId>")` (le nom du tableau n'est pas servi autrement), la date de
  création, l'expiration éventuelle, l'auteur et un identifiant public `publicId` (16 hex, choisi par le navigateur
  pour entrer dans les AAD) qui sert à lister et supprimer.
- `GET /api/public/<jeton>` sert le **chiffré** du tableau (éléments, images) et `wrappedKey` à qui connaît le jeton ;
  le navigateur déchiffre `K_b` avec `K_l`, puis les éléments avec les AAD habituels. Un jeton inconnu, mal formé,
  expiré, supprimé, ou un tableau à la corbeille répondent tous le même `404` (pas d'oracle). Limite : 60 requêtes par
  minute et par IP, 300 par jeton. Réponse `Cache-Control: no-store`, `ETag` (`304` pour l'interrogation toutes les 15 s).
- **Lecture seule par construction** : aucune route d'écriture n'accepte un jeton, et la page n'ouvre aucune websocket.
  Les terminaux et les tunnels web ne sont jamais accessibles : leurs clés (`keyForBoard`) ne sont pas servies, et le
  navigateur écarte les fenêtres et retire des tuiles de machines leurs shells, sites et cibles distantes.
- **Rotation** : retirer un membre renouvelle les clés, et **tous les liens des tableaux concernés sont supprimés dans
  la même transaction** (la personne retirée a pu voir jetons et clés). Supprimer le tableau, ou le vider de la
  corbeille, supprime ses liens. Il faut créer de nouveaux liens après une rotation.
- Ce que le serveur apprend : qu'un lien existe, qui l'a créé, quand, son expiration, et l'IP de ceux qui le lisent
  (comme pour toute requête). Il ne voit ni `K_l`, ni le titre, ni le libellé, ni le contenu.
- Limites : qui possède l'adresse complète lit le tableau, et peut la transmettre ; un lien ne se révoque que par suppression
  (ou rotation). Le titre est figé à la création du lien. Comme pour le reste, un serveur malveillant qui sert du
  JavaScript piégé sur `/v/…` pourrait lire le fragment : même limite que pour tout le code servi.

## HTTPS et certificat auto-signé

- Par défaut (`TLS=auto`), les deux ports (application et tunnels) parlent HTTPS. Un certificat
  fourni (`TLS_CERT`, `TLS_KEY`) est utilisé tel quel. Sinon, le serveur génère au premier démarrage
  un certificat auto-signé dans `DATA_DIR/tls/` : `cert.pem`, `key.pem` (0600) et `sans.json`.
  - ECDSA P-256, signature SHA-256, CN `Excalibash`, valable 10 ans, `CA:FALSE`,
    `digitalSignature`, `serverAuth`. Générateur en TypeScript sur `node:crypto`, sans dépendance
    ni appel à `openssl`.
  - Noms (SAN) : `localhost`, `127.0.0.1`, `::1`, le nom de la machine, ses adresses IP non internes
    (hors lien local IPv6), les hôtes de `PUBLIC_URL` et `PROXY_URL`, et `TLS_SANS`.
  - Si cette liste change, ou à moins de 30 jours de l'expiration, le certificat est réémis **avec
    la même clé** : l'épingle ne change pas et les agents déjà installés continuent de se connecter.
    Supprimer `key.pem` force une nouvelle clé (et donc une nouvelle épingle).
  - Au démarrage, les logs affichent l'empreinte SHA-256 du certificat (à comparer avec celle que
    montre le navigateur avant d'accepter l'avertissement) et l'épingle.
- **Épingle** : `sha256//<base64 du SHA-256 de la SubjectPublicKeyInfo>`, le format de
  `curl --pinnedpubkey`. `/api/config` la publie (`tls.pin`), mais elle n'a de valeur que si la page
  elle-même a été obtenue sur une connexion dont l'empreinte a été vérifiée.
- **Scripts et agents** : avec le certificat auto-signé, les commandes affichées, `/install.sh` et
  `/p/<code>` utilisent `curl -k --pinnedpubkey` (`-k` ne fait qu'ignorer l'autorité de
  certification ; la clé publique reste vérifiée) et lancent l'agent avec `--pin`. L'agent remplace
  alors la vérification habituelle par la comparaison de la clé publique du certificat présenté
  (ni chaîne ni nom d'hôte), pour la websocket `/agent` comme pour l'appairage, et enregistre
  l'épingle dans sa configuration. `wget` ne sait pas épingler : sans curl, le script s'arrête.
- L'épingle n'est pas annoncée quand la requête porte `X-Forwarded-For` ou `Forwarded` : derrière
  un reverse proxy, le client voit le certificat du proxy, pas celui de l'instance.
- **HTTP clair** : sur le même port, une requête HTTP reçoit une redirection 308 vers HTTPS. Seule
  exception : l'ouverture de la websocket `/agent`, servie normalement pour les agents appairés en
  `http://`. Leurs échanges restent chiffrés de bout en bout ; seul le jeton de connexion passe en
  clair, comme avant.
- **Tunnels web** : un navigateur refuse d'enregistrer un Service Worker servi avec un certificat
  qu'il ne reconnaît pas, même après avoir accepté l'avertissement. La page du tunnel l'explique et
  propose `/certificate.pem` à installer dans le navigateur ou le système.
- `TLS=off` rend le comportement antérieur (HTTP seul), pour un reverse proxy qui fait le TLS.

### Tunnels web en mode sous-domaine

Avec `TUNNEL_DOMAIN`, chaque tunnel est servi à la racine de sa propre origine `https://<id>.<TUNNEL_DOMAIN>/` : les sites
voient leurs vrais chemins, et chaque tunnel a son IndexedDB, ses cookies et son Service Worker. Sans `TUNNEL_DOMAIN`, rien ne
change (mode chemin `/t/<id>/`, qui reste utile sans DNS wildcard). Rien de plus n'est lisible par le serveur : le ticket et le
cookie ne transportent aucun contenu, seulement « ce compte peut joindre ce tunnel ».

- **Identifiant** : 16 octets tirés par le navigateur (`crypto.getRandomValues`), en base32 minuscule sans remplissage
  (26 caractères `a-z2-7`), donc valable comme nom d'hôte. Le serveur n'accepte que ce format pour créer un tunnel ; les
  tunnels plus anciens (identifiants base64) ne sont servis qu'en mode chemin.
- **Reverse proxy** : l'hôte et le secret ne viennent jamais de la requête du navigateur. Le reverse proxy pose
  `X-Tunnel-Host: $host` et `X-Tunnel-Auth: <TUNNEL_PROXY_SECRET>` (au moins 32 caractères ; le serveur refuse de démarrer sinon) et
  écrase ceux du client. Le port des tunnels ne doit être joignable que par lui. Pour chaque requête et chaque upgrade WebSocket :
  1. le secret est comparé en temps constant (SHA-256 des deux valeurs : ni contenu ni longueur ne fuient). Faux ou absent : refus,
     et `X-Tunnel-Host` n'est même pas lu ;
  2. `X-Tunnel-Host` (jamais `Host` ni `X-Forwarded-Host`, sans `:port`, en minuscules) doit être exactement `<id>.<TUNNEL_DOMAIN>`,
     avec un id conforme et un tunnel existant.
- **Réponses uniformes** : secret faux, hôte invalide, tunnel inconnu ou fermé, session absente ou expirée, accès retiré, `Origin`
  invalide, adresse bloquée : toutes reçoivent `404`, corps vide, `Cache-Control: no-store` (pour une WebSocket :
  `404`, `Content-Length: 0`, `Connection: close`). Jamais 444 (code de bannissement automatique de certains pare-feu applicatifs),
  jamais 401 ni 403 : rien ne permet de distinguer une cause d'une autre, ni de sonder les tunnels existants. Après authentification,
  les erreurs fonctionnelles restent (400 requête invalide, 429, 504 machine hors ligne).
- **Session de tunnel** (ticket, puis cookie) :
  - un compte connecté demande `POST /api/tunnels/:id/ticket` (60 par minute) ; il faut au moins le rôle lecteur sur le tableau du
    tunnel, sinon 404. Le ticket (32 octets aléatoires) vit 60 s, en mémoire, à usage unique ;
  - la page de démarrage du tunnel reçoit le ticket avec la clé (par `postMessage`, jamais dans une URL) et l'échange par
    `POST /eb-proxy/session` (même `Origin` que le tunnel) contre `__Host-eb_tunnel=<jeton>; Path=/; Secure; HttpOnly; SameSite=Lax`
    (sans `Domain`, `TUNNEL_SESSION_HOURS` heures, 8 par défaut). Le jeton (32 octets) est gardé haché en mémoire, lié à un seul
    tunnel et au compte, 20 sessions au plus par compte et par tunnel. Un échec n'est pas retenté (pas de boucle de rechargement) ;
  - le relais (`POST /eb-proxy/req/<id>`) et les WebSocket exigent en plus : l'id de l'hôte, un `Origin` égal à l'origine du tunnel
    et un cookie valide pour ce tunnel. Toutes les 60 s, le droit de lecture sur le tableau, l'existence du tunnel, la session
    Excalibash d'origine et la non-suspension du compte sont revérifiés ; les sockets ouvertes le sont aussi ;
  - fermer ou renouveler la clé d'un tunnel, se déconnecter, « déconnecter les autres appareils », changer ou réinitialiser le mot de
    passe, suspendre ou supprimer un compte, retirent les sessions concernées, et coupent leurs WebSocket. Elles ne survivent
    pas à un redémarrage du serveur : les pages repassent par la poignée de main (une navigation refusée recharge la page de démarrage) ;
  - les liens publics en lecture seule n'affichent pas de fenêtre de site (leurs fenêtres de tunnel sont retirées du contenu) : ils n'ont
    donc pas de ticket à demander. Sans compte, pas de ticket.
- **Limites et blocage** : par adresse (`req.ip`, avec `trust proxy` : le reverse proxy doit transmettre `X-Forwarded-For`), 2000
  requêtes par minute et 600 sockets ; par tunnel, 6000 requêtes par minute. 50 refus (secret, hôte, tunnel, `Origin`) en 10 minutes
  bloquent l'adresse 15 minutes : elle reçoit le même 404 vide même avec de bonnes valeurs. Un refus pour session absente n'est pas
  compté (c'est aussi l'aspect d'un onglet resté ouvert après un redémarrage), seulement journalisé. Plus de 300 refus par minute, toutes
  adresses confondues, produisent une ligne d'alerte par minute. Les compteurs sont en mémoire.
- **Journal** : une ligne stable par refus sur la sortie standard, faite pour être analysée (règles Wazuh, fail2ban) :
  `excalibash-security event=tunnel_denied reason=<bad_secret|bad_host|unknown_tunnel|no_session|bad_origin|blocked_ip> ip=<ip> host=<8 premiers caractères de l'id ou -> path=<chemin sans query, 64 caractères au plus>`,
  `excalibash-security event=tunnel_denied_burst count=<n> window=60s` et `excalibash-security event=ip_blocked scope=tunnel ip=<ip> minutes=15`.
  Ni secret, ni cookie, ni identifiant complet (un id dans le chemin est remplacé par `-`).
- **Même site** : le cookie est `SameSite=Lax`. Pour qu'il circule dans l'iframe du tableau, `TUNNEL_DOMAIN` doit être sous le même
  domaine enregistrable que `PUBLIC_URL` (par exemple `excalibash.example.com` et `tunnel.example.com`), sinon le navigateur le
  traite comme un cookie tiers.
- **Pare-feu applicatif** : pour ce mode, laisser le port des tunnels derrière le reverse proxy avec `TLS=off` ; avec TLS actif sur
  ce port, une requête en clair reçoit la redirection 308 de l'instance, qui n'est pas la réponse uniforme.

## Risques résiduels (assumés, documentés)

- **Code servi** : le serveur fournit le JavaScript et le binaire de l'agent (`/install.sh`). Un
  hébergeur malveillant peut servir une version piégée. Parade : héberger soi-même, construire
  l'agent depuis les sources, comparer les empreintes.
- **Origine d'un partage non authentifiée** : un serveur malveillant peut présenter à quelqu'un un dossier
  « partagé par Alice » qu'il a créé lui-même. Il ne lit rien de ce qui existe déjà, mais pourrait
  lire ce qui y serait déposé ensuite.
- **Disponibilité et retour en arrière** : le serveur peut refuser, retarder ou resservir une
  ancienne version complète d'un élément (chiffré authentique mais périmé).
- **Membres** : les éditeurs peuvent taper dans les terminaux du tableau, avec les droits du
  propriétaire de la machine. Avec le partage via les tableaux, ils peuvent aussi ouvrir de nouvelles
  sessions sur les machines liées au tableau. Les lecteurs ont les clés : la lecture seule est appliquée par le
  serveur, pas par la cryptographie.
- **Suppression d'un compte par un admin** : elle ne déclenche pas de rotation sur les dossiers que
  ce compte partageait.
- **Sites tunnelisés sur une même origine** : tous les tunnels d'un navigateur partagent l'origine
  proxy, où le Service Worker garde leurs clés. Elles y sont des `CryptoKey` non extractibles : un
  site ne peut pas les copier pour s'en servir ailleurs. Le Service Worker refuse aussi qu'une page
  d'un tunnel appelle un autre tunnel, ou change sa clé. Reste qu'un site piégé, ouvert dans un tunnel
  (par exemple depuis un tableau partagé par quelqu'un d'autre), partage l'IndexedDB et peut intégrer
  une page d'un autre tunnel ouvert dans ce navigateur, puis lire son contenu (même origine). Parade :
  n'ouvrir que des sites de confiance, ou un profil de navigateur dédié. En mode sous-domaine
  (`TUNNEL_DOMAIN`), chaque tunnel a sa propre origine et ce risque disparaît ; il reste en mode chemin.
- **Quotas** : il n'y a pas de quota de stockage par compte. Un tableau est limité à 2000 images
  (512 Mo chiffrés) et chaque socket à 300 messages par seconde, mais avec les inscriptions ouvertes,
  un compte peut encore remplir le disque en créant des tableaux ; les inscriptions sur invitation
  évitent ce risque.
- **Rejeu d'une ancienne clé de terminal ou de tunnel** : `keyForAgent` (`eb:term:<id>`, `eb:web:<id>`)
  ne porte ni époque ni compteur. Un serveur complice d'une personne qui a perdu l'accès peut renvoyer
  à l'agent une ancienne clé qu'elle connaît encore. Pour une coupure complète, supprimer la machine et
  l'appairer de nouveau.
- **Images reconnaissables** : l'identifiant d'une image est l'empreinte SHA-1 de son contenu (choix
  d'Excalidraw), en clair. Le serveur peut tester si un tableau contient une image qu'il connaît déjà.
- **Frappes supprimées** : les entrées d'un terminal sont numérotées (`k`) et l'agent refuse un numéro déjà vu,
  mais pas un trou : le serveur peut retirer une trame (une touche, un morceau de collage) sans que l'agent le voie.
  Un compteur contigu par terminal est prévu avec la mise à jour du protocole de l'agent (époque de `keyForAgent`).
- **Élément racine** : la clé d'un élément à la racine vient d'un accès scellé de façon anonyme à son propriétaire.
  Le serveur peut en remplacer un par une clé de son choix : l'élément paraît alors vide, et ce qui y serait écrit
  ensuite lui serait lisible. Pour un élément dans un dossier, la clé venant du dossier parent l'emporte sur un accès
  qui la contredirait. Le serveur peut aussi glisser dans une rotation un contact déjà épinglé ailleurs.
- **Origine des tunnels** : l'adresse de l'origine proxy vient de `/api/config`. Un serveur qui en donnerait une autre
  recevrait la clé du tunnel. L'identifiant d'un tunnel ne change pas quand sa clé est renouvelée : en mode chemin, qui le
  connaît peut encore envoyer du bruit (sans clé) jusqu'à la machine ; en mode sous-domaine, il faut en plus le secret du
  reverse proxy et une session de tunnel.
- **Sessions de tunnel en mémoire** : les tickets et sessions de tunnel disparaissent au redémarrage du serveur (les pages
  refont la poignée de main) ; un accès retiré à un tableau peut rester utilisable jusqu'à 60 secondes dans un tunnel déjà ouvert.
- **Verrouillage d'un compte** : 8 tentatives de connexion par minute et par email, quelle que soit l'adresse.
  Un inconnu peut empêcher quelqu'un de se connecter tant qu'il continue.
- **Coffre ramené en arrière** : le serveur peut resservir une ancienne version du coffre (clés épinglées)
  ou n'en servir aucune ; un contact épinglé redevient alors « nouveau », sans alerte.
