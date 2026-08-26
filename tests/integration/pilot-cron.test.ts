import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  cronAgentRuntime,
  planPilotCronRoute,
} from "../../src/pilot/cron-route.js";

const serviceSrc = readFileSync("src/cron/service.ts", "utf-8");
const indexSrc = readFileSync("src/index.ts", "utf-8");
const messagesSrc = readFileSync("src/bot/messages.ts", "utf-8");
const commandsSrc = readFileSync("src/bot/commands.ts", "utf-8");

/** The router function body, which is what most of the wiring assertions read. */
const routerBody = (() => {
  const from = indexSrc.slice(indexSrc.indexOf("async function runCronAgentTurn"));
  return from.slice(0, 4000);
})();

// ---------------------------------------------------------------------------
// Route planning (pure)
// ---------------------------------------------------------------------------

describe("planPilotCronRoute", () => {
  it("returns null only when the job has no delivery channel", () => {
    expect(planPilotCronRoute({})).toBeNull();
    expect(planPilotCronRoute({ channelId: null })).toBeNull();
    expect(planPilotCronRoute({ channelId: "   " })).toBeNull();
  });

  it("routes a plain channel to itself and asks for a thread", () => {
    expect(planPilotCronRoute({ channelId: "chan-1" })).toEqual({
      configChannelId: "chan-1",
      sessionChannelId: "chan-1",
      needsThread: true,
    });
  });

  it("keeps a thread's session in the thread and names its parent as the config owner", () => {
    expect(
      planPilotCronRoute({
        channelId: "thread-9",
        isThread: true,
        parentId: "chan-1",
      }),
    ).toEqual({
      configChannelId: "chan-1",
      sessionChannelId: "thread-9",
      // A thread cannot contain a thread.
      needsThread: false,
    });
  });

  it("still routes a thread with no known parent — the session keys to the thread", () => {
    // The parent is only needed to find channel config, and routing no longer
    // depends on it, so an unresolvable parent must not cost the job its run.
    expect(planPilotCronRoute({ channelId: "thread-9", isThread: true })).toEqual({
      configChannelId: null,
      sessionChannelId: "thread-9",
      needsThread: false,
    });
  });

  it("routes a DM to a session in the DM, without a thread", () => {
    // Pilot mode as a channel flag is guild-only, but cron runs every agent turn
    // on the SDK — so the admin-DM fallback target gets a session too. A DM has
    // no channel config to own the flag and cannot hold a thread.
    expect(planPilotCronRoute({ channelId: "dm-1", isDM: true })).toEqual({
      configChannelId: null,
      sessionChannelId: "dm-1",
      needsThread: false,
    });
  });

  it("trims a padded channel id instead of building a bad route", () => {
    expect(planPilotCronRoute({ channelId: " chan-1 " })?.sessionChannelId).toBe("chan-1");
  });
});

// ---------------------------------------------------------------------------
// Runtime escape hatch
// ---------------------------------------------------------------------------

