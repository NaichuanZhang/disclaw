// ---------------------------------------------------------------------------
// Session prompt and bridged tools
//
// The session builds its own system prompt and its own tool list, so pieces the
// rest of the bot relies on can quietly fall out of it. These tests pin the
// shared prompt fragments (exercised directly) and the wiring that consumes them
// (asserted against source, since building the real prompt would spawn an SDK
// child and touch the live DB).
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
  new URL("../../src/sdk/session.ts", import.meta.url),
  "utf8",
);
const bridgeSrc = readFileSync(
  new URL("../../src/sdk/bridge.ts", import.meta.url),
  "utf8",
);

function config(settings: Record<string, unknown>): ChannelConfig {
  return { channelId: "chan-1", settings } as unknown as ChannelConfig;
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

describe("shared prompt fragments", () => {
  it("names both memory tools so the session knows how to recall", () => {
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

  it("is the single definition — the session imports rather than copies", () => {
    expect(sessionSrc).toContain('from "../shared/prompt-fragments.js"');
    // A local copy of either would drift from what /caveman writes.
    expect(sessionSrc).not.toContain("const MEMORY_RECALL_INSTRUCTIONS = ");
    expect(sessionSrc).not.toContain("function buildCavemanInstructions");
  });
});

// ---------------------------------------------------------------------------
// Prompt wiring
// ---------------------------------------------------------------------------

describe("session system prompt", () => {
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

  it("records turn failures as reflection signals", () => {
    expect(sessionSrc).toContain("recordSignal({");
  });
});

// ---------------------------------------------------------------------------
// Bridged context tools
// ---------------------------------------------------------------------------

describe("bridged context tools", () => {
  const CONTEXT_TOOLS = [
    "get_channel_history",
    "create_thread",
    "get_conversation_history",
    "get_conversation_stats",
  ];

  it("exposes the history and thread tools", () => {
    for (const name of CONTEXT_TOOLS) {
      expect(bridgeSrc).toContain(`tool(\n        "${name}"`);
    }
  });

  it("defaults channel-scoped tools to the session's own channel", () => {
    // Both take channel_id optionally; a session that omits it must hit its own
    // channel, not fail or guess.
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
