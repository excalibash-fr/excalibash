// Pure cable data (no Excalidraw runtime import): shared by cables.ts, the exports and their tests.
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

type El = ExcalidrawElement;

/** One end of a cable: an element, or a whole group (library items are groups). */
export type Anchor = { id?: string; group?: string; /** A group's members when it was attached: still there if it is ungrouped. */ ids?: string[] };
/** What sits at one end of a cable: the item's interface, its address and its VLANs (all optional). */
export type EndInfo = {
  iface?: string;
  ip?: string;
  vlans?: string;
  /** Address of the item in some of those VLANs (VLAN interface, SVI…), by VLAN number. */
  vlanIps?: Record<string, string>;
  /** Label moved by hand (scene units). */
  dx?: number;
  dy?: number;
};
/** `a` is the start of the cable (its first point), `b` its end. */
export type CableData = { a: Anchor; b: Anchor; orphaned?: boolean; ends?: { a?: EndInfo; b?: EndInfo } };
export type End = "a" | "b";

export const cd = (el: El | null | undefined) => (el?.customData ?? {}) as Record<string, any>;
// Cable data comes from the board (any editor, older clients): normalized in one place so a
// malformed value can't crash rendering, and a label offset stays within its radius.
/** How far a label can be moved from its spot (scene units): it stays by its cable end. */
export const LABEL_RADIUS = 90;
const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const anchorData = (v: any): Anchor | undefined => {
  if (s(v?.group)) {
    const ids = Array.isArray(v.ids) ? v.ids.filter((i: unknown) => s(i)).slice(0, 500) : [];
    return ids.length ? { group: v.group, ids } : { group: v.group };
  }
  return s(v?.id) ? { id: v.id } : undefined;
};
function endData(v: any): EndInfo | undefined {
  if (!v || typeof v !== "object") return undefined;
  const e: EndInfo = { iface: s(v.iface)?.slice(0, 64), ip: s(v.ip)?.slice(0, 64), vlans: s(v.vlans)?.slice(0, 200) };
  const vlanIps = vlanIpsData(v.vlanIps);
  if (vlanIps && e.vlans) e.vlanIps = vlanIps;
  if (!e.iface && !e.ip && !e.vlans) return undefined;
  const dx = typeof v.dx === "number" && Number.isFinite(v.dx) ? v.dx : 0;
  const dy = typeof v.dy === "number" && Number.isFinite(v.dy) ? v.dy : 0;
  const r = Math.hypot(dx, dy);
  const k = r > LABEL_RADIUS ? LABEL_RADIUS / r : 1;
  if (dx || dy) Object.assign(e, { dx: dx * k, dy: dy * k });
  return e;
}
/** A VLAN number as text: digits only, 1 to 4094. */
export const isVlanId = (v: string): boolean => /^\d{1,4}$/.test(v) && +v >= 1 && +v <= 4094;
function vlanIpsData(v: any): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  // A plain object: it ends up in the element's customData, which Excalidraw deep-copies with
  // hasOwnProperty. Keys are VLAN numbers only, so "__proto__" and the like never get in.
  const out: Record<string, string> = {};
  for (const [k, ip] of Object.entries(v).slice(0, 128)) if (isVlanId(k) && s(ip)) out[k] = (ip as string).slice(0, 64);
  return Object.keys(out).length ? out : undefined;
}
const normalizedCables = new WeakMap<object, CableData>();
export const cableOf = (el: El | null | undefined): CableData | undefined => {
  const raw = cd(el).cable;
  if (!raw || typeof raw !== "object") return undefined;
  const hit = normalizedCables.get(raw);
  if (hit) return hit;
  const a = anchorData(raw.a);
  const b = anchorData(raw.b);
  if (!a || !b) return undefined;
  const ea = endData(raw.ends?.a);
  const eb = endData(raw.ends?.b);
  const c: CableData = { a, b, ...(raw.orphaned === true ? { orphaned: true } : {}), ...(ea || eb ? { ends: { a: ea, b: eb } } : {}) };
  normalizedCables.set(raw, c);
  return c;
};
/** The anchor an element stands for: its outermost group, else itself (a text in a shape: the shape). */
export function anchorOf(el: El, byId: Map<string, El>): Anchor {
  const target = el.type === "text" && el.containerId ? (byId.get(el.containerId) ?? el) : el;
  const group = target.groupIds.at(-1);
  return group ? { group } : { id: target.id };
}

/** VLAN list as typed ("10, 20,30-35"): normalized, or null when a part is not a VLAN or range. */
export function parseVlans(v: string): string | null {
  const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const [lo, hi, extra] = part.split("-").map((s) => s.trim());
    if (extra !== undefined || !isVlanId(lo) || (hi !== undefined && (!isVlanId(hi) || +hi < +lo))) return null;
  }
  return parts.map((p) => p.replace(/\s+/g, "")).join(", ");
}

/** An IPv4 or IPv6 address, with an optional prefix length. */
export const IP_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?:\/(?:3[0-2]|[12]?\d))?|[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*(?:%[\w.]+)?(?:\/(?:12[0-8]|1[01]\d|[1-9]?\d))?)$/;

/**
 * The VLAN lines of a cable end's label: the VLANs without an address together ("VLAN 20, 30-35"),
 * then one line per VLAN with its address ("VLAN 10 10.0.10.1/24").
 */
export function vlanLines(i?: EndInfo): string[] {
  const { plain, withIp } = vlanParts(i);
  return [...(plain.length ? [`VLAN ${plain.join(", ")}`] : []), ...withIp.map(([v, ip]) => `VLAN ${v} ${ip}`)];
}

/** The VLANs of a cable end: those without an address, and those with one (as [vlan, ip]). */
export function vlanParts(i?: EndInfo): { plain: string[]; withIp: [string, string][] } {
  if (!i?.vlans) return { plain: [], withIp: [] };
  const parts = (parseVlans(i.vlans) ?? i.vlans).split(",").map((p) => p.trim()).filter(Boolean);
  // Own numeric keys only: a VLAN written "constructor" must not find Object.prototype.
  const ips = i.vlanIps ?? {};
  const ipOf = (p: string) => (isVlanId(p) && Object.hasOwn(ips, p) && typeof ips[p] === "string" ? ips[p] : undefined);
  return { plain: parts.filter((p) => !ipOf(p)), withIp: parts.filter((p) => ipOf(p)).map((p) => [p, ipOf(p)!]) };
}
