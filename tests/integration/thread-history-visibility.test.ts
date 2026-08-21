/**
 * Integration Test: thread history visibility + /clear cutoff
 *
 * Covers the contract between the two independent history readers:
 *   - bot/thread-history.ts assembles the history injected into the prompt
 *   - agent/tools.ts get_channel_history is the fallback that hits Discord
 *
 * The model can only treat the tool as a fallback if it can see how much
 * history it already has, and the tool can only be safe if it honours /clear.
 */

import { describe, it, expect } from "vitest";

type DbMessageLike = {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  discordMessageId?: string;
};

function msg(
  id: string,
  content: string,
  createdAt: number,
): DbMessageLike {
  return {
    id,
    sessionId: "s1",
    role: "user",
    content,
    createdAt,
    discordMessageId: id,
  };
}

describe("thread history clear cutoff", () => {
  it("reports null for a thread that was never cleared", async () => {
    const { getThreadClearCutoff } = await import(
      "../../src/bot/thread-history.js"
    );
    expect(getThreadClearCutoff(`never-cleared-${Date.now()}`)).toBeNull();
  });

  it("reports a timestamp after /clear so other readers can filter", async () => {
    const { clearThreadHistoryCache, getThreadClearCutoff } = await import(
      "../../src/bot/thread-history.js"
    );
    const threadId = `cleared-${Date.now()}`;
    const before = Date.now();

    clearThreadHistoryCache(threadId);

    const cutoff = getThreadClearCutoff(threadId);
    expect(cutoff).not.toBeNull();
    expect(cutoff as number).toBeGreaterThanOrEqual(before);
  });

  it("drops messages older than the cutoff from the assembled history", async () => {
    const { clearThreadHistoryCache, buildThreadHistory, getThreadClearCutoff } =
      await import("../../src/bot/thread-history.js");
    const threadId = `filtered-${Date.now()}`;

    clearThreadHistoryCache(threadId);
    const cutoff = getThreadClearCutoff(threadId) as number;

    const history = buildThreadHistory({
      threadId,
      discordHistory: [
        msg("old-1", "before the clear", cutoff - 10_000),
        msg("new-1", "after the clear", cutoff + 10_000),
      ] as never,
    });

    const contents = history.map((m) => m.content);
    expect(contents).toContain("after the clear");
    expect(contents).not.toContain("before the clear");
  });
});

describe("get_channel_history tool definition", () => {
  it("is described as a fallback, not the default way to read history", async () => {
    const { discordTools } = await import("../../src/agent/tools.js");
    const tool = discordTools.find((t) => t.name === "get_channel_history");

    expect(tool).toBeDefined();
    const description = (tool as { description: string }).description;
    expect(description).toMatch(/FALLBACK/);
    // Must point the model at the in-context count rather than blind fetching.
    expect(description).toMatch(/already in your context/i);
  });
});
