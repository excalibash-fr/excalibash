import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** A QR code drawn here, in the browser, as an SVG: the text never goes to a third-party service. Always dark on white, so scanners read it in any theme. */
export function QrCode({ text, size = 200, label }: { text: string; size?: number; label: string }) {
  const { n, path } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let path = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { n, path };
  }, [text]);
  const box = n + 8; // 4 modules of quiet zone around
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${box} ${box}`} shapeRendering="crispEdges" style={{ borderRadius: 8, background: "#fff" }}>
      <rect width={box} height={box} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
