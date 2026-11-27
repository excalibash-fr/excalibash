// One stable, parseable line per security event on stdout (for log shippers and alert rules):
//   excalibash-security event=<name> key=value key=value …
// Values never hold secrets, cookies or full tunnel ids: callers pass only what is safe to keep.

/** A value on one line without spaces or control characters, so a line always splits on spaces. */
function clean(v: string | number, max: number): string {
  const s = String(v).replace(/[^\x21-\x7e]/g, "_").slice(0, max);
  return s || "-";
}

export function securityEvent(event: string, fields: Record<string, string | number> = {}): void {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${clean(v, 200)}`);
  console.log(["excalibash-security", `event=${event}`, ...parts].join(" "));
}

/** A request path for a log line: no query, no tunnel id, at most 64 characters. */
export function logPath(path: string): string {
  const noId = path.split("?")[0]!.replace(/(\/(?:req|ws|t)\/)[A-Za-z0-9_-]{16,43}/g, "$1-");
  return clean(noId, 64);
}
