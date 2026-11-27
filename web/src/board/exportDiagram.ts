// Export of the network diagram as an image (PNG or SVG), for a lab report. Excalidraw's own
// export can't show what Excalibash draws on top of the canvas, so the scene is rebuilt for it:
// machine icons become their library icon (or a rounded box) with their name, shell and site
// windows are left out, and the interface / IP / VLAN labels of the cables become real text.
import { convertToExcalidrawElements, exportToBlob, exportToSvg, restoreElements } from "@excalidraw/excalidraw";
import { extractTopology, toContainerlab, toJSON, toMermaid } from "./topology.ts";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { cableEnds, cableOf } from "./cables.ts";
import { labelRect } from "./CableOverlay.tsx";
import { isWindow, nodeDataOf } from "./nodes.ts";
import { saveBlob } from "../download.ts";

type El = ExcalidrawElement;
const INK = "#1e293b";
const MUTED = "#cbd5e1";
const PAPER = "#ffffff";
/** Monospace, like the labels on screen. */
const MONO = 3;
const PAD = 24;

const cd = (el: El) => (el.customData ?? {}) as Record<string, any>;
const newId = () => crypto.getRandomValues(new Uint32Array(3)).reduce((s, n) => s + n.toString(36), "x");

/** A library icon scaled into a box: elements cloned, moved and resized, under one group. */
function iconInto(icon: readonly any[], box: { x: number; y: number; w: number; h: number }): any[] {
  const els = icon.filter((e) => e && !e.isDeleted);
  if (!els.length) return [];
  const bounds = els.map((e) => {
    if (Array.isArray(e.points) && e.points.length) {
      const xs = e.points.map((p: number[]) => p[0]);
      const ys = e.points.map((p: number[]) => p[1]);
      return [e.x + Math.min(...xs), e.y + Math.min(...ys), e.x + Math.max(...xs), e.y + Math.max(...ys)];
    }
    return [e.x, e.y, e.x + e.width, e.y + e.height];
  });
  const x1 = Math.min(...bounds.map((b) => b[0]));
  const y1 = Math.min(...bounds.map((b) => b[1]));
  const w = Math.max(...bounds.map((b) => b[2])) - x1 || 1;
  const h = Math.max(...bounds.map((b) => b[3])) - y1 || 1;
  const k = Math.min(box.w / w, box.h / h);
  const ox = box.x + (box.w - w * k) / 2;
  const oy = box.y + (box.h - h * k) / 2;
  const group = newId();
  return els.map((e) => ({
    ...e,
    id: newId(),
    x: ox + (e.x - x1) * k,
    y: oy + (e.y - y1) * k,
    width: e.width * k,
    height: e.height * k,
    ...(Array.isArray(e.points) ? { points: e.points.map((p: number[]) => [p[0] * k, p[1] * k]) } : {}),
    ...(e.type === "text" ? { fontSize: Math.max(4, e.fontSize * k) } : {}),
    groupIds: [group],
    boundElements: null,
    containerId: null,
    frameId: null,
    locked: false,
    index: null,
  }));
}

/** The machine icon of a node, drawn with plain shapes. */
function nodeShapes(el: El, name: string): any[] {
  const nd = nodeDataOf(el)!;
  if (nd.icon?.elements.length) {
    const textH = 22;
    return [
      ...iconInto(nd.icon.elements, { x: el.x + 6, y: el.y + 4, w: el.width - 12, h: el.height - textH - 8 }),
      ...convertToExcalidrawElements([
        { type: "text", x: el.x + el.width / 2, y: el.y + el.height - textH, text: name, fontSize: 14, textAlign: "center", strokeColor: INK } as any,
      ]).map((t: any) => ({ ...t, x: el.x + el.width / 2 - t.width / 2 })),
    ];
  }
  return convertToExcalidrawElements([
    {
      type: "rectangle",
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      strokeColor: INK,
      backgroundColor: PAPER,
      fillStyle: "solid",
      strokeWidth: 2,
      roughness: 0,
      roundness: { type: 3 },
      label: { text: name, fontSize: 14, strokeColor: INK },
    } as any,
  ]);
}

