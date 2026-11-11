// ---------------------------------------------------------------------------
// Editable relay messages (the subagent board)
//
// First send goes through the ordered, throttled chain; later edits are
// coalesced to one per interval with the latest payload winning; flush()
// cuts the wait short; a failed edit falls back to one fresh send.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { SdkRelayQueue } from "../../src/sdk/relay-queue.js";
import { SdkSession } from "../../src/sdk/session.js";

interface Log {
  events: Array<{ op: "text" | "send" | "edit"; value: unknown }>;
}

function makeChannel(opts: { failEdits?: boolean; failSends?: number } = {}) {
  const log: Log = { events: [] };
  let sendFailures = opts.failSends ?? 0;
  let nextId = 1;
  return {
    log,
    send: async (text: string) => {
      log.events.push({ op: "text", value: text });
    },
    sendPayload: async (payload: unknown) => {
      if (sendFailures > 0) {
        sendFailures -= 1;
        throw new Error("send failed");
      }
      log.events.push({ op: "send", value: payload });
      return { id: nextId++ };
    },
    editPayload: async (message: unknown, payload: unknown) => {
      if (opts.failEdits) throw new Error("Unknown Message");
      log.events.push({ op: "edit", value: { id: (message as { id: number }).id, payload } });
    },
  };
}

