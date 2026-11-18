import express from "express";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { PROJECT_ROOT } from "../shared/paths.js";
import { createApiRouter } from "./api.js";
import { createArtifactRouter } from "./artifacts.js";
import { closeBrowserViewers, createBrowserViewRouter, handleBrowserUpgrade } from "./browser-view.js";
import type { CronService } from "../cron/service.js";
import type { SkillService } from "../skills/service.js";

// ---------------------------------------------------------------------------
// WebSocket client tracking
// ---------------------------------------------------------------------------

const wsClients = new Set<WebSocket>();

/**
 * Broadcast a JSON message to all connected WebSocket clients.
 * Used by the message handler to stream real-time logs to the dashboard.
 */
export function broadcastLog(data: { type: string; [key: string]: any }): void {
  const payload = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Gateway server
// ---------------------------------------------------------------------------

export function startGateway(opts: {
  port: number;
  token: string;
  cronService: CronService;
  skillService: SkillService;
  discordClient?: any;
}): { close: () => void } {
  const { port, token, cronService, skillService, discordClient } = opts;

  const app = express();

  // ---------- Auth middleware for /api/* (disabled for self-hosted) ----------
  // TODO: re-enable for cloud gateway
  // app.use("/api", (req, res, next) => { ... });

  // ---------- JSON body parser ----------
  app.use(express.json());

  // ---------- API routes ----------
  const apiRouter = createApiRouter({ cronService, skillService, discordClient });
  app.use("/api", apiRouter);

  // ---------- Artifact routes (portal + downloads) ----------
  // Mounted at root level so /artifacts/:sessionId and /api/artifacts/:sessionId both work
  const artifactRouter = createArtifactRouter();
  app.use(artifactRouter);

  // ---------- Live browser viewer (token-gated; before the SPA fallback) ----------
  app.use(createBrowserViewRouter());

  // ---------- Static files for dashboard SPA ----------
  const uiDistPath = join(PROJECT_ROOT, "dist", "ui");
  if (existsSync(uiDistPath)) {
    app.use(express.static(uiDistPath));

    // SPA fallback: serve index.html for any non-API, non-artifact, non-file route
    app.get("*", (_req, res) => {
      const indexPath = join(uiDistPath, "index.html");
      if (existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).json({ error: "UI not built" });
      }
    });
  }

  // ---------- HTTP server ----------
  const server = createServer(app);

  // ---------- WebSocket server: logs ----------
  const wssLogs = new WebSocketServer({ noServer: true });

  wssLogs.on("connection", (ws) => {
    wsClients.add(ws);
    console.log(`[gateway] WebSocket logs client connected, total: ${wsClients.size}`);

    ws.on("close", () => {
      wsClients.delete(ws);
      console.log(`[gateway] WebSocket logs client disconnected, total: ${wsClients.size}`);
    });

    ws.on("error", (err) => {
      console.error("[gateway] WebSocket logs error:", err.message);
      wsClients.delete(ws);
    });
  });

  // ---------- HTTP upgrade handling (route WS by path) ----------
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;

    if (pathname === "/ws/logs") {
      wssLogs.handleUpgrade(request, socket, head, (ws) => {
        wssLogs.emit("connection", ws, request);
      });
    } else if (handleBrowserUpgrade(request, socket, head)) {
      // handled (or rejected) by the browser viewer
    } else {
      socket.destroy();
    }
  });

  // ---------- Listen ----------
  server.listen(port, () => {
    console.log(`[gateway] Server listening on port ${port}`);
  });

  // ---------- Close function ----------
  return {
    close: () => {
      console.log("[gateway] Shutting down...");
      // Close all WebSocket connections
      for (const client of wsClients) {
        client.close(1001, "Server shutting down");
      }
      wsClients.clear();
      wssLogs.close();
      closeBrowserViewers();
      server.close();
      console.log("[gateway] Shut down complete");
    },
  };
}
