// Excalibash MCP client: logs in like the browser, then serves MCP tools over stdio.
// All decryption happens here, on the user's machine.
import { createInterface } from "node:readline";
import { auditPath, deleteConfig, loadConfig, resolveConfigPath, saveConfig } from "./config.ts";
import { api, ApiError, keysOf, login, normalizeUrl, useServer } from "./client.ts";
import { serveStdio, VERSION } from "./mcp.ts";
import { buildTools } from "./tools.ts";

const HELP = `Excalibash MCP ${VERSION} — expose tes tableaux à un client MCP, déchiffrés localement.

Usage : node excalibash-mcp.mjs [commande] [options]

Commandes :
  login     Se connecte (adresse, email, mot de passe) et enregistre la session et la clé
            (variables EXCALIBASH_URL, EXCALIBASH_EMAIL, EXCALIBASH_PASSWORD pour le mode non interactif ;
            EXCALIBASH_TOTP pour le code à deux facteurs, si le compte en a un)
  logout    Ferme la session sur le serveur et supprime le fichier de configuration
  statut    Affiche l'état de la connexion
  serve     Lance le serveur MCP sur stdin/stdout (commande par défaut)

Options de serve :
  --autoriser-saisie     Active l'outil ecrire_terminal (taper dans un terminal)
  --autoriser-edition    Active l'outil ajouter_note (ajouter un texte sur un tableau)
  --tableaux <id,id>     Limite tous les outils à ces tableaux
  --config <chemin>      Fichier de configuration (défaut : ~/.config/excalibash/mcp.json)
`;

const log = (s: string) => process.stderr.write(s + "\n");

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s);
    if (name === "config" || name === "tableaux") {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`L'option --${name} attend une valeur.`);
      flags.set(name, v);
    } else if (name === "autoriser-saisie" || name === "autoriser-edition" || name === "help" || name === "version") {
      flags.set(name, true);
    } else throw new Error(`Option inconnue : --${name}\n\n${HELP}`);
  }
  return { flags, rest };
}

async function ask(question: string, secret = false): Promise<string> {
  process.stderr.write(question);
  if (secret && process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let s = "";
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n" || ch === "\u0004") {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.off("data", onData);
            process.stderr.write("\n");
            return resolve(s);
          }
          if (ch === "\u0003") {
            stdin.setRawMode(false);
            process.stderr.write("\n");
            return reject(new Error("Interrompu."));
          }
          if (ch === "\u007f" || ch === "\b") s = s.slice(0, -1);
          else s += ch;
        }
      };
      stdin.on("data", onData);
    });
  }
  const rl = createInterface({ input: process.stdin, terminal: false });
  return new Promise((resolve) => {
    rl.once("line", (l) => {
      rl.close();
      resolve(l);
    });
    rl.once("close", () => resolve(""));
  });
}

async function cmdLogin(configPath: string) {
  const url = normalizeUrl(process.env.EXCALIBASH_URL || (await ask("Adresse d'Excalibash (ex. https://excalibash.exemple.fr) : ")));
  const email = (process.env.EXCALIBASH_EMAIL || (await ask("Email : "))).trim();
  const password = process.env.EXCALIBASH_PASSWORD || (await ask("Mot de passe : ", true));
  if (!email || !password) throw new Error("Email et mot de passe obligatoires.");
  if (url.startsWith("http://") && !/^http:\/\/(localhost|127\.|\[::1\])/.test(url)) log("Attention : connexion en HTTP clair (hors machine locale).");
  const cfg = await login(url, email, password, async () => process.env.EXCALIBASH_TOTP || (await ask("Code à deux facteurs : ")));
  saveConfig(configPath, cfg);
  log(`Connecté en tant que ${cfg.email} sur ${cfg.url}.\nConfiguration enregistrée dans ${configPath} (clé privée incluse : protège ce fichier).`);
}

async function cmdLogout(configPath: string) {
  const cfg = loadConfig(configPath, { skipPermissions: true });
  useServer(cfg.url, cfg.cookie);
  try {
    await api.post("/auth/logout");
    log("Session fermée sur le serveur.");
  } catch (e) {
    log(`Session non fermée sur le serveur (${(e as Error).message}) : révoque-la depuis le navigateur si besoin.`);
  }
  deleteConfig(configPath);
  log(`Configuration supprimée (${configPath}).`);
}

async function cmdStatus(configPath: string) {
  const cfg = loadConfig(configPath);
  log(`Configuration : ${configPath} (droits corrects)\nServeur : ${cfg.url}\nCompte : ${cfg.email}\nJournal d'audit : ${auditPath(configPath)}`);
  await keysOf(cfg);
  log("Clé privée : cohérente avec la clé publique du compte.");
  useServer(cfg.url, cfg.cookie);
  try {
    await api.get("/auth/me");
    log("Session : valide.");
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) log("Session : expirée ou révoquée (relance « login »).");
    else log(`Session : serveur injoignable (${(e as Error).message}).`);
  }
}

async function cmdServe(configPath: string, flags: Map<string, string | true>) {
  // Safety net: nothing but protocol may reach stdout.
  console.log = console.info = console.debug = (...a: unknown[]) => log(a.join(" "));
  const cfg = loadConfig(configPath);
  const keys = await keysOf(cfg);
  useServer(cfg.url, cfg.cookie);
  const boards = typeof flags.get("tableaux") === "string" ? new Set((flags.get("tableaux") as string).split(",").map((s) => s.trim()).filter(Boolean)) : null;
  const allowInput = flags.has("autoriser-saisie");
  const allowEdit = flags.has("autoriser-edition");
  const tools = buildTools(cfg, keys, { allowInput, allowEdit, boards, configPath });
  log(
    `excalibash-mcp ${VERSION} : ${cfg.email} sur ${cfg.url} ; ${tools.length} outils` +
      `${allowInput ? " ; saisie terminal ACTIVÉE" : ""}${allowEdit ? " ; édition ACTIVÉE" : ""}${boards ? ` ; limité à ${boards.size} tableau(x)` : ""}`,
  );
  serveStdio(tools, { name: "excalibash", version: VERSION }, () => process.exit(0));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
}

try {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  if (flags.has("help")) {
    log(HELP);
  } else if (flags.has("version")) {
    log(VERSION);
  } else {
    const configPath = resolveConfigPath(flags.get("config") as string | undefined);
    switch (rest[0] ?? "serve") {
      case "login":
        await cmdLogin(configPath);
        break;
      case "logout":
        await cmdLogout(configPath);
        break;
      case "statut":
        await cmdStatus(configPath);
        break;
      case "serve":
        await cmdServe(configPath, flags);
        break;
      default:
        throw new Error(`Commande inconnue : ${rest[0]}\n\n${HELP}`);
    }
  }
} catch (e) {
  log(`Erreur : ${(e as Error).message}`);
  process.exit(1);
}
