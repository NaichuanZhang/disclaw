// ---------------------------------------------------------------------------
// Browser — URL gate (pure)
//
// The agent's browser may only visit public http(s) sites. Refused: userinfo,
// loopback / private / link-local (incl. cloud metadata) / CGNAT+tailnet /
// unspecified / multicast IPv4, the IPv6 equivalents (incl. IPv4-mapped and
// embedded forms), and local-only names (localhost, *.local, *.internal,
// *.ts.net, single-label hosts). `new URL()` already canonicalises decimal,
// hex, octal and percent-encoded IPv4 forms to a dotted quad, so only that
// form is checked. DNS is never resolved, so a public name that resolves to a
// private address is not caught here.
//
// BROWSER_LOCAL_ORIGINS (comma-separated exact `host:port`) lets an operator
// allow specific local services — but never the gateway's own port on
// loopback, which would hand the agent the unauthenticated dashboard API.
// ---------------------------------------------------------------------------

export interface UrlGateOptions {
  /** Exact `host:port` keys (canonical, see `originKey`). */
  localOrigins: Set<string>;
  gatewayPort: number;
}

export type UrlGateVerdict = { ok: true } | { ok: false; reason: string };

type HostCategory =
  | "loopback"
  | "private"
  | "link-local"
  | "cgnat"
  | "unspecified"
  | "multicast"
  | "reserved"
  | "ipv4-mapped"
  | "local-name";

const CATEGORY_TEXT: Record<HostCategory, string> = {
  loopback: "is a loopback address",
  private: "is a private network address",
  "link-local": "is a link-local address (this includes cloud metadata endpoints)",
  cgnat: "is a CGNAT / tailnet address",
  unspecified: "is the unspecified address",
  multicast: "is a multicast or broadcast address",
  reserved: "is a reserved address",
  "ipv4-mapped": "is an IPv4-mapped IPv6 address",
  "local-name": "is a local-only host name",
};

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".ts.net"];

function classifyIPv4(parts: number[]): HostCategory | null {
  const [a, b, c] = parts;
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link-local";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a >= 224) return "multicast";
  return null;
}

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** Eight hextets, or null. Expects the compressed hex form `new URL()` emits. */
function parseIPv6(host: string): number[] | null {
  if (!/^[0-9a-f:]+$/i.test(host)) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const nums = words.map((w) => (/^[0-9a-f]{1,4}$/i.test(w) ? parseInt(w, 16) : NaN));
  return nums.length === 8 && nums.every((n) => Number.isFinite(n)) ? nums : null;
}

function v4From(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function classifyIPv6(h: number[]): HostCategory | null {
  if (h.every((n) => n === 0)) return "unspecified";
  if (h.slice(0, 7).every((n) => n === 0) && h[7] === 1) return "loopback";
  if (h.slice(0, 5).every((n) => n === 0) && h[5] === 0xffff) return "ipv4-mapped";
  if (h.slice(0, 6).every((n) => n === 0)) return "ipv4-mapped"; // deprecated IPv4-compatible
  if ((h[0] & 0xfe00) === 0xfc00) return "private";
  if ((h[0] & 0xffc0) === 0xfe80) return "link-local";
  if ((h[0] & 0xffc0) === 0xfec0) return "private";
  if ((h[0] & 0xff00) === 0xff00) return "multicast";
  // NAT64 and 6to4 carry an IPv4 address that the network will reach.
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((n) => n === 0)) return classifyIPv4(v4From(h[6], h[7]));
  if (h[0] === 0x2002) return classifyIPv4(v4From(h[1], h[2]));
  return null;
}

/** Why `hostname` (as `URL.hostname` gives it) is not public, or null when it is. */
export function classifyHost(hostname: string): HostCategory | null {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    const h = parseIPv6(host.slice(1, -1));
    return h ? classifyIPv6(h) : "reserved";
  }
  host = host.replace(/\.+$/, "");
  const v4 = parseIPv4(host);
  if (v4) return classifyIPv4(v4);
  if (!host || host === "localhost") return host ? "loopback" : "reserved";
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return host.endsWith(".localhost") ? "loopback" : "local-name";
  if (!host.includes(".")) return "local-name";
  return null;
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

/** Canonical `host:port` for an allowlist entry, or null when unparseable. */
export function originKey(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed || /[/@?#]/.test(trimmed)) return null;
  try {
    const u = new URL(`http://${trimmed}`);
    return `${u.hostname}:${u.port || "80"}`;
  } catch {
    return null;
  }
}

export function urlGateOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): UrlGateOptions {
  const localOrigins = new Set<string>();
  for (const entry of (env.BROWSER_LOCAL_ORIGINS ?? "").split(",")) {
    const key = originKey(entry);
    if (key) localOrigins.add(key);
  }
  const port = Number(env.GATEWAY_PORT);
  return { localOrigins, gatewayPort: Number.isInteger(port) && port > 0 ? port : 3000 };
}

/** Gate for a URL the agent asked to open (http(s) or about:blank). */
export function checkBrowserUrl(raw: string, opts: UrlGateOptions = urlGateOptionsFromEnv()): UrlGateVerdict {
  if (raw === "about:blank") return { ok: true };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "is not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `uses ${url.protocol}, and only http(s) is allowed` };
  }
  if (url.username || url.password) return { ok: false, reason: "contains a username or password (userinfo)" };
  const category = classifyHost(url.hostname);
  if (!category) return { ok: true };
  const port = url.port || defaultPort(url.protocol);
  const loopbackish = category === "loopback" || category === "unspecified" || isMappedLoopback(url.hostname);
  if (loopbackish && Number(port) === opts.gatewayPort) {
    return { ok: false, reason: `${CATEGORY_TEXT[category]} on the bot's own gateway port (${port}), which is never allowed` };
  }
  if (opts.localOrigins.has(`${url.hostname.replace(/\.+$/, "")}:${port}`)) return { ok: true };
  return { ok: false, reason: CATEGORY_TEXT[category] };
}

function isMappedLoopback(hostname: string): boolean {
  if (!hostname.startsWith("[")) return false;
  const h = parseIPv6(hostname.slice(1, -1));
  return !!h && h.slice(0, 5).every((n) => n === 0) && (h[5] === 0xffff || h[5] === 0) && h[6] >> 8 === 127;
}

/**
 * Gate for the URL a page actually committed to. Internal pages with no
 * network reach (about:, Chrome's error page, data:, blob:) are fine;
 * file:, chrome: and the like are not.
 */
export function checkCommittedUrl(raw: string, opts: UrlGateOptions = urlGateOptionsFromEnv()): UrlGateVerdict {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") return checkBrowserUrl(raw, opts);
  if (scheme === "about" || scheme === "chrome-error" || scheme === "data" || scheme === "blob") return { ok: true };
  return { ok: false, reason: `uses ${scheme ?? "an unknown"}:, and only http(s) is allowed` };
}

/** Throw a clear error when the agent may not open `url`. */
export function assertBrowserUrlAllowed(url: string, opts?: UrlGateOptions): void {
  const verdict = checkBrowserUrl(url, opts);
  if (verdict.ok) return;
  throw new Error(
    `Refused to open ${url}: it ${verdict.reason}. The browser only visits public http(s) sites; an operator can allow a specific local service with BROWSER_LOCAL_ORIGINS=host:port.`,
  );
}
