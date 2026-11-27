// "Vérifier le schéma": compares what a cable end says (interface, IP, VLAN addresses) with the
// interfaces a machine really has (agent probe of kind "ifaces"). Pure: no Excalidraw, no network.
import type { EndInfo, End } from "./cableData.ts";
import { stripBrackets } from "../validators.ts";

/** One interface of a machine, as the agent reports it (agent/probe.go). */
export type IfaceInfo = { name: string; up: boolean; running?: boolean; mtu?: number; mac?: string; addrs: string[] };

/** One cable end of the machine's icons, with what is drawn there. */
export type NodeEnd = { cableId: string; end: End; info: EndInfo };

export type FindingKind = "iface-absente" | "interface-down" | "ip-absente" | "ip-ailleurs" | "prefixe-different" | "vlan-absent";
/** What replacing the drawing by reality changes at the end: only when it is unambiguous. */
export type FixPatch = { iface?: string; ip?: string; vlanIp?: { vlan: string; ip: string } };
export type Finding = { kind: FindingKind; message: string; fix?: { label: string; patch: FixPatch } };
export type EndResult = { cableId: string; end: End; key: string; status: "ok" | FindingKind; findings: Finding[] };
/** An address on the machine that no cable end of it mentions. */
export type ExtraAddr = { iface: string; addr: string };
export type Comparison = { ends: EndResult[]; extra: ExtraAddr[] };

// --- Addresses ---------------------------------------------------------------------------

export type Cidr = { addr: string; prefix?: number; v6: boolean };

function expandV6(s: string): number[] | null {
  let t = s.toLowerCase();
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (m) {
    const o = m[2].split(".").map(Number);
    if (o.length !== 4 || o.some((n) => !(n >= 0 && n <= 255))) return null;
    t = m[1] + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = t.split("::");
  if (halves.length > 2) return null;
  const part = (p: string) => (p === "" ? [] : p.split(":"));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.length === 8 && out.every((n) => !Number.isNaN(n)) ? out : null;
}

/** "10.0.0.1/24", "fe80::1%eth0/64", "[::1]" → canonical address and optional prefix, or null. */
export function parseCidr(v?: string): Cidr | null {
  if (!v) return null;
  const [rawAddr, rawPrefix, extra] = stripBrackets(v.trim()).split("/");
  if (extra !== undefined || !rawAddr) return null;
  const a = rawAddr.replace(/\]$/, "").split("%")[0];
  let prefix: number | undefined;
  if (rawPrefix !== undefined) {
    if (!/^\d{1,3}$/.test(rawPrefix)) return null;
    prefix = Number(rawPrefix);
  }
  if (a.includes(":")) {
    const g = expandV6(a);
    if (!g || (prefix !== undefined && prefix > 128)) return null;
    return { addr: g.map((n) => n.toString(16)).join(":"), prefix, v6: true };
  }
  const o = a.split(".");
  if (o.length !== 4 || o.some((n) => !/^\d{1,3}$/.test(n) || Number(n) > 255) || (prefix !== undefined && prefix > 32)) return null;
  return { addr: o.map(Number).join("."), prefix, v6: false };
}

const isLoopback = (c: Cidr) => (c.v6 ? c.addr === "0:0:0:0:0:0:0:1" : c.addr.startsWith("127."));
const isLinkLocal = (c: Cidr) => (c.v6 ? /^fe[89ab][0-9a-f]?:/.test(c.addr) : c.addr.startsWith("169.254."));

type Held = { iface: string; cidr: Cidr; text: string };
const heldBy = (ifaces: IfaceInfo[]): Held[] =>
  ifaces.flatMap((i) => (i.addrs ?? []).map((text) => ({ iface: i.name, text, cidr: parseCidr(text) })).filter((h): h is Held => !!h.cidr));

// --- Names -------------------------------------------------------------------------------

