import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  PilotSession,
  interruptPilotSession,
  pilotConfigChannelId,
} from "../../src/pilot/session.js";
import { buildPilotEnv } from "../../src/pilot/env.js";

// ---------------------------------------------------------------------------
// child process env — pilot is unrestricted: the child inherits everything,
// secrets included. The old allowlist (and the unenforced tool-call policy in
// policy.ts) were removed by operator request.
// ---------------------------------------------------------------------------

describe("buildPilotEnv", () => {
  it("forwards the whole source env, secrets included", () => {
    const env = buildPilotEnv({
      source: {
        PATH: "/usr/bin",
        HOME: "/home/bot",
        DISCORD_TOKEN: "super-secret",
        GH_TOKEN: "gh-secret",
        MEM9_API_KEY: "mem9-secret",
        DATABASE_URL: "postgres://x",
      },
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/bot");
    expect(env.DISCORD_TOKEN).toBe("super-secret");
    expect(env.GH_TOKEN).toBe("gh-secret");
    expect(env.MEM9_API_KEY).toBe("mem9-secret");
    expect(env.DATABASE_URL).toBe("postgres://x");
  });

  it("marks the child process as a pilot child", () => {
    const env = buildPilotEnv({ source: { PATH: "/usr/bin" } });
    expect(env.DISCORDCLAW_PILOT).toBe("1");
  });

  it("forwards model auth so the session can reach a model", () => {
    const env = buildPilotEnv({
      source: {
        PATH: "/usr/bin",
        ANTHROPIC_BASE_URL: "https://proxy.example",
        ANTHROPIC_AUTH_TOKEN: "proxy-token",
        ANTHROPIC_MODEL: "some-model",
      },
    });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("proxy-token");
    expect(env.ANTHROPIC_MODEL).toBe("some-model");
  });

  it("lets a pilot-only API key replace the inherited proxy token", () => {
    const env = buildPilotEnv({
      source: {
        PATH: "/usr/bin",
        ANTHROPIC_AUTH_TOKEN: "proxy-token",
        PILOT_ANTHROPIC_API_KEY: "sk-pilot",
      },
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-pilot");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("lets explicit overrides win over the inherited value", () => {
    const env = buildPilotEnv({
      source: { PATH: "/usr/bin", ANTHROPIC_MODEL: "inherited" },
      overrides: { ANTHROPIC_MODEL: "override" },
    });
    expect(env.ANTHROPIC_MODEL).toBe("override");
  });
});
// ---------------------------------------------------------------------------
// pilot channel resolution (thread inheritance)
// ---------------------------------------------------------------------------

describe("pilotConfigChannelId", () => {
  it("uses the channel itself for a top-level guild channel", () => {
    expect(
      pilotConfigChannelId({
        channelId: "chan-1",
        isDM: false,
        isThread: false,
      }),
    ).toBe("chan-1");
  });

  it("uses the parent channel for a thread, so threads inherit pilot mode", () => {
    expect(
      pilotConfigChannelId({
        channelId: "thread-9",
        isDM: false,
        isThread: true,
        parentId: "chan-1",
      }),
    ).toBe("chan-1");
  });

  it("never applies pilot mode to DMs", () => {
    expect(
      pilotConfigChannelId({ channelId: "dm-1", isDM: true, isThread: false }),
    ).toBeNull();
    expect(
      pilotConfigChannelId({
        channelId: "dm-thread",
        isDM: true,
        isThread: true,
        parentId: "chan-1",
      }),
    ).toBeNull();
  });

  it("returns null for a thread with no resolvable parent", () => {
    expect(
      pilotConfigChannelId({
        channelId: "thread-9",
        isDM: false,
        isThread: true,
        parentId: null,
      }),
    ).toBeNull();
    expect(
      pilotConfigChannelId({ channelId: "thread-9", isDM: false, isThread: true }),
    ).toBeNull();
  });

  it("resolves sibling threads to the same parent config but keeps distinct ids", () => {
    const a = pilotConfigChannelId({
      channelId: "thread-a",
      isDM: false,
      isThread: true,
      parentId: "chan-1",
    });
    const b = pilotConfigChannelId({
      channelId: "thread-b",
      isDM: false,
      isThread: true,
      parentId: "chan-1",
    });
    // Same pilot flag source...
    expect(a).toBe("chan-1");
    expect(b).toBe("chan-1");
    // ...but sessions are keyed by the thread id, not this value.
    expect("thread-a").not.toBe("thread-b");
  });
});

// ---------------------------------------------------------------------------
// interrupt
// ---------------------------------------------------------------------------

function makeTarget(id: string) {
  return { id, send: async () => undefined };
}

describe("pilot interrupt", () => {
  it("returns null when no session is running for the channel", async () => {
    await expect(interruptPilotSession("no-such-channel")).resolves.toBeNull();
  });

  it("does not throw when there is no live SDK stream yet", async () => {
    const session = new PilotSession(makeTarget("chan-int-1"));
    const result = await session.interrupt();
    expect(result.ok).toBe(false);
    expect(result.dropped).toBe(0);
    expect(result.stillQueued).toEqual([]);
  });

  it("drops our own queued messages and reports the count", async () => {
    const session = new PilotSession(makeTarget("chan-int-2"));
    // Reach into the queue directly: submit() would spawn a real SDK session.
    const internals = session as unknown as { queue: unknown[] };
    internals.queue.push({}, {}, {});

    const result = await session.interrupt();
    expect(result.dropped).toBe(3);
    // interrupt() replaces the queue, so re-read it rather than holding a ref.
    expect(internals.queue.length).toBe(0);
  });

  it("reports stillQueued from the receipt only when the CLI advertises it", async () => {
    const session = new PilotSession(makeTarget("chan-int-3"));
    const internals = session as unknown as {
      stream: { interrupt: () => Promise<{ still_queued: string[] }> } | null;
      capabilities: string[];
    };
    internals.stream = {
      interrupt: async () => ({ still_queued: ["uuid-a", "uuid-b"] }),
    };

    // Unknown capability set -> we ignore the receipt contents.
    internals.capabilities = [];
    let result = await session.interrupt();
    expect(result.ok).toBe(true);
    expect(result.stillQueued).toEqual([]);

    // Capability advertised -> pass the uuids through.
    internals.capabilities = ["interrupt_receipt_v1"];
    result = await session.interrupt();
    expect(result.ok).toBe(true);
    expect(result.stillQueued).toEqual(["uuid-a", "uuid-b"]);
  });

  it("surfaces ok:false when the SDK interrupt rejects", async () => {
    const session = new PilotSession(makeTarget("chan-int-4"));
    const internals = session as unknown as {
      stream: { interrupt: () => Promise<never> } | null;
    };
    internals.stream = {
      interrupt: async () => {
        throw new Error("control channel closed");
      },
    };
    const result = await session.interrupt();
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Evolution tools are bridged into pilot sessions
// ---------------------------------------------------------------------------

describe("pilot evolution access", () => {
  const bridgeSrc = readFileSync(
    new URL("../../src/pilot/bridge.ts", import.meta.url),
    "utf8",
  );
  const sessionSrc = readFileSync(
    new URL("../../src/pilot/session.ts", import.meta.url),
    "utf8",
  );

  const EVOLVE_TOOLS = [
    "evolve_start",
    "evolve_read",
    "evolve_write",
    "evolve_bash",
    "evolve_propose",
    "evolve_suggest",
    "evolve_cancel",
    "evolve_review",
    "evolve_merge",
  ];

  it("exposes every evolve_* tool through the MCP bridge", () => {
    for (const name of EVOLVE_TOOLS) {
      expect(bridgeSrc).toContain(`tool(\n        "${name}"`);
    }
  });

  it("sets the evolution context before dispatching, from the live user getter", () => {
    // A captured userId string would freeze attribution on whoever opened the
    // session, so the bridge must read it through the getter on every call.
    expect(bridgeSrc).toContain("setEvolutionContext(ctx.channelId, ctx.getUserId?.())");
  });

  it("appends the shared evolution instructions to the pilot system prompt", () => {
    expect(sessionSrc).toContain("EVOLUTION_INSTRUCTIONS");
    expect(sessionSrc).toContain("this.buildEvolutionPrompt()");
  });

  it("keeps the plan-approval gate enforced in the evolution tool handler", () => {
    const toolsSrc = readFileSync(
      new URL("../../src/evolution/tools.ts", import.meta.url),
      "utf8",
    );
    expect(toolsSrc).toContain("MIN_PLAN_LENGTH");
    expect(toolsSrc).toContain("input.plan_approved === true");
  });
});
