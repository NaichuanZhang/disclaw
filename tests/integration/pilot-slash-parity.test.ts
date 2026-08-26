import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const sessionSrc = readFileSync("src/pilot/session.ts", "utf-8");
const commandsSrc = readFileSync("src/bot/commands.ts", "utf-8");
const pilotIndexSrc = readFileSync("src/pilot/index.ts", "utf-8");
const indexSrc = readFileSync("src/index.ts", "utf-8");
const skillToolsSrc = readFileSync("src/skills/tools.ts", "utf-8");

/**
 * Slice a source file from a marker to the next top-level boundary, so an
 * assertion cannot accidentally match code further down the file.
 */
function fnBody(src: string, marker: string, length = 1600): string {
  const at = src.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  return src.slice(at, at + length);
}

// ---------------------------------------------------------------------------
// Channel settings: thread session, parent channel
//
// Pilot sessions are keyed to the thread, but /config set-prompt and /caveman
// write to the parent channel's config. A thread session therefore used to
// ignore both. The session now falls back to its parent for channel settings.
// ---------------------------------------------------------------------------

describe("pilot channel settings fall back to the parent channel", () => {
  it("tracks the parent id on the target and the session", () => {
    expect(sessionSrc).toMatch(/parentId\?: string \| null/);
    expect(sessionSrc).toContain("this.parentId = target.parentId ?? null");
  });

  it("reads own config first, then the parent", () => {
    const read = fnBody(sessionSrc, "private channelSettings<T>(");
    expect(read).toContain("getChannelConfig(this.channelId)");
    expect(read).toContain("getChannelConfig(this.parentId)");
    // Own value wins whenever it is actually set.
    expect(read.indexOf("getChannelConfig(this.channelId)")).toBeLessThan(
      read.indexOf("getChannelConfig(this.parentId)"),
    );
  });

  it("routes the caveman level and the channel prompt through it", () => {
    expect(fnBody(sessionSrc, "private buildCavemanPrompt()")).toContain(
      "this.channelSettings(",
    );
    expect(fnBody(sessionSrc, "private buildChannelPrompt()")).toContain(
      "this.channelSettings(",
    );
  });

  it("composes the channel prompt into the system prompt", () => {
    expect(sessionSrc).toContain("this.buildChannelPrompt()");
    expect(sessionSrc).toContain("## Channel Instructions");
  });

  it("keeps parentId current when the target moves", () => {
    expect(fnBody(sessionSrc, "setTarget(")).toContain("parentId");
  });
});

// ---------------------------------------------------------------------------
// /model and per-job cron models
// ---------------------------------------------------------------------------

describe("pilot honours a model override", () => {
  it("accepts one on the incoming message and freezes it at start", () => {
    expect(sessionSrc).toMatch(/modelOverride\?: string/);
    const submit = fnBody(sessionSrc, "  submit(message: PilotIncomingMessage)");
    expect(submit).toContain("this.modelOverride");
    // Only meaningful before the child spawns — a running child keeps its model.
    expect(submit).toContain("!this.started");
  });

  it("passes it to the child as ANTHROPIC_MODEL", () => {
    const overrides = fnBody(sessionSrc, "private modelEnvOverrides()");
    expect(overrides).toContain("ANTHROPIC_MODEL");
    expect(overrides).toContain("resolveModel(this.modelOverride)");
    expect(sessionSrc).toContain("buildPilotEnv({ overrides: this.modelEnvOverrides() })");
  });

  it("still lets PILOT_ANTHROPIC_MODEL win", () => {
    const overrides = fnBody(sessionSrc, "private modelEnvOverrides()");
    expect(overrides).toContain("process.env.PILOT_ANTHROPIC_MODEL");
    expect(overrides.indexOf("PILOT_ANTHROPIC_MODEL")).toBeLessThan(
      overrides.indexOf("resolveModel(this.modelOverride)"),
    );
  });

  it("is supplied by the cron route instead of being warned about", () => {
    expect(indexSrc).toContain("modelOverride: model");
    expect(indexSrc).not.toMatch(/ignored for pilot sessions/i);
  });
});

// ---------------------------------------------------------------------------
// Scoped registry lookups
//
// /clear, /stop and /pilot off are invoked in the parent channel but the
// sessions live on threads under it, so every one of them needs a scope walk.
// ---------------------------------------------------------------------------

