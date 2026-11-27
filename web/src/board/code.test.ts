// Unit tests of the code-window rules (pure, no framework):
//   node --experimental-strip-types web/src/board/code.test.ts     (or: npx tsx web/src/board/code.test.ts)
import * as Y from "yjs";
import { EMPTY_SHA, cursorStyleSheet, diffOutcome, initBlank, initFromFile, isDirty, languageForName, markSaved, readMeta, runCommand, safeColor, safeLabel, sha256Hex, splitPath } from "./codeDoc.ts";
import { MAX_CODES, MAX_LABEL, cleanLabel, labelOfName, nodeDataOf } from "./nodeData.ts";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};
const el = (customData: unknown) => ({ customData }) as any;

// 1. Language detection
{
  const l = languageForName;
  ok(l("demo.py") === "python" && l("a/b/run.sh") === "shell" && l("x.js") === "javascript" && l("x.ts") === "typescript", "language : py, sh, js, ts");
  ok(l("a.json") === "json" && l("m.c") === "c" && l("m.h") === "c" && l("m.cpp") === "cpp" && l("M.java") === "java" && l("main.go") === "go" && l("lib.rs") === "rust", "language : json, c/h, cpp, java, go, rs");
  ok(l("c.yaml") === "yaml" && l("c.yml") === "yaml" && l("R.md") === "markdown" && l("i.html") === "html" && l("s.css") === "css" && l("q.sql") === "sql", "language : yaml, md, html, css, sql");
  ok(l("Dockerfile") === "dockerfile" && l("dir/dockerfile") === "dockerfile" && l("app.dockerfile") === "dockerfile", "language : Dockerfile");
  ok(l("php.ini") === "ini" && l("router.cfg") === "plaintext" && l("notes.txt") === "plaintext", "language : ini, cfg (équipement réseau) et txt en texte brut");
  ok(l("noext") === "plaintext" && l(".hidden") === "plaintext" && l("ARCHIVE.PY") === "python" && l("a.unknown") === "plaintext", "language : sans extension, caché, majuscules, inconnu");
}

// 2. Dirty state
{
  const h = await sha256Hex("print('salut')\n");
  ok(h.length === 64 && h === (await sha256Hex("print('salut')\n")) && h !== (await sha256Hex("print('salut')")), "dirty : sha256 stable et sensible à chaque octet");
  ok((await sha256Hex("")) === EMPTY_SHA, "dirty : EMPTY_SHA est le sha du texte vide");
  ok(!isDirty(h, h) && isDirty(h, EMPTY_SHA) && isDirty(h, undefined), "dirty : différent de savedSha = modifié");
  ok(!isDirty(EMPTY_SHA, undefined) && isDirty(EMPTY_SHA, h), "dirty : un document neuf et vide n'est pas modifié ; vidé après enregistrement, il l'est");
}

// 3. Paths and run commands
{
  ok(JSON.stringify(splitPath("a/b/c.py")) === '{"dir":"a/b","name":"c.py"}' && JSON.stringify(splitPath("c.py")) === '{"dir":"","name":"c.py"}' && JSON.stringify(splitPath("/c.py")) === '{"dir":"/","name":"c.py"}', "chemin : dossier et nom");
  ok(runCommand("/tmp/demo.py", "python") === "python3 /tmp/demo.py" && runCommand("x.sh", "shell") === "bash x.sh" && runCommand("x.js", "javascript") === "node x.js", "exécuter : python3 / bash / node");
  ok(runCommand("x.c", "c") === null && runCommand("x.txt", "plaintext") === null, "exécuter : rien pour les autres langages");
  ok(runCommand("/tmp/my file's.py", "python") === "python3 '/tmp/my file'\\''s.py'" && runCommand("/tmp/a;rm -rf x.py", "python") === "python3 '/tmp/a;rm -rf x.py'", "exécuter : le chemin est protégé (espaces, quotes, ;)");
  ok(runCommand("-x.py", "python") === "python3 './-x.py'", "exécuter : un nom qui commence par - n'est pas une option");
}

