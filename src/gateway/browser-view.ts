// ---------------------------------------------------------------------------
// Gateway — live browser viewer
//
// GET /browser/:id?t=<token>        the viewer page
// WS  /ws/browser/:id?t=<token>     JPEG frames out, control + input in
//
// The gateway has no auth, so the viewer token (browser/tokens.ts) is checked
// on both. Frames are acked to Chrome only after the socket write completes
// (see BrowserSession.onFrame), so a slow viewer slows the screencast instead
// of buffering it. Input reaches the page only in `human-control`. A viewer
// that took control releases it when it disconnects.
// ---------------------------------------------------------------------------

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Router } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { getBrowser } from "../browser/manager.js";
import type { BrowserSession } from "../browser/browser-session.js";
import { VIEWPORT } from "../browser/launch.js";
import { parseHumanInput } from "../browser/page-scripts.js";
import { verifyViewerToken } from "../browser/tokens.js";
import { renderViewerError, renderViewerPage } from "./browser-view-page.js";
import { count } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const WS_PATH_RE = /^\/ws\/browser\/([A-Za-z0-9_-]{1,40})$/;
const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;

const PAGE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function createBrowserViewRouter(): Router {
  const router = Router();
  router.get("/browser/:id", (req, res) => {
    res.set(PAGE_HEADERS);
    const id = String(req.params.id ?? "");
    const token = typeof req.query.t === "string" ? req.query.t : "";
    if (!ID_RE.test(id) || !verifyViewerToken(token, id)) {
      res.status(403).type("html").send(renderViewerError("This viewer link is invalid or has expired. Press Live view on the browser board in Discord for a new one."));
      return;
    }
    if (!getBrowser(id)) {
      res.status(404).type("html").send(renderViewerError("That browser is closed."));
      return;
    }
    res.type("html").send(renderViewerPage(id));
  });
  return router;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
const viewers = new Set<WebSocket>();

function reject(socket: Duplex, status: string): void {
  try {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // socket already gone
  }
  socket.destroy();
}

/** Handle `/ws/browser/:id` upgrades. Returns false when the path is not ours. */
export function handleBrowserUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://gateway.local");
  } catch {
    return false;
  }
  const match = WS_PATH_RE.exec(url.pathname);
  if (!match) return false;
  const browserId = match[1];
  const grant = verifyViewerToken(url.searchParams.get("t") ?? "", browserId);
  if (!grant) {
    reject(socket, "403 Forbidden");
    return true;
  }
  const session = getBrowser(browserId);
  if (!session) {
    reject(socket, "404 Not Found");
    return true;
  }
  try {
    wss.handleUpgrade(request, socket, head, (ws) => attachViewer(ws, session, grant.userId));
  } catch (err) {
    console.error("[gateway] browser viewer upgrade failed:", err);
    socket.destroy();
  }
  return true;
}

function attachViewer(ws: WebSocket, session: BrowserSession, userId: string): void {
  count(P.browserViewerConnect);
  viewers.add(ws);
  let tookControl = false;

  const sendJson = (payload: Record<string, unknown>) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // closing
    }
  };
  const sendState = () =>
    sendJson({
      t: "state",
      state: session.state,
      url: session.url,
      title: session.title,
      reason: session.humanReason,
      controller: session.controllerUserId === userId,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    });

  const offs: Array<() => void> = [
    session.on("state", sendState),
    session.on("meta", sendState),
    session.on("closed", () => {
      sendState();
      try {
        ws.close(1000, "browser closed");
      } catch {
        // already closing
      }
    }),
    session.onFrame((frame, done) => {
      if (ws.readyState !== WebSocket.OPEN) {
        done();
        return;
      }
      try {
        ws.send(Buffer.from(frame.data, "base64"), { binary: true }, () => done());
      } catch {
        done();
      }
    }),
  ];

  sendState();
  if (session.lastShot && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(session.lastShot, { binary: true });
    } catch {
      // closing
    }
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary || session.closed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    switch (msg.t) {
      case "take":
        if (session.takeControl(userId)) tookControl = true;
        return;
      case "release":
        if (session.state === "human-control" && session.releaseControl()) tookControl = false;
        return;
      case "done":
        if (session.humanDone(userId)) tookControl = false;
        return;
      default: {
        const input = parseHumanInput(msg);
        if (input) void session.dispatchHumanInput(input);
      }
    }
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    viewers.delete(ws);
    for (const off of offs.splice(0)) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    if (tookControl && session.state === "human-control" && session.controllerUserId === userId) {
      session.releaseControl();
    }
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

/** Close every viewer socket (gateway shutdown). */
export function closeBrowserViewers(): void {
  for (const ws of viewers) {
    try {
      ws.close(1001, "Server shutting down");
    } catch {
      // ignore
    }
  }
  viewers.clear();
  wss.close();
}