/** Levenshtein distance of two short names. */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const VIRTUAL = /^(lo\d*|docker\d*|br-|virbr|veth|tun\d|tap|wg\d|vnet|cni|flannel|cali|kube|vxlan|dummy|ifb|bond\d|vlan|zt|tailscale|utun|awdl|llw|bridge)/i;
/** Broad family of a name: wired (eth0, ens19, enp3s0, eno1, em1, Ethernet), wireless, or other. */
const family = (n: string) => (/^(eth|en|em|ethernet)/i.test(n) ? "wired" : /^(wl|wlan|wi-?fi)/i.test(n) ? "wireless" : "other");
const familyKey = (n: string) => (/^(en|eth|em|ethernet)/i.test(n) ? "wired" : family(n));

/**
 * The real interface most likely meant by a declared name that does not exist, or null when
 * unsure: the one holding the declared address, else a unique near spelling (Eth1, eth01), else
 * the only interface of the same family (wired…) that no other cable end of the machine uses.
 */
export function suggestIface(declared: string, ifaces: IfaceInfo[], opts: { ip?: string; claimed?: Set<string> } = {}): string | null {
  const want = parseCidr(opts.ip);
  if (want) {
    const holders = [...new Set(heldBy(ifaces).filter((h) => h.cidr.addr === want.addr).map((h) => h.iface))];
    if (holders.length === 1) return holders[0];
  }
  const names = ifaces.map((i) => i.name);
  const lower = declared.toLowerCase();
  const near = names.filter((n) => n.toLowerCase() === lower || editDistance(n.toLowerCase(), lower) <= 1).filter((n) => n !== declared);
  if (near.length === 1) return near[0];
  if (near.length > 1) return null;
  const claimed = opts.claimed ?? new Set<string>();
  const same = names.filter((n) => !VIRTUAL.test(n) && !/[.@]/.test(n) && familyKey(n) === familyKey(declared) && familyKey(declared) !== "other" && !claimed.has(n));
  return same.length === 1 ? same[0] : null;
}

/** Interfaces that can carry a VLAN: `<iface>.<id>`, `vlan<id>`, `vlan-<id>`, `*.<id>`, `<iface>-<id>`. */
export function vlanIfaces(ifaces: IfaceInfo[], parent: string | undefined, vlan: string): IfaceInfo[] {
  const id = String(Number(vlan));
  const exact = parent ? [`${parent}.${id}`, `${parent}-${id}`, `${parent}_${id}`] : [];
  const re = new RegExp(`^(?:vlan[-_.]?${id}|.+\\.${id}|.+@.*\\.${id}|(?:vl|v)${id})$`, "i");
  return ifaces.filter((i) => exact.includes(i.name) || re.test(i.name));
}

// --- Comparison --------------------------------------------------------------------------

const fmtPrefix = (p?: number) => (p === undefined ? "?" : `/${p}`);

/** Finds a declared address on a set of interfaces: where it is, with which prefix. */
function locate(held: Held[], want: Cidr, among?: Set<string>) {
  const same = held.filter((h) => h.cidr.addr === want.addr);
  const here = same.filter((h) => !among || among.has(h.iface));
  return { here: here[0], elsewhere: here.length ? undefined : same[0] };
}

/**
 * Compares the cable ends of a machine's icons with its interfaces. Every end with something
 * drawn gets a result (status "ok" when all matches, else one finding per discrepancy); the
 * addresses on the machine that no end mentions come back as `extra` (loopback and link-local left out).
 */