// 4. Metadata and initialisation of a document
{
  const m = new Map<string, unknown>([["name", "a.py"], ["savedSha", "zz"], ["language", "klingon"], ["savedAt", "now"]]);
  const meta = readMeta(m);
  ok(meta.name === "a.py" && meta.language === "python" && meta.savedSha === undefined && meta.savedAt === undefined && meta.path === undefined, "meta : valeurs mal formées ignorées, langage déduit du nom");
  ok(readMeta(new Map()).name === "sans-titre", "meta : nom par défaut");

  const d = new Y.Doc();
  ok(initFromFile(d, { path: "/h/demo.py", name: "demo.py", text: "print(1)\n", sha: "a".repeat(64), by: "Alice" }), "init : un document vide reçoit le fichier");
  const t = d.getText("content");
  ok(t.toString() === "print(1)\n" && d.getMap("meta").get("path") === "/h/demo.py" && d.getMap("meta").get("savedSha") === "a".repeat(64) && d.getMap("meta").get("language") === "python", "init : contenu et métadonnées posés ensemble");
  let updates = 0;
  d.on("update", () => updates++);
  const d2 = new Y.Doc();
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d));
  ok(!initFromFile(d2, { name: "autre.py", text: "x", sha: "b".repeat(64) }) && d2.getText("content").toString() === "print(1)\n", "init : jamais deux fois (document déjà rempli)");
  ok(!initBlank(d) && updates === 0, "init : un document déjà nommé n'est pas réinitialisé");
  const blank = new Y.Doc();
  ok(initBlank(blank) && blank.getMap("meta").get("name") === "sans-titre.txt" && !initBlank(blank), "init : document vierge nommé une seule fois");
  const emptyFile = new Y.Doc();
  initFromFile(emptyFile, { name: "vide.py", text: "", sha: EMPTY_SHA });
  ok(!initFromFile(emptyFile, { name: "x.py", text: "intrus", sha: "c".repeat(64) }), "init : un fichier vide ouvert n'est pas rempli par un second");
  markSaved(d, { path: "/h/sub/new.js", sha: "d".repeat(64), by: "Bob" });
  const saved = readMeta(d.getMap("meta"));
  ok(saved.path === "/h/sub/new.js" && saved.name === "new.js" && saved.language === "javascript" && saved.savedSha === "d".repeat(64) && saved.savedBy === "Bob", "enregistrement : chemin, nom, langage et empreinte mis à jour");
}

// 5. Remote cursors CSS: names and colours come from other people
{
  ok(safeColor("#aBc123") === "#aBc123" && safeColor("hsl(210, 80%, 50%)") === "hsl(210, 80%, 50%)" && safeColor("red;} body{display:none") === "#6366f1" && safeColor(42) === "#6366f1", "curseurs : couleur validée");
  ok(safeLabel('Al"ice\n{}') === "Alice" && safeLabel("") === "Anonyme" && safeLabel("x".repeat(80)).length === 24 && safeLabel("Zoë D'Arc") === "Zoë D'Arc", "curseurs : nom nettoyé, accents conservés");
  const css = cursorStyleSheet([
    { clientId: 7, name: 'Eve"}body{display:none}/*', color: "url(javascript:1)" },
    { clientId: -1, name: "x", color: "#fff" },
    { clientId: 12, name: "Bob", color: "#10b981" },
  ]);
  ok(css.includes(".yRemoteSelection-7{") && css.includes(".yRemoteSelectionHead-12::after") && css.includes('content:"Bob"') && css.includes("#10b981"), "curseurs : une règle par pair, à sa couleur et son nom");
  ok(!css.includes("--1") && !css.includes("-1{") && !css.includes("display:none") && !css.includes("javascript") && !css.includes("*/"), "curseurs : rien d'injectable dans la feuille de style");
}

