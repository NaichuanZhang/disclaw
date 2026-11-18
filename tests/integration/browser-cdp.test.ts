// ---------------------------------------------------------------------------
// Browser — CDP client against an in-test WebSocket server
// ---------------------------------------------------------------------------

import { afterEach, describe, it, expect } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { CdpClient } from "../../src/browser/cdp.js";

let server: WebSocketServer | null = null;

function fakeCdp(onCommand: (ws: WebSocket, msg: { id: number; method: string; params: any }) => void) {
  return new Promise<string>((resolve) => {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`ws://127.0.0.1:${port}/devtools/page/X`);
    });
    server.on("connection", (ws) => {
      ws.on("message", (data) => onCommand(ws, JSON.parse(data.toString())));
    });
  });
}

afterEach(async () => {
  if (server) {
    for (const c of server.clients) c.terminate();
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

describe("CdpClient", () => {
  it("correlates responses by id, even out of order", async () => {
    const url = await fakeCdp((ws, msg) => {
      const reply = () => ws.send(JSON.stringify({ id: msg.id, result: { echo: msg.method } }));
      if (msg.method === "Slow.first") setTimeout(reply, 30);
      else reply();
    });
    const cdp = await CdpClient.connect(url);
    const [a, b] = await Promise.all([cdp.send("Slow.first"), cdp.send("Fast.second")]);
    expect(a).toEqual({ echo: "Slow.first" });
    expect(b).toEqual({ echo: "Fast.second" });
    cdp.close();
  });

  it("rejects CDP errors with the method name", async () => {
    const url = await fakeCdp((ws, msg) =>
      ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: "nope" } })),
    );
    const cdp = await CdpClient.connect(url);
    await expect(cdp.send("Page.navigate", { url: "x" })).rejects.toThrow("Page.navigate: nope");
    cdp.close();
  });

  it("times out a command that never answers", async () => {
    const url = await fakeCdp(() => {});
    const cdp = await CdpClient.connect(url);
    await expect(cdp.send("Never.answer", {}, 50)).rejects.toThrow(/timed out/);
    cdp.close();
  });

  it("delivers events to subscribers and supports unsubscribe", async () => {
    let socket: WebSocket | null = null;
    const url = await fakeCdp((ws, msg) => {
      socket = ws;
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });
    const cdp = await CdpClient.connect(url);
    await cdp.send("Page.enable");
    const seen: unknown[] = [];
    const off = cdp.on("Page.loadEventFired", (p) => seen.push(p));
    socket!.send(JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 } }));
    await new Promise((r) => setTimeout(r, 30));
    off();
    socket!.send(JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 2 } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([{ timestamp: 1 }]);
    cdp.close();
  });

  it("rejects pending commands when the connection closes", async () => {
    const url = await fakeCdp((ws) => setTimeout(() => ws.close(), 10));
    const cdp = await CdpClient.connect(url);
    const reasons: string[] = [];
    cdp.onClose((r) => reasons.push(r));
    await expect(cdp.send("Will.dangle", {}, 5_000)).rejects.toThrow(/closed/);
    expect(cdp.closed).toBe(true);
    expect(reasons).toHaveLength(1);
    await expect(cdp.send("After.close")).rejects.toThrow(/closed/);
  });

  it("rejects pending commands on a local close()", async () => {
    const url = await fakeCdp(() => {});
    const cdp = await CdpClient.connect(url);
    const pending = cdp.send("Will.dangle", {}, 5_000);
    cdp.close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it("fails to connect to a dead port", async () => {
    await expect(CdpClient.connect("ws://127.0.0.1:1/devtools/page/X", { connectTimeoutMs: 2_000 })).rejects.toThrow(
      /connect/,
    );
  });
});
