// ---------------------------------------------------------------------------
// Pilot mode — outbound relay behaviour
//
// Covers the send queue (coalescing, ordering, throttling, flush-on-close) and
// the session's relay of SDK messages into channel lines: the usage footer,
// failed tool results, and the live user-id getter handed to the MCP bridge.
//
// Nothing here spawns an SDK child process: the session's private relay() is
// driven with fabricated SDK messages and a fake channel target.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { PilotRelayQueue } from "../../src/pilot/relay-queue.js";
import { PilotSession } from "../../src/pilot/session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecorder() {
  const sent: string[] = [];
  return {
    sent,
    send: async (text: string) => {
      sent.push(text);
    },
  };
}

/** A fake clock + sleep so throttling is deterministic. */
function makeClock() {
  let now = 1_000;
  const waits: number[] = [];
  return {
    waits,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
  };
}

interface SessionInternals {
  relay: (message: unknown) => Promise<void>;
  outbound: PilotRelayQueue;
  lastUserId: string | undefined;
  currentUserId: () => string | undefined;
}

function makeSession(id: string) {
  const recorder = makeRecorder();
  const session = new PilotSession({ id, send: recorder.send });
  return {
    session,
    sent: recorder.sent,
    internals: session as unknown as SessionInternals,
  };
}

// ---------------------------------------------------------------------------
// Send queue
// ---------------------------------------------------------------------------

describe("PilotRelayQueue", () => {
  it("merges consecutive progress lines into one message", async () => {
    const { sent, send } = makeRecorder();
    const queue = new PilotRelayQueue({ send, debounceMs: 10_000 });

    queue.pushCoalescing("-# a");
    queue.pushCoalescing("-# b");
    queue.pushCoalescing("-# c");
    await queue.flush();

    expect(sent).toEqual(["-# a\n-# b\n-# c"]);
  });

  it("keeps a prompt line separate but in order", async () => {
    const { sent, send } = makeRecorder();
    const queue = new PilotRelayQueue({ send, debounceMs: 10_000 });

    queue.pushCoalescing("-# tool one");
    queue.pushCoalescing("-# tool two");
    queue.push("here is the answer");
    await queue.flush();

    expect(sent).toEqual(["-# tool one\n-# tool two", "here is the answer"]);
  });

  it("starts a new batch rather than exceeding the merge cap", async () => {
    const { sent, send } = makeRecorder();
    const queue = new PilotRelayQueue({
      send,
      debounceMs: 10_000,
      maxMergedChars: 12,
    });

    queue.pushCoalescing("aaaaa");
    queue.pushCoalescing("bbbbb");
    queue.pushCoalescing("ccccc");
    await queue.flush();

    expect(sent).toEqual(["aaaaa\nbbbbb", "ccccc"]);
  });

  it("waits instead of exceeding the per-window send cap", async () => {
    const { sent, send } = makeRecorder();
    const clock = makeClock();
    const queue = new PilotRelayQueue({
      send,
      debounceMs: 10_000,
      maxSendsPerWindow: 2,
      windowMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    queue.push("one");
    queue.push("two");
    queue.push("three");
    await queue.flush();

    expect(sent).toEqual(["one", "two", "three"]);
    // Only the third send has to wait, and only for the rest of the window.
    expect(clock.waits).toEqual([5_000]);
  });

  it("does not wait when sends are spread across windows", async () => {
    const { send } = makeRecorder();
    const clock = makeClock();
    const queue = new PilotRelayQueue({
      send,
      debounceMs: 10_000,
      maxSendsPerWindow: 2,
      windowMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    queue.push("one");
    await queue.flush();
    clock.advance(6_000);
    queue.push("two");
    queue.push("three");
    await queue.flush();

    expect(clock.waits).toEqual([]);
  });

  it("flushes what is buffered when closed", async () => {
    const { sent, send } = makeRecorder();
    const queue = new PilotRelayQueue({ send, debounceMs: 10_000 });

    queue.pushCoalescing("-# tail of the turn");
    await queue.close();

    expect(sent).toEqual(["-# tail of the turn"]);
    // Closed queues drop further work rather than throwing.
    queue.push("after close");
    await queue.flush();
    expect(sent).toEqual(["-# tail of the turn"]);
  });

  it("reports a failed send and keeps draining", async () => {
    const sent: string[] = [];
    const errors: unknown[] = [];
    const queue = new PilotRelayQueue({
      send: async (text) => {
        if (text === "boom") throw new Error("429");
        sent.push(text);
      },
      debounceMs: 10_000,
      onError: (err) => errors.push(err),
    });

    queue.push("boom");
    queue.push("still here");
    await queue.flush();

    expect(sent).toEqual(["still here"]);
    expect(errors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Session relay
// ---------------------------------------------------------------------------

describe("pilot session relay", () => {
  it("relays assistant text as its own message", async () => {
    const { sent, internals } = makeSession("chan-relay-1");

    await internals.relay({
      type: "assistant",
      message: { content: [{ type: "text", text: "  hello  " }] },
    });
    await internals.outbound.flush();

    expect(sent).toEqual(["hello"]);
  });

  it("posts a usage footer with the per-turn cost delta", async () => {
    const { sent, internals } = makeSession("chan-relay-2");

    const result = (totalCost: number) => ({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 8_400,
      total_cost_usd: totalCost,
      usage: {
        input_tokens: 1_200,
        output_tokens: 800,
        cache_read_input_tokens: 20_000,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {
        "claude-opus-5": { outputTokens: 800 },
        "claude-haiku-4-5": { outputTokens: 10 },
      },
    });

    await internals.relay(result(0.01));
    await internals.outbound.flush();
    await internals.relay(result(0.03));
    await internals.outbound.flush();

    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("📊 claude-opus-5");
    expect(sent[0]).toContain("21.2k in (20.0k cached) / 800 out");
    expect(sent[0]).toContain("$0.0100");
    expect(sent[0]).toContain("8.4s");
    // total_cost_usd is cumulative across a streaming session, so the second
    // turn must show the difference, not the running total.
    expect(sent[1]).toContain("$0.0200");
  });

  it("omits the footer when the result carries no usage", async () => {
    const { sent, internals } = makeSession("chan-relay-3");

    await internals.relay({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 10,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    await internals.outbound.flush();

    expect(sent).toEqual([]);
  });

  it("surfaces a failed tool result, labelled with the tool that failed", async () => {
    const { sent, internals } = makeSession("chan-relay-4");

    await internals.relay({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls /nope" } },
        ],
      },
    });
    await internals.relay({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            is_error: true,
            content: [{ type: "text", text: "ls: /nope:\n  No such file or directory" }],
          },
        ],
      },
    });
    await internals.outbound.flush();

    const joined = sent.join("\n");
    expect(joined).toContain("⚙️ **Bash**");
    expect(joined).toContain("⚠️ **Bash** failed · ls: /nope: No such file or directory");
  });

  it("ignores successful tool results", async () => {
    const { sent, internals } = makeSession("chan-relay-5");

    await internals.relay({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_9", content: "fine" },
        ],
      },
    });
    await internals.outbound.flush();

    expect(sent).toEqual([]);
  });

  it("hands the bridge a getter that tracks the current speaker", () => {
    const { internals } = makeSession("chan-relay-6");

    expect(internals.currentUserId()).toBeUndefined();
    internals.lastUserId = "user-a";
    expect(internals.currentUserId()).toBe("user-a");
    // The MCP server is built once per session, so this must keep following the
    // latest speaker rather than the first one.
    internals.lastUserId = "user-b";
    expect(internals.currentUserId()).toBe("user-b");
  });
});
