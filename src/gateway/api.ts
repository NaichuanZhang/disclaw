import { Router, type Request, type Response } from "express";
import { existsSync, statSync, readdirSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DATA_DIR } from "../shared/paths.js";

import { getDb, getSessionMessages, setChannelConfig, setConfig } from "../db/index.js";
import { listSessions, clearSession } from "../agent/sessions.js";
import { getSoul, setSoul } from "../soul/soul.js";
import type { CronService } from "../cron/service.js";
import type { CronJobCreate, CronJobPatch } from "../cron/types.js";
import type { SkillService } from "../skills/service.js";
import { getMemoryLines } from "../memory/memory.js";
import { triggerRestart } from "../restart.js";
import { registerHealthRoute } from "../evolution/health.js";
import {
  listEvolutions,
  getEvolution,
  getIdeas,
  updateEvolution,
} from "../evolution/log.js";
import { getSandboxCIStatus } from "../evolution/sandbox.js";
import { countRoute, declareRoutePaths, flushMetrics } from "../metrics/counters.js";
import {
  getMetrics,
  getDeadPaths,
  getLowUsePaths,
  getStalePaths,
  getMetricsSummary,
  getObservationWindow,
} from "../metrics/report.js";
import type { PathKind } from "../metrics/registry.js";
import {
  getAppLogs,
  getErrorLogs,
  getErrorCountsByCategory,
  getToolCallLogs,
  getToolCallStats,
  getSlowestToolCalls,
} from "../logging/queries.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args: unknown[]): void {
  console.log("[gateway]", ...args);
}

/**
 * Validate that the resolved path is within DATA_DIR (no path traversal).
 */
function safePath(relativePath: string): string | null {
  const resolved = resolve(DATA_DIR, relativePath);
  if (!resolved.startsWith(DATA_DIR + "/") && resolved !== DATA_DIR) {
    return null;
  }
  return resolved;
}

/** Extract a route param as a plain string (Express 5 types return string | string[]). */
function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

