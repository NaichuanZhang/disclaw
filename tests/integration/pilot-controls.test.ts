import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const sessionSrc = readFileSync("src/pilot/session.ts", "utf-8");
const commandsSrc = readFileSync("src/bot/commands.ts", "utf-8");
const indexSrc = readFileSync("src/pilot/index.ts", "utf-8");

// ---------------------------------------------------------------------------
// turn watchdog
//
// A pilot turn that wedges used to hold the session forever: turnActive stayed
// true, the typing indicator kept refreshing, and nothing short of /stop got it
// back. These pin the watchdog to the turn lifecycle.
// ---------------------------------------------------------------------------

describe("pilot turn watchdog", () => {
  it("has a configurable timeout and soft cost cap", () => {
    expect(sessionSrc).toContain("PILOT_TURN_TIMEOUT_MS");
    expect(sessionSrc).toContain("PILOT_TURN_MAX_COST_USD");
    expect(sessionSrc).toMatch(/PILOT_TURN_TIMEOUT_MS \|\| 15 \* 60 \* 1000/);
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
    expect(fmt).toContain("PILOT_TURN_MAX_COST_USD > 0");
  });
});

// ---------------------------------------------------------------------------
// /clear and /pilot
// ---------------------------------------------------------------------------

describe("resetPilotSession", () => {
  it("stops the session and drops the stored resume id", () => {
    const fn = sessionSrc.slice(sessionSrc.indexOf("export async function resetPilotSession"));
    expect(fn.slice(0, 400)).toContain("stopPilotSession(channelId)");
    expect(fn.slice(0, 400)).toContain("clearPilotSessionId(channelId)");
  });

  it("is exported from the pilot barrel", () => {
    expect(indexSrc).toContain("resetPilotSession");
  });
});

describe("/clear in a pilot channel", () => {
  it("resets the pilot session instead of clearing unread conversation rows", () => {
    const handler = commandsSrc.slice(commandsSrc.indexOf("async function handleClear"));
    const body = handler.slice(0, 2200);
    expect(body).toContain("resetPilotSession(interaction.channelId)");
    // The pilot branch must return before the normal clearSession path runs.
    expect(body.indexOf("resetPilotSession")).toBeLessThan(body.indexOf("clearSession(session.id)"));
  });

  it("resolves threads to the channel that owns the pilot flag", () => {
    const handler = commandsSrc.slice(commandsSrc.indexOf("async function handleClear"));
    expect(handler.slice(0, 2200)).toContain("pilotConfigChannelId(");
  });

  it("leaves the non-pilot path intact", () => {
    const handler = commandsSrc.slice(commandsSrc.indexOf("async function handleClear"));
    expect(handler.slice(0, 3000)).toContain("clearSession(session.id)");
  });
});

describe("/pilot command", () => {
  it("is registered with on/off/status choices", () => {
    const decl = commandsSrc.slice(commandsSrc.indexOf('name: "pilot"'), commandsSrc.indexOf('name: "pilot"') + 900);
    expect(decl).toContain('name: "state"');
    for (const choice of ["on", "off", "status"]) {
      expect(decl).toContain(`value: "${choice}"`);
    }
  });

  it("is dispatched and documented in /help", () => {
    expect(commandsSrc).toContain('case "pilot":');
    expect(commandsSrc).toContain("`/pilot on|off|status`");
  });

  it("writes the flag through channel_configs settings", () => {
    const handler = commandsSrc.slice(commandsSrc.indexOf("async function handlePilot"));
    const body = handler.slice(0, 2600);
    expect(body).toContain("setChannelConfig(configId,");
    expect(body).toContain("pilot: turnOn");
    // Must preserve the rest of the settings blob.
    expect(body).toContain("...(existing?.settings ?? {})");
  });

  it("stops a live session when turning pilot off", () => {
    const handler = commandsSrc.slice(commandsSrc.indexOf("async function handlePilot"));
    const body = handler.slice(0, 2600);
    expect(body).toMatch(/if \(!turnOn\)[\s\S]{0,120}stopPilotSession/);
  });

  it("refuses in DMs, where pilot mode does not apply", () => {
    const handler = commandsSrc.slice(commandsSrc.indexOf("async function handlePilot"));
    expect(handler.slice(0, 1200)).toContain("interaction.guildId");
  });
});
