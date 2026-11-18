// ---------------------------------------------------------------------------
// Browser — URL gate (pure, no DNS)
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  assertBrowserUrlAllowed,
  checkBrowserUrl,
  checkCommittedUrl,
  originKey,
  urlGateOptionsFromEnv,
  type UrlGateOptions,
} from "../../src/browser/url-gate.js";

const none: UrlGateOptions = { localOrigins: new Set(), gatewayPort: 3000 };
const ok = (url: string, opts = none) => checkBrowserUrl(url, opts).ok;

describe("checkBrowserUrl", () => {
  it("allows public http(s) targets and about:blank", () => {
    for (const url of [
      "https://example.com/",
      "http://example.com:8080/path?q=1",
      "http://93.184.216.34/",
      "http://172.32.0.1/",
      "http://100.128.0.1/",
      "https://[2606:4700:4700::1111]/",
      "about:blank",
    ]) {
      expect(ok(url), url).toBe(true);
    }
  });

  it("refuses loopback, private, link-local, CGNAT and local names", () => {
    for (const url of [
      "http://localhost/",
      "http://LOCALHOST./",
      "http://foo.localhost/",
      "http://127.0.0.1/",
      "http://127.5.5.5:8080/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://100.127.255.254/",
      "http://0.0.0.0/",
      "http://0/",
      "http://224.0.0.1/",
      "http://[::1]/",
      "http://[::]/",
      "http://[fc00::1]/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:8.8.8.8]/",
      "http://[64:ff9b::a00:1]/",
      "http://nas.local/",
      "http://metadata.google.internal/",
      "http://box.tail1234.ts.net/",
      "http://intranet/",
    ]) {
      expect(ok(url), url).toBe(false);
    }
  });

  it("refuses encoded IPv4 forms (URL canonicalises them first)", () => {
    for (const url of [
      "http://0x7f.1/",
      "http://2130706433/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://%31%32%37.0.0.1/",
      "http://0xa9fea9fe/",
    ]) {
      expect(ok(url), url).toBe(false);
    }
  });

  it("refuses userinfo and non-http schemes", () => {
    expect(checkBrowserUrl("http://user:pass@example.com/", none)).toMatchObject({ ok: false, reason: expect.stringMatching(/userinfo/) });
    expect(ok("http://user@example.com/")).toBe(false);
    expect(ok("file:///etc/passwd")).toBe(false);
    expect(ok("not a url")).toBe(false);
  });

  it("honours the allowlist for exactly those host:port entries", () => {
    const opts: UrlGateOptions = { localOrigins: new Set(["localhost:8080", "192.168.1.5:80"]), gatewayPort: 3000 };
    expect(ok("http://localhost:8080/app", opts)).toBe(true);
    expect(ok("http://localhost:8081/", opts)).toBe(false);
    expect(ok("http://192.168.1.5/", opts)).toBe(true);
    expect(ok("https://192.168.1.5/", opts)).toBe(false);
    expect(ok("http://127.0.0.1:8080/", opts)).toBe(false);
  });

  it("never allows the gateway port on loopback, even when allowlisted", () => {
    const opts: UrlGateOptions = {
      localOrigins: new Set(["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]),
      gatewayPort: 3000,
    };
    expect(checkBrowserUrl("http://localhost:3000/api/config", opts)).toMatchObject({ ok: false, reason: expect.stringMatching(/gateway/) });
    expect(ok("http://127.0.0.1:3000/", opts)).toBe(false);
    expect(ok("http://[::1]:3000/", opts)).toBe(false);
    expect(ok("http://[::ffff:127.0.0.1]:3000/", opts)).toBe(false);
    expect(ok("http://0.0.0.0:3000/", opts)).toBe(false);
  });

  it("reads BROWSER_LOCAL_ORIGINS and GATEWAY_PORT from the environment", () => {
    const opts = urlGateOptionsFromEnv({
      BROWSER_LOCAL_ORIGINS: " localhost:8080, 192.168.1.5:80 ,bad/entry,user@x:1,,",
      GATEWAY_PORT: "4000",
    });
    expect([...opts.localOrigins].sort()).toEqual(["192.168.1.5:80", "localhost:8080"]);
    expect(opts.gatewayPort).toBe(4000);
    expect(urlGateOptionsFromEnv({}).gatewayPort).toBe(3000);
    expect(originKey("LocalHost:80")).toBe("localhost:80");
    const env = urlGateOptionsFromEnv({ BROWSER_LOCAL_ORIGINS: "localhost:4000", GATEWAY_PORT: "4000" });
    expect(ok("http://localhost:4000/", env)).toBe(false);
  });

  it("assertBrowserUrlAllowed throws a clear error", () => {
    expect(() => assertBrowserUrlAllowed("http://127.0.0.1/", none)).toThrow(/Refused to open .*loopback.*BROWSER_LOCAL_ORIGINS/);
    expect(() => assertBrowserUrlAllowed("https://example.com/", none)).not.toThrow();
  });
});

describe("checkCommittedUrl", () => {
  it("allows internal pages with no network reach and gates the rest", () => {
    expect(checkCommittedUrl("about:blank", none).ok).toBe(true);
    expect(checkCommittedUrl("chrome-error://chromewebdata/", none).ok).toBe(true);
    expect(checkCommittedUrl("https://example.com/", none).ok).toBe(true);
    expect(checkCommittedUrl("http://10.0.0.1/", none).ok).toBe(false);
    expect(checkCommittedUrl("file:///etc/passwd", none).ok).toBe(false);
    expect(checkCommittedUrl("chrome://settings", none).ok).toBe(false);
  });
});