// 6. nodeDataOf validates the code windows
{
  const id = (n: number) => n.toString(36).padStart(22, "a");
  const node = (codes: unknown) => nodeDataOf(el({ node: true, shells: [], codes }));
  const sorted = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
  ok(sorted(node([{ docId: id(1) }, { docId: id(2), x: 10, y: 20, w: 760, h: 520 }])!.codes) === sorted([{ docId: id(1) }, { docId: id(2), x: 10, y: 20, w: 760, h: 520 }]), "nodeData : codes bien formés conservés, avec leur géométrie");
  ok(node("nope")!.codes!.length === 0 && node(undefined)!.codes!.length === 0 && nodeDataOf(el({ node: true, shells: [] }))!.codes!.length === 0, "nodeData : codes absent ou pas une liste = liste vide");
  const bad = node([{ docId: "court" }, { docId: id(1) + "x" }, { docId: "a".repeat(21) + "/" }, { docId: 42 }, null, "x", { docId: id(3), x: "1", w: Infinity }]);
  ok(bad!.codes!.length === 1 && bad!.codes![0].docId === id(3) && bad!.codes![0].x === undefined && bad!.codes![0].w === undefined, "nodeData : identifiants stricts (22 base64url), géométrie non numérique ignorée");
  ok(node([{ docId: id(5) }, { docId: id(5) }])!.codes!.length === 1, "nodeData : doublons écartés");
  const many = node(Array.from({ length: 80 }, (_, i) => ({ docId: id(i + 100) })))!;
  ok(many.codes!.length === MAX_CODES && MAX_CODES === 32, "nodeData : au plus 32 fichiers de code par machine");
}

// 7. Display names of the windows (`label` of a codes / notebooks entry)
{
  const el = (customData: unknown) => ({ customData }) as any;
  const id = (n: number) => String(n).padStart(22, "L");
  const node = (extra: object) => nodeDataOf(el({ node: true, shells: [], ...extra }))!;
  ok(cleanLabel("demo.py") === "demo.py" && cleanLabel("  mon fichier é😀.py ") === "mon fichier é😀.py", "label : un nom de fichier est gardé (accents, emoji, blancs autour retirés)");
  ok(cleanLabel("a".repeat(MAX_LABEL)) !== undefined && cleanLabel("a".repeat(MAX_LABEL + 1)) === undefined && MAX_LABEL === 80, "label : 80 caractères au plus");
  ok([42, null, undefined, {}, [], "", "   ", ".", "..", "dossier/demo.py", "a\\b", "x\ny", "x\u0000y", "x\u202ey".replace("\u202e", "\u2028")].every((v) => cleanLabel(v) === undefined), "label : refusés — pas une chaîne, vide, chemin, caractère de contrôle ou séparateur de ligne");
  ok(labelOfName("/home/enzo/projets/demo.py") === "demo.py" && labelOfName("a\\b\\c.txt") === "c.txt" && labelOfName("sans-titre") === "sans-titre" && labelOfName("") === null && labelOfName("/") === null, "label : on ne garde que le nom de base, jamais le chemin");
  ok(labelOfName("x".repeat(200))!.length === MAX_LABEL, "label : un nom trop long est coupé");
  const codes = node({ codes: [{ docId: id(1), label: "demo.py", x: 1 }, { docId: id(2), label: "/etc/passwd" }, { docId: id(3), label: "z".repeat(81) }, { docId: id(4), label: 12 }, { docId: id(5) }] }).codes!;
  ok(codes[0].label === "demo.py" && codes[0].x === 1 && codes.slice(1).every((c) => c.label === undefined && !("label" in c)), "label : lu dans le scénario, validé entrée par entrée (géométrie conservée)");
  const nbs = node({ notebooks: [{ docId: id(6), label: "carnet.ipynb" }, { docId: id(7), label: " " }] }).notebooks!;
  ok(nbs[0].label === "carnet.ipynb" && nbs[1].label === undefined, "label : même règle pour les notebooks");
}

// Conflict diff choices
{
  const o = diffOutcome;
  ok(o("overwrite").save && !o("overwrite").adopt, "conflit : écraser enregistre sans toucher au document");
  ok(!o("take").save && o("take").adopt, "conflit : prendre la version de la machine remplace le document sans enregistrer");
  ok(!o("cancel").save && !o("cancel").adopt, "conflit : annuler ne fait rien");
}

if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("OK");
