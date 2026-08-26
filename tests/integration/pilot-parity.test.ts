// ---------------------------------------------------------------------------
// Pilot mode — parity with the main agent
//
// The two runtimes build their own system prompts and their own tool lists, so
// they drift silently. These tests pin the pieces that are meant to be shared:
// the memory + caveman prompt fragments (exercised directly), and the pilot
// wiring that consumes them (asserted against source, since building the real
// prompt would spawn an SDK child and touch the live DB).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { ChannelConfig } from "../../src/db/index.js";
import {
  MEMORY_RECALL_INSTRUCTIONS,
  CAVEMAN_LEVELS,
  buildCavemanInstructions,
  getCavemanLevel,
} from "../../src/shared/prompt-fragments.js";

const sessionSrc = readFileSync(
  new URL("../../src/pilot/session.ts", import.meta.url),
  "utf8",
);
const bridgeSrc = readFileSync(
  new URL("../../src/pilot/bridge.ts", import.meta.url),
  "utf8",
);
const agentSrc = readFileSync(
  new URL("../../src/agent/agent.ts", import.meta.url),
  "utf8",
);

function config(settings: Record<string, unknown>): ChannelConfig {
  return { channelId: "chan-1", settings } as unknown as ChannelConfig;
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

describe("shared prompt fragments", () => {
  it("names both memory tools so either runtime knows how to recall", () => {
    expect(MEMORY_RECALL_INSTRUCTIONS).toContain("memory_search");
    expect(MEMORY_RECALL_INSTRUCTIONS).toContain("memory_get");
  });

  it("reads a valid caveman level from channel settings", () => {
    for (const level of CAVEMAN_LEVELS) {
      expect(getCavemanLevel(config({ cavemanLevel: level }))).toBe(level);
    }
  });

  it("ignores a missing or bogus caveman level", () => {
    expect(getCavemanLevel(undefined)).toBeUndefined();
    expect(getCavemanLevel(config({}))).toBeUndefined();
    expect(getCavemanLevel(config({ cavemanLevel: "shouty" }))).toBeUndefined();
    expect(getCavemanLevel(config({ cavemanLevel: 3 }))).toBeUndefined();
  });

  it("names the level and the skill in the caveman instructions", () => {
    const text = buildCavemanInstructions("ultra");
    expect(text).toContain("ultra");
    expect(text).toContain("caveman-speak");
  });

  it("is the single definition — the main agent imports rather than copies", () => {
    expect(agentSrc).toContain('from "../shared/prompt-fragments.js"');
    // A second literal `## Memory` heading here would mean the copy came back.
    expect(agentSrc).not.toContain("const MEMORY_RECALL_INSTRUCTIONS = ");
    expect(agentSrc).not.toContain("function buildCavemanInstructions");
  });
});

// ---------------------------------------------------------------------------
// Pilot prompt wiring
// ---------------------------------------------------------------------------

describe("pilot system prompt", () => {
  it("injects soul and the shared memory instructions", () => {
    expect(sessionSrc).toContain("this.buildIdentityPrompt()");
    expect(sessionSrc).toContain("getSoul()");
    expect(sessionSrc).toContain("MEMORY_RECALL_INSTRUCTIONS");
  });

  it("honours the channel's caveman level", () => {
    expect(sessionSrc).toContain("this.buildCavemanPrompt()");
    // Read through channelSettings() so a thread session picks up the level set
    // on its parent channel, which is where /caveman writes it.
    expect(sessionSrc).toMatch(/channelSettings\(\(config\) => getCavemanLevel\(config\)\)/);
  });

  it("records pilot turn failures as reflection signals", () => {
    expect(sessionSrc).toContain('source: "pilot"');
    expect(sessionSrc).toContain("recordSignal({");
  });
});

// ---------------------------------------------------------------------------
// Bridged context tools
// ---------------------------------------------------------------------------

describe("pilot context tools", () => {
  const CONTEXT_TOOLS = [
    "get_channel_history",
    "create_thread",
    "get_conversation_history",
    "get_conversation_stats",
  ];

  it("exposes the main agent's history and thread tools", () => {
    for (const name of CONTEXT_TOOLS) {
      expect(bridgeSrc).toContain(`tool(\n        "${name}"`);
    }
  });

  it("defaults channel-scoped tools to the pilot channel", () => {
    // Both take channel_id optionally; a pilot session that omits it must hit
    // its own channel, not fail or guess.
    expect(bridgeSrc).toContain("args.channel_id ?? channelId");
    expect(bridgeSrc).toContain('runDiscordTool("get_channel_history"');
    expect(bridgeSrc).toContain('runDiscordTool("create_thread"');
  });

  it("reuses the shared conversation-history handler", () => {
    expect(bridgeSrc).toContain(
      'from "../shared/conversation-history.js"',
    );
    expect(bridgeSrc).toContain('runHistoryTool("get_conversation_history"');
    expect(bridgeSrc).toContain('runHistoryTool("get_conversation_stats"');
  });
});
