// Unit tests of the file explorer rules (pure, no framework):
//   node --experimental-strip-types web/src/board/fileTree.test.ts
import { childPath, emptyTree, flatten, parentDir, sortEntries, toggled, withError, withListing, withLoading } from "./fileTree.ts";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};
const f = (name: string, dir = false) => ({ name, dir, size: 0, mtime: 0 });

// 1. Paths
ok(parentDir("/a/b") === "/a" && parentDir("/a") === "/" && parentDir("/") === "/" && parentDir("/a/b/") === "/a", "parentDir : remonte, s'arrête à la racine");
ok(parentDir("rel/x") === null && parentDir("") === null, "parentDir : un chemin relatif n'a pas de parent");
ok(childPath("/", "a") === "/a" && childPath("/a/b", "c.py") === "/a/b/c.py" && childPath("/a/b/", "c") === "/a/b/c", "childPath : fusion sans double barre");

// 2. Order
{
  const names = sortEntries([f("b.txt"), f("Zed", true), f("a10"), f("a2"), f("alpha", true), f(".env")]).map((e) => e.name);
  ok(names.join() === "alpha,Zed,.env,a2,a10,b.txt", "tri : dossiers d'abord, puis alphabétique et numérique");
}

// 3. Tree state
{
  let t = emptyTree();
  t = withListing(t, "/r", [f("x.py"), f("sub", true)], false);
  ok(flatten("/r", t).map((r) => r.name).join() === "sub,x.py", "flatten : racine triée");
  t = toggled(t, "/r/sub");
  t = withLoading(t, "/r/sub");
  const rows = flatten("/r", t);
  ok(rows[0]!.open && rows[0]!.loading, "flatten : dossier déplié en chargement");
  t = withListing(t, "/r/sub", [f("deep.go")], true);
  const rows2 = flatten("/r", t);
  ok(rows2.map((r) => `${r.depth}:${r.name}`).join() === "0:sub,1:deep.go,1:Liste tronquée,0:x.py", "flatten : enfants indentés, note de troncature");
  ok(!rows2[0]!.loading, "chargement terminé");
  t = toggled(t, "/r/sub");
  ok(flatten("/r", t).length === 2, "replier masque les enfants");
  ok(t.folders.has("/r/sub"), "le cache est conservé");
  t = withError(t, "/r/sub", "Accès refusé");
  t = toggled(t, "/r/sub");
  ok(flatten("/r", t).some((r) => r.note === "Accès refusé"), "erreur affichée sous le dossier");
  ok(flatten("/e", withListing(emptyTree(), "/e", [], false))[0]?.note === "Dossier vide", "dossier vide");
}

if (failures) {
  console.log(`\n${failures} échec(s)`);
  process.exit(1);
}
console.log("\nTout est bon");