describe("scoped pilot session lookups", () => {
  it("matches the channel itself and any session whose parent is it", () => {
    const fn = fnBody(sessionSrc, "export function pilotSessionChannelIdsUnder(");
    expect(fn).toContain("session.parentId === channelId");
    expect(fn).toContain("isClosed");
  });

  it("exports interrupt/stop/reset scope helpers from the barrel", () => {
    for (const name of [
      "pilotSessionChannelIdsUnder",
      "interruptPilotSessionsUnder",
      "stopPilotSessionsUnder",
      "resetPilotSessionScope",
    ]) {
      // Some of these are async, so match the export without pinning the keyword.
      expect(sessionSrc).toMatch(new RegExp(`export (async )?function ${name}\\(`));
      expect(pilotIndexSrc).toContain(name);
    }
  });

  it("clears the stored resume id for every channel it stops", () => {
    const fn = fnBody(sessionSrc, "export async function resetPilotSessionScope(", 1400);
    expect(fn).toContain("clearPilotSessionId(");
    expect(fn).toContain("stopped");
    expect(fn).toContain("cleared");
  });

  it("/stop falls back to the scope when no session matches the channel", () => {
    const handler = fnBody(commandsSrc, "async function handleInterrupt", 2600);
    expect(handler).toContain("interruptPilotSessionsUnder(");
  });

  it("/pilot off stops live sessions under the channel", () => {
    const handler = fnBody(commandsSrc, "async function handlePilot", 3200);
    expect(handler).toContain("stopPilotSessionsUnder(");
  });
});

// ---------------------------------------------------------------------------
// /restart
// ---------------------------------------------------------------------------

describe("/restart shuts pilot children down first", () => {
  it("stops all pilot sessions before exiting", () => {
    expect(indexSrc).toContain("stopAllPilotSessions()");
    const exitAt = indexSrc.indexOf("process.exit(100)");
    expect(exitAt).toBeGreaterThan(-1);
    expect(indexSrc.lastIndexOf("stopAllPilotSessions()", exitAt)).toBeGreaterThan(-1);
  });

  it("tells the user how many are being stopped", () => {
    expect(fnBody(commandsSrc, 'case "restart"', 1200)).toContain("activePilotSessionCount()");
  });
});

// ---------------------------------------------------------------------------
// Read-only surfaces
// ---------------------------------------------------------------------------

describe("status and help surfaces mention pilot", () => {
  it("/ping reports the live pilot session count", () => {
    expect(commandsSrc).toContain("activePilotSessionCount()");
    expect(commandsSrc).toMatch(/name: "Pilot"/);
  });

  it("/config show reports which runtime the channel uses", () => {
    expect(fnBody(commandsSrc, 'case "show"', 3000)).toMatch(/Runtime/);
  });

  it("/help documents what /clear does in a pilot channel", () => {
    const help = fnBody(commandsSrc, "async function handleHelp", 4000);
    expect(help).toMatch(/pilot/i);
  });
});

describe("settings that only apply on the next session say so", () => {
  it("has one shared note helper, used by the prompt-bearing commands", () => {
    expect(commandsSrc).toContain("function pilotPromptNote(");
    const calls = commandsSrc.match(/pilotPromptNote\(/g) ?? [];
    // definition + /config set-prompt + both /caveman replies
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it("keys the skills note on live sessions, since skills are global", () => {
    const note = fnBody(commandsSrc, "function pilotSkillsNote(");
    expect(note).toContain("activePilotSessionCount()");
    const calls = commandsSrc.match(/pilotSkillsNote\(\)/g) ?? [];
    // add-github + add-file + remove (plus the definition's own return)
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("stays silent outside pilot channels", () => {
    const note = fnBody(commandsSrc, "function pilotPromptNote(");
    expect(note).toContain("isPilotChannelId(channelId)");
    expect(note).toContain('""');
  });
});

// ---------------------------------------------------------------------------
// /cron model UI
// ---------------------------------------------------------------------------

describe("/cron marks pilot-routed jobs", () => {
  it("has a predicate based on the delivery channel", () => {
    const fn = fnBody(commandsSrc, "function isPilotRoutedJob(");
    expect(fn).toContain("job.delivery?.channelId");
    expect(fn).toContain("isPilotChannelId(");
    expect(fn).toContain('job.payload.kind !== "agentTurn"');
  });

  it("annotates list, show and set-model", () => {
    const calls = commandsSrc.match(/isPilotRoutedJob\(job\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("says the job model applies to the pilot session, not that it is ignored", () => {
    expect(commandsSrc).not.toMatch(/model[^\n]{0,40}ignored[^\n]{0,40}pilot/i);
    expect(commandsSrc).toMatch(/pilot session this job runs on/);
  });
});

// ---------------------------------------------------------------------------
// /skills disable
// ---------------------------------------------------------------------------

describe("pilot skill tools respect the enabled flag", () => {
  it("refuses a disabled skill in both read paths", () => {
    expect(skillToolsSrc).toContain("function disabledSkillError(");
    const guard = fnBody(skillToolsSrc, "function disabledSkillError(", 700);
    expect(guard).toContain("enabled === false");
    const calls = skillToolsSrc.match(/disabledSkillError\(/g) ?? [];
    // definition + read_skill + list_skill_files
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});
