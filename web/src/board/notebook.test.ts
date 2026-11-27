// Unit tests of the notebook rules (pure, no framework):
//   node --experimental-strip-types web/src/board/notebook.test.ts     (or: npx tsx web/src/board/notebook.test.ts)
import * as Y from "yjs";
import {
  MAX_CELLS,
  MAX_OUTPUT_BYTES,
  NotebookFormatError,
  applyKernelEvents,
  beginRun,
  cellViews,
  deleteCell,
  exportIpynb,
  fillNotebook,
  findCell,
  initBlankNotebook,
  insertCell,
  newCellMap,
  kernelCwd,
  moveCell,
  newWriteState,
  ensureOrder,
  orderOf,
  parseIpynb,
  readMeta,
  removeDuplicates,
  setCellType,
  setKernelTerm,
  splitLines,
} from "./notebookDoc.ts";
import { classifyBundle, classifyOutputs, cleanBase64, collapseCarriage, frameDoc, frameHeight, parseAnsi, stripAnsi, markdownFrame } from "./notebookRender.ts";
import { NotebookRunner } from "./notebookRunner.ts";
import { CodeRunner } from "./codeRunner.ts";
import { acquireCode, acquireNotebook, hasNotebookService, type ServiceEnv } from "./notebookService.ts";
import { AAD, box, newSymKey, unbox } from "../crypto.ts";
import { beginCodeRun, clearCodeOutputs, finishCodeRun, initBlank, kernelTermOf as codeKernelTermOf, outputsOf, readMeta as readCodeMeta, readOutputs, setKernelTerm as setCodeKernelTerm } from "./codeDoc.ts";
import { codePointsToUtf16, docMarkdown, mapComplete, utf16ToCodePoints, wordAt } from "./pyComplete.ts";
import { copyDocState, sceneDocIds, sealDoc, type StoredDoc } from "./docCrypto.ts";
import { LineSplitter } from "./kernelProtocol.ts";
import { MAX_NOTEBOOKS, nodeDataOf } from "./nodeData.ts";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};
const el = (customData: unknown) => ({ customData }) as any;
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noPause = () => Promise.resolve();
const throwsFormat = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch (e) {
    return e instanceof NotebookFormatError;
  }
};

/** Two documents that exchange their updates (immediately, or when `sync()` is called). */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  let live = true;
  const pending: [Y.Doc, Uint8Array][] = [];
  a.on("update", (u: Uint8Array, o: unknown) => o !== "net" && (live ? Y.applyUpdate(b, u, "net") : pending.push([b, u])));
  b.on("update", (u: Uint8Array, o: unknown) => o !== "net" && (live ? Y.applyUpdate(a, u, "net") : pending.push([a, u])));
  return {
    a,
    b,
    offline: () => (live = false),
    sync: () => {
      live = true;
      for (const [d, u] of pending.splice(0)) Y.applyUpdate(d, u, "net");
    },
  };
}
const ids = (d: Y.Doc) => cellViews(d).map((c) => c.id);
const text = (d: Y.Doc, id: string) => findCell(d, id)!.source.toString();

// A notebook as Jupyter writes it (nbformat 4.5): sources as string[], text outputs as string[], sorted keys, 1-space indent.
const SAMPLE = {
  cells: [
    { cell_type: "markdown", id: "intro", metadata: {}, source: ["# Titre\n", "\n", "Du *texte*."] },
    {
      cell_type: "code",
      execution_count: 2,
      id: "calc",
      metadata: { tags: ["demo"] },
      outputs: [
        { name: "stdout", output_type: "stream", text: ["42\n", "fin\n"] },
        { data: { "text/plain": ["'é'"] }, execution_count: 2, metadata: {}, output_type: "execute_result" },
        { data: { "application/json": { a: [1, 2] }, "image/png": "iVBORw0KGgo=", "text/html": ["<b>gras</b>"] }, metadata: {}, output_type: "display_data" },
        { ename: "ValueError", evalue: "x", output_type: "error", traceback: ["\u001b[0;31mValueError\u001b[0m"] },
      ],
      source: ["x = 41\n", "print(x + 1)"],
    },
    { cell_type: "code", execution_count: null, id: "vide", metadata: {}, outputs: [], source: [] },
    { cell_type: "raw", id: "brut", metadata: { format: "text/plain" }, source: ["texte brut"] },
  ],
  metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python", version: "3.12" } },
  nbformat: 4,
  nbformat_minor: 5,
};
const SAMPLE_TEXT = JSON.stringify(SAMPLE, null, 1) + "\n";

// 1. .ipynb import / export
{
  ok(JSON.stringify(splitLines("a\nb\n\nc")) === '["a\\n","b\\n","\\n","c"]' && splitLines("").length === 0 && JSON.stringify(splitLines("x\n")) === '["x\\n"]', "ipynb : coupe en lignes comme Jupyter (fins de ligne gardées, vide = [])");
  const nb = parseIpynb(SAMPLE_TEXT);
  ok(nb.cells.length === 4 && nb.cells[0].source === "# Titre\n\nDu *texte*." && nb.cells[3].source === "texte brut", "ipynb : source en string[] ou en string, jointe");
  ok(parseIpynb('{"nbformat":4,"cells":[{"cell_type":"raw","metadata":{},"source":"a\\nb"}],"metadata":{}}').cells[0].source === "a\nb", "ipynb : source donnée en simple chaîne");
  ok(nb.cells[1].source === "x = 41\nprint(x + 1)" && nb.cells[1].executionCount === 2 && nb.cells[2].executionCount === null && nb.cells[2].source === "", "ipynb : execution_count (nombre ou null), source vide");
  ok(nb.cells[1].outputs[0].text === "42\nfin\n" && nb.cells[1].outputs[1].data["text/plain"] === "'é'", "ipynb : les sorties texte en tableau sont jointes");
  ok(nb.cells[1].outputs[2].data["application/json"] === '{"a":[1,2]}' && nb.cells[1].outputs[2].data["image/png"] === "iVBORw0KGgo=", "ipynb : un JSON de sortie devient du texte, une image reste en base64");
  ok(nb.cells[1].id === "calc" && nb.kernel === "python3" && nb.minor === 5, "ipynb : identifiants de cellule, noyau et version mineure conservés");

  const d = new Y.Doc();
  await fillNotebook(d, nb, { name: "demo.ipynb", path: "/tmp/demo.ipynb", sha: "a".repeat(64), pause: noPause });
  ok(exportIpynb(d) === SAMPLE_TEXT, "ipynb : import puis export redonnent exactement le fichier (clés triées, indentation 1, retour final)");
  const again = new Y.Doc();
  await fillNotebook(again, parseIpynb(exportIpynb(d)), { name: "demo.ipynb", sha: "b".repeat(64), pause: noPause });
  ok(exportIpynb(again) === SAMPLE_TEXT, "ipynb : l'aller-retour est stable");
  ok(readMeta(d.getMap("meta")).path === "/tmp/demo.ipynb" && readMeta(d.getMap("meta")).savedSha === "a".repeat(64), "ipynb : le chemin et l'empreinte du fichier sont dans les métadonnées");

  // Older minor versions without cell ids, attachments, unknown outputs and cell types.
  const old = JSON.stringify({
    cells: [
      { cell_type: "code", execution_count: 1, metadata: {}, outputs: [{ output_type: "weird" }, { output_type: "stream", name: "stderr", text: "e" }], source: "1" },
      { cell_type: "markdown", metadata: {}, source: "![x](attachment:a.png)", attachments: { "a.png": { "image/png": "AAAA" } } },
      { cell_type: "alien", source: "?" },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 2,
  });
  const o = parseIpynb(old);
  ok(o.cells.length === 2 && o.cells[0].id.length === 36 && o.cells[0].id !== o.cells[1].id, "ipynb : sans identifiants (nbformat < 4.5), de nouveaux sont créés");
  ok(o.warnings.some((w) => /pièces jointes/.test(w)) && o.warnings.some((w) => /inconnu/.test(w)) && o.cells[0].outputs.length === 1, "ipynb : pièces jointes, sorties et cellules inconnues ignorées avec avertissement");
  const od = new Y.Doc();
  await fillNotebook(od, o, { name: "vieux.ipynb", sha: "c".repeat(64), pause: noPause });
  ok(JSON.parse(exportIpynb(od)).nbformat_minor === 5 && JSON.parse(exportIpynb(od)).cells.every((c: any) => typeof c.id === "string"), "ipynb : l'export est du nbformat 4.5 avec identifiants");

  ok(throwsFormat(() => parseIpynb("pas du json")) && throwsFormat(() => parseIpynb("[]")) && throwsFormat(() => parseIpynb('{"nbformat":3,"cells":[]}')) && throwsFormat(() => parseIpynb('{"nbformat":4}')), "ipynb : refuse ce qui n'est pas un notebook nbformat 4");
  ok(throwsFormat(() => parseIpynb(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: Array.from({ length: MAX_CELLS + 1 }, () => ({ cell_type: "raw", metadata: {}, source: "" })) }))), "ipynb : trop de cellules refusé");

  // A huge output is replaced by a note instead of blowing the size of an update.
  const big = parseIpynb(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", id: "g", execution_count: 1, metadata: {}, source: "", outputs: [{ output_type: "display_data", metadata: {}, data: { "image/png": "A".repeat(400_000), "text/plain": ["<Figure>"] } }] }] }));
  const out = big.cells[0].outputs[0];
  ok(JSON.stringify(out).length < MAX_OUTPUT_BYTES && !("image/png" in out.data) && /trop volumineuse/.test(out.data["text/plain"]) && out.data["text/plain"].startsWith("<Figure>"), "ipynb : une sortie énorme est remplacée par une note (le texte reste)");

  // Big notebooks are filled in several updates.
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, type: "code" as const, source: "x".repeat(20_000), outputs: [], executionCount: null, metadata: {} }));
  const big2 = new Y.Doc();
  let updates = 0;
  big2.on("update", () => updates++);
  await fillNotebook(big2, { cells: many, metadata: {}, minor: 5, warnings: [] }, { name: "gros.ipynb", sha: "d".repeat(64), pause: noPause });
  ok(cellViews(big2).length === 40 && updates >= 4, `ipynb : 800 Kio de code arrivent en ${updates} mises à jour, pas en une seule`);
  const doc2 = new Y.Doc();
  await fillNotebook(doc2, parseIpynb(SAMPLE_TEXT), { name: "a.ipynb", sha: "e".repeat(64), pause: noPause });
  await fillNotebook(doc2, { cells: [{ id: "nouveau", type: "raw", source: "n", outputs: [], executionCount: null, metadata: {} }], metadata: {}, minor: 5, warnings: [] }, { name: "a.ipynb", sha: "f".repeat(64), replace: true, pause: noPause });
  ok(ids(doc2).join() === "nouveau", "ipynb : « recharger » remplace toutes les cellules");
  ok(kernelCwd("/home/x/nb/a.ipynb") === "/home/x/nb" && kernelCwd("/a.ipynb") === "/" && kernelCwd("rel/a.ipynb") === undefined && kernelCwd(undefined) === undefined, "noyau : le dossier de travail est celui du notebook (chemin absolu seulement)");
}