describe("cronAgentRuntime", () => {
  const original = process.env.CRON_RUNTIME;
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_RUNTIME;
    else process.env.CRON_RUNTIME = original;
  });

  it("defaults to the SDK", () => {
    delete process.env.CRON_RUNTIME;
    expect(cronAgentRuntime()).toBe("sdk");
    process.env.CRON_RUNTIME = "";
    expect(cronAgentRuntime()).toBe("sdk");
  });

  it("falls back to the main agent loop only on an explicit CRON_RUNTIME=main", () => {
    process.env.CRON_RUNTIME = "main";
    expect(cronAgentRuntime()).toBe("main");
    process.env.CRON_RUNTIME = "  MAIN  ";
    expect(cronAgentRuntime()).toBe("main");
  });

  it("treats anything else as the default rather than guessing", () => {
    process.env.CRON_RUNTIME = "pilot";
    expect(cronAgentRuntime()).toBe("sdk");
    process.env.CRON_RUNTIME = "nonsense";
    expect(cronAgentRuntime()).toBe("sdk");
  });

  it("is read per call, so the flip needs a restart and not a rebuild", () => {
    const src = readFileSync("src/pilot/cron-route.ts", "utf-8");
    expect(src).toMatch(/export function cronAgentRuntime\(\)/);
    // Not captured in a module-level const at import time.
    expect(src).not.toMatch(/^const CRON_RUNTIME/m);
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe("cron service agent-turn context", () => {
  it("hands the delivery channel and job identity to the callback", () => {
    expect(serviceSrc).toContain("export interface CronAgentTurnContext");
    expect(serviceSrc).toMatch(/channelId: this\.resolveDelivery\(job\)\?\.channelId/);
    expect(serviceSrc).toContain("jobName: job.name");
  });

  it("keeps the context optional so the callback contract is backwards compatible", () => {
    expect(serviceSrc).toMatch(/context\?: CronAgentTurnContext/);
  });

  it("still leaves agentTurn delivery to the agent's own tools", () => {
    expect(serviceSrc).toContain('if (job.payload.kind !== "agentTurn")');
  });
});

describe("cron agent-turn router", () => {
  it("routes every agent turn through a pilot session", () => {
    expect(routerBody).toContain("planPilotCronRoute(");
    expect(routerBody).toContain("submitToPilotSession(");
  });

  it("no longer gates on the channel's pilot flag", () => {
    expect(routerBody).not.toContain("isPilotChannelId(");
    expect(indexSrc).not.toContain("isPilotChannelId");
  });

  it("skips the pilot path only when CRON_RUNTIME asks for the main loop", () => {
    expect(routerBody).toMatch(/cronAgentRuntime\(\) === "main"\s*\n?\s*\?\s*null/);
  });

  it("creates a thread only when the target is not already one", () => {
    expect(routerBody).toMatch(/route\.needsThread\s*\n?\s*\?\s*await ensureThread/);
  });

  it("falls back to the main agent when pilot routing fails", () => {
    expect(routerBody).toContain("catch (err)");
    // The fallback is the last statement, so the no-route case and a failed
    // pilot route both reach it.
    expect(routerBody).toContain("return processAgentTurn({ message, model });");
    expect(routerBody.lastIndexOf("return processAgentTurn")).toBeGreaterThan(
      routerBody.indexOf("submitToPilotSession("),
    );
  });

  it("says why a run went to the main loop instead of failing silently", () => {
    expect(routerBody).toContain("on the main agent loop");
  });

  it("is what cron actually calls", () => {
    expect(indexSrc).toMatch(/setExecuteAgentTurn\(\(message, model, context\) =>\s*\n?\s*runCronAgentTurn\(message, model, context\)/);
  });

  it("forwards a per-job model override to the pilot session", () => {
    // It used to warn that the override was ignored; the session now starts its
    // child on that model, so the job's model is honoured either way it routes.
    expect(routerBody).toContain("modelOverride: model");
    expect(routerBody).not.toMatch(/ignored for pilot sessions/);
  });
});

describe("replies to a cron session", () => {
  it("routes a channel with a live pilot session to that session, flag or not", () => {
    // Cron sessions live in threads nobody flagged; without this a reply would
    // be answered by the main agent loop with none of the session's context.
    expect(messagesSrc).toContain("hasLivePilotSession(message.channelId)");
    const fn = messagesSrc.slice(messagesSrc.indexOf("function isPilotChannel("));
    const body = fn.slice(0, 1200);
    expect(body.indexOf("hasLivePilotSession")).toBeLessThan(
      body.indexOf("pilotConfigChannelId("),
    );
  });
});

describe("/cron annotations", () => {
  it("marks agent-turn jobs as SDK-routed without consulting the channel flag", () => {
    const fn = commandsSrc.slice(commandsSrc.indexOf("function isPilotRoutedJob("));
    const body = fn.slice(0, 400);
    expect(body).toContain('cronAgentRuntime() === "sdk"');
    expect(body).not.toContain("isPilotChannelId(");
  });

  it("keeps the created-job note on the same rule as the router", () => {
    expect(commandsSrc).toContain("const pilotNote = isPilotRoutedJob(job)");
  });
});
