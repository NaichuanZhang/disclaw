// ---------------------------------------------------------------------------
// Browser — state machine, session control and registry (no real Chromium)
// ---------------------------------------------------------------------------

import { afterEach, describe, it, expect } from "vitest";
import { agentBlockedReason, nextBrowserState } from "../../src/browser/state.js";
import { normalizeBrowserUrl, parseHumanInput } from "../../src/browser/page-scripts.js";
import {
  closeBrowserFor,
  getBrowser,
  getBrowserFor,
  openBrowser,
  setBrowserLauncher,
  stopAllBrowsers,
} from "../../src/browser/manager.js";
import type { CdpPage, LaunchedBrowser } from "../../src/browser/launch.js";
import { attachBrowserBoard } from "../../src/browser/board.js";

class FakePage implements CdpPage {
  closed = false;
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  private handlers = new Map<string, Set<(p: any) => void>>();
  private closeHandlers = new Set<(r: string) => void>();

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new Error("closed");
    this.calls.push({ method, params });
    if (method === "Page.navigate") {
      queueMicrotask(() => this.emit("Page.loadEventFired", {}));
      return { loaderId: "L1" } as T;
    }
    if (method === "Runtime.evaluate") {
      return { result: { value: JSON.stringify(["https://example.com/", "Example"]) } } as T;
    }
    if (method === "Page.captureScreenshot") return { data: Buffer.from("jpeg").toString("base64") } as T;
    return {} as T;
  }

  on(method: string, handler: (p: any) => void): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  onClose(handler: (r: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  emit(method: string, params: unknown): void {
    for (const h of [...(this.handlers.get(method) ?? [])]) h(params);
  }

  close(): void {
    this.closed = true;
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

let pages: FakePage[] = [];
let kills = 0;

function fakeLauncher() {
  return async (): Promise<LaunchedBrowser> => {
    const page = new FakePage();
    pages.push(page);
    return {
      page,
      kill: async () => {
        kills++;
        page.close();
      },
      killSync: () => {},
      onExit: () => {},
    };
  };
}

afterEach(async () => {
  await stopAllBrowsers();
  setBrowserLauncher();
  pages = [];
  kills = 0;
  delete process.env.BROWSER_MAX;
});

describe("nextBrowserState", () => {
  it("walks the documented transitions", () => {
    expect(nextBrowserState("running", "pause")).toBe("paused");
    expect(nextBrowserState("paused", "resume")).toBe("running");
    expect(nextBrowserState("running", "request_human")).toBe("needs-human");
    expect(nextBrowserState("needs-human", "takeover")).toBe("human-control");
    expect(nextBrowserState("human-control", "release", { awaitingHuman: true })).toBe("needs-human");
    expect(nextBrowserState("human-control", "release")).toBe("running");
    expect(nextBrowserState("human-control", "done")).toBe("running");
    expect(nextBrowserState("needs-human", "done")).toBe("running");
    expect(nextBrowserState("paused", "close")).toBe("closed");
  });

  it("refuses events that do not apply", () => {
    expect(nextBrowserState("running", "resume")).toBeNull();
    expect(nextBrowserState("paused", "request_human")).toBeNull();
    expect(nextBrowserState("human-control", "takeover")).toBeNull();
    expect(nextBrowserState("running", "done")).toBeNull();
    expect(nextBrowserState("running", "release")).toBeNull();
    expect(nextBrowserState("closed", "resume")).toBeNull();
    expect(nextBrowserState("closed", "close")).toBeNull();
  });

  it("lets the agent act only while running", () => {
    expect(agentBlockedReason("running")).toBeNull();
    expect(agentBlockedReason("human-control")).toMatch(/human has control/i);
    expect(agentBlockedReason("paused")).toMatch(/paused/i);
    expect(agentBlockedReason("needs-human")).toBeTruthy();
    expect(agentBlockedReason("closed")).toBeTruthy();
  });
});

describe("BrowserSession via the registry", () => {
  it("opens once per owner and reuses it", async () => {
    setBrowserLauncher(fakeLauncher());
    const a = await openBrowser("chan-1");
    const b = await openBrowser("chan-1");
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.session).toBe(a.session);
    expect(getBrowserFor("chan-1")).toBe(a.session);
    expect(pages[0].count("Emulation.setDeviceMetricsOverride")).toBe(1);
  });

  it("enforces BROWSER_MAX", async () => {
    process.env.BROWSER_MAX = "1";
    setBrowserLauncher(fakeLauncher());
    await openBrowser("chan-1");
    await expect(openBrowser("chan-2")).rejects.toThrow(/limit/i);
  });

  it("rejects agent actions while a human has control, and accepts them after", async () => {
    setBrowserLauncher(fakeLauncher());
    const { session } = await openBrowser("chan-1");
    await session.navigate("example.com");
    expect(session.url).toBe("https://example.com/");
    expect(session.takeControl("u1")).toBe(true);
    await expect(session.navigate("https://other.example/")).rejects.toThrow(/human has control/i);
    await expect(session.click({ x: 10, y: 10 })).rejects.toThrow(/human has control/i);
    await expect(session.type({ text: "hi" })).rejects.toThrow(/human has control/i);
    // Observation is still allowed while the human drives.
    await expect(session.screenshot()).resolves.toMatchObject({ path: null });
    expect(session.humanDone("u1")).toBe(true);
    expect(session.state).toBe("running");
    await expect(session.click({ x: 10, y: 10 })).resolves.toContain("(10, 10)");
  });

  it("forwards human input only in human-control", async () => {
    setBrowserLauncher(fakeLauncher());
    const { session } = await openBrowser("chan-1");
    const input = parseHumanInput({ t: "text", text: "hello" })!;
    expect(await session.dispatchHumanInput(input)).toBe(false);
    session.takeControl("u1");
    expect(await session.dispatchHumanInput(input)).toBe(true);
    expect(pages[0].calls.at(-1)).toEqual({ method: "Input.insertText", params: { text: "hello" } });
  });

  it("refuses agent actions while paused", async () => {
    setBrowserLauncher(fakeLauncher());
    const { session } = await openBrowser("chan-1");
    expect(session.setPaused(true)).toBe(true);
    await expect(session.navigate("https://example.com/")).rejects.toThrow(/paused/i);
    expect(session.setPaused(false)).toBe(true);
    await expect(session.navigate("https://example.com/")).resolves.toBe("https://example.com/");
  });

  it("requestHuman resolves on Done, and release while waiting goes back to needs-human", async () => {
    setBrowserLauncher(fakeLauncher());
    const { session } = await openBrowser("chan-1");
    const wait = session.requestHuman("log in", 60_000);
    expect(session.state).toBe("needs-human");
    expect(session.humanReason).toBe("log in");
    session.takeControl("u1");
    session.releaseControl();
    expect(session.state).toBe("needs-human");
    session.takeControl("u1");
    session.humanDone("u1");
    await expect(wait).resolves.toBe("done");
    expect(session.state).toBe("running");
  });

  it("requestHuman times out back to running", async () => {
    setBrowserLauncher(fakeLauncher());
    const { session } = await openBrowser("chan-1");
    await expect(session.requestHuman("x", 10)).resolves.toBe("timeout");
    expect(session.state).toBe("running");
  });

  it("close resolves a waiting request, kills the browser and forgets it", async () => {
    setBrowserLauncher(fakeLauncher());
    const { session } = await openBrowser("chan-1");
    const wait = session.requestHuman("x", 60_000);
    const states: string[] = [];
    session.on("state", (s) => states.push(s));
    expect(await closeBrowserFor("chan-1", "test")).toBe(true);
    await expect(wait).resolves.toBe("closed");
    expect(states).toContain("closed");
    expect(kills).toBe(1);
    expect(getBrowser(session.id)).toBeNull();
    expect(getBrowserFor("chan-1")).toBeNull();
    await expect(session.snapshot()).rejects.toThrow(/closed/i);
  });

  it("acks a screencast frame only after every viewer is done", async () => {
    setBrowserLauncher(fakeLauncher());
    const { session } = await openBrowser("chan-1");
    const page = pages[0];
    const dones: Array<() => void> = [];
    const offA = session.onFrame((_f, done) => dones.push(done));
    const offB = session.onFrame((_f, done) => dones.push(done));
    expect(page.count("Page.startScreencast")).toBe(1);
    page.emit("Page.screencastFrame", { data: "AAAA", metadata: {}, sessionId: 7 });
    expect(dones).toHaveLength(2);
    dones[0]();
    dones[0]();
    await Promise.resolve();
    expect(page.count("Page.screencastFrameAck")).toBe(0);
    dones[1]();
    await Promise.resolve();
    expect(page.calls.filter((c) => c.method === "Page.screencastFrameAck")).toEqual([
      { method: "Page.screencastFrameAck", params: { sessionId: 7 } },
    ]);
    offA();
    expect(page.count("Page.stopScreencast")).toBe(0);
    offB();
    expect(page.count("Page.stopScreencast")).toBe(1);
  });
});

describe("attachBrowserBoard", () => {
  it("posts once, updates on events, and finalizes read-only on close", async () => {
    setBrowserLauncher(fakeLauncher());
    const { session } = await openBrowser("chan-1");
    const sent: any[] = [];
    const updates: any[] = [];
    let finalized: any = null;
    attachBrowserBoard(session, (payload) => {
      sent.push(payload);
      return {
        update: (p) => updates.push(p),
        finalize: async (p) => {
          finalized = p;
        },
      };
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].components[0].components[0].custom_id).toBe(`br:${session.id}:live`);
    await session.navigate("https://example.com/");
    expect(updates.length).toBeGreaterThan(0);
    const last = updates.at(-1);
    expect(last.files[0].name).toBe("browser.jpg");
    expect(last.attachments).toEqual([]);
    await closeBrowserFor("chan-1");
    expect(finalized.components).toEqual([]);
    const before = updates.length;
    session.setPaused(true);
    expect(updates.length).toBe(before);
  });
});

describe("input parsing", () => {
  it("validates and clamps viewer input", () => {
    expect(parseHumanInput({ t: "mouse", type: "mousePressed", x: 99999, y: -5, button: "left" })).toMatchObject({
      x: 1280,
      y: 0,
      button: "left",
    });
    expect(parseHumanInput({ t: "mouse", type: "drag", x: 1, y: 1 })).toBeNull();
    expect(parseHumanInput({ t: "key", type: "keyDown", key: "" })).toBeNull();
    expect(parseHumanInput({ t: "key", type: "keyDown", key: "a", text: "a", keyCode: 65 })).toMatchObject({
      key: "a",
      text: "a",
      keyCode: 65,
    });
    expect(parseHumanInput({ t: "text", text: "x".repeat(5000) })).toEqual({ t: "text", text: "x".repeat(2000) });
    expect(parseHumanInput({ t: "eval", code: "x" })).toBeNull();
    expect(parseHumanInput(null)).toBeNull();
  });

  it("normalizes URLs and refuses non-http schemes", () => {
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com/");
    expect(normalizeBrowserUrl("about:blank")).toBe("about:blank");
    expect(() => normalizeBrowserUrl("file:///etc/passwd")).toThrow(/http/);
    expect(() => normalizeBrowserUrl("javascript:alert(1)")).toThrow(/http/);
    expect(() => normalizeBrowserUrl("")).toThrow();
  });
});
