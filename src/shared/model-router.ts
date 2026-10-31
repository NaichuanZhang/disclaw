// ---------------------------------------------------------------------------
// Model router — picks the model a new SDK session starts on
//
// An SDK child keeps its model for its whole life, so routing happens once, at
// the moment a session is created (in practice: the first message of a thread),
// and a mid-thread change means restarting the child on the same transcript.
// The decision itself is cheap: a regex pass covers the obvious cases, and a
// tiny LLM judge is consulted only when the text is genuinely ambiguous.
//
// Where this sits in model precedence (interactive sessions only — cron keeps
// its per-job override):
//   SDK_ANTHROPIC_MODEL pin > /model selection > router > ANTHROPIC_MODEL env
//   > DEFAULT_MODEL
// An explicit /model pick is a human decision, so the router stands down while
// one is set; /model reset or /model name:auto hands control back.
// ---------------------------------------------------------------------------

import { anthropicClient } from "./anthropic.js";
import { createLogger } from "../logging/logger.js";
import { getConfig, setConfig } from "../db/index.js";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import {
  FALLBACK_MODEL_IDS,
  clearSelectedModel,
  getCachedSelectableModelIds,
  getSelectedModel,
  pickByFamily,
  pickClosestModel,
} from "./models.js";
import { count } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

const log = createLogger("router");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Config-table key for the on/off switch. Absent means on. */
export const ROUTER_CONFIG_KEY = "model_router";

export type RouteTier = "coding" | "common";
export type RouterBias = "cheap" | "balanced" | "strong";

export interface RouterModels {
  coding: string;
  common: string;
  judge: string;
}

export type RouterTierKey = keyof RouterModels;

/**
 * Tiers are configured as model *families*; the concrete id is whatever the
 * endpoint's catalog lists newest for that family (see getRouterModels()).
 */
const DEFAULT_ROUTER_FAMILIES: Record<RouterTierKey, string> = {
  coding: "opus",
  common: "sonnet",
  judge: "haiku",
};

const FAMILY_ORDER: Record<RouterTierKey, readonly string[]> = {
  coding: ["opus", "sonnet", "haiku"],
  common: ["sonnet", "haiku", "opus"],
  judge: ["haiku", "sonnet", "opus"],
};

/** Text the judge sees for each tier. Kept as prose so it can be tuned without touching code paths. */
export const ROUTE_DESCRIPTIONS: Record<RouteTier, string> = {
  coding:
    "Software work: writing or reviewing code, debugging, stack traces, refactors, " +
    "architecture, shell/devops, data pipelines, anything where a wrong answer breaks a build. " +
    "Also multi-step research or analysis that needs careful reasoning.",
  common:
    "Everyday requests: chat, quick questions, reminders, summaries, translations, " +
    "recipes, scheduling, light writing, looking something up, logging a meal or a workout.",
};