/** Parse time window from query string — accepts hours as a number, defaults to 24. */
function parseTimeWindow(req: Request): number {
  const hours = parseFloat(req.query.hours as string);
  return (isNaN(hours) || hours <= 0 ? 24 : hours) * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createApiRouter(opts: {
  cronService: CronService;
  skillService: SkillService;
  discordClient?: any;
}): Router {
  const { cronService, skillService, discordClient } = opts;
  const router = Router();

  // Usage metrics — count route hits so unused endpoints surface as dead code.
  // req.route is only populated after matching, so read it on finish; that also
  // means unmatched (404) requests are correctly not counted.
  router.use((req: Request, res: Response, next) => {
    res.on("finish", () => {
      const routePattern = (req as Request & { route?: { path?: string } }).route?.path;
      if (routePattern) countRoute(req.method, routePattern);
    });
    next();
  });

  // Health endpoint (used by start.sh, no auth)
  registerHealthRoute(router);

  // =========================================================================
  // Status
  // =========================================================================

  router.get("/status", (_req: Request, res: Response) => {
    try {
      const online = !!discordClient?.isReady();
      const guilds =
        discordClient?.guilds?.cache?.map(
          (g: any) => ({
            id: g.id,
            name: g.name,
            memberCount: g.memberCount,
            channelCount: g.channels?.cache?.size ?? 0,
          }),
        ) ?? [];

      const uptime = discordClient?.uptime ?? 0;
      const mem = process.memoryUsage();

      res.json({
        online,
        guilds,
        uptime,
        memoryUsage: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
        },
      });
    } catch (err) {
      log("Error in GET /status:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // =========================================================================
  // Sessions
  // =========================================================================

  router.get("/sessions", (req: Request, res: Response) => {
    try {
      const guildId = req.query.guildId as string | undefined;
      const limit = parseInt(req.query.limit as string, 10) || 50;
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const result = listSessions({ guildId, limit, offset });
      res.json(result);
    } catch (err) {
      log("Error in GET /sessions:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/sessions/:id", (req: Request, res: Response) => {
    try {
      const id = param(req, "id");
      const db = getDb();
      const row = db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;

      if (!row) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const session = {
        id: row.id as string,
        discordKey: row.discord_key as string,
        agentSessionId: (row.agent_session_id as string) ?? undefined,
        guildId: (row.guild_id as string) ?? undefined,
        channelId: (row.channel_id as string) ?? undefined,
        userId: (row.user_id as string) ?? undefined,
        createdAt: row.created_at as number,
        lastActive: row.last_active as number,
      };

      const messages = getSessionMessages(id);

      res.json({ session, messages });
    } catch (err) {
      log("Error in GET /sessions/:id:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/sessions/:id", (req: Request, res: Response) => {
    try {
      const id = param(req, "id");
      clearSession(id);
      res.json({ ok: true });
    } catch (err) {
      log("Error in DELETE /sessions/:id:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // =========================================================================
  // Channels
  // =========================================================================

  router.get("/channels", (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const rows = db
        .prepare("SELECT * FROM channel_configs ORDER BY updated_at DESC")
        .all() as Record<string, unknown>[];

      const channels = rows.map((row) => {
        const channelId = row.channel_id as string;
        const guildId = (row.guild_id as string) ?? undefined;

        // Resolve channel and guild names from Discord client cache
        let name: string | undefined;
        let guildName: string | undefined;

        if (discordClient?.isReady()) {
          try {
            const discordChannel = discordClient.channels?.cache?.get(channelId);
            if (discordChannel) {
              name = (discordChannel as any).name ?? undefined;
              const guild = (discordChannel as any).guild;
              if (guild) {
                guildName = guild.name;
              }
            }
            // If we didn't get guild name from channel, try direct lookup
            if (!guildName && guildId) {
              const guild = discordClient.guilds?.cache?.get(guildId);
              if (guild) {
                guildName = guild.name;
              }
            }
          } catch {
            // Silently ignore lookup failures — names are best-effort
          }
        }

        return {
          id: channelId,
          guildId,
          name,
          guildName,
          enabled: (row.enabled as number) === 1,
          systemPrompt: (row.system_prompt as string) ?? undefined,
          settings: JSON.parse((row.settings as string) || "{}"),
          updatedAt: row.updated_at as number,
        };
      });

      res.json({ channels });
    } catch (err) {
      log("Error in GET /channels:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.put("/channels/:id", (req: Request, res: Response) => {
    try {
      const id = param(req, "id");
      const body = req.body as {
        enabled?: boolean;
        systemPrompt?: string;
        settings?: Record<string, unknown>;
      };

      setChannelConfig(id, body);
      res.json({ ok: true });
    } catch (err) {
      log("Error in PUT /channels/:id:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // =========================================================================
  // Config
  // =========================================================================

  router.get("/config", (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const rows = db
        .prepare("SELECT key, value FROM config")
        .all() as Array<{ key: string; value: string }>;

      const config: Record<string, string> = {};
      for (const row of rows) {
        config[row.key] = row.value;
      }

      res.json(config);
    } catch (err) {
      log("Error in GET /config:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.put("/config", (req: Request, res: Response) => {
    try {
      const body = req.body as Record<string, string>;

      for (const [key, value] of Object.entries(body)) {
        setConfig(key, value);
      }

      res.json({ ok: true });
    } catch (err) {
      log("Error in PUT /config:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // =========================================================================
  // Soul
  // =========================================================================

  router.get("/soul", (_req: Request, res: Response) => {
    try {
      res.json({ content: getSoul() });
    } catch (err) {
      log("Error in GET /soul:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.put("/soul", async (req: Request, res: Response) => {
    try {
      const { content } = req.body as { content: string };
      if (typeof content !== "string") {
        res.status(400).json({ error: "content must be a string" });
        return;
      }
      await setSoul(content);
      res.json({ ok: true });
    } catch (err) {
      log("Error in PUT /soul:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // =========================================================================
  // Memory
  // =========================================================================

  router.get("/memory", async (_req: Request, res: Response) => {
    try {
      const files: Array<{ path: string; size: number; mtime: number }> = [];

      // Check MEMORY.md
      const memoryFile = join(DATA_DIR, "MEMORY.md");
      if (existsSync(memoryFile)) {
        const stat = statSync(memoryFile);
        files.push({
          path: "MEMORY.md",
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      }

      // Check data/memory/*.md
      const memoryDir = join(DATA_DIR, "memory");
      if (existsSync(memoryDir)) {
        const entries = readdirSync(memoryDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(".md")) {
            const filePath = join(memoryDir, entry.name);
            const stat = statSync(filePath);
            files.push({
              path: `memory/${entry.name}`,
              size: stat.size,
              mtime: stat.mtimeMs,
            });
          }
        }
      }

      res.json({ files });
    } catch (err) {
      log("Error in GET /memory:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/memory/:path(*)", (req: Request, res: Response) => {
    try {
      const filePath = param(req, "path");

      // Validate path is safe
      const absPath = safePath(filePath);
      if (!absPath) {
        res.status(400).json({ error: "Invalid path" });
        return;
      }

      const content = getMemoryLines(filePath);
      res.json({ path: filePath, content });
    } catch (err) {
      log("Error in GET /memory/:path:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.put("/memory/:path(*)", async (req: Request, res: Response) => {
    try {
      const filePath = param(req, "path");
      const { content } = req.body as { content: string };

      if (typeof content !== "string") {
        res.status(400).json({ error: "content must be a string" });
        return;
      }

      // Validate path is safe
      const absPath = safePath(filePath);
      if (!absPath) {
        res.status(400).json({ error: "Invalid path" });
        return;
      }

      // Ensure parent directory exists
      const dir = dirname(absPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      await writeFile(absPath, content, "utf-8");
      log(`Memory file written: ${filePath}`);
      res.json({ ok: true });
    } catch (err) {
      log("Error in PUT /memory/:path:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // =========================================================================
  // Skills
  // =========================================================================

  router.get("/skills", (_req, res) => {
    try {
      const skills = skillService.list();
      res.json({ skills });
    } catch (err) {
      log("Error in GET /skills:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/skills/:id", (req, res) => {
    try {
      const id = param(req, "id");
      const skill = skillService.get(id);
      if (!skill) { res.status(404).json({ error: "Skill not found" }); return; }
      res.json(skill);
    } catch (err) {
      log("Error in GET /skills/:id:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/skills", async (req, res) => {
    try {
      const { source, content, url, name } = req.body as {
        source: "upload" | "github";
        content?: string;
        url?: string;
        name?: string;
      };

      let skill;
      if (source === "github") {
        if (!url) { res.status(400).json({ error: "url is required for GitHub install" }); return; }
        skill = await skillService.installFromGitHub({ url, name });
      } else if (source === "upload") {
        if (!content) { res.status(400).json({ error: "content is required for upload" }); return; }
        skill = await skillService.installFromUpload({ content, name });
      } else {
        res.status(400).json({ error: "source must be 'upload' or 'github'" });
        return;
      }

      res.status(201).json(skill);
    } catch (err) {
      log("Error in POST /skills:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.put("/skills/:id", async (req, res) => {
    try {
      const id = param(req, "id");
      const { enabled, content } = req.body as { enabled?: boolean; content?: string };
      const skill = await skillService.update(id, { enabled, content });
      if (!skill) { res.status(404).json({ error: "Skill not found" }); return; }
      res.json(skill);
    } catch (err) {
      log("Error in PUT /skills/:id:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/skills/:id", (req, res) => {
    try {
      const id = param(req, "id");
      const removed = skillService.remove(id);
      if (!removed) { res.status(404).json({ error: "Skill not found" }); return; }
      res.json({ ok: true });
    } catch (err) {
      log("Error in DELETE /skills/:id:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // =========================================================================
  // Cron
  // =========================================================================

  router.get("/cron", (_req: Request, res: Response) => {
    try {
      const jobs = cronService.list();
      res.json({ jobs });
    } catch (err) {
      log("Error in GET /cron:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/cron", (req: Request, res: Response) => {
    try {
      const body = req.body as CronJobCreate;
      const job = cronService.add(body);
      res.status(201).json(job);
    } catch (err) {
      log("Error in POST /cron:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.put("/cron/:id", (req: Request, res: Response) => {
    try {
      const id = param(req, "id");
      const body = req.body as CronJobPatch;
      const job = cronService.update(id, body);
      if (!job) {
        res.status(404).json({ error: "Cron job not found" });
        return;
      }
      res.json(job);
    } catch (err) {
      log("Error in PUT /cron/:id:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/cron/:id", (req: Request, res: Response) => {
    try {
      const id = param(req, "id");
      const removed = cronService.remove(id);
      if (!removed) {
        res.status(404).json({ error: "Cron job not found" });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      log("Error in DELETE /cron/:id:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/cron/:id/run", async (req: Request, res: Response) => {
    try {
      const id = param(req, "id");
      await cronService.forceRun(id);
      res.json({ ok: true });
    } catch (err) {
      log("Error in POST /cron/:id/run:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/cron/:id/runs", (req: Request, res: Response) => {
    try {
      const id = param(req, "id");
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const runs = cronService.getRunHistory(id, limit);
      res.json({ runs });
    } catch (err) {
      log("Error in GET /cron/:id/runs:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // =========================================================================
  // Evolutions
  // =========================================================================

  router.get("/evolutions", (req: Request, res: Response) => {
    try {
      const status = req.query.status as string | undefined;
      const evolutions = status
        ? listEvolutions({ status: status as any })
        : listEvolutions();
      res.json({ evolutions });
    } catch (err) {
      log("Error in GET /evolutions:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Sandbox CI config (must be before :id param route) ──

  /** GET /api/evolutions/sandbox-ci — get sandbox CI status and config */
  router.get("/evolutions/sandbox-ci", (_req: Request, res: Response) => {
    try {
      const status = getSandboxCIStatus();
      res.json(status);
    } catch (err) {
      log("Error in GET /evolutions/sandbox-ci:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  /** PUT /api/evolutions/sandbox-ci — toggle sandbox CI on/off */
  router.put("/evolutions/sandbox-ci", (req: Request, res: Response) => {
    try {
      const { enabled } = req.body as { enabled: boolean };
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean" });
        return;
      }
      setConfig("sandbox_ci_enabled", enabled ? "true" : "false");
      log(`Sandbox CI ${enabled ? "enabled" : "disabled"} via gateway UI`);
      const status = getSandboxCIStatus();
      res.json(status);
    } catch (err) {
      log("Error in PUT /evolutions/sandbox-ci:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Evolution CRUD (parameterized routes after static ones) ──

  router.get("/evolutions/:id", (req: Request, res: Response) => {
    try {
      const id = param(req, "id");
      const evolution = getEvolution(id);
      if (!evolution) {
        res.status(404).json({ error: "Evolution not found" });
        return;
      }
      res.json(evolution);
    } catch (err) {
      log("Error in GET /evolutions/:id:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/evolutions/:id/dismiss", (req: Request, res: Response) => {
    try {
      const id = param(req, "id");
      const evolution = getEvolution(id);
      if (!evolution) {
        res.status(404).json({ error: "Evolution not found" });
        return;
      }
      if (evolution.status !== "idea") {
        res.status(400).json({ error: "Can only dismiss ideas" });
        return;
      }
      updateEvolution(id, { status: "rejected" });
      res.json({ ok: true });
    } catch (err) {
      log("Error in POST /evolutions/:id/dismiss:", err);
      res.status(500).json({ error: String(err) });
    }
  });


  // =========================================================================
  // Logs (structured — application_log, error_log, tool_call_log)
  // =========================================================================

  /** GET /api/logs/app — query application log entries */
  router.get("/logs/app", (req: Request, res: Response) => {
    try {
      const sinceMs = parseTimeWindow(req);
      const level = req.query.level as string | undefined;
      const category = req.query.category as string | undefined;
      const limit = parseInt(req.query.limit as string, 10) || 200;

      const logs = getAppLogs({ sinceMs, level, category, limit });
      res.json({ logs });
    } catch (err) {
      log("Error in GET /logs/app:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  /** GET /api/logs/errors — query error log entries */
  router.get("/logs/errors", (req: Request, res: Response) => {
    try {
      const sinceMs = parseTimeWindow(req);
      const category = req.query.category as string | undefined;
      const limit = parseInt(req.query.limit as string, 10) || 200;

      const logs = getErrorLogs({ sinceMs, category, limit });
      res.json({ logs });
    } catch (err) {
      log("Error in GET /logs/errors:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  /** GET /api/logs/errors/stats — error counts by category */
  router.get("/logs/errors/stats", (req: Request, res: Response) => {
    try {
      const sinceMs = parseTimeWindow(req);
      const counts = getErrorCountsByCategory(sinceMs);
      res.json({ counts });
    } catch (err) {
      log("Error in GET /logs/errors/stats:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  /** GET /api/logs/tools — query tool call log entries */
  router.get("/logs/tools", (req: Request, res: Response) => {
    try {
      const sinceMs = parseTimeWindow(req);
      const tool = req.query.tool as string | undefined;
      const successOnly = req.query.success === "true";
      const failedOnly = req.query.failed === "true";
      const limit = parseInt(req.query.limit as string, 10) || 200;

      const logs = getToolCallLogs({ sinceMs, tool, successOnly, failedOnly, limit });
      res.json({ logs });
    } catch (err) {
      log("Error in GET /logs/tools:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  /** GET /api/logs/tools/stats — tool call statistics (count, failure rate, avg/max duration) */
  router.get("/logs/tools/stats", (req: Request, res: Response) => {
    try {
      const sinceMs = parseTimeWindow(req);
      const stats = getToolCallStats(sinceMs);
      res.json({ stats });
    } catch (err) {
      log("Error in GET /logs/tools/stats:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  /** GET /api/logs/tools/slowest — slowest tool calls */
  router.get("/logs/tools/slowest", (req: Request, res: Response) => {
    try {
      const sinceMs = parseTimeWindow(req);
      const limit = parseInt(req.query.limit as string, 10) || 10;
      const logs = getSlowestToolCalls({ sinceMs, limit });
      res.json({ logs });
    } catch (err) {
      log("Error in GET /logs/tools/slowest:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // =========================================================================
  // Bot control
  // =========================================================================

  router.post("/bot/restart", (_req: Request, res: Response) => {
    res.json({ message: "Restarting..." });
    triggerRestart();
  });

  // =========================================================================
  // Invocation metrics — usage, dead code, low-use features
  // =========================================================================

  /** Narrow a query param to a PathKind, or undefined when absent/invalid. */
  function parseKind(raw: unknown): PathKind | undefined {
    const kinds = ["command", "tool", "route", "skill", "feature", "branch"];
    return typeof raw === "string" && kinds.includes(raw) ? (raw as PathKind) : undefined;
  }

  router.get("/metrics/invocations", (req: Request, res: Response) => {
    try {
      flushMetrics(); // include counts still buffered in memory
      const minCountRaw = parseInt(req.query.minCount as string, 10);
      res.json({
        metrics: getMetrics({
          kind: parseKind(req.query.kind),
          minCount: isNaN(minCountRaw) ? undefined : minCountRaw,
          limit: parseInt(req.query.limit as string, 10) || undefined,
        }),
        summary: getMetricsSummary(),
        window: getObservationWindow(),
      });
    } catch (err) {
      log("Error in GET /metrics/invocations:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/metrics/dead", (req: Request, res: Response) => {
    try {
      flushMetrics();
      res.json({
        dead: getDeadPaths({
          kind: parseKind(req.query.kind),
          includeRare: req.query.includeRare === "1" || req.query.includeRare === "true",
        }),
        summary: getMetricsSummary(),
        window: getObservationWindow(),
      });
    } catch (err) {
      log("Error in GET /metrics/dead:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/metrics/low-use", (req: Request, res: Response) => {
    try {
      flushMetrics();
      const threshold = parseInt(req.query.threshold as string, 10);
      const staleDays = parseInt(req.query.staleDays as string, 10);
      res.json({
        lowUse: getLowUsePaths({
          threshold: isNaN(threshold) ? undefined : threshold,
          kind: parseKind(req.query.kind),
          limit: parseInt(req.query.limit as string, 10) || undefined,
        }),
        stale: getStalePaths({ days: isNaN(staleDays) ? undefined : staleDays }),
        window: getObservationWindow(),
      });
    } catch (err) {
      log("Error in GET /metrics/low-use:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // Seed one row per route now that every route is registered, so endpoints
  // nobody calls are visible as dead rather than missing.
  declareRoutePaths(router as unknown as { stack?: any[] });

  return router;
}