// 2. Cell operations under concurrent edits
{
  const { a, b, offline, sync } = pair();
  initBlankNotebook(a);
  const first = ids(a)[0];
  ok(ids(b).join() === first && readMeta(b.getMap("meta")).name === "sans-titre.ipynb" && !initBlankNotebook(b), "cellules : un notebook neuf a une cellule vide, il ne s'initialise qu'une fois");

  // Concurrent inserts above / below the same cell, plus typing inside it.
  offline();
  const up = insertCell(a, { type: "code", source: "A", at: { before: first } });
  const down = insertCell(b, { type: "markdown", source: "B", at: { after: first } });
  findCell(b, first)!.source.insert(0, "x = 1");
  findCell(a, first)!.source.insert(0, "# ");
  sync();
  ok(ids(a).join() === ids(b).join() && ids(a).length === 3 && ids(a)[0] === up && ids(a)[2] === down, "cellules : insertions simultanées au-dessus et au-dessous, même ordre partout");
  ok(text(a, first) === text(b, first) && /x = 1/.test(text(a, first)) && /# /.test(text(a, first)), "cellules : la frappe simultanée dans la cellule est fusionnée, pas écrasée");

  // Delete while somebody types in another cell.
  offline();
  deleteCell(a, up);
  findCell(b, down)!.source.insert(1, "!");
  sync();
  ok(ids(a).join() === ids(b).join() && !ids(a).includes(up) && text(a, down) === "B!", "cellules : suppression d'une cellule pendant la frappe dans une autre");

  // Concurrent delete and edit of the SAME cell: the delete wins on both sides.
  offline();
  deleteCell(a, down);
  findCell(b, down)!.source.insert(0, "perdu");
  sync();
  ok(ids(a).join() === ids(b).join() && ids(a).length === 1, "cellules : supprimer et modifier la même cellule converge");

  // Move, and the duplicate left by two simultaneous moves.
  const c2 = insertCell(a, { type: "code", source: "2", at: "end" });
  const c3 = insertCell(a, { type: "code", source: "3", at: "end" });
  ok(moveCell(a, c3, -1) && ids(b).join() === [first, c3, c2].join() && text(b, c3) === "3", "cellules : monter une cellule (même cellule, même identifiant, seul l'ordre change)");
  ok(!moveCell(a, first, -1) && !moveCell(a, c2, 1), "cellules : on ne sort pas des bornes");
  offline();
  moveCell(a, c2, -1);
  moveCell(b, c2, -1);
  sync();
  ok(ids(a).length === 3 && ids(a).join() === ids(b).join() && orderOf(a).length === 4, "cellules : deux déplacements simultanés laissent un identifiant en double dans l'ordre, que la lecture ignore");
  const removedA = removeDuplicates(a);
  const removedB = removeDuplicates(b);
  ok(removedA === 1 && removedB <= 1 && orderOf(a).length === 3 && orderOf(b).length === 3 && ids(a).join() === ids(b).join(), "cellules : le nettoyage des doublons converge (idempotent entre clients)");
  sync();
  ok(orderOf(a).length === 3 && orderOf(b).length === 3 && a.getArray("cells").length === 3, "cellules : …et la cellule elle-même n'a jamais été dupliquée");

  // Type change drops outputs.
  const cc = ids(a)[0];
  beginRun(a, cc, "r1");
  applyKernelEvents(a, cc, "r1", [{ ev: "stream", id: "r1", name: "stdout", text: "o" }, { ev: "done", id: "r1", count: 3, status: "ok" }], newWriteState());
  ok(findCell(b, cc)!.outputs.length === 1 && findCell(b, cc)!.executionCount === 3, "cellules : les sorties arrivent chez l'autre participant");
  ok(setCellType(a, cc, "markdown") && findCell(b, cc)!.type === "markdown" && findCell(b, cc)!.outputs.length === 0 && findCell(b, cc)!.executionCount === null, "cellules : passer en Markdown efface sorties et compteur");
  // Limits.
  const full = new Y.Doc();
  for (let i = 0; i < MAX_CELLS; i++) insertCell(full, { type: "raw", at: "end" });
  let refused = false;
  try {
    insertCell(full, { type: "raw", at: "end" });
  } catch {
    refused = true;
  }
  ok(refused, `cellules : ${MAX_CELLS} au maximum`);
  // Garbage written by an editor is ignored, not fatal.
  const g = new Y.Doc();
  g.getArray("cells").push([new Y.Map() as any, "pas une cellule" as any, 42 as any]);
  ok(cellViews(g).length === 0, "cellules : une entrée mal formée est ignorée");
  setKernelTerm(a, "A".repeat(22));
  ok(readMeta(b.getMap("meta")).kernelTerm === "A".repeat(22), "noyau : l'identifiant de session est partagé par les métadonnées");
  b.getMap("meta").set("kernelTerm", "../../etc");
  ok(readMeta(b.getMap("meta")).kernelTerm === undefined, "noyau : un identifiant de session invalide est ignoré");
}

// 3. Kernel events into a cell (merging, clearing, display updates, limits)
{
  const d = new Y.Doc();
  initBlankNotebook(d);
  const id = ids(d)[0];
  const st = newWriteState();
  ok(beginRun(d, id, "run1").ok && !beginRun(d, id, "run2").ok && findCell(d, id)!.running === "run1", "exécution : une cellule déjà en cours n'est pas relancée");
  findCell(d, id)!.map.get("outputs").push([{ output_type: "stream", name: "stdout", text: "ancien" }]);
  ok(applyKernelEvents(d, id, "autre", [{ ev: "stream", id: "autre", name: "stdout", text: "x" }], st) === false && findCell(d, id)!.outputs.length === 1, "exécution : les événements d'un autre identifiant sont ignorés");
  beginRun(d, id, "run1"); // refused: still running, outputs kept
  const clear = new Y.Doc();
  initBlankNotebook(clear);
  const cid = ids(clear)[0];
  beginRun(clear, cid, "r");
  ok(findCell(clear, cid)!.outputs.length === 0, "exécution : lancer efface les sorties dans la même transaction que `running`");
  const s2 = newWriteState();
  applyKernelEvents(clear, cid, "r", [
    { ev: "stream", id: "r", name: "stdout", text: "a" },
    { ev: "stream", id: "r", name: "stdout", text: "b\n" },
    { ev: "stream", id: "r", name: "stderr", text: "e" },
    { ev: "stream", id: "r", name: "stdout", text: "c" },
  ], s2);
  const outs = findCell(clear, cid)!.outputs;
  ok(outs.length === 3 && outs[0].text === "ab\n" && outs[1].name === "stderr" && outs[2].text === "c", "exécution : les flux consécutifs du même nom sont fusionnés comme dans Jupyter");
  applyKernelEvents(clear, cid, "r", [{ ev: "display", id: "r", data: { "text/plain": "<A>" }, metadata: {}, display_id: "d1" }], s2);
  applyKernelEvents(clear, cid, "r", [{ ev: "update", id: "r", display_id: "d1", data: { "text/plain": "<B>" }, metadata: {} }], s2);
  ok(findCell(clear, cid)!.outputs.length === 4 && findCell(clear, cid)!.outputs[3].data["text/plain"] === "<B>", "exécution : update_display_data remplace la sortie du même display_id");
  applyKernelEvents(clear, cid, "r", [{ ev: "clear", id: "r", wait: true }], s2);
  ok(findCell(clear, cid)!.outputs.length === 4, "exécution : clear_output(wait=True) attend la sortie suivante");
  applyKernelEvents(clear, cid, "r", [{ ev: "stream", id: "r", name: "stdout", text: "neuf" }], s2);
  ok(findCell(clear, cid)!.outputs.length === 1 && findCell(clear, cid)!.outputs[0].text === "neuf", "exécution : …puis efface tout avant d'écrire");
  applyKernelEvents(clear, cid, "r", [{ ev: "error", id: "r", ename: "ValueError", evalue: "x", traceback: ["tb"] }, { ev: "result", id: "r", count: 7, data: { "text/plain": "7" } }], s2);
  ok(findCell(clear, cid)!.outputs.at(-1)!.output_type === "execute_result" && findCell(clear, cid)!.outputs.at(-2)!.output_type === "error", "exécution : erreur et résultat");
  const fin = applyKernelEvents(clear, cid, "r", [{ ev: "done", id: "r", count: 7, status: "ok" }], s2);
  ok(fin && findCell(clear, cid)!.running === undefined && findCell(clear, cid)!.executionCount === 7, "exécution : `done` enregistre le compteur et termine l'exécution");
  ok(!applyKernelEvents(clear, cid, "r", [{ ev: "stream", id: "r", name: "stdout", text: "tard" }], s2) && findCell(clear, cid)!.outputs.length === 3, "exécution : après `done`, plus rien n'est écrit");

  // Big streams are cut in small items and capped.
  const bigDoc = new Y.Doc();
  initBlankNotebook(bigDoc);
  const bid = ids(bigDoc)[0];
  beginRun(bigDoc, bid, "big");
  const sb = newWriteState();
  const sizes: number[] = [];
  bigDoc.on("update", (u: Uint8Array) => sizes.push(u.length));
  for (let i = 0; i < 40; i++) applyKernelEvents(bigDoc, bid, "big", [{ ev: "stream", id: "big", name: "stdout", text: "é".repeat(50_000) }], sb);
  const bo = findCell(bigDoc, bid)!.outputs;
  const total = bo.reduce((n, o) => n + (o.text?.length ?? 0), 0);
  ok(bo.every((o) => o.text.length <= 33_000) && total <= 1024 * 1024 + 100 && /tronquée/.test(bo.at(-1)!.text), "exécution : un flux énorme est découpé, plafonné à 1 Mio, avec la mention « tronquée »");
  ok(Math.max(...sizes) < 380 * 1024, "exécution : chaque mise à jour du document reste sous 380 Kio");
  const emoji = new Y.Doc();
  initBlankNotebook(emoji);
  const eid = ids(emoji)[0];
  beginRun(emoji, eid, "e");
  applyKernelEvents(emoji, eid, "e", [{ ev: "stream", id: "e", name: "stdout", text: "😀".repeat(40_000) }], newWriteState());
  ok(findCell(emoji, eid)!.outputs.every((o) => !/[\ud800-\udbff]$/.test(o.text) && !/^[\udc00-\udfff]/.test(o.text)), "exécution : on ne coupe jamais une paire de substitution");
  const huge = new Y.Doc();
  initBlankNotebook(huge);
  const hid = ids(huge)[0];
  beginRun(huge, hid, "h");
  applyKernelEvents(huge, hid, "h", [{ ev: "display", id: "h", data: { "image/png": "A".repeat(500_000), "text/plain": "<Fig>" }, metadata: {} }], newWriteState());
  ok(!("image/png" in findCell(huge, hid)!.outputs[0].data) && /Fig/.test(findCell(huge, hid)!.outputs[0].data["text/plain"]), "exécution : une image trop grosse n'est pas partagée (note à la place)");
}

// 4. Rendering: classification, ANSI, sandbox
{
  ok(stripAnsi("\u001b[0;31mValueError\u001b[0m: \u001b[1;32mok\u001b[0m\u001b]0;titre\u0007 \u001b[2J\u001b[H fin") === "ValueError: ok  fin", "ANSI : codes de couleur, OSC et déplacements retirés");
  const sp = parseAnsi("a\u001b[31mrouge\u001b[1;4;32mvert gras\u001b[0m b\u001b[38;5;196mx\u001b[38;2;1;2;3my\u001b[0m");
  ok(sp.map((s) => s.text).join("") === "arougevert gras bxy" && sp[1].fg === "#cd3131" && sp[2].bold === true && sp[2].underline === true && sp[2].fg === "#0dbc79" && sp[3].fg === undefined && !sp[3].bold, "ANSI : couleurs de base, gras, soulignement, réinitialisation");
  ok(sp[4].fg === "rgb(255,0,0)" && sp[5].fg === "rgb(1,2,3)", "ANSI : 256 couleurs et couleurs vraies sont produites par une table, jamais recopiées de la sortie");
  ok(parseAnsi("\u001b[38;5;999mx").every((s) => s.fg === undefined) && parseAnsi("x\u001b[31;mz")[1]?.fg === undefined, "ANSI : valeurs hors bornes ignorées");
  ok(collapseCarriage("abc\rd\n10%\r50%\r100%\nx\r\ny") === "dbc\n100%\nx\ny", "ANSI : retours chariot (barres de progression)");

  // Everything that can run goes to a sandboxed frame; nothing is ever an HTML string for the app.
  const html = classifyBundle({ "text/html": "<script>alert(1)</script><b>x</b>", "text/plain": "x" });
  ok(html?.kind === "frame" && /<script>alert\(1\)<\/script>/.test(html.srcdoc) && /Content-Security-Policy" content="default-src 'none'/.test(html.srcdoc), "rendu : text/html va dans un cadre isolé avec une CSP sans script");
  const svg = classifyBundle({ "image/svg+xml": '<svg onload="alert(1)"/>', "image/png": "AAAA" });
  ok(svg?.kind === "frame", "rendu : le SVG va dans un cadre isolé (pas dans <img>, pas dans la page)");
  const js = classifyBundle({ "application/javascript": "alert('<b>')" });
  ok(js?.kind === "frame" && !/alert\('<b>'\)/.test(js.srcdoc) && /alert\(&#39;&lt;b&gt;&#39;\)/.test(js.srcdoc), "rendu : le JavaScript n'est jamais exécuté, seulement affiché (échappé) dans un cadre");
  const md = classifyBundle({ "text/markdown": "# <img src=x onerror=1>" }, { markdown: (m) => `<h1>${m}</h1>` });
  ok(md?.kind === "frame" && /<h1># /.test(md.srcdoc), "rendu : le Markdown passe par le convertisseur puis le cadre isolé");
  ok(classifyBundle({ "text/markdown": "<b>" })?.kind === "frame" && /&lt;b&gt;/.test((classifyBundle({ "text/markdown": "<b>" }) as any).srcdoc), "rendu : sans convertisseur, le Markdown est affiché en texte échappé");
  const png = classifyBundle({ "image/png": "iVBORw0KGgo=\n", "text/plain": "<Figure>" });
  ok(png?.kind === "image" && png.src === "data:image/png;base64,iVBORw0KGgo=", "rendu : une image PNG valide devient un data: URL");
  ok(classifyBundle({ "image/png": 'AAAA" onerror="alert(1)' })?.kind === "note" && classifyBundle({ "image/jpeg": "AA AA\nAA==" })?.kind === "image", "rendu : base64 invalide refusé, espaces tolérés");
  ok(cleanBase64("AAAA") === "AAAA" && cleanBase64("") === null && cleanBase64("A\"B") === null && cleanBase64("A=B") === null && cleanBase64("<svg>") === null, "rendu : alphabet base64 strict");
  ok(classifyBundle({ "text/plain": "<b>x</b>" })?.kind === "text" && (classifyBundle({ "text/plain": "<b>x</b>" }) as any).text === "<b>x</b>", "rendu : le texte reste du texte (le DOM en fera un nœud texte)");
  ok(classifyBundle({ "application/vnd.jupyter.widget-view+json": "{}" })?.kind === "note" && classifyBundle({})?.kind === undefined, "rendu : widgets non pris en charge, bundle vide = rien");
  {
    const f = frameDoc('<p>a</p><META http-equiv="refresh" content="0;url=https://exemple.invalid/"><meta http-equiv=refresh content=0>', false);
    ok(!/refresh/i.test(f) && !/exemple\.invalid/.test(f) && /<base target="_blank">/.test(f), "rendu : aucune balise meta du notebook (pas de redirection automatique), liens sans navigation");
    const nested = frameDoc('<me<meta>ta http-equiv="refresh" content="0;url=https://exemple.invalid/">', false);
    const unclosed = frameDoc('<p>a</p><meta http-equiv=refresh content="0;url=https://exemple.invalid/"', false);
    ok(!/refresh/i.test(nested) && !/refresh/i.test(unclosed), "rendu : une balise meta imbriquée ou non fermée est retirée aussi");
  }
  ok(/sandbox/.test("") === false && !/<script/.test(frameDoc("x", true).replace("</head>", "")) , "rendu : le gabarit du cadre ne contient aucun script");

  const items = classifyOutputs([
    { output_type: "stream", name: "stdout", text: "a" },
    { output_type: "stream", name: "stdout", text: "b\r\nc\rd" },
    { output_type: "stream", name: "stderr", text: "\u001b[31merr" },
    { output_type: "error", ename: "\u001b[31mE", evalue: "v\u001b[0m", traceback: ["\u001b[0;31mline1\u001b[0m", "line2"] },
    { output_type: "display_data", data: { "text/html": "<i>h</i>" }, metadata: {} },
  ]);
  ok(items.length === 4 && items[0].kind === "text" && (items[0] as any).text === "ab\nd" && items[1].kind === "text" && (items[1] as any).stream === "stderr", "rendu : flux fusionnés, retours chariot appliqués");
  ok(items[2].kind === "error" && (items[2] as any).traceback === "line1\nline2" && (items[2] as any).ename === "E" && items[3].kind === "frame", "rendu : l'erreur est sans ANSI, le HTML dans un cadre");
  const table = "<table>" + "<tr><td>a</td></tr>".repeat(200) + "</table>";
  ok(frameHeight("html", "<b>x</b>") < 100 && frameHeight("html", table) === 420 && frameHeight("svg", "<svg height='20' width='5'/>") === 56 && frameHeight("svg", "<svg/>") === 240 && frameHeight("text", "a") >= 56 && frameHeight("text", "x\n".repeat(500)) === 460, "rendu : hauteur des cadres estimée d'après le contenu, bornée");
  const capped = classifyOutputs([{ output_type: "stream", name: "stdout", text: "x".repeat(5000) }, { output_type: "stream", name: "stderr", text: "y".repeat(5000) }], { maxText: 1000 });
  ok(capped.length === 2 && (capped[0] as any).text.length === 1000 && (capped[1] as any).text === "[sortie tronquée]", "rendu : le texte affiché est plafonné, avec la mention « sortie tronquée »");
  ok(/<pre style="white-space:pre-wrap">&lt;b&gt;/.test(markdownFrame("<b>", undefined, false)) && /<h1>/.test(markdownFrame("# t", (m) => `<h1>${m}</h1>`, true)), "rendu : cellule Markdown sans convertisseur = texte échappé");
}

// 5. nodeDataOf: `notebooks`
{
  const docId = "A".repeat(22);
  const base = { node: true, shells: [{ terminalId: "t" }] };
  ok(nodeDataOf(el({ ...base, notebooks: [{ docId, x: 1, y: 2, w: 800, h: 600 }] }))?.notebooks?.[0]?.w === 800, "nodeData : notebooks conservés avec leur géométrie");
  ok(nodeDataOf(el({ ...base, notebooks: [{ docId: "court" }, { docId: "../../etc/passwd" }, { docId: 12 }, null, "x", { docId: `${"B".repeat(21)}!` }] }))?.notebooks?.length === 0, "nodeData : identifiants de notebook invalides écartés");
  ok(nodeDataOf(el({ ...base, notebooks: [{ docId }, { docId }] }))?.notebooks?.length === 1, "nodeData : pas de doublon");
  const lots = Array.from({ length: 50 }, (_, i) => ({ docId: String(i).padStart(22, "N") }));
  ok(nodeDataOf(el({ ...base, notebooks: lots }))?.notebooks?.length === MAX_NOTEBOOKS && MAX_NOTEBOOKS === 32, "nodeData : 32 notebooks au maximum");
  ok(nodeDataOf(el({ ...base, notebooks: "oups" }))?.notebooks?.length === 0 && nodeDataOf(el(base))?.notebooks?.length === 0, "nodeData : notebooks absent ou invalide = liste vide");
  ok(nodeDataOf(el({ ...base, codes: [{ docId }], notebooks: [{ docId: "C".repeat(22) }] }))?.codes?.length === 1, "nodeData : codes et notebooks sont indépendants");
}

// 6. Runner: one executor, everybody sees the outputs; an orphaned run is finalized
{
  /** A fake kernel session: what the executors send is answered line by line, everybody gets the output stream. */
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  type L = { onReplay(d: Uint8Array): void; onData(d: Uint8Array): void };
  const listeners = new Set<L>();
  const history: Uint8Array[] = [];
  const sent: string[] = [];
  const emit = (ev: object) => {
    const b = enc.encode(JSON.stringify(ev) + "\n");
    history.push(b);
    for (const l of listeners) l.onData(b);
  };
  let reqBuf = "";
  const port = {
    subscribe(_t: string, l: L) {
      listeners.add(l);
      l.onReplay(enc.encode(history.map((h) => dec.decode(h)).join("")));
      return () => listeners.delete(l);
    },
    input(_t: string, data: Uint8Array) {
      reqBuf += dec.decode(data, { stream: true });
      for (const line of reqBuf.split("\n").slice(0, -1)) sent.push(line);
      reqBuf = reqBuf.split("\n").at(-1)!;
    },
  };
  const { a, b, offline, sync } = pair();
  initBlankNotebook(a);
  const cell = ids(a)[0];
  findCell(a, cell)!.source.insert(0, "print(41 + 1)");
  const awA = { states: new Map<number, any>(), getStates() { return this.states; }, setLocalStateField(k: string, v: unknown) { this.states.set(1, { ...(this.states.get(1) ?? {}), [k]: v }); } };
  const awB = { states: new Map<number, any>(), getStates() { return new Map([...awA.states, ...this.states]); }, setLocalStateField(k: string, v: unknown) { this.states.set(2, { ...(this.states.get(2) ?? {}), [k]: v }); } };
  const ra = new NotebookRunner(a, port, { awareness: awA, canEdit: true });
  const rb = new NotebookRunner(b, port, { awareness: awB, canEdit: true });
  const TERM = "T".repeat(22);
  emit({ ev: "ready", kernel: "python3", language: "python", version: "3" });
  emit({ ev: "status", state: "idle" });
  ra.attach(TERM);
  rb.attach(TERM);
  ok(ra.status === "idle" && rb.status === "idle", "noyau : l'état vient du flux rejoué");
  ok(sent.length === 2 && sent.every((l) => JSON.parse(l).op === "ping"), "noyau : chaque éditeur envoie un ping en s'attachant");
  sent.length = 0;
  const r = ra.run(cell);
  ok(r.ok && sent.length === 1 && JSON.parse(sent[0]).op === "exec" && JSON.parse(sent[0]).code === "print(41 + 1)" && JSON.parse(sent[0]).id === (r.ok ? r.execId : ""), "noyau : l'exécuteur envoie une seule ligne exec");
  ok(findCell(b, cell)!.running === (r.ok ? r.execId : "") && JSON.stringify(awA.states.get(1).execs) === JSON.stringify([r.ok ? r.execId : ""]), "noyau : `running` est visible chez l'autre, l'identifiant est annoncé dans la présence");
  const exec = r.ok ? r.execId : "";
  ok(!rb.run(cell).ok, "noyau : l'autre ne peut pas relancer une cellule en cours");
  emit({ ev: "status", state: "busy" });
  emit({ ev: "stream", id: exec, name: "stdout", text: "42\n" });
  emit({ ev: "result", id: exec, count: 1, data: { "text/plain": "42" } });
  emit({ ev: "done", id: exec, count: 1, status: "ok" });
  emit({ ev: "status", state: "idle" });
  await nap(250);
  const seenB = findCell(b, cell)!;
  ok(seenB.outputs[0]?.text === "42\n" && seenB.outputs[1]?.output_type === "execute_result" && seenB.executionCount === 1 && !seenB.running, "noyau : les sorties, le compteur et la fin d'exécution arrivent chez l'autre participant");
  ok(ra.localRuns.length === 0 && JSON.stringify(awA.states.get(1).execs) === "[]" && rb.localRuns.length === 0, "noyau : seul l'exécuteur écrivait, la présence est vidée à la fin");
  ok(!JSON.stringify(a.getArray("cells").toJSON()).includes('"stream","name":"stdout","text":"42\\n"42') , "noyau : les sorties ne sont pas écrites deux fois");
  ok(findCell(a, cell)!.outputs.length === 2, "noyau : exactement deux sorties (pas de doublon des autres clients)");

  // Late joiner: the replay carries the old events, whose ids are nobody's: nothing is rewritten.
  const rc = new NotebookRunner(new Y.Doc(), port, { canEdit: true });
  rc.attach(TERM);
  ok(rc.status === "idle", "noyau : un nouveau venu rejoue le flux sans rien réécrire");
  rc.destroy();

  // The executor disappears mid-run; the kernel finishes, someone else finalizes the run.
  const r2 = ra.run(cell);
  const exec2 = r2.ok ? r2.execId : "";
  ra.destroy();
  awA.states.clear();
  emit({ ev: "status", state: "busy" });
  emit({ ev: "stream", id: exec2, name: "stdout", text: "perdu\n" });
  emit({ ev: "done", id: exec2, count: 2, status: "ok" });
  emit({ ev: "status", state: "idle" });
  await nap(120);
  ok(findCell(b, cell)!.running === exec2, "noyau : un exécuteur disparu laisse la cellule en cours…");
  rb.sweep(Date.now() + 1000);
  ok(findCell(b, cell)!.running === exec2, "noyau : …on attend 5 s avant de conclure");
  rb.sweep(Date.now() + 6000);
  ok(!findCell(b, cell)!.running && findCell(b, cell)!.executionCount === 2, "noyau : après 5 s, un autre éditeur termine l'exécution (compteur du `done`)");
  sync();
  ok(findCell(a, cell)!.running === undefined, "noyau : tout le monde voit la fin");

  // A presence that still announces the run keeps it alive.
  offline();
  sync();
  const rd = new NotebookRunner(b, port, { awareness: awB, canEdit: true });
  rd.attach(TERM);
  b.transact(() => findCell(b, cell)!.map.set("running", "fantome:abc"));
  awA.states.set(1, { execs: ["fantome:abc"] });
  rd.sweep(Date.now());
  rd.sweep(Date.now() + 9000);
  ok(findCell(b, cell)!.running === "fantome:abc", "noyau : un exécuteur encore présent n'est pas écarté");
  awA.states.clear();
  emit({ ev: "status", state: "busy" });
  rd.attach(null);
  rd.attach(TERM);
  rd.sweep(Date.now() + 20000);
  ok(findCell(b, cell)!.running === "fantome:abc", "noyau : sans `done` et noyau occupé, on n'abandonne pas une exécution peut-être en file");
  emit({ ev: "status", state: "idle" });
  rd.sweep(Date.now() + 40000);
  ok(!findCell(b, cell)!.running, "noyau : sans `done` et noyau au repos, l'exécution perdue est libérée");
  rd.destroy();

  // The kernel goes away while a run is in flight: the executor ends it with an error.
  const re = new NotebookRunner(a, port, { awareness: awA, canEdit: true });
  re.attach(TERM);
  emit({ ev: "status", state: "idle" });
  const r3 = re.run(cell);
  ok(r3.ok, "noyau : relancer après la fin");
  re.terminalGone();
  ok(!findCell(a, cell)!.running && findCell(a, cell)!.outputs.at(-1)!.output_type === "error" && !re.run(cell).ok, "noyau : la session s'arrête → l'exécution se termine par une erreur, plus de lancement possible");
  re.destroy();

  // Read-only participants never write nor send.
  const ro = new NotebookRunner(b, port, { canEdit: false });
  ro.attach(TERM);
  const before = sent.length;
  ok(!ro.run(cell).ok && !ro.interrupt() && !ro.restart() && sent.length === before, "noyau : un lecteur ne peut ni lancer, ni interrompre, ni redémarrer");
  ro.destroy();
  rb.destroy();

  // Splitting long code into several frames keeps one line.
  const d3 = new Y.Doc();
  initBlankNotebook(d3);
  const big = ids(d3)[0];
  findCell(d3, big)!.source.insert(0, "# é\n" + "x = 'é😀'\n".repeat(30_000));
  const frames: Uint8Array[] = [];
  const p3 = { subscribe: (_t: string, _l: L) => () => {}, input: (_t: string, d: Uint8Array) => void frames.push(d.slice()) };
  const rf = new NotebookRunner(d3, p3, { canEdit: true });
  rf.attach(TERM);
  frames.length = 0; // the ping sent on attach
  ok(rf.run(big).ok && frames.length > 4 && frames.every((f) => f.length <= 48 * 1024), "noyau : un long code part en plusieurs trames (48 Kio au plus)");
  const joined = new LineSplitter().push(new Uint8Array(frames.flatMap((f) => [...f])));
  ok(joined.length === 1 && JSON.parse(joined[0]).code === findCell(d3, big)!.source.toString(), "noyau : …qui se recollent en une seule ligne JSON identique (UTF-8 intact)");
  rf.destroy();
  const d4 = new Y.Doc();
  initBlankNotebook(d4);
  findCell(d4, ids(d4)[0])!.source.insert(0, "x".repeat(1024 * 1024 + 1));
  const rg = new NotebookRunner(d4, p3, { canEdit: true });
  rg.attach(TERM);
  const tooLong = rg.run(ids(d4)[0]);
  ok(!tooLong.ok && /trop long/.test((tooLong as any).reason) && !findCell(d4, ids(d4)[0])!.running, "noyau : un code de plus de 1 Mio est refusé avant de marquer la cellule en cours");
  rg.destroy();
}

// 7. The notebook service: the runner outlives the window
{
  const enc = new TextEncoder();
  const key = await newSymKey();
  const handlers = new Map<string, any>();
  const host = {
    boardId: "board",
    key,
    canEdit: true,
    currentEpoch: 1,
    you: { name: "Alice", color: "#336699" },
    docSend(m: any) {
      if (m.t === "doc.sub") queueMicrotask(() => handlers.get(m.doc)?.onMessage({ t: "doc.state", ups: [] }));
      return true;
    },
    docRegister(doc: string, h: any) {
      handlers.set(doc, h);
      queueMicrotask(() => h.onOpen());
      return () => handlers.delete(doc);
    },
    on: () => () => {},
  };
  type L = { onReplay(d: Uint8Array): void; onData(d: Uint8Array): void };
  const listeners = new Set<L>();
  const sent: string[] = [];
  const emit = (ev: object) => {
    const b = enc.encode(JSON.stringify(ev) + "\n");
    for (const l of listeners) l.onData(b);
  };
  let over = false;
  let watcher: (() => void) | undefined;
  let closeBoard: (() => void) | undefined;
  const env: ServiceEnv = {
    port: {
      subscribe: (_t, l) => (listeners.add(l), () => listeners.delete(l)),
      input: (_t, d) => void sent.push(new TextDecoder().decode(d)),
    },
    watchTerminals: (fn) => ((watcher = fn), () => (watcher = undefined)),
    terminalOver: () => over,
    onClose: (fn) => ((closeBoard = fn), () => (closeBoard = undefined)),
  };
  const TERM = "K".repeat(22);
  const docId = "S".repeat(22);

  const win = acquireNotebook(host, env, docId, { idleMs: 200 });
  await win.doc.synced;
  initBlankNotebook(win.doc.ydoc);
  const cell = ids(win.doc.ydoc)[0];
  findCell(win.doc.ydoc, cell)!.source.insert(0, "print(1)");
  setKernelTerm(win.doc.ydoc, TERM);
  emit({ ev: "status", state: "idle" });
  ok(win.runner.term === TERM, "service : le runner suit la session de noyau du document, sans fenêtre pour le lui dire");
  sent.length = 0; // the ping sent on attach
  const run = win.runner.run(cell);
  ok(run.ok && sent.length === 1, "service : la cellule part au noyau");
  const execId = run.ok ? run.execId : "";

  // The window is hidden in the middle of the run: its handle goes away, the service stays.
  const again = acquireNotebook(host, env, docId, { idleMs: 200 });
  ok(again.runner === win.runner && again.doc === win.doc, "service : une seconde fenêtre rejoint le même runner et le même document");
  win.release();
  again.release();
  await nap(260);
  ok(hasNotebookService(host, docId) && !win.disposed, "service : sans fenêtre mais avec une exécution en cours, il reste en vie");
  emit({ ev: "stream", id: execId, name: "stdout", text: "1\n" });
  emit({ ev: "done", id: execId, count: 1, status: "ok" });
  await nap(200);
  const got = findCell(win.doc.ydoc, cell)!;
  ok(got.outputs[0]?.text === "1\n" && got.executionCount === 1 && !got.running, "service : les sorties arrivent dans le document alors que plus aucune fenêtre n'est ouverte");
  await nap(450);
  ok(!hasNotebookService(host, docId) && win.disposed && !handlers.has(docId) && listeners.size === 0, "service : plus d'exécution ni de fenêtre depuis un moment → libéré (document et noyau)");

  // A window shown again during the grace period finds the service warm; a later one starts a new one.
  const w2 = acquireNotebook(host, env, docId, { idleMs: 150 });
  w2.release();
  await nap(60);
  const w3 = acquireNotebook(host, env, docId, { idleMs: 150 });
  ok(w3.runner === w2.runner && !w3.disposed, "service : rouvrir la fenêtre avant l'échéance retrouve le même service");
  w3.release();
  await nap(300);
  ok(w3.disposed, "service : …et il disparaît une fois l'échéance passée");

  // Document deleted: the service goes away even with a window open.
  const w4 = acquireNotebook(host, env, docId, { idleMs: 5000 });
  await w4.doc.synced;
  handlers.get(docId).onMessage({ t: "doc.gone", doc: docId });
  ok(w4.disposed && !hasNotebookService(host, docId), "service : document supprimé → runner et abonnement libérés");
  w4.release();

  // Board closed.
  const w5 = acquireNotebook(host, env, docId, { idleMs: 5000 });
  closeBoard?.();
  ok(w5.disposed && listeners.size === 0, "service : tableau fermé → tout est libéré");
  w5.release();

  // The kernel session ends while a run is in flight: the service (not a window) ends it with an error.
  const w6 = acquireNotebook(host, env, docId, { idleMs: 5000 });
  await w6.doc.synced;
  initBlankNotebook(w6.doc.ydoc);
  const c6 = ids(w6.doc.ydoc)[0];
  setKernelTerm(w6.doc.ydoc, TERM);
  emit({ ev: "status", state: "idle" });
  ok(w6.runner.run(c6).ok, "service : exécution lancée");
  w6.release();
  over = true;
  watcher?.();
  ok(!findCell(w6.doc.ydoc, c6)!.running && findCell(w6.doc.ydoc, c6)!.outputs.at(-1)!.output_type === "error", "service : la session de noyau disparaît fenêtre masquée → l'exécution se termine par une erreur");
  closeBoard?.();
}

// 8. Stable cell identity: moving only touches the order
{
  // Typing in a cell while somebody moves it: nothing is lost, in both directions.
  const { a, b, offline, sync } = pair();
  initBlankNotebook(a);
  const c1 = ids(a)[0];
  const c2 = insertCell(a, { type: "code", source: "deux", at: "end" });
  const c3 = insertCell(a, { type: "code", source: "trois", at: "end" });
  offline();
  moveCell(a, c1, 1);
  findCell(b, c1)!.source.insert(0, "frappé pendant le déplacement ");
  findCell(b, c1)!.source.insert(findCell(b, c1)!.source.length, " et la suite");
  sync();
  ok(ids(a).join() === [c2, c1, c3].join() && ids(b).join() === ids(a).join() && text(a, c1) === "frappé pendant le déplacement  et la suite" && text(b, c1) === text(a, c1), "déplacement : la frappe simultanée dans la cellule déplacée n'est pas perdue");
  const mapBefore = findCell(a, c1)!.map;
  moveCell(a, c1, 1);
  ok(findCell(a, c1)!.map === mapBefore && a.getArray("cells").length === 3, "déplacement : la cellule est la même (même Y.Map), pas une copie");
  offline();
  moveCell(a, c3, -1);
  findCell(b, c3)!.source.insert(5, "!");
  findCell(a, c2)!.source.insert(0, "A:");
  moveCell(b, c2, 1);
  sync();
  ok(ids(a).join() === ids(b).join() && text(a, c3) === "trois!" && text(b, c2) === "A:deux", `déplacements croisés + frappes : tout converge (${ids(a).length} cellules)`);
  // A move concurrent with the deletion of the same cell leaves no ghost.
  offline();
  deleteCell(a, c3);
  moveCell(b, c3, -1);
  sync();
  ok(ids(a).join() === ids(b).join() && !ids(a).includes(c3) && ids(a).length === 2, "déplacement : déplacer une cellule supprimée en même temps ne la ressuscite pas");
  // Insert next to a cell that moves concurrently.
  offline();
  const neu = insertCell(a, { type: "markdown", source: "n", at: { after: c1 } });
  moveCell(b, c1, -1);
  sync();
  ok(ids(a).join() === ids(b).join() && ids(a).includes(neu) && ids(a).length === 3, "déplacement : une insertion pendant un déplacement converge");
  removeDuplicates(a);
  removeDuplicates(b);
  sync();
  ok(orderOf(a).length === ids(a).length && orderOf(b).length === ids(b).length, "déplacement : le nettoyage ne laisse que les identifiants utiles");
}

// 9. Migration of documents written before "order" existed
{
  /** An old notebook: the cells in the "cells" array only, no order. */
  const legacy = (n = 4) => {
    const d = new Y.Doc();
    d.transact(() => {
      d.getMap("meta").set("name", "vieux.ipynb");
      d.getMap("meta").set("nbformatMinor", 5);
      d.getArray("cells").push(Array.from({ length: n }, (_, i) => newCellMap({ type: "code", source: `cellule ${i}`, id: `c${i}` })));
    });
    return d;
  };
  const d = legacy();
  ok(orderOf(d).length === 0 && ids(d).join() === "c0,c1,c2,c3", "migration : un ancien document se lit sans conversion, dans l'ordre de stockage");
  const before = exportIpynb(d);
  ok(ensureOrder(d) && orderOf(d).toArray().join() === "c0,c1,c2,c3" && !ensureOrder(d), "migration : ensureOrder écrit l'ordre une fois (idempotent)");
  ok(exportIpynb(d) === before, "migration : l'export .ipynb est identique avant et après");
  const back = parseIpynb(before);
  const d2 = new Y.Doc();
  await fillNotebook(d2, back, { name: "r.ipynb", sha: "f".repeat(64), pause: noPause });
  ok(JSON.stringify(JSON.parse(exportIpynb(d2)).cells) === JSON.stringify(JSON.parse(before).cells) && ids(d2).join() === "c0,c1,c2,c3" && orderOf(d2).length === 4, "migration : l'import .ipynb écrit cellules et ordre");

  // First edit by an editor converts: a move on an old document.
  const old = legacy();
  const { a, b, offline, sync } = pair();
  Y.applyUpdate(a, Y.encodeStateAsUpdate(old), "net");
  Y.applyUpdate(b, Y.encodeStateAsUpdate(old), "net");
  ok(orderOf(a).length === 0 && ids(a).length === 4, "migration : deux éditeurs ouvrent le même ancien document");
  // Both convert at the same moment (one by moving, one by inserting), while a third edit types.
  offline();
  moveCell(a, "c3", -1);
  const ins = insertCell(b, { type: "code", source: "nouvelle", at: { after: "c0" } });
  findCell(b, "c2")!.source.insert(0, "# ");
  sync();
  ok(ids(a).join() === ids(b).join() && ids(a).length === 5 && new Set(ids(a)).size === 5, `migration : conversions simultanées, même liste partout (${ids(a).join()})`);
  ok(text(a, "c2") === "# cellule 2" && text(b, "c2") === text(a, "c2") && a.getArray("cells").length === 5, "migration : aucune cellule copiée, la frappe simultanée est gardée");
  const ra = removeDuplicates(a);
  const rb = removeDuplicates(b);
  sync();
  ok(ra > 0 && rb <= ra && orderOf(a).length === 5 && orderOf(b).length === 5 && ids(a).join() === ids(b).join() && ids(a).includes(ins), "migration : le nettoyage supprime les identifiants répétés des deux conversions, identique des deux côtés");
  const afterIds = ids(a).join();
  removeDuplicates(a);
  removeDuplicates(b);
  sync();
  ok(ids(a).join() === afterIds && ids(b).join() === afterIds, "migration : nettoyer à nouveau ne change plus rien");

  // Cells the order does not mention (written by an older client) are shown after the known ones; deleting works.
  const mixed = legacy(3);
  ensureOrder(mixed);
  mixed.getArray("cells").push([newCellMap({ type: "markdown", source: "tard", id: "late" })]);
  ok(ids(mixed).join() === "c0,c1,c2,late", "migration : une cellule absente de l'ordre apparaît à la fin");
  ok(moveCell(mixed, "late", -1) && ids(mixed).join() === "c0,c1,late,c2" && orderOf(mixed).length === 4, "migration : la déplacer l'inscrit dans l'ordre");
  ok(deleteCell(mixed, "c1") && ids(mixed).join() === "c0,late,c2" && orderOf(mixed).length === 3, "migration : supprimer retire la cellule et son identifiant");
  // An id that points to nothing and a non-string entry are ignored.
  mixed.getArray("order").push(["fantôme", 42 as any]);
  ok(ids(mixed).join() === "c0,late,c2", "migration : un identifiant sans cellule, ou qui n'est pas une chaîne, est ignoré");
}

// 10. Duplicating a board: documents re-sealed under the new board's key
{
  const oldKey = await newSymKey();
  const newKey = await newSymKey();
  const SRC = "src-board";
  const DST = "dst-board";
  const doc = "D".repeat(22);
  // A notebook with a live kernel session and a running cell, stored as a snapshot plus two updates.
  const y = new Y.Doc();
  const ups: Uint8Array[] = [];
  y.on("update", (u: Uint8Array) => ups.push(u));
  initBlankNotebook(y, "orig.ipynb");
  const cell = ids(y)[0];
  findCell(y, cell)!.source.insert(0, "print('é😀')");
  setKernelTerm(y, "K".repeat(22));
  beginRun(y, cell, "exec:1");
  const stored: StoredDoc = {
    doc,
    epoch: 3,
    snap: await box(oldKey, ups[0], AAD.doc(SRC, doc, 3)),
    snapSeq: 1,
    seq: 3,
    ups: await Promise.all(ups.slice(1).map(async (u, i) => ({ seq: i + 2, d: await box(oldKey, u, AAD.doc(SRC, doc, 3)) }))),
  };
  const copied = await copyDocState(stored, { boardId: SRC, key: oldKey });
  const c = new Y.Doc();
  Y.applyUpdate(c, copied.state);
  ok(copied.doc === doc && findCell(c, cell)!.source.toString() === "print('é😀')" && readMeta(c.getMap("meta")).name === "orig.ipynb", "duplication : le document est relu avec l'ancienne clé, même identifiant, même contenu");
  ok(readMeta(c.getMap("meta")).kernelTerm === undefined && !c.getMap("meta").has("kernelTerm") && !findCell(c, cell)!.running, "duplication : la session de noyau et les cellules « en cours » ne sont pas copiées");
  ok(readMeta(y.getMap("meta")).kernelTerm === "K".repeat(22) && !!findCell(y, cell)!.running, "duplication : l'original n'est pas touché");
  const sealed = await sealDoc(copied.doc, copied.state, { boardId: DST, key: newKey, epoch: 0 });
  const reopened = new Y.Doc();
  Y.applyUpdate(reopened, await unbox(newKey, sealed.d, AAD.doc(DST, doc, 0)));
  ok(findCell(reopened, cell)!.source.toString() === "print('é😀')", "duplication : la copie se lit avec la clé, le tableau et l'epoch du nouveau tableau");
  const fails = async (f: () => Promise<unknown>) => f().then(() => false, () => true);
  ok(
    (await fails(() => unbox(oldKey, sealed.d, AAD.doc(DST, doc, 0)))) && (await fails(() => unbox(newKey, sealed.d, AAD.doc(SRC, doc, 0)))) && (await fails(() => unbox(newKey, sealed.d, AAD.doc(DST, doc, 1)))),
    "duplication : l'ancienne clé ne lit pas la copie, et elle ne se rejoue ni dans l'ancien tableau ni à un autre epoch",
  );
  const bad: StoredDoc = { ...stored, ups: [...stored.ups, { seq: 9, d: await box(newKey, ups[1], AAD.doc(SRC, doc, 3)) }] };
  ok(await fails(() => copyDocState(bad, { boardId: SRC, key: oldKey })), "duplication : une mise à jour qui ne s'authentifie pas interrompt la copie");
  const mk = (customData: unknown, isDeleted = false) => ({ customData, isDeleted });
  const A = "A".repeat(22);
  const B = "B".repeat(22);
  ok(
    sceneDocIds([mk({ node: true, codes: [{ docId: A }], notebooks: [{ docId: B }, { docId: "court" }, { docId: A }, null] }), mk({ node: true, codes: [{ docId: "C".repeat(22) }] }, true), mk({ codeId: "x" }), mk(undefined)]).join() === `${A},${B}`,
    "duplication : les documents à copier sont ceux des icônes du schéma (valides, sans doublon, sans icône supprimée)",
  );
}

// 11. Completion and docstrings: offsets, mapping, requests
{
  const emoji = "x = '😀é'; 😀.na";
  const at = emoji.length;
  ok(utf16ToCodePoints("abc", 2) === 2 && utf16ToCodePoints("é😀é", 3) === 2 && utf16ToCodePoints("é😀é", 4) === 3, "complétion : UTF-16 → points de code (accents : 1, emoji : 2 unités UTF-16 mais 1 point)");
  ok(utf16ToCodePoints("é😀é", 2) === 1 && utf16ToCodePoints("é😀é", 99) === 3 && utf16ToCodePoints("é😀é", -4) === 0, "complétion : un offset au milieu d'une paire de substitution ne compte pas l'emoji ; bornes");
  ok(codePointsToUtf16("é😀é", 2) === 3 && codePointsToUtf16("é😀é", 3) === 4 && codePointsToUtf16("é😀é", 50) === 4 && codePointsToUtf16("😀", 1) === 2, "complétion : points de code → UTF-16");
  ok(utf16ToCodePoints(emoji, at) === [...emoji].length && codePointsToUtf16(emoji, [...emoji].length) === at, "complétion : aller-retour sur un texte avec emoji et accents");
  const code = "s = '😀'\nmath.sq";
  const pos = code.length;
  ok(JSON.stringify(mapComplete(code, pos, { matches: ["sqrt"], start: 13, end: 15 })) === JSON.stringify({ start: pos - 2, end: pos, matches: ["sqrt"] }), "complétion : début et fin du noyau (points de code) convertis en UTF-16 (l'emoji décale de 1)");
  ok(mapComplete(code, pos, { matches: ["a", "a", "", 3 as any, "b\nc", "b"], start: 0, end: 0 })?.matches.join() === "a,b" && mapComplete(code, pos, { matches: [] }) === null && mapComplete(code, pos, { matches: "x" as any }) === null, "complétion : correspondances nettoyées (doublons, vides, non-chaînes, retours à la ligne), rien = null");
  const wild = mapComplete(code, pos, { matches: ["q"], start: 999, end: 3 });
  ok(wild!.start === pos && wild!.end === pos, "complétion : une plage qui n'entoure pas le curseur est ramenée au curseur");
  ok(mapComplete("ab", 2, { matches: ["abc"] })!.start === 2, "complétion : sans bornes, au curseur");
  ok(mapComplete("x", 1, { matches: Array.from({ length: 500 }, (_, i) => `m${i}`) })!.matches.length === 200, "complétion : 200 propositions au plus");
  const md = docMarkdown("\u001b[1;31mSignature:\u001b[0m sqrt(x)\r\nDoc avec ``` et `code` <script>alert(1)</script> [lien](http://x)")!;
  ok(md.startsWith("````text\n") && md.endsWith("\n````") && !md.includes("\u001b") && md.includes("<script>") && !md.includes("\r"), "docstring : ANSI retiré, bloc de code dont la clôture est plus longue que toute série de ` du texte (rien n'est interprété)");
  ok(docMarkdown("x\n".repeat(10000))!.length < 8100 && docMarkdown("   ") === null && docMarkdown(null) === null && docMarkdown(42) === null, "docstring : plafonnée, vide ou pas du texte = rien");
  ok(wordAt("a = math.sqrt(2)", 10)?.start === 9 && wordAt("a = math.sqrt(2)", 8)?.end === 8 && wordAt("a = (", 5) === null && wordAt("é😀x", 3) !== null, "docstring : le mot sous le curseur");

  // Requests through a runner: what goes to the kernel, what comes back, what is never sent.
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  type L = { onReplay(d: Uint8Array): void; onData(d: Uint8Array): void };
  let listener: L | undefined;
  const lines: any[] = [];
  const reply = (ev: object) => listener!.onData(enc.encode(JSON.stringify(ev) + "\n"));
  const port = {
    subscribe: (_t: string, l: L) => ((listener = l), () => (listener = undefined)),
    input: (_t: string, d: Uint8Array) => void lines.push(...dec.decode(d).split("\n").filter(Boolean).map((l) => JSON.parse(l))),
  };
  const run = new NotebookRunner(new Y.Doc(), port, { canEdit: true });
  run.attach("Q".repeat(22));
  reply({ ev: "status", state: "idle" });
  const asked = run.complete(code, pos);
  const req = lines.at(-1);
  ok(req.op === "complete" && req.code === code && req.pos === [...code].length && typeof req.id === "string" && req.id.length <= 64, "complétion : la requête envoie le code et la position en points de code");
  reply({ ev: "complete", id: "autre", matches: ["non"], start: 0, end: 0 });
  reply({ ev: "complete", id: req.id, matches: ["sqrt", "sin"], start: 13, end: 15 });
  const got = await asked;
  ok(got?.matches.join() === "sqrt,sin" && got.start === pos - 2 && got.end === pos, "complétion : seule la réponse portant l'identifiant de la requête est prise, convertie en UTF-16");
  const insp = run.inspect(code, pos);
  const ireq = lines.at(-1);
  reply({ ev: "inspect", id: ireq.id, found: true, data: { "text/plain": "\u001b[31mdoc\u001b[0m de sqrt" } });
  ok((await insp) === "```text\ndoc de sqrt\n```", "docstring : la réponse devient un bloc Markdown, ANSI retiré");
  const none = run.inspect(code, pos);
  reply({ ev: "inspect", id: lines.at(-1).id, found: false, data: {} });
  ok((await none) === null, "docstring : « introuvable » = rien");
  const t0 = Date.now();
  ok((await run.complete(code, pos, { timeoutMs: 120 })) === null && Date.now() - t0 < 1000, "complétion : sans réponse, rendue vide à l'échéance (3 s par défaut)");
  const ac = new AbortController();
  const before = lines.length;
  const stale = run.complete(code, pos, { signal: ac.signal, timeoutMs: 5000 });
  ac.abort();
  ok((await stale) === null && lines.length === before + 1, "complétion : une requête abandonnée rend aussitôt (la réponse tardive est ignorée)");
  reply({ ev: "complete", id: lines.at(-1).id, matches: ["tard"], start: 0, end: 0 });
  reply({ ev: "status", state: "busy" });
  const nb = lines.length;
  ok((await run.complete(code, pos)) === null && (await run.inspect(code, pos)) === null && lines.length === nb && !run.canQuery, "complétion : noyau occupé, rien n'est envoyé (la requête attendrait derrière la cellule en cours)");
  reply({ ev: "status", state: "idle" });
  const viewer = new NotebookRunner(new Y.Doc(), port, { canEdit: false });
  viewer.attach("Q".repeat(22));
  const nv = lines.length;
  ok((await viewer.complete(code, pos)) === null && lines.length === nv && !viewer.canQuery, "complétion : un lecteur ne peut pas taper dans la session, donc rien n'est envoyé");
  const pend = run.complete(code, pos, { timeoutMs: 5000 });
  run.attach(null);
  ok((await pend) === null && (await run.complete(code, pos)) === null, "complétion : session détachée, les requêtes en attente rendent vide");
  run.destroy();
  viewer.destroy();
}

// 12. A code window runs its buffer on a kernel: same executor rules as a notebook cell
{
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  type L = { onReplay(d: Uint8Array): void; onData(d: Uint8Array): void };
  const listeners = new Set<L>();
  const sent: any[] = [];
  const emit = (ev: object) => {
    const b = enc.encode(JSON.stringify(ev) + "\n");
    for (const l of listeners) l.onData(b);
  };
  const port = {
    subscribe: (_t: string, l: L) => (listeners.add(l), () => listeners.delete(l)),
    input: (_t: string, d: Uint8Array) => void sent.push(...dec.decode(d).split("\n").filter(Boolean).map((l) => JSON.parse(l))),
  };
  const TERM = "C".repeat(22);
  const { a, b } = pair();
  initBlank(a, "run.py");
  a.getText("content").insert(0, "print(6 * 7)\n");
  ok(codeKernelTermOf(b) === null && !readCodeMeta(b.getMap("meta")).running, "code : un document neuf n'a ni noyau ni exécution");
  b.getMap("meta").set("kernelTerm", "pas un identifiant");
  ok(codeKernelTermOf(b) === null, "code : un identifiant de session invalide est ignoré");
  setCodeKernelTerm(a, TERM);
  ok(codeKernelTermOf(b) === TERM, "code : l'identifiant de la session de noyau est partagé par le document");
  const ra = new CodeRunner(a, port, { canEdit: true });
  const rb = new CodeRunner(b, port, { canEdit: true });
  ra.attach(TERM);
  rb.attach(TERM);
  emit({ ev: "status", state: "idle" });
  sent.length = 0; // the pings sent on attach
  const r = ra.run(a.getText("content").toString());
  const execId = r.ok ? r.execId : "";
  ok(r.ok && sent.length === 1 && sent[0].op === "exec" && sent[0].code === "print(6 * 7)\n" && sent[0].id === execId, "code : la ligne exec porte le contenu actuel de la fenêtre");
  ok(readCodeMeta(b.getMap("meta")).running === execId && !rb.run("x").ok && !ra.run("x").ok, "code : « en cours » est visible partout et on ne lance pas deux fois");
  a.getText("content").insert(0, "# modifié après le lancement\n");
  emit({ ev: "status", state: "busy" });
  emit({ ev: "stream", id: execId, name: "stdout", text: "42\n" });
  emit({ ev: "result", id: execId, count: 3, data: { "text/plain": "42" } });
  emit({ ev: "done", id: execId, count: 3, status: "ok" });
  emit({ ev: "status", state: "idle" });
  await nap(250);
  const outs = readOutputs(b);
  ok(outs[0]?.text === "42\n" && outs[1]?.output_type === "execute_result" && outs.length === 2 && readCodeMeta(b.getMap("meta")).runCount === 3 && !readCodeMeta(b.getMap("meta")).running, "code : les sorties (« 42 »), le compteur et la fin arrivent chez l'autre participant, une seule fois");
  ok(ra.localRuns.length === 0 && rb.localRuns.length === 0, "code : seul l'exécuteur écrivait");
  // A second run replaces the outputs.
  const r2 = rb.run("print('bis')");
  ok(r2.ok && readOutputs(a).length === 0, "code : relancer efface les sorties précédentes, dans la même transaction");
  const exec2 = r2.ok ? r2.execId : "";
  emit({ ev: "stream", id: exec2, name: "stderr", text: "oups\n" });
  emit({ ev: "error", id: exec2, ename: "ValueError", evalue: "x", traceback: ["\u001b[31mTraceback\u001b[0m"] });
  emit({ ev: "done", id: exec2, count: 4, status: "error" });
  await nap(250);
  ok(readOutputs(a).map((o) => o.output_type).join() === "stream,error" && readCodeMeta(a.getMap("meta")).runCount === 4, "code : flux et erreur sont des sorties nbformat");
  // The executor vanishes: another editor finalizes after 5 s.
  const r3 = ra.run("while True: pass");
  const exec3 = r3.ok ? r3.execId : "";
  ra.destroy();
  emit({ ev: "done", id: exec3, count: 5, status: "ok" });
  await nap(100);
  rb.sweep(Date.now() + 1000);
  ok(readCodeMeta(b.getMap("meta")).running === exec3, "code : un exécuteur disparu laisse « en cours »…");
  rb.sweep(Date.now() + 7000);
  ok(!readCodeMeta(b.getMap("meta")).running && readCodeMeta(b.getMap("meta")).runCount === 5, "code : …puis un autre éditeur termine l'exécution (compteur du `done`)");
  // Kernel gone while the executor runs.
  const rc = new CodeRunner(a, port, { canEdit: true });
  rc.attach(TERM);
  emit({ ev: "status", state: "idle" });
  const r4 = rc.run("1");
  rc.terminalGone();
  ok(r4.ok && !readCodeMeta(a.getMap("meta")).running && readOutputs(a).at(-1)!.output_type === "error" && !rc.run("1").ok, "code : la session s'arrête → l'exécution se termine par une erreur");
  // Viewers do not run; clearing is refused during a run.
  const rv = new CodeRunner(b, port, { canEdit: false });
  rv.attach(TERM);
  ok(!rv.run("1").ok && !rv.interrupt() && !rv.restart(), "code : un lecteur ne peut ni lancer, ni interrompre, ni redémarrer");
  const c = new Y.Doc();
  initBlank(c, "x.py");
  ok(beginCodeRun(c, "e:1").ok && !beginCodeRun(c, "e:2").ok && !clearCodeOutputs(c) && finishCodeRun(c, "e:1", 1) && clearCodeOutputs(c), "code : une seule exécution à la fois, effacer les sorties seulement hors exécution");
  c.getMap("meta").set("running", "x".repeat(65));
  ok(!readCodeMeta(c.getMap("meta")).running, "code : un marquage d'exécution trop long est ignoré");
  c.getArray("outputs").push([{ output_type: "stream", name: "stdout", text: "ok" }, { output_type: "weird" }, "x"]);
  ok(readOutputs(c).length === 1, "code : seules les sorties bien formées sont lues");
  rc.destroy();
  rb.destroy();
  rv.destroy();

  // The code service, like a notebook's: a hidden window does not lose the outputs.
  const handlers = new Map<string, any>();
  const host = {
    boardId: "board",
    key: await newSymKey(),
    canEdit: true,
    currentEpoch: 1,
    you: { name: "Alice", color: "#336699" },
    docSend(m: any) {
      if (m.t === "doc.sub") queueMicrotask(() => handlers.get(m.doc)?.onMessage({ t: "doc.state", ups: [] }));
      return true;
    },
    docRegister(doc: string, h: any) {
      handlers.set(doc, h);
      queueMicrotask(() => h.onOpen());
      return () => handlers.delete(doc);
    },
    on: () => () => {},
  };
  let closeBoard: (() => void) | undefined;
  const env: ServiceEnv = { port, watchTerminals: () => () => {}, terminalOver: () => false, onClose: (fn) => ((closeBoard = fn), () => (closeBoard = undefined)) };
  const win = acquireCode(host, env, "R".repeat(22), { idleMs: 150 });
  await win.doc.synced;
  initBlank(win.doc.ydoc, "svc.py");
  setCodeKernelTerm(win.doc.ydoc, TERM);
  emit({ ev: "status", state: "idle" });
  const rr = win.runner.run("print('svc')");
  win.release();
  emit({ ev: "stream", id: rr.ok ? rr.execId : "", name: "stdout", text: "svc\n" });
  emit({ ev: "done", id: rr.ok ? rr.execId : "", count: 1, status: "ok" });
  await nap(250);
  ok(readOutputs(win.doc.ydoc)[0]?.text === "svc\n" && !readCodeMeta(win.doc.ydoc.getMap("meta")).running && outputsOf(win.doc.ydoc).length === 1, "code : fenêtre masquée en pleine exécution, les sorties arrivent quand même (service du tableau)");
  await nap(400);
  ok(win.disposed, "code : service libéré une fois inactif");
  closeBoard?.();
}

// 13. Moving a running cell keeps its run: the later events of the executor are still written
{
  const enc = new TextEncoder();
  type L = { onReplay(d: Uint8Array): void; onData(d: Uint8Array): void };
  const listeners = new Set<L>();
  const lines: string[] = [];
  const emit = (ev: object) => {
    const line = JSON.stringify(ev) + "\n";
    lines.push(line);
    for (const l of listeners) l.onData(enc.encode(line));
  };
  const port = {
    subscribe(_t: string, l: L) {
      listeners.add(l);
      l.onReplay(enc.encode(lines.join("")));
      return () => listeners.delete(l);
    },
    input() {},
  };
  const aw = { states: new Map<number, any>(), getStates() { return this.states; }, setLocalStateField(k: string, v: unknown) { this.states.set(1, { ...(this.states.get(1) ?? {}), [k]: v }); } };
  const d = new Y.Doc();
  initBlankNotebook(d);
  const id = ids(d)[0];
  findCell(d, id)!.source.insert(0, "1");
  insertCell(d, { type: "code", at: "start" });
  emit({ ev: "status", state: "idle" });
  const r = new NotebookRunner(d, port, { awareness: aw, canEdit: true });
  r.attach("M".repeat(22));
  const x = r.run(id);
  const ex = x.ok ? x.execId : "";
  emit({ ev: "stream", id: ex, name: "stdout", text: "a\n" });
  await nap(120);
  ok(moveCell(d, id, -1) && ids(d)[0] === id && findCell(d, id)!.running === ex, "cellules : déplacer une cellule en cours garde son exécution");
  emit({ ev: "stream", id: ex, name: "stdout", text: "b\n" });
  emit({ ev: "done", id: ex, count: 2, status: "ok" });
  await nap(120);
  const texts = findCell(d, id)!.outputs.map((o) => o.text ?? o.output_type).join("|");
  ok(texts === "a\nb\n", `cellules : …et ses sorties suivantes arrivent (${JSON.stringify(texts)})`);
  ok(findCell(d, id)!.executionCount === 2 && !findCell(d, id)!.running, "cellules : …et elle se termine");
  r.destroy();
}

// 14. Runner: replays, lost requests, kernel switch
{
  const enc = new TextEncoder();
  type L = { onReplay(d: Uint8Array): void; onData(d: Uint8Array): void };
  const TERM = "K".repeat(22);
  function fakeKernel() {
    const listeners = new Set<L>();
    const lines: string[] = [];
    const sent: any[] = [];
    let drop = false;
    return {
      lines,
      sent,
      set drop(v: boolean) {
        drop = v;
      },
      emit(ev: object) {
        const line = JSON.stringify(ev) + "\n";
        lines.push(line);
        for (const l of listeners) l.onData(enc.encode(line));
      },
      /** A reconnection: the server replays its scrollback (the lines from `from` on). */
      replay(from = 0) {
        for (const l of listeners) l.onReplay(enc.encode(lines.slice(from).join("")));
      },
      port: {
        subscribe(_t: string, l: L) {
          listeners.add(l);
          l.onReplay(enc.encode(lines.join("")));
          return () => listeners.delete(l);
        },
        input(_t: string, d: Uint8Array) {
          if (drop) return;
          for (const line of new TextDecoder().decode(d).split("\n")) if (line) sent.push(JSON.parse(line));
        },
      },
    };
  }
  const aw = () => ({ states: new Map<number, any>(), getStates() { return this.states; }, setLocalStateField(k: string, v: unknown) { this.states.set(1, { ...(this.states.get(1) ?? {}), [k]: v }); } });
  const newNb = (code: string) => {
    const d = new Y.Doc();
    initBlankNotebook(d);
    const id = ids(d)[0];
    findCell(d, id)!.source.insert(0, code);
    return { d, id };
  };
  const texts = (d: Y.Doc, id: string) => findCell(d, id)!.outputs.map((o) => o.text ?? o.output_type).join("|");

  // Starting: no status in the scrollback → "starting" until the kernel answers the ping.
  {
    const k = fakeKernel();
    const { d } = newNb("1");
    const r = new NotebookRunner(d, k.port, { canEdit: true });
    r.attach(TERM);
    ok(r.status === "starting" && k.sent.length === 1 && k.sent[0].op === "ping", "noyau : sans état dans le flux rejoué, le noyau reste « démarrage » (ping envoyé)");
    k.emit({ ev: "pong" });
    ok(r.status === "idle", "noyau : la réponse au ping montre que le noyau est prêt");
    const v = new NotebookRunner(d, k.port, { canEdit: false });
    const before = k.sent.length;
    v.attach(TERM);
    ok(k.sent.length === before, "noyau : un lecteur n'envoie pas de ping");
    v.destroy();
    r.destroy();
  }

  // A reconnection replays the whole scrollback: the outputs of an in-flight run are rebuilt, not doubled.
  {
    const k = fakeKernel();
    k.emit({ ev: "status", state: "idle" });
    const { d, id } = newNb("for i in range(3): print(i)");
    const r = new NotebookRunner(d, k.port, { awareness: aw(), canEdit: true });
    r.attach(TERM);
    const x = r.run(id);
    const ex = x.ok ? x.execId : "";
    k.emit({ ev: "status", state: "busy" });
    k.emit({ ev: "stream", id: ex, name: "stdout", text: "0\n" });
    k.emit({ ev: "display", id: ex, data: { "text/plain": "<fig>" }, metadata: {}, display_id: "d1" });
    await nap(120);
    k.emit({ ev: "stream", id: ex, name: "stdout", text: "1\n" });
    k.replay();
    await nap(120);
    ok(texts(d, id) === "0\n|display_data|1\n", `noyau : reconnexion → sorties reconstruites depuis le flux rejoué, sans doublon (${texts(d, id)})`);
    k.emit({ ev: "update", id: ex, display_id: "d1", data: { "text/plain": "<fig2>" }, metadata: {} });
    k.emit({ ev: "stream", id: ex, name: "stdout", text: "2\n" });
    k.emit({ ev: "done", id: ex, count: 7, status: "ok" });
    await nap(120);
    const end = findCell(d, id)!;
    ok(!end.running && end.executionCount === 7 && texts(d, id) === "0\n|display_data|1\n2\n" && end.outputs[1]?.data?.["text/plain"] === "<fig2>", `noyau : fin normale après la reconnexion (${texts(d, id)})`);
    r.destroy();

    const k2 = fakeKernel();
    k2.emit({ ev: "status", state: "idle" });
    const nb2 = newNb("x");
    const r2 = new NotebookRunner(nb2.d, k2.port, { awareness: aw(), canEdit: true });
    r2.attach(TERM);
    const y = r2.run(nb2.id);
    const ey = y.ok ? y.execId : "";
    k2.emit({ ev: "stream", id: ey, name: "stdout", text: "a\n" });
    await nap(120);
    const cut = k2.lines.length;
    k2.emit({ ev: "stream", id: ey, name: "stdout", text: "b\n" });
    await nap(120);
    k2.emit({ ev: "done", id: ey, count: 3, status: "ok" });
    // Replay of a truncated scrollback (without "a"), the `done` included, before the live `done` is flushed.
    k2.replay(cut);
    await nap(120);
    ok(texts(nb2.d, nb2.id) === "a\nb\n" && !findCell(nb2.d, nb2.id)!.running && findCell(nb2.d, nb2.id)!.executionCount === 3, `noyau : flux rejoué tronqué → rien n'est réécrit, seule la fin est prise (${texts(nb2.d, nb2.id)})`);
    r2.destroy();
  }

  // The same for a code window.
  {
    const k = fakeKernel();
    k.emit({ ev: "status", state: "idle" });
    const d = new Y.Doc();
    initBlank(d, "a.py");
    const r = new CodeRunner(d, k.port, { awareness: aw(), canEdit: true });
    r.attach(TERM);
    const x = r.run("print(1)");
    const ex = x.ok ? x.execId : "";
    k.emit({ ev: "stream", id: ex, name: "stdout", text: "1\n" });
    await nap(120);
    k.replay();
    k.emit({ ev: "done", id: ex, count: 1, status: "ok" });
    await nap(120);
    ok(readOutputs(d).map((o) => o.text).join("|") === "1\n" && !readCodeMeta(d.getMap("meta")).running, `code : reconnexion → sorties sans doublon (${readOutputs(d).map((o) => o.text).join("|")})`);
    r.destroy();
  }

  // The request was lost (socket down): once the kernel has been idle for 15 s, the run ends with an error.
  {
    const k = fakeKernel();
    k.emit({ ev: "status", state: "idle" });
    const { d, id } = newNb("1");
    const a = aw();
    const r = new NotebookRunner(d, k.port, { awareness: a, canEdit: true });
    r.attach(TERM);
    k.drop = true;
    ok(r.run(id).ok, "noyau : lancement pendant une coupure");
    r.sweep(Date.now() + 5000);
    ok(!!findCell(d, id)!.running, "noyau : pas d'abandon avant 15 s");
    k.emit({ ev: "status", state: "busy" });
    r.sweep(Date.now() + 20000);
    ok(!!findCell(d, id)!.running, "noyau : pas d'abandon tant que le noyau est occupé (la cellule est peut-être en file)");
    k.emit({ ev: "status", state: "idle" });
    r.sweep(Date.now() + 20000);
    const c = findCell(d, id)!;
    ok(!c.running && c.outputs.at(-1)?.ename === "ExecutionLost" && r.localRuns.length === 0 && JSON.stringify(a.states.get(1).execs) === "[]", "noyau : requête perdue → l'exécution se termine par une erreur explicite");
    r.destroy();
  }

  // Following no kernel (attach(null), e.g. the document now names a shell) or another one ends the own runs.
  {
    const k = fakeKernel();
    k.emit({ ev: "status", state: "idle" });
    const { d, id } = newNb("import time; time.sleep(60)");
    const a = aw();
    const r = new NotebookRunner(d, k.port, { awareness: a, canEdit: true });
    r.attach(TERM);
    const x = r.run(id);
    k.emit({ ev: "stream", id: x.ok ? x.execId : "", name: "stdout", text: "avant\n" });
    r.attach(null);
    const c = findCell(d, id)!;
    ok(!c.running && c.outputs[0]?.text === "avant\n" && c.outputs.at(-1)?.ename === "KernelStopped" && JSON.stringify(a.states.get(1).execs) === "[]" && r.status === "absent" && !r.run(id).ok, "noyau : ne plus suivre le noyau termine les exécutions en cours (sortie reçue gardée, erreur, présence vidée)");
    r.attach(TERM);
    const y = r.run(id);
    r.attach("L".repeat(22));
    ok(y.ok && !findCell(d, id)!.running && r.localRuns.length === 0, "noyau : passer à un autre noyau termine aussi les exécutions de l'ancien");
    r.destroy();
  }
}

if (failures) {
  console.error(`\n${failures} échec(s)`);
  process.exit(1);
}
console.log("\nTout est bon");
