// ---------------------------------------------------------------------------
// Browser — minimal Chrome DevTools Protocol client
//
// One WebSocket per page target, JSON-RPC style: every command carries an id,
// the matching response settles its promise, everything without an id is an
// event. No sessions/flattening — we always attach straight to the page's own
// debugger URL. Closing (by us or the browser) rejects every pending command,
// so a dead browser can never leave a tool call hanging.
// ---------------------------------------------------------------------------

import WebSocket from "ws";

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 5_000): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Targets on a debugging port (`/json/list`). */
export function listTargets(port: number): Promise<CdpTarget[]> {
  return fetchJson<CdpTarget[]>(`http://127.0.0.1:${port}/json/list`);
}

/** Open a new page target (`/json/new`; Chrome requires PUT). */
export function newPageTarget(port: number, url = "about:blank"): Promise<CdpTarget> {
  return fetchJson<CdpTarget>(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  );
}

/** First page target on the port, creating one if the browser has none. */
export async function findOrCreatePage(port: number): Promise<CdpTarget> {
  const targets = await listTargets(port);
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  return page ?? newPageTarget(port);
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type CdpEventHandler = (params: any) => void;

export class CdpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<CdpEventHandler>>();
  private closeHandlers = new Set<(reason: string) => void>();
  private _closed = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly commandTimeoutMs: number,
  ) {
    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", () => this.teardown("CDP connection closed"));
    ws.on("error", (err) => this.teardown(`CDP connection error: ${err.message}`));
  }

  static connect(
    wsUrl: string,
    opts: { connectTimeoutMs?: number; commandTimeoutMs?: number } = {},
  ): Promise<CdpClient> {
    const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      // perMessageDeflate off: Chrome does not negotiate it and frames are JPEG.
      const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`CDP connect timed out after ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws, opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS));
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${err.message}`));
      });
    });
  }

  get closed(): boolean {
    return this._closed;
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (this._closed) return Promise.reject(new Error(`CDP closed (${method})`));
    const id = this.nextId++;
    const limit = timeoutMs ?? this.commandTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${limit}ms`));
      }, limit);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }), (err) => {
          if (err) this.settle(id, new Error(`CDP send failed (${method}): ${err.message}`));
        });
      } catch (err) {
        this.settle(id, new Error(`CDP send failed (${method}): ${(err as Error).message}`));
      }
    });
  }

  /** Subscribe to an event; returns the unsubscribe function. */
  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  onClose(handler: (reason: string) => void): () => void {
    if (this._closed) {
      handler("already closed");
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  close(): void {
    if (this._closed) return;
    this.teardown("CDP connection closed");
    try {
      this.ws.close();
    } catch {
      // socket already gone
    }
  }

  private settle(id: number, err: Error | null, value?: unknown): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(value);
  }

  private onMessage(data: WebSocket.RawData): void {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.error) this.settle(msg.id, new Error(`${p.method}: ${msg.error.message ?? "CDP error"}`));
      else this.settle(msg.id, null, msg.result ?? {});
      return;
    }
    if (typeof msg.method === "string") {
      const set = this.handlers.get(msg.method);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(msg.params ?? {});
        } catch (err) {
          console.error(`[browser] CDP handler for ${msg.method} threw:`, err);
        }
      }
    }
  }

  private teardown(reason: string): void {
    if (this._closed) return;
    this._closed = true;
    for (const [id] of this.pending) this.settle(id, new Error(reason));
    this.handlers.clear();
    const handlers = [...this.closeHandlers];
    this.closeHandlers.clear();
    for (const handler of handlers) {
      try {
        handler(reason);
      } catch {
        // a close handler must not stop the others
      }
    }
  }
}
