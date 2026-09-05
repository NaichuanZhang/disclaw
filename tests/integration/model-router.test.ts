/**
 * Integration Test: Model Router
 *
 * Covers src/shared/model-router.ts — the heuristic classifier, the judge
 * plumbing (injected, never the network) and the precedence rules that decide
 * whether the router is even consulted for a session.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

import { initDb, deleteConfig } from "../../src/db/index.js";
import { clearSelectedModel, setSelectedModel } from "../../src/shared/models.js";
import {
  AUTO_MODEL_VALUE,
  ROUTER_CONFIG_KEY,
  buildJudgePrompt,
  classifyHeuristic,
  enableAutoMode,
  getRouterModels,
  isAutoMode,
  isModelRouterEnabled,
  parseJudgeReply,
  planSessionModel,
  routeModel,
  setModelRouterEnabled,
  modelFamilyEmoji,
  shortModelName,
} from "../../src/shared/model-router.js";

const ENV_KEYS = [
  "SDK_ANTHROPIC_MODEL",
  "PILOT_ANTHROPIC_MODEL",
  "ROUTER_MODEL_CODING",
  "ROUTER_MODEL_COMMON",
  "ROUTER_MODEL_JUDGE",
  "ROUTER_BIAS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  initDb();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  clearSelectedModel();
  deleteConfig(ROUTER_CONFIG_KEY);
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  clearSelectedModel();
  deleteConfig(ROUTER_CONFIG_KEY);
});

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

describe("classifyHeuristic", () => {
  it("routes obvious code to coding", () => {
    expect(classifyHeuristic("why does this throw?\n```ts\nconst x: number = 'a'\n```").verdict).toBe("coding");
    expect(classifyHeuristic("look at src/bot/messages.ts line 40").verdict).toBe("coding");
    expect(classifyHeuristic("TypeError: Cannot read properties of undefined").verdict).toBe("coding");
    expect(classifyHeuristic("fix the bug in the parser").verdict).toBe("coding");
    expect(classifyHeuristic("write a script that renames files").verdict).toBe("coding");
  });

  it("routes chat to common", () => {
    expect(classifyHeuristic("hey how's it going").verdict).toBe("common");
    expect(classifyHeuristic("remind me to call mom tomorrow at 5").verdict).toBe("common");
    expect(classifyHeuristic("what's a good recipe for dinner tonight").verdict).toBe("common");
    expect(classifyHeuristic("logged: chicken rice bowl, 650 kcal").verdict).toBe("common");
  });

  it("marks a single weak signal ambiguous, two as coding", () => {
    expect(classifyHeuristic("how do I set up a cron for this").verdict).toBe("ambiguous");
    expect(classifyHeuristic("how do I set up a cron in docker").verdict).toBe("coding");
  });

  it("lets the strong bias resolve ambiguity without a judge", () => {
    expect(classifyHeuristic("how do I set up a cron for this", { bias: "strong" }).verdict).toBe("coding");
  });

  it("detects a request for a stronger model, and it beats coding signals", () => {
    const r = classifyHeuristic("use a smarter model for this please");
    expect(r.verdict).toBe("escalate");
    expect(r.hits[0]).toMatch(/^escalate:/);
    expect(classifyHeuristic("switch to opus and fix `foo()` in `bar.ts`").verdict).toBe("escalate");
    expect(classifyHeuristic("think harder about this").verdict).toBe("escalate");
  });

  it("treats a code attachment as a coding signal", () => {
    expect(classifyHeuristic("what does this do", { attachmentNames: ["main.py"] }).verdict).toBe("coding");
    expect(classifyHeuristic("what does this do", { attachmentNames: ["photo.jpg"] }).verdict).toBe("common");
  });

  it("does not throw on empty input", () => {
    expect(classifyHeuristic("").verdict).toBe("common");
  });
});

// ---------------------------------------------------------------------------
// Judge plumbing
// ---------------------------------------------------------------------------

describe("judge", () => {
  it("parses a tier out of a chatty reply", () => {
    expect(parseJudgeReply("coding")).toBe("coding");
    expect(parseJudgeReply("I'd say: Common.")).toBe("common");
    expect(parseJudgeReply("neither")).toBeUndefined();
  });

  it("puts the bias hint in the prompt", () => {
    expect(buildJudgePrompt("cheap")).toContain("prefer common");
    expect(buildJudgePrompt("strong")).toContain("prefer coding");
  });

  it("is only consulted for ambiguous text", async () => {
    let calls = 0;
    const judge = async () => {
      calls++;
      return "coding";
    };
    await routeModel("hello there", { judge });
    await routeModel("fix the bug in `x`", { judge });
    expect(calls).toBe(0);
    const d = await routeModel("how do I set up a cron for this", { judge });
    expect(calls).toBe(1);
    expect(d.source).toBe("judge");
    expect(d.tier).toBe("coding");
    expect(d.judgeMs).toBeGreaterThanOrEqual(0);
  });

  it("falls back along the bias when the judge fails", async () => {
    const judge = async () => {
      throw new Error("timeout");
    };
    const balanced = await routeModel("how do I set up a cron for this", { judge, bias: "balanced" });
    expect(balanced.source).toBe("judge_fallback");
    expect(balanced.tier).toBe("common");
    expect(balanced.judgeError).toBe("timeout");
    const strong = await routeModel("how do I set up a cron for this", { judge, bias: "strong" });
    expect(strong.tier).toBe("coding");
  });

  it("escalation goes straight to the coding tier", async () => {
    const d = await routeModel("use the smartest model", { judge: async () => "common" });
    expect(d.escalated).toBe(true);
    expect(d.tier).toBe("coding");
    expect(d.model).toBe(getRouterModels().coding);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("reads tier models from env with sane defaults", () => {
    expect(getRouterModels()).toEqual({
      coding: "bedrock-claude-fable-5-1",
      common: "bedrock-claude-sonnet-5",
      judge: "bedrock-claude-sonnet-5",
    });
    process.env.ROUTER_MODEL_CODING = "bedrock-claude-opus-5-1m";
    expect(getRouterModels().coding).toBe("bedrock-claude-opus-5-1m");
  });

  it("is on by default and toggles through config", () => {
    expect(isModelRouterEnabled()).toBe(true);
    setModelRouterEnabled(false);
    expect(isModelRouterEnabled()).toBe(false);
    setModelRouterEnabled(true);
    expect(isModelRouterEnabled()).toBe(true);
  });

  it("reports auto mode only when the router is genuinely in charge", () => {
    expect(AUTO_MODEL_VALUE).toBe("auto");
    expect(isAutoMode()).toBe(true);

    setSelectedModel("bedrock-claude-opus-5-1m");
    expect(isAutoMode()).toBe(false);
    clearSelectedModel();

    setModelRouterEnabled(false);
    expect(isAutoMode()).toBe(false);
    setModelRouterEnabled(true);

    process.env.SDK_ANTHROPIC_MODEL = "bedrock-claude-opus-5-1m";
    expect(isAutoMode()).toBe(false);
    delete process.env.SDK_ANTHROPIC_MODEL;
    expect(isAutoMode()).toBe(true);
  });

  it("enableAutoMode clears the pin and switches routing on together", async () => {
    setSelectedModel("bedrock-claude-opus-5-1m");
    setModelRouterEnabled(false);
    expect(isAutoMode()).toBe(false);

    enableAutoMode();
    expect(isAutoMode()).toBe(true);
    expect(isModelRouterEnabled()).toBe(true);

    const plan = await planSessionModel({
      channelId: "t-auto",
      hasLiveSession: false,
      judge: async () => "common",
      text: "fix the bug in `x`",
    });
    expect(plan.action).toBe("route");
  });

  it("shortens model ids for the channel line", () => {
    expect(shortModelName("bedrock-claude-fable-5-1")).toBe("fable-5-1");
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe("haiku-4-5-20251001");
  });
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe("modelFamilyEmoji", () => {
  it("maps each family to one glyph, keyed on the handshake-reported id", () => {
    expect(modelFamilyEmoji("bedrock-claude-fable-5-1")).toBe("🟣");
    expect(modelFamilyEmoji("claude-mythos-5")).toBe("🟣");
    expect(modelFamilyEmoji("bedrock-claude-opus-5-1m")).toBe("🔵");
    expect(modelFamilyEmoji("bedrock-claude-sonnet-5")).toBe("🟢");
    expect(modelFamilyEmoji("claude-haiku-4-5-20251001")).toBe("⚪");
    expect(modelFamilyEmoji("gpt-5")).toBe("⚫");
  });

  it("is honest about an unknown model rather than guessing", () => {
    expect(modelFamilyEmoji(null)).toBe("❔");
    expect(modelFamilyEmoji(undefined)).toBe("❔");
    expect(modelFamilyEmoji("")).toBe("❔");
  });
});

describe("planSessionModel", () => {
  const base = { channelId: "t1", hasLiveSession: false, judge: async () => "common" };

  it("routes a fresh session", async () => {
    const plan = await planSessionModel({ ...base, text: "fix the bug in `x`" });
    expect(plan.action).toBe("route");
    if (plan.action === "route") expect(plan.decision.model).toBe(getRouterModels().coding);
  });

  it("stands down for the SDK env pin", async () => {
    process.env.SDK_ANTHROPIC_MODEL = "bedrock-claude-opus-5-1m";
    expect(await planSessionModel({ ...base, text: "fix the bug" })).toEqual({
      action: "skip",
      reason: "sdk_env_pin",
    });
  });

  it("stands down for a /model selection", async () => {
    setSelectedModel("bedrock-claude-opus-5-1m");
    expect(await planSessionModel({ ...base, text: "fix the bug" })).toEqual({
      action: "skip",
      reason: "model_pin",
    });
  });

  it("stands down when switched off", async () => {
    setModelRouterEnabled(false);
    expect(await planSessionModel({ ...base, text: "fix the bug" })).toEqual({
      action: "skip",
      reason: "disabled",
    });
  });

  it("leaves a live session alone unless asked for a stronger model", async () => {
    expect(await planSessionModel({ ...base, hasLiveSession: true, text: "fix the bug" })).toEqual({
      action: "skip",
      reason: "live_session",
    });
    const plan = await planSessionModel({
      ...base,
      hasLiveSession: true,
      text: "use a better model for this",
    });
    expect(plan.action).toBe("escalate_restart");
    if (plan.action === "escalate_restart") expect(plan.decision.model).toBe(getRouterModels().coding);
  });

  it("skips empty text", async () => {
    expect(await planSessionModel({ ...base, text: "   " })).toEqual({ action: "skip", reason: "empty" });
  });
});
