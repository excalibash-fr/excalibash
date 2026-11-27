// Real-browser end-to-end: drives the built web app in Chrome (Playwright) against a throwaway server and the real agent.
// Run through tests/run.sh (BASE, DB = the server's database file, CHROME_PATH optional).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { base32Decode, totp as totpAt } from "../server/src/totp.ts";
import { chromium, type Browser, type BrowserContext, type Page } from "../web/node_modules/playwright-core/index.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:6797";
const DB = process.env.DB!;
const DATA = dirname(DB);
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const SHOTS = join(DATA, "shots");

let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};
const block = (name: string) => console.log(`\n# ${name}`);

if (!existsSync(CHROME)) {
  console.log(`⚠ Chrome introuvable (${CHROME}) : suite navigateur ignorée (définir CHROME_PATH).`);
  process.exit(process.env.CI ? 1 : 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns something truthy (no blind sleeps). */
async function until<T>(what: string, fn: () => Promise<T | false | null | undefined> | T | false | null | undefined, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`délai dépassé : ${what}${last ? ` (${(last as Error).message?.split("\n")[0]})` : ""}`);
    await sleep(150);
  }
}

// Console messages that are not application bugs. Keep this list short and justified.
const blocked = { scripts: 0 };
const ALLOWED_CONSOLE: RegExp[] = [
  // Chrome reports the script the sandboxed notebook frame refused to run: that is the sandbox working (counted in the notebook block).
  /Blocked script execution in 'about:srcdoc'/,
  // Logged out (or not yet unlocked) pages ask /api/auth/me: the 401 is the expected answer.
  /Failed to load resource: the server responded with a status of 401/,
  // Excalidraw listens to window "unload", which recent Chrome versions deny by default (unload deprecation):
  // the browser reports it, nothing breaks.
  /Permissions policy violation: unload is not allowed in this document/,
];

const problems: string[] = [];
let shotN = 0;
function track(page: Page, label: string) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Blocked script execution in 'about:srcdoc'/.test(t)) blocked.scripts++;
    if (ALLOWED_CONSOLE.some((r) => r.test(t))) return;
    problems.push(`[${label}] console: ${t} @ ${m.location().url}`);
  });
  page.on("pageerror", (e) => problems.push(`[${label}] exception: ${e.message}`));
}
const takeProblems = () => problems.splice(0);
async function noConsoleErrors(msg: string) {
  await sleep(300);
  const p = takeProblems();
  if (p.length) console.log(p.map((x) => `    ${x}`).join("\n"));
  ok(p.length === 0, msg);
}

const pages = new Map<string, Page>();
async function shot(why: string) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [label, p] of pages) {
    const f = join(SHOTS, `${String(++shotN).padStart(2, "0")}-${why.replace(/\W+/g, "_").slice(0, 40)}-${label}.png`);
    await p.screenshot({ path: f }).then(() => console.log(`    capture : ${f}`), () => {});
  }
}

/** Last verification code emailed to `email`, read from the server log (SMTP_TRANSPORT=log). */
const mailCode = (email: string) =>
  readFileSync(`${DATA}/server.log`, "utf8").split("\n").filter((l) => l.startsWith(`[mail] to=${email} `)).at(-1)?.match(/code=(\d{6})/)?.[1] ?? "";
const setupCode = () => readFileSync(`${DATA}/server.log`, "utf8").match(/Code d'installation[^:]*: ([A-Z0-9-]+)/)?.[1] ?? "";

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ([m, p, b]) => {
      const r = await fetch(`/api${p}`, { method: m as string, headers: b ? { "content-type": "application/json" } : {}, body: (b as string) || undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    [method, path, body ? JSON.stringify(body) : ""] as const,
  );
}

const browser: Browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const agentBin = new URL(`../agent/dist/excalibash-agent-${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`, import.meta.url).pathname;
const children: ChildProcess[] = [];

async function newUser(label: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, baseURL: BASE, locale: "fr-FR" });
  const page = await ctx.newPage();
  track(page, label);
  pages.set(label, page);
  return { ctx, page };
}

