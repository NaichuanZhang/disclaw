import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { planPilotCronRoute } from "../../src/pilot/cron-route.js";

const serviceSrc = readFileSync("src/cron/service.ts", "utf-8");
const indexSrc = readFileSync("src/index.ts", "utf-8");

// ---------------------------------------------------------------------------
// Route planning (pure)
// ---------------------------------------------------------------------------

describe("planPilotCronRoute", () => {
  it("returns null when the job has no delivery channel", () => {
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

  it("reads the flag from a thread's parent but keeps the session in the thread", () => {
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

  it("gives up on a thread with no known parent rather than guessing", () => {
    expect(planPilotCronRoute({ channelId: "thread-9", isThread: true })).toBeNull();
  });

  it("never routes a DM — pilot mode is per guild channel", () => {
    expect(planPilotCronRoute({ channelId: "dm-1", isDM: true })).toBeNull();
  });

  it("trims a padded channel id instead of building a bad route", () => {
    expect(planPilotCronRoute({ channelId: " chan-1 " })?.configChannelId).toBe("chan-1");
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
  it("routes a pilot-flagged channel through the pilot session", () => {
    const fn = indexSrc.slice(indexSrc.indexOf("async function runCronAgentTurn"));
    const body = fn.slice(0, 3000);
    expect(body).toContain("planPilotCronRoute(");
    expect(body).toContain("isPilotChannelId(route.configChannelId)");
    expect(body).toContain("submitToPilotSession(");
  });

  it("creates a thread only when the target is not already one", () => {
    const fn = indexSrc.slice(indexSrc.indexOf("async function runCronAgentTurn"));
    expect(fn.slice(0, 3000)).toMatch(/route\.needsThread\s*\n?\s*\?\s*await ensureThread/);
  });

  it("falls back to the main agent when pilot routing fails", () => {
    const fn = indexSrc.slice(indexSrc.indexOf("async function runCronAgentTurn"));
    const body = fn.slice(0, 3000);
    expect(body).toContain("catch (err)");
    // The fallback is the last statement, so both the non-pilot path and a
    // failed pilot route reach it.
    expect(body).toContain("return processAgentTurn({ message, model });");
    expect(body.lastIndexOf("return processAgentTurn")).toBeGreaterThan(
      body.indexOf("submitToPilotSession("),
    );
  });

  it("is what cron actually calls", () => {
    expect(indexSrc).toMatch(/setExecuteAgentTurn\(\(message, model, context\) =>\s*\n?\s*runCronAgentTurn\(message, model, context\)/);
  });

  it("warns rather than silently dropping a per-job model override", () => {
    const fn = indexSrc.slice(indexSrc.indexOf("async function runCronAgentTurn"));
    expect(fn.slice(0, 3000)).toMatch(/ignored for pilot sessions/);
  });
});