function envValue(name: string): string | undefined {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export function getRouterFamilies(): Record<RouterTierKey, string> {
  return {
    coding: envValue("ROUTER_FAMILY_CODING")?.toLowerCase() ?? DEFAULT_ROUTER_FAMILIES.coding,
    common: envValue("ROUTER_FAMILY_COMMON")?.toLowerCase() ?? DEFAULT_ROUTER_FAMILIES.common,
    judge: envValue("ROUTER_FAMILY_JUDGE")?.toLowerCase() ?? DEFAULT_ROUTER_FAMILIES.judge,
  };
}

const warnedSubstitutions = new Set<string>();
function warnOnce(key: string, message: string, fields: Record<string, unknown>): void {
  if (warnedSubstitutions.has(key)) return;
  warnedSubstitutions.add(key);
  log.warn(message, fields);
}

/**
 * Resolve one tier to a concrete model id. Sync and never throws (it sits on
 * the message hot path), so it reads the cached catalog only; a cold cache
 * resolves against FALLBACK_MODEL_IDS until the boot-time warm lands.
 *
 * Order: an exact `ROUTER_MODEL_<TIER>` id if the catalog lists it → the
 * newest model of the tier's family → the closest family that exists.
 */
function resolveTierModel(tier: RouterTierKey, ids: readonly string[], cold: boolean): string {
  const override = envValue(`ROUTER_MODEL_${tier.toUpperCase()}`);
  if (override) {
    if (cold || ids.includes(override)) return override;
    warnOnce(`override:${tier}:${override}`, `ROUTER_MODEL_${tier.toUpperCase()}="${override}" is not in the endpoint catalog — resolving by family`, { tier });
  }
  const family = getRouterFamilies()[tier];
  const exact = pickByFamily(family, ids);
  if (exact) return exact;

  const order = [family, ...FAMILY_ORDER[tier].filter((f) => f !== family)];
  const near = pickClosestModel(undefined, ids, order);
  if (near) {
    warnOnce(`family:${tier}:${family}:${near}`, `no "${family}" model in the endpoint catalog for the ${tier} tier — using ${near}`, { tier, family });
    return near;
  }
  return override ?? FALLBACK_MODEL_IDS[0];
}

export function getRouterModels(): RouterModels {
  const live = getCachedSelectableModelIds();
  const cold = !live || live.length === 0;
  const ids = cold ? FALLBACK_MODEL_IDS : live;
  return {
    coding: resolveTierModel("coding", ids, cold),
    common: resolveTierModel("common", ids, cold),
    judge: resolveTierModel("judge", ids, cold),
  };
}

export function getRouterBias(): RouterBias {
  const v = envValue("ROUTER_BIAS")?.toLowerCase();
  return v === "cheap" || v === "strong" ? v : "balanced";
}

/** Never throws — the DB may not be initialised in a unit test. */
export function isModelRouterEnabled(): boolean {
  try {
    return getConfig(ROUTER_CONFIG_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setModelRouterEnabled(enabled: boolean): void {
  setConfig(ROUTER_CONFIG_KEY, enabled ? "on" : "off");
}

/** The operator pin that bypasses every model choice for SDK sessions. */
function sdkModelPin(): string | undefined {
  return envValue("SDK_ANTHROPIC_MODEL") ?? envValue("PILOT_ANTHROPIC_MODEL");
}

/** The `/model name:` value that means "let the router decide". */
export const AUTO_MODEL_VALUE = "auto";

/**
 * True when the router is actually in charge of new sessions: switched on,
 * no `/model` pin, no `SDK_ANTHROPIC_MODEL` pin. This is the single answer
 * `/model` and its autocomplete show as "auto", so it must agree with the
 * precedence walk in planSessionModel(). Never throws.
 */
export function isAutoMode(): boolean {
  try {
    return isModelRouterEnabled() && !getSelectedModel() && !sdkModelPin();
  } catch {
    return false;
  }
}

/**
 * Put the router in charge: clear the `/model` pin and switch routing on in
 * one step. An env pin is out of reach (it is the operator's), so the caller
 * should check isAutoMode() afterwards if it needs to promise anything.
 */
export function enableAutoMode(): void {
  clearSelectedModel();
  setModelRouterEnabled(true);
}

// ---------------------------------------------------------------------------
// Heuristics (pure)
// ---------------------------------------------------------------------------

export type HeuristicVerdict = RouteTier | "escalate" | "ambiguous";

export interface HeuristicResult {
  verdict: HeuristicVerdict;
  /** Names of the patterns that fired, for the log line. */
  hits: string[];
}

const CODE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|sh|zsh|bash|sql|json|ya?ml|toml|css|scss|html|vue|svelte|tf|dockerfile|ipynb";

/** Signals strong enough to route on their own. */
const STRONG_CODING: Array<[string, RegExp]> = [
  ["code_fence", /```/],
  ["file_path", new RegExp(`(^|[\\s"'\`(])[\\w./-]+\\.(${CODE_EXTENSIONS})\\b`, "i")],
  ["stack_trace", /(^|\n)\s*at\s+\S+\s+\(.*:\d+:\d+\)|Traceback \(most recent call last\)|\b\w+Error: /],
  ["evolve", /\b(evolve|evolution|self[- ]modify|write a (pr|pull request))\b/i],
  ["write_code", /\b(write|implement|build|create|add|fix|refactor|debug|patch)\b.{0,40}\b(code|script|function|class|module|component|endpoint|test|tests|bug|feature|migration|schema|cli|tool|skill|router|parser|hook)\b/i],
  ["inline_code", /`[^`\n]{2,}`.*`[^`\n]{2,}`/s],
];

/** Weaker vocabulary: one hit is ambiguous, two or more is coding. */
const WEAK_CODING =
  /\b(typescript|javascript|python|rust|golang|node(js)?|npm|pnpm|pip|cargo|tsc|typecheck|compile[rs]?|lint(er)?|vitest|jest|pytest|git|github|branch|commit|merge|rebase|pull request|\bPR\b|deploy(ment)?|docker|kubernetes|k8s|nginx|systemd|cron|regex|api|endpoint|webhook|sql|sqlite|postgres|database|json|yaml|schema|migration|unit test|stack ?trace|exception|segfault|refactor|codebase|repo(sitory)?|src\/|function|variable|async|promise|mutex|benchmark|algorithm|architecture|dependency|framework|sdk|mcp|prompt engineering)\b/gi;

const ESCALATE: Array<[string, RegExp]> = [
  ["stronger_model", /\b(smart(er|est)|better|strong(er|est)|big(ger|gest)|more capable|most capable|best|top|expensive|frontier)\s+(model|brain|llm|claude)\b/i],
  ["named_model", /\b(use|switch(\s+to)?|try|route(\s+to)?|escalate(\s+to)?|upgrade(\s+to)?|go with)\s+(the\s+)?(fable|opus|mythos)\b/i],
  ["think_harder", /\b(think (harder|deeper|more carefully)|deep(er)? think(ing)?|full reasoning)\b/i],
];

/** Attachment names that make a message a coding message on their own. */
const CODE_ATTACHMENT = new RegExp(`\\.(${CODE_EXTENSIONS}|log|diff|patch)$`, "i");

export interface HeuristicOptions {
  attachmentNames?: readonly string[];
  bias?: RouterBias;
}

export function classifyHeuristic(text: string, opts: HeuristicOptions = {}): HeuristicResult {
  const hits: string[] = [];
  const body = text ?? "";

  for (const [name, re] of ESCALATE) {
    if (re.test(body)) hits.push(`escalate:${name}`);
  }
  if (hits.length > 0) return { verdict: "escalate", hits };

  for (const [name, re] of STRONG_CODING) {
    if (re.test(body)) hits.push(name);
  }
  for (const name of opts.attachmentNames ?? []) {
    if (CODE_ATTACHMENT.test(name)) {
      hits.push(`attachment:${name.split(".").pop()?.toLowerCase()}`);
      break;
    }
  }
  if (hits.length > 0) return { verdict: "coding", hits };

  const weak = new Set<string>();
  for (const m of body.matchAll(WEAK_CODING)) weak.add(m[0].toLowerCase());
  for (const w of weak) hits.push(`kw:${w}`);

  if (weak.size >= 2) return { verdict: "coding", hits };
  if (weak.size === 1) {
    return { verdict: (opts.bias ?? "balanced") === "strong" ? "coding" : "ambiguous", hits };
  }
  return { verdict: "common", hits };
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

export const JUDGE_TIMEOUT_MS = 4000;
const JUDGE_INPUT_CHARS = 2000;

/** A decider may answer with a bare word (tests, legacy) or a structured verdict. */
export interface JudgeVerdict {
  tier: string;
  reason?: string;
}
export type JudgeFn = (text: string) => Promise<string | JudgeVerdict>;

function biasHint(bias: RouterBias): string {
  switch (bias) {
    case "cheap":
      return "When unsure, prefer common.";
    case "strong":
      return "When unsure, prefer coding.";
    default:
      return "When it is a coin flip, prefer common — the user can ask for a smarter model.";
  }
}

export function buildJudgePrompt(bias: RouterBias): string {
  return (
    "You route a chat message to one of two assistant tiers. Reply with exactly one word: coding or common.\n\n" +
    `coding — ${ROUTE_DESCRIPTIONS.coding}\n` +
    `common — ${ROUTE_DESCRIPTIONS.common}\n\n` +
    biasHint(bias)
  );
}

/** Pull a tier out of whatever the judge said. Undefined when it said neither. */
export function parseJudgeReply(reply: string): RouteTier | undefined {
  const m = /\b(coding|common)\b/i.exec(reply ?? "");
  return m ? (m[1].toLowerCase() as RouteTier) : undefined;
}

const DECIDER_TOOL_NAME = "route";

const DeciderOutput = z.object({
  tier: z.enum(["coding", "common"]),
  reason: z.string().max(200).default(""),
});

/**
 * Structured-output decider: one forced tool call on the judge-family model,
 * validated with zod, so a verbose or off-format reply cannot be mis-parsed
 * into a tier. Throws on anything unusable — routeModel() owns the fallback.
 */
export function createDecider(
  client: Pick<Anthropic, "messages"> = anthropicClient,
  getModel: () => string = () => getRouterModels().judge,
): JudgeFn {
  return async (text) => {
    const res = await client.messages.create(
      {
        model: getModel(),
        max_tokens: 120,
        system:
          buildJudgePrompt(getRouterBias()) +
          `\n\nCall the ${DECIDER_TOOL_NAME} tool with your decision and a reason of at most 12 words.`,
        tools: [
          {
            name: DECIDER_TOOL_NAME,
            description: "Record which assistant tier should handle the message.",
            input_schema: {
              type: "object",
              properties: {
                tier: { type: "string", enum: ["coding", "common"] },
                reason: { type: "string", description: "At most 12 words." },
              },
              required: ["tier", "reason"],
            },
          },
        ],
        tool_choice: { type: "tool", name: DECIDER_TOOL_NAME },
        messages: [{ role: "user", content: text.slice(0, JUDGE_INPUT_CHARS) }],
      },
      { timeout: JUDGE_TIMEOUT_MS, maxRetries: 0 },
    );
    const block = res.content.find((c) => c.type === "tool_use");
    if (!block || block.type !== "tool_use") throw new Error("decider returned no tool call");
    const parsed = DeciderOutput.safeParse(block.input);
    if (!parsed.success) throw new Error(`decider output invalid: ${parsed.error.issues[0]?.message ?? "?"}`);
    return parsed.data;
  };
}

const defaultJudge: JudgeFn = (text) => createDecider()(text);

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type RouteSource = "heuristic" | "judge" | "judge_fallback";

export interface RouteDecision {
  tier: RouteTier;
  model: string;
  source: RouteSource;
  /** The user asked for a stronger model in so many words. */
  escalated: boolean;
  hits: string[];
  judgeMs?: number;
  judgeError?: string;
  /** The decider's own one-line justification, when it gave one. */
  judgeReason?: string;
}

export interface RouteOptions extends HeuristicOptions {
  /** For the log line only. */
  channelId?: string;
  /** Injectable for tests; defaults to the structured decider. */
  judge?: JudgeFn;
}

/**
 * Pick a tier for a message. Heuristics first; the judge only for ambiguous
 * text. Never throws — a judge failure falls back along the configured bias.
 */
export async function routeModel(text: string, opts: RouteOptions = {}): Promise<RouteDecision> {
  const bias = opts.bias ?? getRouterBias();
  const models = getRouterModels();
  const h = classifyHeuristic(text, { ...opts, bias });

  if (h.verdict === "escalate") {
    count(P.routerEscalate);
    return { tier: "coding", model: models.coding, source: "heuristic", escalated: true, hits: h.hits };
  }
  if (h.verdict !== "ambiguous") {
    count(P.routerHeuristic);
    return { tier: h.verdict, model: models[h.verdict], source: "heuristic", escalated: false, hits: h.hits };
  }

  const started = Date.now();
  const judge = opts.judge ?? defaultJudge;
  try {
    const reply = await judge(text);
    const raw = typeof reply === "string" ? reply : reply.tier;
    const judgeReason = typeof reply === "string" ? undefined : reply.reason || undefined;
    const tier = parseJudgeReply(raw);
    const judgeMs = Date.now() - started;
    if (tier) {
      count(P.routerJudge);
      return {
        tier,
        model: models[tier],
        source: "judge",
        escalated: false,
        hits: h.hits,
        judgeMs,
        ...(judgeReason ? { judgeReason } : {}),
      };
    }
    throw new Error(`judge replied "${String(raw).slice(0, 40)}"`);
  } catch (err) {
    const judgeMs = Date.now() - started;
    const judgeError = err instanceof Error ? err.message : String(err);
    const tier: RouteTier = bias === "strong" ? "coding" : "common";
    count(P.routerJudgeFallback);
    log.error("judge failed — falling back", err, {
      channelId: opts.channelId,
      bias,
      fallbackTier: tier,
      judgeMs,
    });
    return { tier, model: models[tier], source: "judge_fallback", escalated: false, hits: h.hits, judgeMs, judgeError };
  }
}

// ---------------------------------------------------------------------------
// Session-level plan: what messages.ts should do with a decision
// ---------------------------------------------------------------------------

export type SessionModelPlan =
  | { action: "route"; decision: RouteDecision }
  | { action: "escalate_restart"; decision: RouteDecision }
  | { action: "skip"; reason: "sdk_env_pin" | "model_pin" | "disabled" | "live_session" | "empty" };

export interface SessionModelInput {
  text: string;
  channelId: string;
  hasLiveSession: boolean;
  attachmentNames?: readonly string[];
  judge?: JudgeFn;
}

/**
 * Apply the precedence rules and, when the router is in charge, decide.
 *
 * Every outcome is logged with the same shape so a dead-simple query on
 * `application_log WHERE category='router'` tells the whole story.
 */
export async function planSessionModel(input: SessionModelInput): Promise<SessionModelPlan> {
  const base = { channelId: input.channelId, live: input.hasLiveSession };

  const skip = (reason: Extract<SessionModelPlan, { action: "skip" }>["reason"], extra: Record<string, unknown> = {}) => {
    if (reason === "model_pin") count(P.routerBypassedPin);
    // info, not debug: the DB sink drops debug, and a skip is the one branch
    // an operator asks about ("why did this thread get fable?").
    log.info(`skipped: ${reason}`, { ...base, ...extra });
    return { action: "skip", reason } as const;
  };

  if (!input.text?.trim()) return skip("empty");

  const envPin = sdkModelPin();
  if (envPin) return skip("sdk_env_pin", { model: envPin });

  const pinned = getSelectedModel();
  if (pinned) return skip("model_pin", { model: pinned });

  if (!isModelRouterEnabled()) return skip("disabled");

  if (input.hasLiveSession) {
    // A running child keeps its model; the only thing we act on mid-thread is
    // an explicit ask for something stronger.
    const h = classifyHeuristic(input.text, { attachmentNames: input.attachmentNames });
    if (h.verdict !== "escalate") return skip("live_session");
    const decision = await routeModel(input.text, {
      channelId: input.channelId,
      attachmentNames: input.attachmentNames,
      judge: input.judge,
    });
    log.info(`escalating live session to ${decision.model}`, { ...base, ...decisionFields(decision) });
    return { action: "escalate_restart", decision };
  }

  const decision = await routeModel(input.text, {
    channelId: input.channelId,
    attachmentNames: input.attachmentNames,
    judge: input.judge,
  });
  log.info(`routed to ${decision.model}`, { ...base, ...decisionFields(decision) });
  return { action: "route", decision };
}

function decisionFields(d: RouteDecision): Record<string, unknown> {
  return {
    tier: d.tier,
    model: d.model,
    source: d.source,
    escalated: d.escalated,
    hits: d.hits,
    ...(d.judgeMs !== undefined ? { judgeMs: d.judgeMs } : {}),
    ...(d.judgeError ? { judgeError: d.judgeError } : {}),
    ...(d.judgeReason ? { judgeReason: d.judgeReason } : {}),
  };
}

/** Short model label for the in-channel `-# 🧭` line. */
export function shortModelName(id: string): string {
  return id.replace(/^(?:bedrock|anthropic)[-.]claude-/, "").replace(/^claude-/, "");
}

/**
 * One glyph per model family, for the per-turn reaction on the user's message.
 * Keyed on the id the SDK child reports in its `system/init` handshake, so the
 * glyph reflects what is actually running rather than what was configured.
 */
export function modelFamilyEmoji(id: string | null | undefined): string {
  const s = (id ?? "").toLowerCase();
  if (!s) return "❔";
  if (s.includes("fable") || s.includes("mythos")) return "🟣";
  if (s.includes("opus")) return "🔵";
  if (s.includes("sonnet")) return "🟢";
  if (s.includes("haiku")) return "⚪";
  return "⚫";
}

/** One-line rendering for Discord. */
export function describeDecision(d: RouteDecision): string {
  const via = d.source === "judge" ? "judge" : d.source === "judge_fallback" ? "judge failed, default" : "heuristic";
  const why = d.escalated ? "asked for a stronger model" : d.tier;
  return `\`${shortModelName(d.model)}\` (${why}, ${via})`;
}