/** The label of a cable end as a light box with its lines of monospace text. */
function labelShapes(rect: { x: number; y: number; w: number; h: number; lines: string[] }): any[] {
  const text = convertToExcalidrawElements([
    { type: "text", x: rect.x + 6, y: rect.y + 3, text: rect.lines.join("\n"), fontSize: 11, fontFamily: MONO, strokeColor: INK } as any,
  ])[0] as any;
  const box = convertToExcalidrawElements([
    {
      type: "rectangle",
      x: rect.x,
      y: rect.y,
      width: Math.max(rect.w, text.width + 12),
      height: Math.max(rect.h, text.height + 6),
      strokeColor: MUTED,
      backgroundColor: PAPER,
      fillStyle: "solid",
      strokeWidth: 1,
      roughness: 0,
      roundness: { type: 3 },
    } as any,
  ])[0];
  return [box, text];
}

/** The scene as it should appear on paper. `nameOf` gives a machine icon's name. */
export const diagramElements = (x: ExcalidrawImperativeAPI, nameOf: (nodeId: string) => string): El[] => diagramShapes(x.getSceneElements(), nameOf);

/** Same, from a list of (non-deleted) elements: also used by the read-only public view. */
export function diagramShapes(elements: readonly El[], nameOf: (nodeId: string) => string): El[] {
  const out: any[] = [];
  const labels: any[] = [];
  for (const el of elements) {
    if (isWindow(el)) continue;
    if (nodeDataOf(el)) {
      out.push(...nodeShapes(el, nameOf(el.id)));
      continue;
    }
    out.push(el);
    const c = cableOf(el);
    if (!c) continue;
    for (const end of cableEnds(el)) {
      const info = c.ends?.[end.end];
      if (info && (info.iface || info.ip || info.vlans)) labels.push(...labelShapes(labelRect(end.p, end.dir, info)));
    }
  }
  // Labels last: above the cables and the shapes, as on screen.
  return restoreElements([...out, ...labels], null, { refreshDimensions: false, repairBindings: true }) as El[];
}

const fileName = (name: string, ext: string) => `${name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "schema"}.${ext}`;

/** Downloads the diagram as a PNG (2×) or an SVG, on a white background. */
export async function exportDiagram(x: ExcalidrawImperativeAPI, kind: "png" | "svg", boardName: string, nameOf: (nodeId: string) => string) {
  const elements = diagramElements(x, nameOf);
  if (!elements.length) throw new Error("Le tableau est vide");
  const appState = { ...x.getAppState(), exportBackground: true, viewBackgroundColor: PAPER, exportWithDarkMode: false, exportScale: 2 };
  const files = x.getFiles();
  if (kind === "svg") {
    const svg = await exportToSvg({ elements, appState, files, exportPadding: PAD });
    saveBlob(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }), fileName(boardName, "svg"));
  } else {
    const blob = await exportToBlob({ elements, appState, files, exportPadding: PAD, mimeType: "image/png" });
    saveBlob(blob, fileName(boardName, "png"));
  }
}

export type TopologyFormat = "containerlab" | "mermaid" | "json";
const TOPOLOGY_FILES: Record<TopologyFormat, { ext: string; type: string }> = {
  containerlab: { ext: "clab.yml", type: "application/yaml" },
  mermaid: { ext: "mmd", type: "text/plain" },
  json: { ext: "json", type: "application/json" },
};

/** Downloads the cables of the diagram as a topology file; returns the warnings to show. */
export function exportTopology(x: ExcalidrawImperativeAPI, format: TopologyFormat, boardName: string, nameOf: (nodeId: string) => string): string[] {
  const topo = extractTopology(x.getSceneElements(), nameOf);
  if (!topo.nodes.length) throw new Error("Le tableau est vide");
  const text = format === "containerlab" ? toContainerlab(topo, boardName) : format === "mermaid" ? toMermaid(topo) : toJSON(topo);
  const f = TOPOLOGY_FILES[format];
  saveBlob(new Blob([text], { type: `${f.type};charset=utf-8` }), fileName(boardName, f.ext));
  return topo.warnings;
}
