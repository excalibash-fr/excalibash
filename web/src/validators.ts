// Input rules the Go agent enforces, repeated here for early feedback in the forms (the agent
// checks again). Keep each one in sync with the regex it mirrors.

/** Capture interface name. Mirrors `ifaceRe` in agent/capture.go. */
export const IFACE_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,31}$/;

/** One word of a capture (BPF) filter. Mirrors `filterRe` in agent/capture.go. */
export const FILTER_TOKEN_RE = /^[A-Za-z0-9._:/!()&|<>=-]{1,64}$/;

/** Remote host (name, IPv4 or bracketless IPv6). Mirrors `targetHost` in agent/remote.go. */
export const HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/;

/** Remote user name, may be empty. Mirrors `targetUser` in agent/remote.go. */
export const USER_RE = /^[A-Za-z0-9._@-]{0,64}$/;

/** Host header sent to a web tunnel's target, with an optional port. Mirrors `validHostHeader` in agent/web.go. */
export const HOST_HEADER_RE = /^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/;

/** `[2001:db8::1]` → `2001:db8::1`: removes the brackets around an IPv6 address. */
export const stripBrackets = (s: string) => s.replace(/^\[|\]$/g, "");