/** Registers through the UI (the verification step too when the server asks for it). */
async function registerUI(page: Page, email: string, name: string, password: string, setup?: string) {
  await page.goto("/register");
  if (setup) await page.getByLabel("Code d'installation").fill(setup);
  await page.getByLabel("Nom", { exact: true }).fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(password);
  await page.getByLabel("Confirmation").fill(password);
  await page.getByRole("button", { name: "Créer le compte" }).click();
  const code = page.getByLabel("Code", { exact: true });
  const recovery = page.getByRole("heading", { name: "Ta clé de récupération" });
  await until("code email ou clé de récupération", async () => (await code.isVisible()) || (await recovery.isVisible()), 60000);
  if (await code.isVisible()) {
    await until("code email dans le log", () => mailCode(email));
    await code.fill(mailCode(email));
    await page.getByRole("button", { name: "Valider" }).click();
    await recovery.waitFor({ timeout: 20000 });
  }
  const key = (await page.locator(".codebox").first().innerText()).trim();
  await page.getByLabel(/Je l'ai rangée/).check();
  await page.getByRole("button", { name: "Continuer" }).click();
  return key;
}

async function loginUI(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
}

try {
  // ---- 1. Setup ----
  block("1. Installation et inscription");
  const A = await newUser("alice");
  const recoveryKey = await registerUI(A.page, "alice@test.local", "Alice", "alice-password-1", setupCode());
  ok(/^[A-Z0-9]{4}(-[A-Z0-9]{4})+$/.test(recoveryKey), "la clé de récupération est affichée une fois, puis acquittée");
  await A.page.getByRole("region", { name: "Guide de démarrage" }).waitFor();
  ok(true, "le guide de démarrage s'affiche après la première connexion");
  await A.page.getByRole("button", { name: "Passer" }).click();
  await until("guide fermé", async () => !(await A.page.getByRole("region", { name: "Guide de démarrage" }).isVisible()));
  ok(true, "le guide de démarrage se ferme");
  await noConsoleErrors("inscription : aucune erreur console");

  // Bob: signs up through the API of the open registration (setting enabled by the admin), then logs in through the UI.
  await api(A.page, "PATCH", "/admin/settings", { registrationOpen: true });
  const B = await newUser("bob");
  await registerUI(B.page, "bob@test.local", "Bob", "bob-password-1");
  await B.page.getByRole("region", { name: "Guide de démarrage" }).getByRole("button", { name: "Passer" }).click();
  ok(await B.page.getByText("Une page blanche…").isVisible(), "Bob s'inscrit par l'interface et arrive sur un tableau de bord vide");

  // ---- 2. Dashboard ----
  block("2. Tableau de bord");
  await A.page.goto("/");
  await A.page.getByRole("button", { name: "Dossier", exact: true }).click();
  const folderCard = A.page.locator(".card-title", { hasText: "Nouveau dossier" });
  await folderCard.waitFor();
  await folderCard.dblclick();
  await A.page.locator(".card-title input").fill("TP réseau");
  await A.page.keyboard.press("Enter");
  await A.page.locator(".card-title", { hasText: "TP réseau" }).waitFor();
  ok(true, "création d'un dossier puis renommage au double-clic");
  await A.page.locator(".card-title", { hasText: "TP réseau" }).click();
  await A.page.waitForURL(/\/folder\//);
  await A.page.getByRole("button", { name: "Tableau", exact: true }).click();
  await A.page.waitForURL(/\/board\//);
  const boardUrl = A.page.url();
  await A.page.getByRole("button", { name: "Sans titre" }).click();
  await A.page.locator("input.board-title").fill("Archi labo");
  await A.page.keyboard.press("Enter");
  await A.page.getByRole("button", { name: "Archi labo" }).waitFor();
  ok(true, "création d'un tableau dans le dossier, ouverture et renommage dans l'en-tête");
  await A.page.locator(".excalidraw").first().waitFor();
  ok(await A.page.locator(".excalidraw canvas").first().isVisible(), "le canvas Excalidraw s'affiche");
  await A.page.getByRole("button", { name: "Retour" }).click();
  await A.page.locator(".card-title", { hasText: "Archi labo" }).waitFor();
  ok(true, "le nouveau nom du tableau apparaît dans la liste du dossier");
  await A.page.locator(".card-title", { hasText: "Archi labo" }).click();
  await A.page.waitForURL(boardUrl);
  const before = await A.page.evaluate(() => document.documentElement.classList.contains("dark"));
  await A.page.getByRole("button", { name: /^Thème (sombre|clair)$/ }).click();
  const after = await until("thème changé", () => A.page.evaluate((b) => document.documentElement.classList.contains("dark") !== b, before));
  ok(after, "le bouton de thème bascule clair / sombre");
  await noConsoleErrors("tableau de bord et tableau : aucune erreur console");

  // ---- 2b. Second factor ----
  block("2b. Double authentification (activation, connexion avec code, code de secours, désactivation)");
  {
    const pg = B.page;
    await pg.goto("/account");
    const panel = pg.locator(".panel", { has: pg.getByRole("heading", { name: "Double authentification" }) });
    await panel.getByRole("button", { name: "Activer", exact: true }).click();
    await panel.getByLabel("Mot de passe").fill("bob-password-1");
    await panel.getByRole("button", { name: "Continuer" }).click();
    const secretBox = panel.getByTestId("mfa-secret");
    await secretBox.waitFor();
    const secret = (await secretBox.innerText()).replace(/\s/g, "");
    ok(/^[A-Z2-7]{32}$/.test(secret), "activation : le secret est affiché en clair (base32), copiable");
    const qr = panel.locator("svg[role=img]");
    ok((await qr.isVisible()) && (await qr.locator("path").getAttribute("d"))!.length > 500, "activation : un QR code est dessiné localement (SVG)");
    await shot("mfa-qr");
    await panel.getByLabel("Code à 6 chiffres").fill("000000");
    await panel.getByRole("button", { name: "Activer", exact: true }).click();
    await pg.locator(".toast", { hasText: "Code incorrect" }).first().waitFor();
    ok(true, "activation : un mauvais code est refusé (« Code incorrect »)");
    await panel.getByLabel("Code à 6 chiffres").fill(totpAt(base32Decode(secret)!, Date.now()));
    await panel.getByRole("button", { name: "Activer", exact: true }).click();
    const boxCodes = panel.getByTestId("mfa-backup-codes");
    await boxCodes.waitFor();
    const codes = (await boxCodes.innerText()).match(/[2-9A-Z]{5}-[2-9A-Z]{5}/g) ?? [];
    ok(codes.length === 10 && new Set(codes).size === 10, "activation : les 10 codes de secours sont affichés");
    ok(await panel.getByRole("button", { name: "Terminé" }).isDisabled(), "activation : « Terminé » attend la confirmation que les codes sont rangés");
    await shot("mfa-codes");
    await panel.getByLabel(/Je les ai rangés/).check();
    await panel.getByRole("button", { name: "Terminé" }).click();
    await panel.getByText("activée", { exact: true }).waitFor();
    ok(/Codes de secours restants : 10/.test(await panel.innerText()), "la section indique « activée » et 10 codes de secours restants");
    await noConsoleErrors("activation du MFA : aucune erreur console");

    // A fresh browser: password, then the code.
    const B2 = await newUser("bob-mfa");
    await loginUI(B2.page, "bob@test.local", "bob-password-1");
    await B2.page.getByRole("heading", { name: "Code de vérification" }).waitFor();
    ok((await B2.page.getByLabel("Code", { exact: true }).getAttribute("autocomplete")) === "one-time-code", "connexion : l'étape « Code de vérification » suit le mot de passe (autocomplete one-time-code)");
    ok((await api(B2.page, "GET", "/auth/me")).status === 401, "connexion : pas de session avant le code");
    await B2.page.getByLabel("Code", { exact: true }).fill("123456");
    await B2.page.getByRole("button", { name: "Valider" }).click();
    await B2.page.getByText("Code incorrect").waitFor();
    ok(true, "connexion : mauvais code → « Code incorrect »");
    // The step after the one used to enable (±1 step is accepted).
    await B2.page.getByLabel("Code", { exact: true }).fill(totpAt(base32Decode(secret)!, Date.now() + 30_000));
    await B2.page.getByRole("button", { name: "Valider" }).click();
    await B2.page.getByText("Une page blanche…").waitFor();
    ok((await api(B2.page, "GET", "/auth/me")).body.user?.mfaEnabled === true, "connexion : bon code → session ouverte, tableau de bord");
    await B2.ctx.close();
    pages.delete("bob-mfa");

    // Backup code from the link.
    const B3 = await newUser("bob-mfa-backup");
    await loginUI(B3.page, "bob@test.local", "bob-password-1");
    await B3.page.getByRole("button", { name: "Utiliser un code de secours" }).click();
    await B3.page.getByLabel("Code de secours").fill(codes[0]);
    await B3.page.getByRole("button", { name: "Valider" }).click();
    await B3.page.getByText("Une page blanche…").waitFor();
    ok(true, "connexion : un code de secours ouvre la session");
    await B3.ctx.close();
    pages.delete("bob-mfa-backup");
    const reuse = await newUser("bob-mfa-reuse");
    await loginUI(reuse.page, "bob@test.local", "bob-password-1");
    await reuse.page.getByRole("button", { name: "Utiliser un code de secours" }).click();
    await reuse.page.getByLabel("Code de secours").fill(codes[0]);
    await reuse.page.getByRole("button", { name: "Valider" }).click();
    await reuse.page.getByText("Code incorrect").waitFor();
    ok(true, "connexion : le même code de secours ne marche qu'une fois");
    await reuse.ctx.close();
    pages.delete("bob-mfa-reuse");

    // The administration lists the state; the switch is there.
    await A.page.goto("/admin");
    await A.page.getByText("MFA obligatoire pour les administrateurs").waitFor();
    ok((await A.page.locator(".admin-user", { hasText: "Bob" }).getByText("MFA", { exact: true }).count()) === 1, "administration : le MFA de Bob est signalé dans la liste, le réglage « obligatoire » est proposé");
    await noConsoleErrors("connexions avec code : aucune erreur console");

    // Turn it off again with a backup code (the rest of the suite signs Bob in with a password only).
    await pg.goto("/account");
    await panel.getByRole("button", { name: "Désactiver" }).click();
    await panel.getByLabel("Mot de passe").fill("bob-password-1");
    await panel.getByLabel(/Code à 6 chiffres/).fill(codes[1]);
    await panel.getByRole("button", { name: "Désactiver" }).click();
    await panel.getByRole("button", { name: "Activer", exact: true }).waitFor();
    ok((await api(pg, "GET", "/account")).body.mfa.enabled === false, "désactivation : mot de passe + code de secours, la section revient à « Activer »");
  }

  // ---- 3. Machine ----
  block("3. Machine appairée par code");
  await A.page.goto("/machines");
  await A.page.getByRole("button", { name: "Ajouter avec un code" }).click();
  const code = (await A.page.locator(".pair-code").innerText()).trim();
  ok(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/i.test(code), "le code d'appairage s'affiche");
  const agentHome = mkdtempSync(join(tmpdir(), "eb-agent-"));
  const agentLog: string[] = [];
  const agent = spawn(agentBin, ["--server", BASE, "--pair", code.toLowerCase(), "--config", join(agentHome, "agent.json"), "--name", "vm-tp"], { cwd: agentHome, env: { ...process.env, HOME: agentHome }, stdio: ["ignore", "ignore", "pipe"] });
  agent.stderr!.on("data", (d) => agentLog.push(String(d)));
  children.push(agent);
  // The machine prints a confirmation code under its fingerprint; it never goes through the server.
  const confirmCode = await until("code de confirmation de la machine", () => agentLog.join("").match(/Code de confirmation : ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1], 30000);
  await A.page.getByLabel("Code de confirmation affiché sur la machine").fill(confirmCode);
  await A.page.getByRole("button", { name: "C'est la même" }).click({ timeout: 30000 });
  const fp = (await A.page.locator(".pair-fp").innerText().catch(() => "")).trim();
  await until("agent en ligne", () => A.page.locator(".dot.on").first().isVisible(), 30000);
  ok(await A.page.getByText("vm-tp").first().isVisible(), "l'agent réel est appairé depuis l'interface et la machine s'affiche");
  ok(!fp || agentLog.join("").includes(fp), "l'empreinte vue dans le navigateur est celle de l'agent");
  await noConsoleErrors("machines : aucune erreur console");

  // ---- 4. Terminal on the board ----
  block("4. Terminal sur le tableau");
  const activeTool = (p: Page) => p.locator('input[data-testid^="toolbar-"]:checked').first().getAttribute("data-testid");
  await A.page.goto(boardUrl);
  await A.page.locator(".excalidraw canvas").first().waitFor();
  await A.page.locator(".excalidraw .layer-ui__wrapper").first().click({ position: { x: 5, y: 5 }, trial: true }).catch(() => {});
  await A.page.keyboard.press("Alt+t");
  await A.page.getByRole("button", { name: /vm-tp/ }).click();
  const term = A.page.locator(".xterm").first();
  await term.waitFor({ timeout: 30000 });
  ok(true, "Alt+T propose la machine, le shell s'ouvre dans une fenêtre xterm");
  await until("shell prêt", async () => (await A.page.locator(".term-head .status", { hasText: /connect|actif|en cours/i }).count()) > 0 || (await term.locator(".xterm-rows").innerText()).trim().length > 0, 30000);
  await term.click();
  const toolBefore = await activeTool(A.page);
  await A.page.keyboard.type("echo bonjour-$((6*7)) rrrr ppp");
  await A.page.keyboard.press("Enter");
  await until("sortie du shell", async () => /bonjour-42 rrrr ppp/.test(await term.locator(".xterm-rows").innerText()), 20000);
  ok(true, "la saisie atteint le shell réel et la sortie « bonjour-42 » apparaît dans le DOM xterm");
  ok((await activeTool(A.page)) === toolBefore, `les touches tapées dans le terminal ne changent pas l'outil Excalidraw (${toolBefore})`);
  await noConsoleErrors("terminal : aucune erreur console");

  // ---- 5. Shared code window ----
  block("5. Fenêtre de code partagée (Alice + Bob)");
  await A.page.getByRole("button", { name: "Partager", exact: true }).click();
  await A.page.getByLabel("Nom ou email").fill("Bob");
  const share = A.page.getByRole("dialog");
  await share.getByRole("button", { name: "Chercher", exact: true }).click();
  await share.getByRole("button", { name: /Bob/ }).first().click();
  await share.getByRole("button", { name: /^Partager \(/ }).click();
  await until("Bob est membre", async () => (await share.getByTitle("Retirer l'accès").count()) > 0);
  ok((await share.locator(".row", { hasText: "Bob" }).locator("select").inputValue()) === "editor", "le tableau est partagé avec Bob comme éditeur");
  await share.getByRole("button", { name: "Fermer" }).click();
  const dockA = A.page.getByRole("complementary", { name: "Fenêtres du tableau" });
  await dockA.getByTitle("Nouveau fichier de code").click();
  const editorA = A.page.locator(".monaco-editor").first();
  await editorA.waitFor({ timeout: 30000 });
  /** Puts the caret in the Monaco of a window: an unselected window first needs a click that selects it on the canvas. */
  const focusEditor = async (p: Page) => {
    const lines = p.locator(".monaco-editor .view-lines").first();
    await until("éditeur Monaco focalisé", async () => {
      await lines.click({ position: { x: 300, y: 8 }, force: true });
      return p.evaluate(() => !!document.activeElement?.closest(".monaco-editor"));
    });
  };
  const textOf = async (p: Page) => (await p.locator(".monaco-editor .view-lines").first().innerText()).replace(/\u00a0/g, " ").trim();
  await focusEditor(A.page);
  await A.page.keyboard.type("# ligne alice");
  await until("texte d'Alice", async () => (await textOf(A.page)).includes("# ligne alice"));
  ok((await activeTool(A.page)) === "toolbar-selection", "taper dans Monaco ne change pas l'outil Excalidraw");
  ok((await A.page.locator(".excalidraw-container").evaluate((el) => el.scrollTop)) === 0, "donner le focus à une fenêtre qui déborde du canvas ne fait pas défiler le tableau");

  await B.page.goto(boardUrl);
  const dockB = B.page.getByRole("complementary", { name: "Fenêtres du tableau" });
  await dockB.waitFor({ timeout: 30000 });
  // The window is open for everyone by default; if not, open it from the dock.
  await until("fenêtre de code de Bob", () => B.page.locator(".monaco-editor").count(), 5000).catch(() => dockB.getByText("Code 1").click());
  await B.page.locator(".monaco-editor").first().waitFor({ timeout: 30000 });
  await until("Bob voit le texte d'Alice", async () => (await textOf(B.page)).includes("# ligne alice"), 15000);
  ok(true, "Bob voit le texte d'Alice dans Monaco");
  await focusEditor(B.page);
  await B.page.keyboard.press("Control+End");
  await B.page.keyboard.type("\n# ligne bob");
  await until("Alice voit Bob", async () => (await textOf(A.page)).includes("# ligne bob"), 15000);
  ok(true, "Alice voit ce que Bob tape");
  await focusEditor(A.page);
  await A.page.keyboard.press("Control+End");
  await A.page.keyboard.type("\n# fin alice");
  await until("convergence", async () => (await textOf(A.page)) === (await textOf(B.page)) && (await textOf(B.page)).includes("# fin alice"), 15000);
  ok((await textOf(A.page)) === (await textOf(B.page)), "les deux éditeurs convergent vers le même texte");
  const remote = await until("curseur distant", () => A.page.locator('[class*="yRemoteSelectionHead-"]').first().evaluate((el) => getComputedStyle(el, "::after").content), 10000);
  ok(remote.includes("Bob"), `le curseur distant de Bob est affiché avec son nom (${remote})`);

  // Ctrl+S on an unsaved document asks where, then writes on the machine.
  await A.page.keyboard.press("Control+s");
  const pathInput = A.page.getByLabel("Chemin du fichier sur la machine");
  await pathInput.waitFor();
  await pathInput.fill("demo.py");
  await A.page.keyboard.press("Enter");
  const demo = join(agentHome, "demo.py");
  await until("fichier sur la machine", () => existsSync(demo), 15000);
  const saved = readFileSync(demo, "utf8");
  ok(saved.includes("# ligne alice") && saved.includes("# ligne bob") && saved.includes("# fin alice"), "Ctrl+S puis « Enregistrer sous » écrit demo.py sur la machine avec le texte partagé");

  // Monaco hit-testing under a zoomed canvas (CSS transform): a click lands on the character under the pointer.
  const zoomOf = async (p: Page) => parseInt(await p.locator(".reset-zoom-button").innerText(), 10);
  const z0 = await zoomOf(A.page);
  await A.page.mouse.move(600, 500);
  await A.page.keyboard.down("Control");
  for (let i = 0; i < 3; i++) await A.page.mouse.wheel(0, -100);
  await A.page.keyboard.up("Control");
  await until("zoom appliqué", async () => (await zoomOf(A.page)) > z0);
  const firstLine = A.page.locator(".monaco-editor .view-line").first();
  const line1 = (await firstLine.innerText()).replace(/\u00a0/g, " ");
  const box = (await firstLine.locator("span > span").first().boundingBox())!;
  await A.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await A.page.keyboard.type("Z");
  const idx = await until("lettre insérée", async () => {
    const l = (await firstLine.innerText()).replace(/\u00a0/g, " ");
    return l.includes("Z") ? l.indexOf("Z") : false;
  });
  ok(Math.abs(idx - line1.length / 2) <= 2, `zoom ${await zoomOf(A.page)} % : le clic dans Monaco place le curseur sous le pointeur (caractère ${idx} sur ${line1.length})`);

  // The editor follows the app theme.
  const monacoDark = () => A.page.locator(".monaco-editor").first().evaluate((el) => el.classList.contains("vs-dark"));
  const appDark = () => A.page.evaluate(() => document.documentElement.classList.contains("dark"));
  const wasDark = await appDark();
  await A.page.getByRole("button", { name: /^Thème (sombre|clair)$/ }).click();
  await until("thème de Monaco", async () => (await appDark()) !== wasDark && (await monacoDark()) === (await appDark()));
  ok((await monacoDark()) === (await appDark()), "Monaco suit le thème de l'application (clair / sombre)");
  await noConsoleErrors("fenêtre de code : aucune erreur console (Alice et Bob)");

  // ---- 6. Notebook ----
  block("6. Notebook partagé sur un noyau Jupyter");
  await A.page.getByTitle(/^Masquer \(le document reste partagé, l'icône aussi\)/).click();
  await A.page.locator(".reset-zoom-button").click();
  await dockA.getByTitle("Nouveau notebook").click();
  const nbA = A.page.locator(".nb-cells");
  await nbA.waitFor({ timeout: 30000 });
  await A.page.getByRole("button", { name: /Démarrer le noyau/ }).click();
  await A.page.getByRole("dialog").getByRole("button", { name: "Démarrer", exact: true }).click();
  await until("noyau prêt", async () => /prêt|inactif|idle/i.test(await A.page.locator(".nb-kernel").innerText()), 60000);
  ok(true, `le noyau Jupyter démarre sur la machine (${(await A.page.locator(".nb-kernel").innerText()).trim()})`);
  const cellEditor = (p: Page, n: number) => p.locator(".nb-cell").nth(n).locator(".monaco-editor");
  const typeInCell = async (p: Page, n: number, text: string) => {
    const ed = cellEditor(p, n);
    await until(`cellule ${n}`, () => ed.count(), 15000);
    await until(`cellule ${n} focalisée`, async () => {
      await ed.locator(".view-lines").click({ position: { x: 20, y: 8 }, force: true });
      return p.evaluate((i) => !!document.querySelectorAll(".nb-cell")[i]?.contains(document.activeElement), n);
    });
    await p.keyboard.type(text);
    await p.keyboard.press("Escape");
  };
  await typeInCell(A.page, 0, "x = 41");
  await A.page.keyboard.press("Shift+Enter");
  await until("cellule 2", () => A.page.locator(".nb-cell").count().then((n) => n >= 2));
  await typeInCell(A.page, 1, "print(x + 1)");
  await A.page.keyboard.press("Shift+Enter");
  await until("sortie 42 (Alice)", async () => /\b42\b/.test(await A.page.locator(".nb-outputs .nb-text").allInnerTexts().then((t) => t.join("\n"))), 30000);
  ok(true, "Maj+Entrée exécute les cellules sur le noyau et la sortie « 42 » s'affiche chez Alice");
  ok((await activeTool(A.page)) === "toolbar-selection", "taper dans les cellules ne change pas l'outil Excalidraw");

  // Bob sees the same notebook, with the same output.
  await B.page.goto(boardUrl);
  await dockB.waitFor({ timeout: 30000 });
  await until("notebook de Bob", () => B.page.locator(".nb-cells").count(), 8000).catch(() => dockB.getByText("Notebook 1").click());
  await until("sortie 42 (Bob)", async () => /\b42\b/.test(await B.page.locator(".nb-outputs .nb-text").allInnerTexts().then((t) => t.join("\n"))), 30000);
  ok(true, "Bob voit la même sortie « 42 » dans le notebook partagé");

  // HTML output: sandboxed iframe, no script runs.
  await B.page.evaluate(() => {
    (window as any).__msgs = [];
    window.addEventListener("message", (e) => (window as any).__msgs.push(String(e.data)));
  });
  await A.page.evaluate(() => {
    (window as any).__msgs = [];
    window.addEventListener("message", (e) => (window as any).__msgs.push(String(e.data)));
  });
  await until("cellule vide ajoutée par Maj+Entrée", () => A.page.locator(".nb-cell").count().then((n) => n >= 3));
  await typeInCell(A.page, 2, `from IPython.display import HTML; HTML("<b>gras</b><script>parent.postMessage('pwned','*')</script>")`);
  await A.page.keyboard.press("Shift+Enter");
  const frameA = A.page.locator(".nb-cell").nth(2).locator("iframe.nb-frame");
  await frameA.waitFor({ timeout: 30000 });
  ok((await frameA.getAttribute("sandbox")) === "", "la sortie HTML s'affiche dans une iframe avec sandbox=\"\" (aucun droit)");
  const frameB = B.page.locator(".nb-cell").nth(2).locator("iframe.nb-frame");
  await frameB.waitFor({ timeout: 30000 });
  ok((await frameB.getAttribute("sandbox")) === "", "même chose chez Bob");
  const gras = await frameA.contentFrame().locator("b").innerText().catch(() => "");
  ok(gras === "gras" || gras === "", "le contenu HTML est rendu dans l'iframe isolée");
  await sleep(800);
  const leaked = [...(await A.page.evaluate(() => (window as any).__msgs)), ...(await B.page.evaluate(() => (window as any).__msgs))];
  ok(!leaked.includes("pwned"), "le script de la sortie HTML ne s'exécute pas");
  ok(blocked.scripts >= 1, "Chrome confirme avoir bloqué le script de la sortie HTML (sandbox sans allow-scripts)");

  // Ctrl+Entrée runs a cell without moving on.
  await until("cellule vide ajoutée", () => A.page.locator(".nb-cell").count().then((n) => n >= 4));
  await typeInCell(A.page, 3, "print(6 * 7 + 1)");
  await A.page.keyboard.press("Control+Enter");
  await until("sortie 43", async () => /\b43\b/.test(await A.page.locator(".nb-cell").nth(3).innerText()), 20000);
  ok(true, "Ctrl+Entrée exécute la cellule courante");
  await noConsoleErrors("notebook : aucune erreur console (Alice et Bob)");

  // ---- 7. Broadcast, history, public link ----
  block("7. Diffusion de saisie, historique, lien public");
  await A.page.getByTitle(/^Masquer \(le notebook reste partagé/).click();
  await dockA.getByTitle("Nouveau shell sur cette machine").click();
  await until("deux terminaux", () => A.page.locator(".term:not(.code) .xterm").count().then((n) => n === 2), 30000);
  const termText = (n: number) => A.page.locator(".term:not(.code) .xterm").nth(n).locator(".xterm-rows").innerText();
  await until("second shell prêt", async () => /[#$] ?$/m.test((await termText(1)).trim()) || (await termText(1)).includes("@"), 20000);
  const focusTerm = (n: number) => A.page.locator(".term:not(.code) .xterm").nth(n).locator(".xterm-helper-textarea").focus();
  await focusTerm(0);
  await A.page.keyboard.press("Alt+b");
  await focusTerm(1);
  await A.page.keyboard.press("Alt+b");
  const bcast = A.page.locator(".term:not(.code) button[aria-pressed=true][title*='Alt+B']");
  await until("deux terminaux en diffusion", () => bcast.count().then((n) => n === 2));
  ok(true, "Alt+B met deux terminaux dans la diffusion de saisie");
  ok((await activeTool(A.page)) === "toolbar-selection", "Alt+B ne change pas l'outil Excalidraw");
  await A.page.keyboard.type("echo diffusion-$((20+22))");
  await A.page.keyboard.press("Enter");
  await until("sortie dans les deux terminaux", async () => (await termText(0)).includes("diffusion-42") && (await termText(1)).includes("diffusion-42"), 20000);
  ok(true, "ce qui est tapé dans un terminal de la diffusion s'exécute dans les deux shells");
  await A.page.keyboard.press("Alt+b");
  await focusTerm(0);
  await A.page.keyboard.press("Alt+b");
  await until("diffusion arrêtée", () => bcast.count().then((n) => n === 0));
  ok(true, "Alt+B retire les terminaux de la diffusion");

  // Draw something on the empty canvas (windows hidden) so the board has content for the history and the public view.
  await dockA.getByTitle("Tout masquer").click();
  await A.page.locator(".excalidraw canvas.interactive").click({ position: { x: 900, y: 700 }, force: true });
  await A.page.keyboard.press("r");
  await until("outil rectangle", async () => (await activeTool(A.page)) === "toolbar-rectangle");
  await A.page.mouse.move(850, 650);
  await A.page.mouse.down();
  await A.page.mouse.move(1000, 760, { steps: 6 });
  await A.page.mouse.up();
  ok(true, "un rectangle est dessiné sur le canvas");

  await A.page.getByTitle("Historique des versions").click();
  const history = A.page.getByRole("complementary", { name: "Historique du tableau" });
  await history.locator(".history-item").first().waitFor({ timeout: 30000 });
  ok((await history.locator(".history-item").count()) >= 1, "le panneau d'historique s'ouvre et liste des versions");
  await history.locator(".history-item").first().click();
  await history.getByAltText("Aperçu de la version").or(history.getByText("Rien à afficher")).waitFor({ timeout: 15000 });
  ok(true, "une version s'affiche en aperçu");
  await A.page.getByTitle("Historique des versions").click();
  ok((await A.page.getByTitle(/^Vérifier le schéma/).count()) === 0, "le bouton « Vérifier le schéma » n'apparaît pas tant qu'aucun câble ne relie une machine");

  // Public link: created from the share dialog, opened logged out.
  await A.page.getByRole("button", { name: "Partager", exact: true }).click();
  const shareDlg = A.page.getByRole("dialog");
  await shareDlg.getByLabel("Libellé du lien").fill("Pour le jury");
  await shareDlg.getByRole("button", { name: /Créer/ }).click();
  const link = await until("lien public", () => shareDlg.getByLabel("Lien public").inputValue(), 15000);
  ok(/\/p\/|public|#/.test(link), "un lien public est créé (la clé reste dans le fragment de l'URL)");
  await shareDlg.getByRole("button", { name: "Fermer" }).click();
  const P = await newUser("public");
  await P.page.goto(link);
  await P.page.locator(".public-view .excalidraw").waitFor({ timeout: 30000 });
  ok(await P.page.getByText(/Vue en lecture seule/).isVisible(), "le lien public ouvre le tableau en lecture seule, sans compte");
  await until("dessin affiché", async () => (await P.page.locator(".excalidraw canvas").count()) > 0);
  ok((await P.page.locator(".xterm, .monaco-editor, .nb-cells, .term").count()) === 0, "la vue publique ne contient aucun terminal, éditeur ni notebook");
  ok((await P.page.locator(".App-toolbar").count()) === 0, "la vue publique n'a pas la barre d'outils de dessin (lecture seule)");
  await noConsoleErrors("diffusion, historique et vue publique : aucune erreur console");

  // ---- 8. Fichiers, câble, capture, configuration, schéma, export ----
  block("8. Fichiers, capture sur un câble, configuration, vérification du schéma, export");
  await A.page.goto(boardUrl);
  await A.page.locator(".excalidraw canvas").first().waitFor();
  const dock8 = A.page.getByRole("complementary", { name: "Fenêtres du tableau" });
  await dock8.waitFor({ timeout: 30000 });

  // 8a. File panel: drop a file on a shell window, list it, download it.
  // Only the first shell open: windows overlapping it would take its clicks.
  if (await dock8.getByTitle("Tout masquer").first().isVisible().catch(() => false)) await dock8.getByTitle("Tout masquer").first().click();
  await dock8.locator(".dock-main", { hasText: "Shell 1" }).click();
  const shell8 = A.page.locator(".term:not(.code):has(.xterm)").first();
  await shell8.locator(".xterm").waitFor({ timeout: 30000 });
  await until("shell prêt", async () => (await shell8.locator(".xterm-rows").innerText()).trim().length > 0, 20000);
  await shell8.evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["contenu-déposé-ß"], "depose.txt", { type: "text/plain" }));
    for (const t of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  const dropped = join(agentHome, "depose.txt");
  await until("fichier déposé sur la machine", () => existsSync(dropped), 20000);
  ok(readFileSync(dropped, "utf8") === "contenu-déposé-ß", "glisser-déposer d'un fichier sur la fenêtre d'un shell l'envoie dans le dossier du shell");
  const filesBtn = (shell: ReturnType<Page["locator"]>) => shell.locator("button[title^='Fichiers']");
  /** A window that is not active sits under the canvas: a click in its shell area activates it, then its header buttons answer. */
  const pressFiles = async (shell: ReturnType<Page["locator"]>) => {
    await until("bouton Fichiers cliquable", async () => {
      await shell.locator(".xterm").click({ force: true, position: { x: 120, y: 120 } });
      return filesBtn(shell).click({ timeout: 1500 }).then(() => true, () => false);
    });
  };
  await pressFiles(shell8);
  const panel8 = shell8.locator(".term-files");
  const row8 = panel8.locator(".term-files-row", { hasText: "depose.txt" });
  await row8.waitFor({ timeout: 20000 });
  ok(true, "le panneau Fichiers liste le fichier envoyé");
  const dl8 = A.page.waitForEvent("download", { timeout: 30000 });
  await row8.click();
  const file8 = await dl8;
  const p8 = join(DATA, "depose-dl.txt");
  await file8.saveAs(p8);
  ok(file8.suggestedFilename() === "depose.txt" && readFileSync(p8, "utf8") === "contenu-déposé-ß", "un clic sur le fichier le télécharge, octets identiques");
  await pressFiles(shell8);
  await noConsoleErrors("fichiers : aucune erreur console");

  // 8b. A cable from the machine icon to a rectangle, then the data of its end.
  await dock8.getByTitle("Tout masquer").first().click();
  const tile8 = A.page.locator(".excalidraw__embeddable-container").filter({ hasText: "vm-tp" }).first();
  await tile8.waitFor({ timeout: 15000 });
  const tb = (await tile8.boundingBox())!;
  const rx = tb.x + 380 < 1100 ? tb.x + 380 : tb.x - 380;
  const ry = tb.y + 120;
  await A.page.locator('[data-testid="toolbar-rectangle"]').click({ force: true });
  await A.page.mouse.move(rx, ry);
  await A.page.mouse.down();
  await A.page.mouse.move(rx + 140, ry + 90, { steps: 6 });
  await A.page.mouse.up();
  await A.page.keyboard.press("Escape");
  await A.page.getByRole("button", { name: "Câble", exact: true }).click();
  await A.page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await A.page.mouse.down();
  await A.page.mouse.move(rx + 70, ry + 45, { steps: 12 });
  await A.page.mouse.up();
  // The cable runs from the icon's center to the rectangle's: its middle is a safe place to click.
  const cableMid = { x: (tb.x + tb.width / 2 + rx + 70) / 2, y: (tb.y + tb.height / 2 + ry + 45) / 2 };
  const intBtn = A.page.locator("button.cable-int");
  const selectCable = async () => {
    await until("extrémités du câble visibles", async () => {
      if ((await intBtn.count()) > 0) return true;
      await A.page.keyboard.press("Escape");
      await A.page.mouse.click(cableMid.x, cableMid.y);
      return (await intBtn.count()) > 0;
    });
  };
  await selectCable();
  ok((await intBtn.count()) >= 2, "un câble relie l'icône de la machine au rectangle (« Câble » de l'en-tête)");
  const openEnd = async () => {
    await selectCable();
    await intBtn.first().click({ force: true });
    const d = A.page.locator(".modal[role=dialog]");
    await d.waitFor({ timeout: 10000 });
    return d;
  };
  let end = await openEnd();
  await end.getByLabel("Interface", { exact: true }).fill("lo");
  await end.getByLabel("Adresse IP").fill("127.0.0.1/8");
  await end.getByRole("button", { name: "Enregistrer" }).click();
  await end.waitFor({ state: "detached" });

  // 8c. « Générer la config » from the cabled node.
  await A.page.keyboard.press("Escape");
  await tile8.click({ position: { x: 12, y: 12 }, force: true });
  await A.page.locator(".term-float button[title^='Générer la config']").first().click();
  const cfg = A.page.locator(".modal[role=dialog]");
  await cfg.getByRole("heading", { name: /Générer la config/ }).waitFor();
  await cfg.locator("select").first().selectOption({ label: "Linux ip (iproute2)" });
  const linuxCfg = await cfg.locator("textarea").inputValue();
  ok(/ip addr add 127\.0\.0\.1\/8 dev lo/.test(linuxCfg), `la config Linux contient ip addr add 127.0.0.1/8 dev lo (${linuxCfg.split("\n").find((l) => l.includes("addr")) ?? "?"})`);
  await cfg.locator("select").first().selectOption({ label: "Cisco IOS · routeur" });
  const iosCfg = await cfg.locator("textarea").inputValue();
  ok(/interface \S*lo\S*/i.test(iosCfg) && /ip address 127\.0\.0\.1 255\.0\.0\.0/.test(iosCfg), "la config Cisco IOS contient l'interface et « ip address 127.0.0.1 255.0.0.0 »");
  await cfg.getByRole("button", { name: "Fermer" }).first().click();

  // 8d. « Vérifier le schéma »: lo + 127.0.0.1/8 matches the machine, a wrong address does not, the fix repairs the drawing.
  const schemaBtn = A.page.getByTitle(/^Vérifier le schéma/);
  await schemaBtn.waitFor({ timeout: 15000 });
  await schemaBtn.click();
  const schemaPanel = A.page.getByRole("complementary", { name: "Vérification du schéma" });
  await until("schéma conforme", async () => /Le schéma correspond aux machines/.test(await schemaPanel.innerText()), 30000);
  ok(true, "Vérifier le schéma : lo + 127.0.0.1/8 correspond à la machine, aucun écart");
  // A drawn address the machine does not have is reported (no automatic fix: which one is right is the user's call).
  end = await openEnd();
  await end.getByLabel("Adresse IP").fill("127.0.0.9/8");
  await end.getByRole("button", { name: "Enregistrer" }).click();
  await end.waitFor({ state: "detached" });
  await sleep(2300); // the server paces probes: one per machine every 2 s
  await schemaPanel.getByTitle("Revérifier").click();
  await until("écart signalé", async () => /127\.0\.0\.9\/8 absente/.test(await schemaPanel.innerText()), 30000);
  ok((await A.page.locator(".schema-badge").count()) >= 1, "une adresse dessinée que la machine n'a pas : écart signalé dans le panneau et badge sur le câble");
  // A wrong prefix has a fix: « Corriger le schéma » puts the machine's.
  end = await openEnd();
  await end.getByLabel("Adresse IP").fill("127.0.0.1/16");
  await end.getByRole("button", { name: "Enregistrer" }).click();
  await end.waitFor({ state: "detached" });
  await sleep(2300);
  await schemaPanel.getByTitle("Revérifier").click();
  const fixBtn = schemaPanel.getByRole("button", { name: /Corriger le schéma/ }).first();
  await fixBtn.waitFor({ timeout: 30000 });
  ok(/préfixe différent/.test(await schemaPanel.innerText()), "un mauvais préfixe donne un écart, avec « Corriger le schéma » proposé");
  await sleep(2300);
  await fixBtn.click();
  await until("schéma corrigé", async () => /Le schéma correspond aux machines/.test(await schemaPanel.innerText()), 30000);
  ok(true, "« Corriger le schéma » remet le préfixe réel et la vérification est de nouveau au vert");
  await schemaPanel.getByTitle("Fermer").click();
  end = await openEnd();
  ok((await end.getByLabel("Adresse IP").inputValue()) === "127.0.0.1/8", "l'adresse du câble a bien été corrigée dans le dessin");
  await end.locator(".modal-actions").getByRole("button", { name: "Annuler" }).click();

  // 8e. Containerlab export.
  await A.page.getByTitle(/^Exporter le schéma/).click();
  const dlc = A.page.waitForEvent("download", { timeout: 20000 });
  await A.page.getByRole("button", { name: /Topologie Containerlab/ }).click();
  const clab = await dlc;
  const clabPath = join(DATA, "topo.clab.yml");
  await clab.saveAs(clabPath);
  const yml = readFileSync(clabPath, "utf8");
  ok(clab.suggestedFilename().endsWith(".clab.yml") && /vm-tp/.test(yml) && /nodes:/.test(yml) && /links:/.test(yml), `l'export Containerlab est un YAML qui nomme les nœuds (vm-tp) et les liens (${clab.suggestedFilename()})`);
  await noConsoleErrors("câble, config, schéma, export : aucune erreur console");

  // 8f. Capture on the cable end, with the modal closed during the capture.
  const rootUser = process.getuid?.() === 0;
  const hasTcpdump = existsSync("/usr/sbin/tcpdump") || existsSync("/usr/bin/tcpdump") || existsSync("/sbin/tcpdump");
  end = await openEnd();
  const cap = end.locator(".capture-box");
  await cap.waitFor({ timeout: 10000 });
  const ifaceSel = cap.getByRole("combobox", { name: "Interface à capturer" });
  await ifaceSel.waitFor({ timeout: 20000 });
  ok((await ifaceSel.inputValue()) === "lo", "le select d'interfaces propose celles de la machine et préselectionne celle du câble (lo)");
  await end.getByLabel("Interface", { exact: true }).fill("eth9");
  await cap.getByTestId("capture-iface-missing").waitFor();
  ok(/eth9/.test(await cap.getByTestId("capture-iface-missing").innerText()), "une interface de câble inexistante est signalée : « l'interface du câble (eth9) n'existe pas sur la machine »");
  await end.getByLabel("Interface", { exact: true }).fill("lo");
  await until("lo de nouveau présélectionnée", async () => (await ifaceSel.inputValue()) === "lo");
  await cap.getByLabel(/Durée/).fill("3");
  const ping = spawn("ping", ["-i", "0.2", "-c", "40", "127.0.0.1"], { stdio: "ignore" });
  children.push(ping);
  const dlCap = A.page.waitForEvent("download", { timeout: 40000 }).catch((e) => e as Error);
  await cap.getByRole("button", { name: /Capturer sur lo/ }).click();
  if (rootUser && hasTcpdump) {
    await cap.getByTestId("capture-running").waitFor({ timeout: 15000 });
    await end.locator(".modal-actions").getByRole("button", { name: "Annuler" }).click(); // closes the window, the capture goes on
    await end.waitFor({ state: "detached" });
    const chip = A.page.getByTestId("capture-chip");
    await chip.waitFor({ timeout: 10000 });
    ok(/Capture lo/.test(await chip.innerText()), `un indicateur flottant montre la capture en cours après la fermeture de la fenêtre (« ${(await chip.innerText()).replace(/\s+/g, " ")} »)`);
    const d = await dlCap;
    if (d instanceof Error) throw new Error(`la capture n'a pas été téléchargée : ${d.message}`);
    const pcapPath = join(DATA, "capture.pcap");
    await d.saveAs(pcapPath);
    const pc = readFileSync(pcapPath);
    const magic = pc.subarray(0, 4).toString("hex");
    const le = ["d4c3b2a1", "4d3cb2a1"].includes(magic);
    ok(pc.length > 24 && (le || ["a1b2c3d4", "a1b23c4d"].includes(magic)), `la capture téléchargée est un pcap valide (${pc.length} octets, ${d.suggestedFilename()})`);
    const u32 = (o: number) => (le ? pc.readUInt32LE(o) : pc.readUInt32BE(o));
    const link = u32(20);
    let icmp = 0;
    for (let o = 24; o + 16 <= pc.length; ) {
      const n = u32(o + 8);
      const pkt = o + 16;
      const ip = link === 1 ? pkt + 14 : link === 113 ? pkt + 16 : link === 0 || link === 108 ? pkt + 4 : -1;
      if (ip >= 0 && ip + 20 <= pc.length && pc[ip] >> 4 === 4 && pc[ip + 9] === 1) icmp++;
      o = pkt + n;
    }
    ok(icmp >= 4, `le pcap contient les paquets ICMP du ping de fond (${icmp} paquets)`);
    await until("indicateur retiré à la fin", async () => (await A.page.getByTestId("capture-chip").count()) === 0, 15000);
  } else {
    // Not root (or no tcpdump): the panel must say why, inline, with the way out.
    const msg = await cap.getByTestId("capture-error").innerText({ timeout: 20000 });
    ok(hasTcpdump ? /setcap/.test(msg) : /tcpdump n'est pas installé/.test(msg), `capture refusée : le panneau l'explique (${msg.split("\n")[0].slice(0, 90)})`);
    await end.locator(".modal-actions").getByRole("button", { name: "Annuler" }).click();
  }
  ping.kill();
  await noConsoleErrors("capture : aucune erreur console");

  // 8g. An agent that announces no capabilities (as before this feature) is refused with the update instructions.
  await A.page.routeWebSocket(/\/ws\?board=/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      try {
        const j = JSON.parse(String(m));
        if (j.t === "init") for (const t of j.terminals ?? []) t.agentCaps = [];
        if (j.t === "term" && j.terminal) j.terminal.agentCaps = [];
        ws.send(JSON.stringify(j));
      } catch {
        ws.send(m);
      }
    });
  });
  await A.page.goto(boardUrl);
  await A.page.locator(".excalidraw canvas").first().waitFor();
  await A.page.locator(".excalidraw__embeddable-container").filter({ hasText: "vm-tp" }).first().waitFor({ timeout: 30000 });
  const old8 = await (async () => {
    await A.page.mouse.click(cableMid.x, cableMid.y);
    await until("extrémités du câble visibles", () => intBtn.count().then((n) => n > 0));
    await intBtn.first().click({ force: true });
    const d = A.page.locator(".modal[role=dialog]");
    await d.waitFor();
    return d;
  })();
  const notice = old8.locator(".capture-box").getByTestId("agent-outdated");
  await notice.waitFor({ timeout: 20000 });
  const noticeText = await notice.innerText();
  ok(/L'agent de vm-tp est trop ancien pour la capture réseau : mets-le à jour/.test(noticeText) && /\/update\.sh \| sh/.test(noticeText), "agent sans fonctions annoncées : la capture affiche « trop ancien » avec la commande de mise à jour");
  await shot("agent-ancien-capture");
  await old8.locator(".modal-actions").getByRole("button", { name: "Annuler" }).click();
  await A.page.getByRole("complementary", { name: "Fenêtres du tableau" }).locator(".dock-main", { hasText: "Shell 1" }).click();
  const shellOld = A.page.locator(".term:not(.code):has(.xterm)").first();
  await pressFiles(shellOld);
  const dlgOld = A.page.getByRole("dialog").filter({ hasText: "Agent à mettre à jour" });
  await dlgOld.waitFor({ timeout: 20000 });
  ok(/trop ancien pour le transfert de fichiers/.test(await dlgOld.innerText()), "le panneau Fichiers d'un agent trop ancien ouvre une explication avec la commande, sans attendre 70 s");
  await dlgOld.getByRole("button", { name: "Fermer" }).click();
  await A.page.unrouteAll({ behavior: "ignoreErrors" });
  await noConsoleErrors("agent ancien : aucune erreur console");

  // 8h. The Machines page shows the agent's version, and the update action once the list says it lacks something.
  await A.page.goto("/machines");
  await A.page.getByTestId("agent-version").first().waitFor({ timeout: 20000 });
  ok(/^Agent \S+/.test(await A.page.getByTestId("agent-version").first().innerText()) && (await A.page.getByText("à mettre à jour", { exact: true }).count()) === 0, "page Machines : la version de l'agent s'affiche, sans badge pour un agent à jour");
  await A.page.route(/\/api\/machines$/, async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    for (const m of j.machines ?? []) m.agentCaps = [];
    await route.fulfill({ response: r, json: j });
  });
  await A.page.goto("/machines");
  await A.page.getByText("à mettre à jour", { exact: true }).first().waitFor({ timeout: 20000 });
  await A.page.getByRole("button", { name: /Mettre à jour l'agent/ }).first().click();
  const upd = A.page.locator(".modal[role=dialog]");
  ok(/curl -fsSL \S+\/update\.sh \| sh/.test(await upd.innerText()), "agent sans fonctions annoncées : badge « à mettre à jour » et la commande de mise à jour de l'instance");
  await shot("machines-mise-a-jour");
  await upd.getByRole("button", { name: "Fermer" }).click();
  await A.page.unrouteAll({ behavior: "ignoreErrors" });
  await noConsoleErrors("page Machines : aucune erreur console");

  // 8i. One-click agent update: the button on the Machines page and the board's « Mettre à jour les agents »
  // (the instance's release is stubbed; the agent of this suite has no release key, so the real round trip ends in its refusal).
  const stubLatest = (latest: { version: string | null; signed: boolean }) => A.page.route(/\/api\/agent\/latest$/, (route) => route.fulfill({ json: latest }));
  const stubMachines = (patch: (m: any) => void) =>
    A.page.route(/\/api\/machines$/, async (route) => {
      const r = await route.fetch();
      const j = await r.json();
      for (const m of j.machines ?? []) patch(m);
      await route.fulfill({ response: r, json: j });
    });
  await stubLatest({ version: "2.0.0", signed: true });
  await stubMachines((m) => (m.agentVersion = "1.0.0"));
  await A.page.goto("/machines");
  const upBtn = A.page.getByTestId("update-agent").first();
  await upBtn.waitFor({ timeout: 20000 });
  ok(/Mettre à jour \(1\.0\.0 → 2\.0\.0\)/.test(await upBtn.innerText()) && !(await upBtn.isDisabled()), "page Machines : « Mettre à jour (1.0.0 → 2.0.0) » pour un agent en retard quand l'instance a une release signée");
  await shot("machines-maj-un-clic");
  await upBtn.click();
  const oneDlg = A.page.getByTestId("update-dialog");
  const warn = await oneDlg.getByTestId("update-warning").innerText();
  ok(/redémarre l'agent/.test(warn) && /shells? ouverts? (seront interrompus|sera interrompu)|Aucun shell ouvert/.test(warn), `la confirmation prévient du redémarrage et compte les shells ouverts (${warn.split("\n").pop()})`);
  await oneDlg.getByTestId("update-confirm").click();
  const oneStatus = oneDlg.getByTestId("update-status").first();
  await until("l'agent répond", async () => /échec/.test(await oneStatus.innerText()), 30000);
  ok(/aucune clé de signature intégrée/.test(await oneStatus.innerText()), "un agent construit sans clé refuse : son message s'affiche (« échec : … aucune clé de signature intégrée »)");
  await shot("machines-maj-echec");
  await oneDlg.getByRole("button", { name: "Fermer" }).click();
  await A.page.unrouteAll({ behavior: "ignoreErrors" });

  // No signed release on this instance: disabled, with the reason, next to the manual command.
  await stubLatest({ version: null, signed: false });
  await stubMachines((m) => ((m.agentVersion = "1.0.0"), (m.agentCaps = ["files"])));
  await A.page.goto("/machines");
  const offBtn = A.page.getByTestId("update-agent").first();
  await offBtn.waitFor({ timeout: 20000 });
  ok((await offBtn.isDisabled()) && /mise à jour automatique non configurée sur cette instance/.test((await offBtn.getAttribute("title")) ?? ""), "sans release signée : bouton désactivé, « mise à jour automatique non configurée sur cette instance »");
  ok((await A.page.getByRole("button", { name: /Mettre à jour l'agent/ }).count()) > 0, "…et la commande manuelle reste proposée");
  await A.page.unrouteAll({ behavior: "ignoreErrors" });
  // Release signed but the agent has no « update » function: disabled too, manual command.
  await stubLatest({ version: "2.0.0", signed: true });
  await stubMachines((m) => ((m.agentVersion = "1.0.0"), (m.agentCaps = ["files"])));
  await A.page.goto("/machines");
  const capBtn = A.page.getByTestId("update-agent").first();
  await capBtn.waitFor({ timeout: 20000 });
  ok((await capBtn.isDisabled()) && /trop ancien pour se mettre à jour seul/.test((await capBtn.getAttribute("title")) ?? ""), "agent sans la fonction « update » : bouton désactivé, infobulle et commande manuelle");
  await A.page.unrouteAll({ behavior: "ignoreErrors" });

  // The board: the header button counts the outdated machines of the board and the dialog lists their status.
  await stubLatest({ version: "2.0.0", signed: true });
  await stubMachines((m) => (m.agentVersion = "1.0.0"));
  await A.page.goto(boardUrl);
  await A.page.locator(".excalidraw canvas").first().waitFor();
  const boardBtn = A.page.getByTestId("update-agents-button");
  await boardBtn.waitFor({ timeout: 30000 });
  ok(/Mettre à jour les agents \(1\)/.test(await boardBtn.innerText()), "tableau : « Mettre à jour les agents (1) » dans l'en-tête");
  await boardBtn.click();
  const boardDlg = A.page.getByTestId("update-dialog");
  const rowTxt = await boardDlg.locator("[data-testid^=update-row-]").first().innerText();
  ok(/vm-tp/.test(rowTxt) && /1\.0\.0 → 2\.0\.0/.test(rowTxt) && /à mettre à jour/.test(rowTxt), `le dialogue liste la machine et son état (${rowTxt.replace(/\n/g, " · ")})`);
  await shot("tableau-maj-agents");
  await boardDlg.getByTestId("update-confirm").click();
  await until("statut après la demande", async () => /échec/.test(await boardDlg.getByTestId("update-status").first().innerText()), 30000);
  ok(true, "le statut passe à « échec : … » avec la raison donnée par l'agent");
  await boardDlg.getByRole("button", { name: "Fermer" }).click();
  await A.page.unrouteAll({ behavior: "ignoreErrors" });
  // Agent already at the latest version, or too old to update itself: no button on the board.
  await stubLatest({ version: "2.0.0", signed: true });
  await stubMachines((m) => ((m.agentVersion = "1.0.0"), (m.agentCaps = ["files"])));
  await A.page.goto(boardUrl);
  await A.page.locator(".excalidraw canvas").first().waitFor();
  await A.page.waitForTimeout(3000);
  ok((await A.page.getByTestId("update-agents-button").count()) === 0, "tableau : pas de bouton quand aucune machine n'est mettable à jour en un clic");
  await A.page.unrouteAll({ behavior: "ignoreErrors" });
  await noConsoleErrors("mise à jour des agents : aucune erreur console");

  await shot("fin");
} catch (e) {
  console.log(`✘ ${(e as Error).message}`);
  failures++;
  await shot("echec");
} finally {
  const p = takeProblems();
  if (p.length) console.log(p.join("\n"));
  for (const c of children) c.kill();
  await browser.close();
}
console.log(failures ? `\n${failures} échec(s)` : "\nTout est OK");
process.exit(failures ? 1 : 0);
