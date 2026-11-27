import { api } from "../api.ts";
import type { SymKey } from "../crypto.ts";
import { createItem, fetchBoardContent } from "../library.tsx";
import { encryptPreview } from "./boardCrypto.ts";
import { isWindow } from "./nodes.ts";
import { saveBlob } from "../download.ts";

/** Renders a scene to an SVG string for dashboard thumbnails (Excalidraw is loaded on demand). */
export async function renderPreview(elements: readonly any[], files: Record<string, any>, background = "#ffffff"): Promise<string | null> {
  // Terminal and code windows would export as a bare URL placeholder: draw them as dark panes, and
  // machine nodes as their library icon (or a small box).
  const visible = elements
    .filter((e) => !e.isDeleted)
    .flatMap((e): any[] => {
      if (e.customData?.node) return nodePreview(e);
      if (e.customData?.notebookId)
        return [{ ...e, type: "rectangle", link: null, backgroundColor: "#fafafa", fillStyle: "solid", strokeColor: "#f97316", strokeWidth: 2, roughness: 0, roundness: { type: 3 } }];
      if (e.customData?.codeId)
        return [{ ...e, type: "rectangle", link: null, backgroundColor: "#1e1e1e", fillStyle: "solid", strokeColor: "#3b82f6", strokeWidth: 2, roughness: 0, roundness: { type: 3 } }];
      if (e.customData?.webId)
        return [{ ...e, type: "rectangle", link: null, backgroundColor: "#ffffff", fillStyle: "solid", strokeColor: "#1e293b", strokeWidth: 2, roughness: 0, roundness: { type: 3 } }];
      if (e.customData?.terminalId)
        return [{ ...e, type: "rectangle", link: null, backgroundColor: "#0b1020", fillStyle: "solid", strokeColor: "#1e293b", strokeWidth: 2, roughness: 0, roundness: { type: 3 } }];
      return [e];
    });
  if (!visible.length) return null;
  const { exportToSvg } = await import("@excalidraw/excalidraw");
  const svg = await exportToSvg({
    elements: visible,
    appState: { exportBackground: false, viewBackgroundColor: background, exportWithDarkMode: false },
    files,
    exportPadding: 16,
  });
  return svg.outerHTML;
}

export async function savePreview(boardId: string, key: SymKey, epoch: number, elements: readonly any[], files: Record<string, any>) {
  const svg = await renderPreview(elements, files);
  if (svg) await api.put(`/items/${boardId}/preview`, { epoch, preview: await encryptPreview(key, boardId, svg) });
}

/** Node tiles stay as drawings (title, icon) but lose their shells, sites, machine and remote links. */
function stripNodeRefs<T extends { customData?: Record<string, any> }>(e: T): T {
  if (!e.customData?.node) return e;
  const { shells: _s, webs: _w, codes: _c, notebooks: _nb, machineId: _m, machineName: _n, remote: _r, ...rest } = e.customData;
  return { ...e, customData: rest };
}

export async function exportBoard(name: string, key: SymKey, id: string) {
  const content = await fetchBoardContent(key, id);
  const data = {
    type: "excalidraw",
    version: 2,
    source: location.origin,
    elements: content.elements.filter((e) => !isWindow(e)).map(stripNodeRefs),
    appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
    files: content.files,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  saveBlob(blob, `${name.replace(/[\\/:*?"<>|]+/g, "_") || "tableau"}.excalidraw`);
}

/** Imports .excalidraw / .json files as new encrypted boards. Returns how many were created. */
export async function importFiles(ctx: Parameters<typeof createItem>[0], files: FileList | File[], parentId: string | null): Promise<number> {
  let created = 0;
  for (const file of Array.from(files)) {
    let data: any;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new Error(`${file.name} : fichier illisible`);
    }
    if (!Array.isArray(data?.elements)) throw new Error(`${file.name} : ce n'est pas un fichier Excalidraw`);
    const name = file.name.replace(/\.(excalidraw|json)$/i, "") || "Importé";
    const { restoreElements } = await import("@excalidraw/excalidraw");
    const elements = restoreElements(data.elements, null);
    const preview = await renderPreview(elements, data.files ?? {}).catch(() => null);
    await createItem(ctx, "board", parentId, name, { elements: [...elements], files: data.files ?? {}, preview });
    created++;
  }
  return created;
}

/** A node's icon elements moved onto the node's box, for thumbnails. */
function nodePreview(node: any): any[] {
  const icon: any[] | undefined = node.customData?.icon?.elements;
  if (!icon?.length) return [{ ...node, type: "rectangle", link: null, customData: undefined, strokeColor: "#1e293b", backgroundColor: "#e2e8f0", fillStyle: "solid", roughness: 0, roundness: { type: 3 } }];
  const minX = Math.min(...icon.map((e) => e.x));
  const minY = Math.min(...icon.map((e) => e.y));
  const maxX = Math.max(...icon.map((e) => e.x + (e.width ?? 0)));
  const maxY = Math.max(...icon.map((e) => e.y + (e.height ?? 0)));
  const dx = node.x + (node.width - (maxX - minX)) / 2 - minX;
  const dy = node.y + (node.height - (maxY - minY)) / 2 - minY;
  return icon.map((e) => ({ ...e, id: `${node.id}:${e.id}`, x: e.x + dx, y: e.y + dy, groupIds: [], frameId: null, boundElements: null, containerId: null }));
}
