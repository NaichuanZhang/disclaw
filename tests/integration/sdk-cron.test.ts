// ---------------------------------------------------------------------------
// Cron agent turns
//
// Scheduled `agentTurn` jobs run on a Claude Agent SDK session, in a thread of
// their own. The route planning is pure and tested directly; the wiring that
// consumes it is asserted against source, since running it for real would spawn
// an SDK child and talk to Discord.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { planSdkCronRoute } from "../../src/sdk/cron-route.js";

const serviceSrc = readFileSync("src/cron/service.ts", "utf-8");
const indexSrc = readFileSync("src/index.ts", "utf-8");
const commandsSrc = readFileSync("src/bot/commands.ts", "utf-8");

/** The router function body, which is what most of the wiring assertions read. */
const routerBody = (() => {
  const from = indexSrc.slice(indexSrc.indexOf("async function runCronAgentTurn"));
  return from.slice(0, 4000);
})();

// ---------------------------------------------------------------------------
// Route planning (pure)
// ---------------------------------------------------------------------------

describe("planSdkCronRoute", () => {
  it("returns null only when the job has no delivery channel", () => {
    expect(planSdkCronRoute({})).toBeNull();
    expect(planSdkCronRoute({ channelId: null })).toBeNull();
    expect(planSdkCronRoute({ channelId: "   " })).toBeNull();
  });

  it("routes a plain channel to itself and asks for a thread", () => {
    expect(planSdkCronRoute({ channelId: "chan-1" })).toEqual({
      sessionChannelId: "chan-1",
      needsThread: true,
    });
  });

  it("keeps a thread's session in the thread", () => {
    // A thread cannot contain a thread, so the run posts into the thread itself.
    expect(
      planSdkCronRoute({
        channelId: "thread-9",
        isThread: true,
        parentId: "chan-1",
      }),
    ).toEqual({ sessionChannelId: "thread-9", needsThread: false });
  });

  it("still routes a thread with no known parent", () => {
    // Routing keys on the thread alone, so an unresolvable parent must not cost
    // the job its run.
    expect(planSdkCronRoute({ channelId: "thread-9", isThread: true })).toEqual({
      sessionChannelId: "thread-9",
      needsThread: false,
    });
  });

  it("routes a DM to a session in the DM, without a thread", () => {
    // The admin-DM fallback target gets a session like anything else; a DM just
    // cannot hold a thread.
    expect(planSdkCronRoute({ channelId: "dm-1", isDM: true })).toEqual({
      sessionChannelId: "dm-1",
      needsThread: false,
    });
  });

  it("trims a padded channel id instead of building a bad route", () => {
    expect(planSdkCronRoute({ channelId: " chan-1 " })?.sessionChannelId).toBe("chan-1");
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
  it("routes every agent turn through an SDK session", () => {
    expect(routerBody).toContain("planSdkCronRoute(");
    expect(routerBody).toContain("submitToSdkSession(");
  });

  it("creates a thread only when the target is not already one", () => {
    expect(routerBody).toMatch(/route\.needsThread\s*\n?\s*\?\s*await ensureThread/);
  });

  it("fails loudly rather than silently dropping a run it cannot route", () => {
    // There is no second runtime to fall back to, so an unroutable job must
    // surface as an error the cron log records.
    expect(routerBody).toMatch(/if \(!route\) \{\s*\n\s*throw new Error\(/);
    expect(routerBody).toContain("Discord client not ready");
    expect(routerBody).not.toContain("processAgentTurn");
  });

  it("is what cron actually calls", () => {
    expect(indexSrc).toMatch(/setExecuteAgentTurn\(\(message, model, context\) =>\s*\n?\s*runCronAgentTurn\(message, model, context\)/);
  });

  it("forwards a per-job model override to the session", () => {
    // A fresh thread means a fresh session, so the job's model is honoured for
    // real rather than logged and dropped.
    expect(routerBody).toContain("modelOverride: model");
  });
});

describe("/cron annotations", () => {
  it("marks every agent-turn job as session-routed, with no flag to consult", () => {
    const fn = commandsSrc.slice(commandsSrc.indexOf("function isAgentJob("));
    expect(fn.slice(0, 400)).toContain('job.payload.kind === "agentTurn"');
  });

  it("keeps the created-job note on the same rule as the router", () => {
    expect(commandsSrc).toContain("const agentNote = isAgentJob(job)");
  });
});
