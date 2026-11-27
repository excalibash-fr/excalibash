import { useEffect, useRef, useState } from "react";
import { ArrowUp, File as FileIcon, Folder, Upload, X } from "lucide-react";
import type { Entry, FileClient, Listing } from "./fileTransfer.ts";
import { fmtBytes } from "../format.ts";

const joinPath = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;
const parentOf = (dir: string) => dir.replace(/\/[^/]*\/*$/, "") || "/";

/**
 * Small file picker over the shell's working directory: browse, click a file to download it, or
 * send files into the folder shown. Everything goes through the sealed channel of the terminal.
 */
export function FilesPanel({
  client,
  busy,
  onDownload,
  onUpload,
  onClose,
  keep,
}: {
  client: FileClient;
  busy: boolean;
  onDownload: (path: string) => void;
  /** Without it, the panel only browses (no upload button). */
  onUpload?: (files: File[], dir: string) => void;
  onClose: () => void;
  /** Lists only the entries it accepts (folders should pass, to stay navigable). */
  keep?: (e: Entry) => boolean;
}) {
  const [path, setPath] = useState<string | undefined>(undefined);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    client
      .ls(path)
      .then((l) => live && setListing(l))
      .catch((e) => live && (setError(e.message), setListing(null)));
    return () => {
      live = false;
    };
  }, [client, path, reload]);

  // After an upload ends, the new file should show up.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) setReload((n) => n + 1);
    wasBusy.current = busy;
  }, [busy]);

  const open = (e: Entry) => {
    if (!listing) return;
    if (e.dir) setPath(joinPath(listing.cwd, e.name));
    else onDownload(joinPath(listing.cwd, e.name));
  };

  return (
    <div className="term-files" role="dialog" aria-label="Fichiers du shell">
      <div className="term-files-head">
        <button title="Dossier parent" disabled={!listing || listing.cwd === "/"} onClick={() => listing && setPath(parentOf(listing.cwd))}>
          <ArrowUp size={14} />
        </button>
        <span className="path" title={listing?.cwd}>
          {listing?.cwd ?? "…"}
        </span>
        {onUpload && (
          <button title="Envoyer des fichiers dans ce dossier" disabled={!listing || busy} onClick={() => input.current?.click()}>
            <Upload size={14} />
          </button>
        )}
        <button title="Fermer" onClick={onClose}>
          <X size={14} />
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length && listing) onUpload?.(files, listing.cwd);
          }}
        />
      </div>
      <div className="term-files-list">
        {error && <div className="term-files-empty">{error}</div>}
        {listing && !listing.entries.filter((e) => !keep || keep(e)).length && <div className="term-files-empty">Dossier vide</div>}
        {listing?.entries.filter((e) => !keep || keep(e)).map((e) => (
          <button key={e.name} className="term-files-row" title={e.dir ? "Ouvrir le dossier" : onUpload ? "Télécharger" : "Ouvrir ce fichier"} disabled={busy && !e.dir} onClick={() => open(e)}>
            {e.dir ? <Folder size={14} /> : <FileIcon size={14} />}
            <span className="n">{e.name}</span>
            <span className="s">{e.dir ? "" : fmtBytes(e.size)}</span>
          </button>
        ))}
        {listing?.truncated && <div className="term-files-empty">Liste tronquée (500 entrées au maximum)</div>}
      </div>
    </div>
  );
}