function makeClock() {
  let now = 1_000;
  const waits: number[] = [];
  return {
    waits,
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const never = () => new Promise<void>(() => {});

describe("SdkRelayQueue.pushEditable", () => {
  it("sends first in order with text, then coalesces edits to one per interval", async () => {
    const ch = makeChannel();
    const clock = makeClock();
    const errors: unknown[] = [];
    const queue = new SdkRelayQueue({
      ...ch,
      editIntervalMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
      onError: (e) => errors.push(e),
    });

    queue.push("before");
    const board = queue.pushEditable("v0");
    queue.push("after");
    board.update("v1");
    board.update("v2");
    board.update("v3");
    for (let i = 0; i < 5; i++) await settle();

    expect(ch.log.events).toEqual([
      { op: "text", value: "before" },
      { op: "send", value: "v0" },
      { op: "text", value: "after" },
      { op: "edit", value: { id: 1, payload: "v3" } },
    ]);
    expect(clock.waits).toContain(5_000);

    board.update("v4");
    for (let i = 0; i < 5; i++) await settle();
    expect(ch.log.events.at(-1)).toEqual({ op: "edit", value: { id: 1, payload: "v4" } });
    // Two edits, each held to the interval.
    expect(clock.waits.filter((w) => w === 5_000).length).toBe(2);
    expect(errors).toEqual([]);
  });

  it("flush() pushes the latest payload out without waiting the interval", async () => {
    const ch = makeChannel();
    const queue = new SdkRelayQueue({ ...ch, editIntervalMs: 5_000, sleep: never });

    const board = queue.pushEditable("v0");
    board.update("v1");
    board.update("v2");
    await queue.flush();

    expect(ch.log.events).toEqual([
      { op: "send", value: "v0" },
      { op: "edit", value: { id: 1, payload: "v2" } },
    ]);
  });

  it("finalize() applies its payload immediately and stops further edits", async () => {
    const ch = makeChannel();
    const queue = new SdkRelayQueue({ ...ch, sleep: never });

    const board = queue.pushEditable("v0");
    await board.finalize("final");
    board.update("ignored");
    await queue.flush();

    expect(ch.log.events).toEqual([
      { op: "send", value: "v0" },
      { op: "edit", value: { id: 1, payload: "final" } },
    ]);
  });

  it("falls back to one fresh send when edits fail, and never throws", async () => {
    const ch = makeChannel({ failEdits: true });
    const errors: unknown[] = [];
    const queue = new SdkRelayQueue({ ...ch, sleep: never, onError: (e) => errors.push(e) });

    const board = queue.pushEditable("v0");
    board.update("v1");
    await queue.flush();
    board.update("v2");
    await queue.flush();
    board.update("v3");
    await queue.flush();

    expect(ch.log.events).toEqual([
      { op: "send", value: "v0" },
      { op: "send", value: "v1" },
    ]);
    expect(errors.length).toBe(3);
  });

  it("a failed first send also gets exactly one retry on the next update", async () => {
    const ch = makeChannel({ failSends: 1 });
    const queue = new SdkRelayQueue({ ...ch, sleep: never, onError: () => {} });

    const board = queue.pushEditable("v0");
    board.update("v1");
    await queue.flush();
    board.update("v2");
    await queue.flush();

    expect(ch.log.events).toEqual([
      { op: "send", value: "v1" },
      { op: "edit", value: { id: 1, payload: "v2" } },
    ]);
  });

  it("is a no-op handle without a payload sender, and after close", async () => {
    const ch = makeChannel();
    const textOnly = new SdkRelayQueue({ send: ch.send });
    const handle = textOnly.pushEditable("x");
    handle.update("y");
    await handle.finalize();

    const queue = new SdkRelayQueue({ ...ch, sleep: never });
    await queue.close();
    queue.pushEditable("z").update("zz");
    await queue.flush();
    expect(ch.log.events).toEqual([]);
  });

  it("close() flushes a pending edit", async () => {
    const ch = makeChannel();
    const queue = new SdkRelayQueue({ ...ch, sleep: never });
    const board = queue.pushEditable("v0");
    board.update("v1");
    await queue.close();
    expect(ch.log.events.at(-1)).toEqual({ op: "edit", value: { id: 1, payload: "v1" } });
  });
});

// ---------------------------------------------------------------------------
// Session wiring: task messages -> one board, footer report
// ---------------------------------------------------------------------------

interface SessionInternals {
  relay: (message: unknown) => Promise<void>;
  outbound: SdkRelayQueue;
}

function makeSession(id: string) {
  const sent: unknown[] = [];
  const edits: unknown[] = [];
  const target = {
    id,
    send: async (content: unknown) => {
      sent.push(content);
      return {
        edit: async (payload: unknown) => {
          edits.push(payload);
        },
      };
    },
  };
  const session = new SdkSession(target as never);
  return { session, sent, edits, internals: session as unknown as SessionInternals };
}

const started = (taskId: string, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  tool_use_id: `tu-${taskId}`,
  description: "Audit auth middleware",
  subagent_type: "Explore",
  task_type: "local_agent",
  ...extra,
});

describe("SdkSession subagent board", () => {
  it("posts one board per turn, edits it, and folds the tally into the footer", async () => {
    const { sent, edits, internals } = makeSession("board-1");
    await internals.relay(started("t1"));
    await internals.relay(started("t2", { description: "Read the router" }));
    await internals.relay(started("amb", { skip_transcript: true }));
    await internals.relay({
      type: "system",
      subtype: "task_progress",
      task_id: "t1",
      description: "Audit auth middleware",
      usage: { total_tokens: 1000, tool_uses: 2, duration_ms: 3000 },
      last_tool_name: "Read",
    });
    await internals.relay({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      status: "completed",
      output_file: "",
      summary: "ok",
      usage: { total_tokens: 34_000, tool_uses: 12, duration_ms: 41_000 },
    });
    await internals.relay({
      type: "system",
      subtype: "task_notification",
      task_id: "t2",
      status: "failed",
      output_file: "",
      summary: "boom",
    });
    await internals.relay({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.01,
      modelUsage: { "claude-x": { outputTokens: 5 } },
    });
    await internals.outbound.flush();

    const boards = sent.filter((m) => typeof m === "object");
    expect(boards.length).toBe(1);
    const last = edits.at(-1) as { embeds: Array<{ title: string; description: string }> };
    expect(last.embeds[0].title).toBe("Two subagents, 1 failed, 1 done");
    expect(last.embeds[0].description).not.toContain("amb");
    const footer = sent.find((m) => typeof m === "string" && m.startsWith("-# 📊")) as string;
    expect(footer).toContain("subagents: 2 (1 ✅ 1 ❌)");
  });

  it("marks a subagent blocked on ask_user as needing you, until it is answered", async () => {
    const { session, internals } = makeSession("board-2");
    await internals.relay(started("t1"));
    await internals.relay({
      type: "assistant",
      parent_tool_use_id: "tu-t1",
      message: { content: [{ type: "tool_use", id: "ask-1", name: "mcp__discordclaw__ask_user", input: {} }] },
    });
    expect(session.subagent("t1")?.status).toBe("needs_you");
    await internals.relay({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "ask-1", content: "yes" }] },
    });
    expect(session.subagent("t1")?.status).toBe("running");
    await session.stop();
  });

  it("stopSubagent reports not_running for unknown or finished tasks", async () => {
    const { session, internals } = makeSession("board-3");
    expect(await session.stopSubagent("nope")).toBe("not_running");
    await internals.relay(started("t1"));
    // No live query handle in a unit test, so a running task still can't be stopped.
    expect(await session.stopSubagent("t1")).toBe("not_running");
    await session.stop();
  });
});
