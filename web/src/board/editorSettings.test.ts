// Unit tests of the editor settings (pure, no framework):
//   node --experimental-strip-types web/src/board/editorSettings.test.ts
import { DEFAULT_SETTINGS, STORAGE_KEY, createSettingsStore, editorOptions, modelOptions, normalizeSettings, parseSettings } from "./editorSettings.ts";

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};
const mem = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const json = (v: unknown) => JSON.stringify(v);

{
  const d = DEFAULT_SETTINGS;
  ok(d.fontSize === 13 && d.tabSize === 4 && !d.minimap && d.renderWhitespace === "selection" && d.quickSuggestions === "auto", "défauts : ceux de l'éditeur actuel");
  ok(json(normalizeSettings(undefined)) === json(d) && json(normalizeSettings(42)) === json(d) && json(normalizeSettings([1])) === json(d), "normalisation : non-objet = défauts");
}
{
  ok(normalizeSettings({ fontSize: 3 }).fontSize === 10 && normalizeSettings({ fontSize: 99 }).fontSize === 24 && normalizeSettings({ fontSize: 15.6 }).fontSize === 16, "bornes : taille de police 10–24, arrondie");
  ok(normalizeSettings({ fontSize: "20" }).fontSize === 13 && normalizeSettings({ fontSize: NaN }).fontSize === 13 && normalizeSettings({ fontSize: Infinity }).fontSize === 13, "police : non numérique = défaut");
  ok(normalizeSettings({ tabSize: 8 }).tabSize === 8 && normalizeSettings({ tabSize: 2 }).tabSize === 2 && normalizeSettings({ tabSize: 3 }).tabSize === 4, "tabulation : 2, 4, 8 sinon défaut");
  ok(normalizeSettings({ renderWhitespace: "all" }).renderWhitespace === "all" && normalizeSettings({ renderWhitespace: "boundary" }).renderWhitespace === "selection", "espaces visibles : valeurs connues seulement");
  ok(normalizeSettings({ wordWrap: "yes", minimap: 1 }).wordWrap === false && normalizeSettings({ minimap: true }).minimap === true, "booléens : seuls les vrais booléens passent");
  ok(!("extra" in normalizeSettings({ extra: 1 })), "normalisation : champs inconnus ignorés");
}
{
  const d = json(DEFAULT_SETTINGS);
  ok(json(parseSettings("{oups")) === d && json(parseSettings("")) === d && json(parseSettings(null)) === d && json(parseSettings("null")) === d, "JSON corrompu ou absent = défauts");
  const p = parseSettings('{"fontSize":18,"tabSize":2}');
  ok(p.fontSize === 18 && p.tabSize === 2 && p.insertSpaces === true, "JSON partiel : complété par les défauts");
}
{
  const s = mem();
  const store = createSettingsStore(() => s);
  let n = 0;
  store.subscribe(() => n++);
  store.update({ fontSize: 40, tabSize: 8 });
  ok(store.get().fontSize === 24 && store.get().tabSize === 8 && n === 1 && JSON.parse(s.m.get(STORAGE_KEY)!).tabSize === 8, "store : met à jour, borne, notifie et écrit");
  store.update({ tabSize: 8 });
  ok(n === 1, "store : pas de notification sans changement");
  s.m.set(STORAGE_KEY, '{"fontSize":11}');
  store.refresh();
  ok(store.get().fontSize === 11 && n === 2, "store : relecture (autre onglet)");
  store.reset();
  ok(store.get().fontSize === 13 && !s.m.has(STORAGE_KEY) && n === 3, "store : réinitialisation");
  const boom = () => {
    throw new Error("indisponible");
  };
  ok(createSettingsStore(boom).get().fontSize === 13 && createSettingsStore(() => null).get().tabSize === 4, "stockage indisponible : défauts");
  const bad = createSettingsStore(() => ({ getItem: boom, setItem: boom, removeItem: boom }));
  bad.update({ fontSize: 20 });
  ok(bad.get().fontSize === 20, "stockage qui lève : le réglage reste valable pour la session");
}
{
  const s = normalizeSettings({ minimap: true, wordWrap: true, lineNumbers: false, quickSuggestions: "on" });
  const o: any = editorOptions(s);
  ok(o.minimap.enabled && o.wordWrap === "on" && o.lineNumbers === "off" && o.quickSuggestions.other === true, "options éditeur");
  const nb: any = editorOptions(s, true);
  ok(!("minimap" in nb) && !("wordWrap" in nb) && !("lineNumbers" in nb) && nb.fontSize === 13, "cellule de notebook : ni minimap, ni retour à la ligne, ni numéros");
  ok((editorOptions(DEFAULT_SETTINGS) as any).quickSuggestions.other === true && (editorOptions(DEFAULT_SETTINGS, false, false) as any).quickSuggestions === false && modelOptions(s).insertSpaces === true, "options : suggestions selon le langage par défaut, espaces");
  ok((editorOptions(normalizeSettings({ quickSuggestions: "off" })) as any).quickSuggestions === false && normalizeSettings({ quickSuggestions: true }).quickSuggestions === "auto", "suggestions : jamais, valeur invalide");
}
if (failures) {
  console.log(`\n${failures} échec(s)`);
  process.exit(1);
}
console.log("\nTout est bon");
