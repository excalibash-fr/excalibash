export type User = { id: string; email: string; name: string; isAdmin: boolean; color: string; publicKey: string; mfaEnabled: boolean };

export type Role = "owner" | "editor" | "viewer";

/** Item as stored by the server: everything sensitive is ciphertext. */
export type RawItem = {
  id: string;
  kind: "folder" | "board";
  parentId: string | null;
  ownerId: string;
  ownerName: string;
  encName: string;
  keyWrap: string | null;
  epoch: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  shares: number;
  terminals: number;
};

export type RawGrant = { itemId: string; role: Role; wrappedKey: string; grantedBy: string | null };

export type RawMachine = {
  id: string;
  encName: string;
  encPub: string;
  encAuth: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  /** What the agent announced: its version and features (empty: an agent from before the list existed). */
  agentVersion: string | null;
  agentCaps: string[];
  /** Said by the agent in its hello after a rolled-back update (« mise à jour annulée »). */
  agentNote?: string | null;
  /** Shells open on the machine (an update restarts the agent and ends them). */
  openSessions?: number;
  lastSeen: number | null;
  online: boolean;
  shareBoards: boolean;
};

/** A machine someone else shared (directly, or through a board): its keys sealed or boxed for us. */
export type RawSharedMachine = {
  id: string;
  ownerId: string;
  ownerName: string;
  key: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  /** What the agent announced: its version and features (empty: an agent from before the list existed). */
  agentVersion: string | null;
  agentCaps: string[];
  agentNote?: string | null;
  openSessions?: number;
  lastSeen: number | null;
  online: boolean;
};

/** Element as the server sees it: merge metadata + ciphertext. */
export type Entry = { id: string; v: number; n: number; c: string };

export type TerminalInfo = {
  id: string;
  boardId: string;
  machineId: string;
  machineOwnerId: string | null;
  /** The machine's agent: version and features, for the features that need a recent one. */
  agentVersion: string | null;
  agentCaps: string[];
  status: "starting" | "running" | "exited" | "offline";
  exitCode: number | null;
  cols: number;
  rows: number;
  createdBy: string | null;
  keyForBoard: string;
  encLabel: string;
};

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Erreur ${res.status}`, data.code);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

/** Public settings of this instance (GET /api/config). */
export type ServerConfig = {
  proxyUrl: string;
  /** Subdomain mode: every web tunnel has its own origin <id>.<tunnelDomain>. null: one origin, /t/<id>/. */
  tunnelDomain: string | null;
  tunnelScheme: "https" | "http";
  emailVerification: boolean;
  contactEmail: string | null;
  legalName: string | null;
  /** null: plain HTTP (TLS done by a reverse proxy). pin: set for the instance's own self-signed certificate. */
  tls: { selfSigned: boolean; pin: string | null } | null;
};

let configPromise: Promise<ServerConfig> | null = null;
export function serverConfig(): Promise<ServerConfig> {
  configPromise ??= api.get<ServerConfig>("/config").catch((e) => {
    configPromise = null;
    throw e;
  });
  return configPromise;
}

export type WebInfo = {
  id: string;
  boardId: string;
  machineId: string;
  machineOwnerId: string | null;
  createdBy: string | null;
  online: boolean;
  keyForBoard: string;
  encLabel: string;
};

/** What a web tunnel points at (sealed for the agent, and in the board-encrypted label). */
export type WebTarget = { url: string; insecure: boolean; machine: string; hostHeader?: string; legacyTls?: boolean };

/** A device the agent connects to instead of starting a local shell (sealed for the agent only). */
export type RemoteTarget = {
  /**
   * "jupyter" runs a Jupyter kernel on the machine itself (same authority as a local shell) and speaks the
   * JSON-lines protocol of board/kernelProtocol.ts: it has no host or port (send "" and 0), only cwd / kernel.
   */
  kind: "telnet" | "ssh" | "raw" | "jupyter";
  host: string;
  port: number;
  /** Jupyter only: absolute or "~/"-relative working directory (the agent's home when absent). */
  cwd?: string;
  /** Jupyter only: kernelspec name, "python3" when absent. */
  kernel?: string;
  /** SSH only: empty means the agent asks "login as:" in the terminal. */
  user?: string;
  legacyKex?: boolean;
  legacyHostKey?: boolean;
  legacyCiphers?: boolean;
  hostKeyCheck?: "tofu" | "off";
  /** SSH jump hosts, the first one reached from the machine (like ssh -J); the target is reached from the last one. */
  via?: RemoteHop[];
};

/** One SSH jump host on the way to a device. */
export type RemoteHop = Omit<RemoteTarget, "kind" | "via">;
