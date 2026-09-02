import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const sessionSrc = readFileSync("src/sdk/session.ts", "utf-8");
const commandsSrc = readFileSync("src/bot/commands.ts", "utf-8");
const indexSrc = readFileSync("src/sdk/index.ts", "utf-8");

// ---------------------------------------------------------------------------
// turn watchdog
//
// A turn that wedges used to hold the session forever: turnActive stayed
// true, the typing indicator kept refreshing, and nothing short of /stop got it
// back. These pin the watchdog to the turn lifecycle.
// ---------------------------------------------------------------------------

describe("turn watchdog", () => {
  it("has a configurable timeout and soft cost cap", () => {
    expect(sessionSrc).toContain("SDK_TURN_TIMEOUT_MS");
    expect(sessionSrc).toContain("SDK_TURN_MAX_COST_USD");
    // Read through pickSdkEnv so SDK_* and the pre-rename PILOT_* both work.
    expect(sessionSrc).toMatch(
      /pickSdkEnv\(process\.env, "TURN_TIMEOUT_MS"\) \|\| 15 \* 60 \* 1000/,
    );
  });

  it("arms on every turn start via beginTurn, not just the first", () => {
    expect(sessionSrc).toContain("private beginTurn()");
    expect(sessionSrc).toMatch(/beginTurn\(\)[\s\S]*armTurnWatchdog\(\)/);
    // Both the initial submit and the resume-retry path must go through it.
    const calls = sessionSrc.match(/this\.beginTurn\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // beginTurn() owns the whole turn-start trio, so no caller can drift.
    const begin = sessionSrc.slice(sessionSrc.indexOf("private beginTurn()"));
    expect(begin.slice(0, 300)).toContain("this.turnActive = true");
    expect(begin.slice(0, 300)).toContain("this.startTyping()");
  });

  it("clears when the turn ends and when the session stops", () => {
    expect(sessionSrc).toContain("private clearTurnWatchdog()");
    const endTurn = sessionSrc.slice(sessionSrc.indexOf("private endTurn()"));
    expect(endTurn.slice(0, 400)).toContain("clearTurnWatchdog()");
    const stop = sessionSrc.slice(sessionSrc.indexOf("async stop("));
    expect(stop.slice(0, 400)).toContain("clearTurnWatchdog()");
  });

  it("interrupts rather than kills, so the session survives a timeout", () => {
    const arm = sessionSrc.slice(sessionSrc.indexOf("private armTurnWatchdog()"));
    expect(arm.slice(0, 700)).toContain("this.interrupt()");
    expect(arm.slice(0, 700)).not.toContain("this.stop()");
  });

  it("does not hold the event loop open", () => {
    expect(sessionSrc).toMatch(/unref\?\.\(\)/);
  });

  it("flags a turn that runs past the soft cost cap in the footer", () => {
    const fmt = sessionSrc.slice(sessionSrc.indexOf("private formatUsage("), sessionSrc.indexOf("private formatToolUse("));
    expect(fmt).toContain("soft cap");
    expect(fmt).toContain("SDK_TURN_MAX_COST_USD > 0");
  });
});

// ---------------------------------------------------------------------------
// /clear
// ---------------------------------------------------------------------------

describe("resetSdkSession", () => {
  it("stops the session and drops the stored resume id", () => {
    const fn = sessionSrc.slice(sessionSrc.indexOf("export async function resetSdkSession("));
    expect(fn.slice(0, 400)).toContain("stopSdkSession(channelId)");
    expect(fn.slice(0, 400)).toContain("clearSdkSessionId(channelId)");
  });

  it("is exported from the sdk barrel", () => {
    expect(indexSrc).toContain("resetSdkSession");
  });
});

describe("/clear", () => {
  it("stops the session scope, since that is where the model's context lives", () => {
    const handler = commandsSrc.slice(commandsSrc.indexOf("async function handleClear"));
    const body = handler.slice(0, 2200);
    // Scope, not one channel: thread sessions under the channel reset too.
    expect(body).toContain("resetSdkSessionScope(interaction.channelId)");
  });

  it("also clears our own rows, which /history and the archive still read", () => {
    const handler = commandsSrc.slice(commandsSrc.indexOf("async function handleClear"));
    const body = handler.slice(0, 3000);
    expect(body).toContain("clearSession(session.id)");
    expect(body).toContain("clearThreadHistoryCache(");
    // Both halves run on every /clear — there is no branch that skips one.
    expect(body.indexOf("resetSdkSessionScope")).toBeLessThan(
      body.indexOf("clearSession(session.id)"),
    );
  });

  it("says whether anything was actually live, rather than claiming success", () => {
    const handler = commandsSrc.slice(commandsSrc.indexOf("async function handleClear"));
    expect(handler.slice(0, 2600)).toMatch(/stopped > 0/);
  });
});
