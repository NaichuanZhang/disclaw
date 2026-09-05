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
// one is set; /model reset hands control back.
// ---------------------------------------------------------------------------

import { anthropicClient } from "./anthropic.js";
import { createLogger } from "../logging/logger.js";
import { getConfig, setConfig } from "../db/index.js";
import { getSelectedModel } from "./models.js";
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

const DEFAULT_ROUTER_MODELS: RouterModels = {
  coding: "bedrock-claude-fable-5-1",
  common: "bedrock-claude-sonnet-5",
  judge: "bedrock-claude-sonnet-5",
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

export function getRouterModels(): RouterModels {
  return {
    coding: envValue("ROUTER_MODEL_CODING") ?? DEFAULT_ROUTER_MODELS.coding,
    common: envValue("ROUTER_MODEL_COMMON") ?? DEFAULT_ROUTER_MODELS.common,
    judge: envValue("ROUTER_MODEL_JUDGE") ?? DEFAULT_ROUTER_MODELS.judge,
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

export const JUDGE_TIMEOUT_MS = 3000;
const JUDGE_INPUT_CHARS = 2000;

export type JudgeFn = (text: string) => Promise<string>;

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

async function defaultJudge(text: string): Promise<string> {
  const models = getRouterModels();
  const res = await anthropicClient.messages.create(
    {
      model: models.judge,
      max_tokens: 5,
      system: buildJudgePrompt(getRouterBias()),
      messages: [{ role: "user", content: text.slice(0, JUDGE_INPUT_CHARS) }],
    },
    { timeout: JUDGE_TIMEOUT_MS, maxRetries: 0 },
  );
  return res.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join(" ")
    .trim();
}

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
}

export interface RouteOptions extends HeuristicOptions {
  /** For the log line only. */
  channelId?: string;
  /** Injectable for tests; defaults to the Sonnet judge. */
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
    const tier = parseJudgeReply(reply);
    const judgeMs = Date.now() - started;
    if (tier) {
      count(P.routerJudge);
      return { tier, model: models[tier], source: "judge", escalated: false, hits: h.hits, judgeMs };
    }
    throw new Error(`judge replied "${reply.slice(0, 40)}"`);
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
    log.debug(`skipped: ${reason}`, { ...base, ...extra });
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
  };
}

/** Short model label for the in-channel `-# 🧭` line. */
export function shortModelName(id: string): string {
  return id.replace(/^bedrock-claude-/, "").replace(/^claude-/, "");
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