export function compareEnds(nodeEnds: NodeEnd[], ifaces: IfaceInfo[]): Comparison {
  const held = heldBy(ifaces);
  const byName = new Map(ifaces.map((i) => [i.name, i]));
  const claimed = new Set(nodeEnds.map((e) => e.info.iface?.trim()).filter((n): n is string => !!n && byName.has(n)));
  const mentioned = new Set<string>();
  const ends: EndResult[] = [];

  for (const { cableId, end, info } of nodeEnds) {
    const findings: Finding[] = [];
    const declared = info.iface?.trim();
    const want = parseCidr(info.ip);
    if (want) mentioned.add(want.addr);
    let iface = declared ? (byName.get(declared) ?? ifaces.find((i) => i.name.toLowerCase() === declared.toLowerCase() && !byName.has(declared))) : undefined;

    if (declared && !iface) {
      const s = suggestIface(declared, ifaces, { ip: info.ip, claimed });
      findings.push({
        kind: "iface-absente",
        message: `interface ${declared} absente de la machine${s ? ` (${s} ?)` : ""}`,
        ...(s ? { fix: { label: `Remplacer par ${s}`, patch: { iface: s } } } : {}),
      });
    } else if (iface && !iface.up) {
      findings.push({ kind: "interface-down", message: `interface ${iface.name} down` });
    }

    // The address: on the declared interface, else anywhere when none is declared.
    if (want && !(declared && !iface)) {
      const scope = iface ? new Set([iface.name]) : undefined;
      const { here, elsewhere } = locate(held, want, scope);
      if (here) {
        if (want.prefix !== undefined && here.cidr.prefix !== want.prefix) {
          findings.push({
            kind: "prefixe-different",
            message: `${info.ip!.split("/")[0]} : préfixe différent (${fmtPrefix(want.prefix)} attendu, ${fmtPrefix(here.cidr.prefix)} trouvé)`,
            fix: { label: `Mettre ${fmtPrefix(here.cidr.prefix)}`, patch: { ip: `${info.ip!.trim().split("/")[0]}/${here.cidr.prefix}` } },
          });
        }
      } else if (elsewhere) {
        findings.push({ kind: "ip-ailleurs", message: `${info.ip} présente ailleurs : sur ${elsewhere.iface} (${elsewhere.text})` });
      } else {
        findings.push({ kind: "ip-absente", message: `${info.ip} absente${iface ? ` de ${iface.name}` : " de la machine"}` });
      }
    }

    // VLAN addresses: on a sub-interface (`<iface>.<vlan>`) or any interface named with that VLAN.
    for (const [vlan, ip] of Object.entries(info.vlanIps ?? {})) {
      const vw = parseCidr(ip);
      if (!vw) continue;
      mentioned.add(vw.addr);
      const carriers = vlanIfaces(ifaces, declared, vlan);
      const names = new Set(carriers.map((c) => c.name));
      const expected = declared ? `${declared}.${vlan}` : `vlan${vlan}`;
      const { here, elsewhere } = locate(held, vw, names);
      if (here) {
        if (vw.prefix !== undefined && here.cidr.prefix !== vw.prefix) {
          findings.push({
            kind: "prefixe-different",
            message: `VLAN ${vlan} : ${ip.split("/")[0]} préfixe différent (${fmtPrefix(vw.prefix)} attendu, ${fmtPrefix(here.cidr.prefix)} trouvé sur ${here.iface})`,
            fix: { label: `Mettre ${fmtPrefix(here.cidr.prefix)}`, patch: { vlanIp: { vlan, ip: `${ip.trim().split("/")[0]}/${here.cidr.prefix}` } } },
          });
        }
      } else if (elsewhere) {
        findings.push({ kind: "ip-ailleurs", message: `VLAN ${vlan} : ${ip} présente ailleurs : sur ${elsewhere.iface}, pas sur une interface du VLAN` });
      } else if (!carriers.length) {
        findings.push({ kind: "vlan-absent", message: `VLAN ${vlan} : aucune interface (${expected} attendue), ${ip} absente` });
      } else {
        findings.push({ kind: "vlan-absent", message: `VLAN ${vlan} : ${ip} absente de ${carriers.map((c) => c.name).join(", ")}` });
      }
    }
    ends.push({ cableId, end, key: `${cableId}:${end}`, status: findings[0]?.kind ?? "ok", findings });
  }

  const extra: ExtraAddr[] = [];
  for (const h of held) {
    if (isLoopback(h.cidr) || isLinkLocal(h.cidr) || mentioned.has(h.cidr.addr)) continue;
    extra.push({ iface: h.iface, addr: h.text });
  }
  return { ends, extra };
}

/** The end's data with a fix applied (what setCableEnd is given). */
export function applyFix(info: EndInfo, patch: FixPatch): EndInfo {
  const next: EndInfo = { ...info };
  if (patch.iface) next.iface = patch.iface;
  if (patch.ip) next.ip = patch.ip;
  if (patch.vlanIp) next.vlanIps = { ...info.vlanIps, [patch.vlanIp.vlan]: patch.vlanIp.ip };
  return next;
}

/** Messages of an end, for a badge tooltip. */
export const endMessages = (r: EndResult) => r.findings.map((f) => f.message);
