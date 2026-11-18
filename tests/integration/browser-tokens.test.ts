// ---------------------------------------------------------------------------
// Browser viewer tokens — mint / verify / expiry / binding
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { VIEWER_TOKEN_TTL_MS, createViewerTokenStore } from "../../src/browser/tokens.js";

function store(start = 1_000_000) {
  let t = start;
  const s = createViewerTokenStore({ now: () => t });
  return { s, advance: (ms: number) => (t += ms) };
}

describe("viewer tokens", () => {
  it("mints url-safe 32-byte tokens that verify for their browser", () => {
    const { s } = store();
    const { token, expiresAt } = s.mint("b1", "u1");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(1_000_000 + VIEWER_TOKEN_TTL_MS);
    expect(s.verify(token, "b1")).toEqual({ browserId: "b1", userId: "u1", expiresAt });
  });

  it("mints a different token every time", () => {
    const { s } = store();
    expect(s.mint("b1", "u1").token).not.toBe(s.mint("b1", "u1").token);
  });

  it("rejects a token for another browser", () => {
    const { s } = store();
    const { token } = s.mint("b1", "u1");
    expect(s.verify(token, "b2")).toBeNull();
  });

  it("rejects a token presented for another user", () => {
    const { s } = store();
    const { token } = s.mint("b1", "u1");
    expect(s.verify(token, "b1", "u2")).toBeNull();
    expect(s.verify(token, "b1", "u1")?.userId).toBe("u1");
  });

  it("expires after 15 minutes", () => {
    const { s, advance } = store();
    const { token } = s.mint("b1", "u1");
    advance(VIEWER_TOKEN_TTL_MS - 1);
    expect(s.verify(token, "b1")).not.toBeNull();
    advance(1);
    expect(s.verify(token, "b1")).toBeNull();
  });

  it("rejects unknown, empty and oversized tokens", () => {
    const { s } = store();
    s.mint("b1", "u1");
    expect(s.verify("", "b1")).toBeNull();
    expect(s.verify("x".repeat(43), "b1")).toBeNull();
    expect(s.verify("x".repeat(500), "b1")).toBeNull();
    expect(s.verify(undefined as unknown as string, "b1")).toBeNull();
  });

  it("purges expired grants and revokes per browser", () => {
    const { s, advance } = store();
    s.mint("b1", "u1");
    const keep = s.mint("b2", "u1").token;
    advance(VIEWER_TOKEN_TTL_MS);
    const fresh = s.mint("b2", "u2").token;
    expect(s.size()).toBe(1);
    expect(s.verify(keep, "b2")).toBeNull();
    s.revokeBrowser("b2");
    expect(s.verify(fresh, "b2")).toBeNull();
    expect(s.size()).toBe(0);
  });
});
