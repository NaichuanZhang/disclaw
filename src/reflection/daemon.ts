// ---------------------------------------------------------------------------
// Reflection Daemon — periodic self-analysis for improvement opportunities
// ---------------------------------------------------------------------------
//
// Level 1 trust: discovers ideas and posts them to Discord for human approval.
// Does NOT auto-implement anything.
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "../shared/anthropic.js";
import { getDb } from "../db/index.js";
import {
  getSignalsSince,
  getSignalSummary,
  getTopSignals,
  pruneSignals,
} from "./signals.js";
import { listEvolutions, type Evolution } from "../evolution/log.js";
import { recordSuggestion } from "../evolution/engine.js";
import { getErrorLogs, getErrorCountsByCategory, getToolCallStats, getSlowestToolCalls, pruneLogs } from "../logging/queries.js";
import { createLogger } from "../logging/logger.js";
import { resolveModel } from "../shared/models.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger("reflection");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** How often the reflection runs (default: 6 hours) */
const REFLECTION_INTERVAL_MS = parseInt(
  process.env.REFLECTION_INTERVAL_HOURS || "6",
  10,
) * 60 * 60 * 1000;

/** How far back to look for signals (default: 24 hours) */
const SIGNAL_LOOKBACK_MS = parseInt(
  process.env.REFLECTION_LOOKBACK_HOURS || "24",
  10,
) * 60 * 60 * 1000;

/** Minimum number of signals before reflection is worth running */
const MIN_SIGNALS_FOR_REFLECTION = parseInt(
  process.env.REFLECTION_MIN_SIGNALS || "3",
  10,
);

/** Prune signals older than this (default: 7 days) */
const SIGNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Model for reflection runs. Resolved per-run rather than at module load so a
 * `/model` selection takes effect without a restart; REFLECTION_MODEL still
 * pins this daemon to a specific model when set.
 */
function getReflectionModel(): string {
  return resolveModel(process.env.REFLECTION_MODEL);
}

// ---------------------------------------------------------------------------
// Discord notification callback
// ---------------------------------------------------------------------------

let _sendToDiscord: ((channelId: string, text: string) => Promise<void>) | null = null;
let _reflectionChannelId: string | null = null;

export function setReflectionSendToDiscord(
  fn: (channelId: string, text: string) => Promise<void>,
): void {
  _sendToDiscord = fn;
}

export function setReflectionChannelId(channelId: string): void {
  _reflectionChannelId = channelId;
}

// ---------------------------------------------------------------------------
// Gather context for reflection
// ---------------------------------------------------------------------------

interface ReflectionContext {
  signalSummary: Record<string, number>;
  topErrors: { detail: string; count: number; type: string }[];
  topFailures: { detail: string; count: number; type: string }[];
  topUnknown: { detail: string; count: number; type: string }[];
  recentPositive: { detail: string; count: number; type: string }[];
  recentIdeas: Evolution[];
  recentDeployed: Evolution[];
  conversationStats: { totalSessions: number; totalMessages: number };
  totalSignals: number;
  // Structured log data
  errorCountsByCategory: Record<string, number>;
  toolCallStats: { tool: string; totalCalls: number; failures: number; avgDurationMs: number; maxDurationMs: number }[];
  slowestToolCalls: { tool: string; durationMs: number; error: string | null }[];
  recentErrors: { category: string; message: string; stack: string | null }[];
}

function gatherContext(): ReflectionContext {
  const since = Date.now() - SIGNAL_LOOKBACK_MS;
  const db = getDb();

  const signalSummary = getSignalSummary(since);
  const topErrors = getTopSignals(since, { type: "error", limit: 10 });
  const topFailures = getTopSignals(since, { type: "tool_failure", limit: 10 });
  const topUnknown = getTopSignals(since, { type: "unknown_request", limit: 10 });
  const recentPositive = getTopSignals(since, { type: "user_sentiment", limit: 10 });

  const recentIdeas = listEvolutions({ status: "idea" }).slice(0, 10);
  const recentDeployed = listEvolutions({ status: "deployed" }).slice(0, 5);

  // Conversation stats
  const sessionRow = db
    .prepare("SELECT COUNT(*) as count FROM sessions WHERE last_active > ?")
    .get(since) as { count: number };
  const messageRow = db
    .prepare("SELECT COUNT(*) as count FROM messages WHERE created_at > ?")
    .get(since) as { count: number };

  const allSignals = getSignalsSince(since);

  // Structured log data
  const errorCountsByCategory = getErrorCountsByCategory(SIGNAL_LOOKBACK_MS);
  const toolCallStats = getToolCallStats(SIGNAL_LOOKBACK_MS);
  const slowestToolCalls = getSlowestToolCalls({ sinceMs: SIGNAL_LOOKBACK_MS, limit: 5 })
    .map((r) => ({ tool: r.tool, durationMs: r.durationMs, error: r.error }));
  const recentErrors = getErrorLogs({ sinceMs: SIGNAL_LOOKBACK_MS, limit: 20 })
    .map((r) => ({ category: r.category, message: r.message, stack: r.stack }));

  return {
    signalSummary,
    topErrors,
    topFailures,
    topUnknown,
    recentPositive,
    recentIdeas,
    recentDeployed,
    conversationStats: {
      totalSessions: sessionRow.count,
      totalMessages: messageRow.count,
    },
    totalSignals: allSignals.length,
    errorCountsByCategory,
    toolCallStats,
    slowestToolCalls,
    recentErrors,
  };
}

// ---------------------------------------------------------------------------
// Build the reflection prompt
// ---------------------------------------------------------------------------

function buildReflectionPrompt(ctx: ReflectionContext): string {
  const parts: string[] = [];

  parts.push(`You are a self-improving AI assistant analyzing your own performance over the last ${Math.round(SIGNAL_LOOKBACK_MS / 3600000)} hours.

Your job is to identify the SINGLE most impactful improvement you could make to yourself. You have access to signals collected from your recent operation.

## Rules
- Be specific and actionable. "Improve error handling" is too vague. "Add retry logic for Discord API timeouts in send_message tool" is good.
- Consider whether the improvement should be a CODE change (new runtime capability) or a SKILL (procedural knowledge using existing tools).
- If you don't see any meaningful improvement opportunity, say so. Don't force it.
- Prioritize: errors/failures > unhandled user requests > efficiency > nice-to-haves.
- Don't suggest things that have already been deployed or are in the ideas backlog (listed below).`);

  parts.push(`## Activity Summary
- Active sessions: ${ctx.conversationStats.totalSessions}
- Messages processed: ${ctx.conversationStats.totalMessages}
- Total signals collected: ${ctx.totalSignals}`);

  parts.push(`## Signal Summary
- Errors: ${ctx.signalSummary.error}
- Tool failures: ${ctx.signalSummary.tool_failure}
- Unknown requests: ${ctx.signalSummary.unknown_request}
- User sentiment signals: ${ctx.signalSummary.user_sentiment}
- Patterns: ${ctx.signalSummary.pattern}`);

  if (ctx.topErrors.length > 0) {
    parts.push(`## Top Errors\n${ctx.topErrors.map((e) => `- [${e.count}x] ${e.detail}`).join("\n")}`);
  }

  if (ctx.topFailures.length > 0) {
    parts.push(`## Top Tool Failures\n${ctx.topFailures.map((e) => `- [${e.count}x] ${e.detail}`).join("\n")}`);
  }

  if (ctx.topUnknown.length > 0) {
    parts.push(`## Things Users Asked For That I Couldn't Do\n${ctx.topUnknown.map((e) => `- [${e.count}x] ${e.detail}`).join("\n")}`);
  }

  if (ctx.recentPositive.length > 0) {
    parts.push(`## Positive Signals\n${ctx.recentPositive.map((e) => `- [${e.count}x] ${e.detail}`).join("\n")}`);
  }

  // --- Structured log data ---

  if (Object.keys(ctx.errorCountsByCategory).length > 0) {
    parts.push(`## Error Log Summary (by category)\n${Object.entries(ctx.errorCountsByCategory).map(([cat, count]) => `- **${cat}**: ${count} errors`).join("\n")}`);
  }

  if (ctx.recentErrors.length > 0) {
    const errorLines = ctx.recentErrors.slice(0, 10).map((e) => {
      const stackPreview = e.stack ? `\n  Stack: ${e.stack.split("\n")[0]}` : "";
      return `- [${e.category}] ${e.message.slice(0, 200)}${stackPreview}`;
    });
    parts.push(`## Recent Errors (from error_log)\n${errorLines.join("\n")}`);
  }

  if (ctx.toolCallStats.length > 0) {
    const toolLines = ctx.toolCallStats.map((t) => {
      const failRate = t.totalCalls > 0 ? ((t.failures / t.totalCalls) * 100).toFixed(1) : "0";
      return `- **${t.tool}**: ${t.totalCalls} calls, ${t.failures} failures (${failRate}%), avg ${t.avgDurationMs}ms, max ${t.maxDurationMs}ms`;
    });
    parts.push(`## Tool Call Statistics\n${toolLines.join("\n")}`);
  }

  if (ctx.slowestToolCalls.length > 0) {
    const slowLines = ctx.slowestToolCalls.map((t) => {
      const errorNote = t.error ? ` (error: ${t.error.slice(0, 100)})` : "";
      return `- **${t.tool}**: ${t.durationMs}ms${errorNote}`;
    });
    parts.push(`## Slowest Tool Calls\n${slowLines.join("\n")}`);
  }

  // --- Existing ideas / deployed ---

  if (ctx.recentIdeas.length > 0) {
    parts.push(`## Existing Ideas (don't repeat these)\n${ctx.recentIdeas.map((e) => `- ${e.triggerMessage?.slice(0, 200)}`).join("\n")}`);
  }

  if (ctx.recentDeployed.length > 0) {
    parts.push(`## Recently Deployed Improvements\n${ctx.recentDeployed.map((e) => `- ${e.changesSummary || e.triggerMessage?.slice(0, 200)}`).join("\n")}`);
  }

  parts.push(`## Your Response Format

Respond in EXACTLY this JSON format:
{
  "has_proposal": true/false,
  "title": "Short title for the improvement",
  "description": "Detailed description of what to change and why",
  "type": "code" | "skill" | "soul",
  "priority": "high" | "medium" | "low",
  "reasoning": "Why this is the most impactful thing to work on"
}

If nothing warrants action, set has_proposal to false and explain why in reasoning.`);

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Run a single reflection cycle
// ---------------------------------------------------------------------------

interface ReflectionResult {
  outcome: "no_action" | "idea_recorded" | "proposal_sent" | "skipped" | "error";
  proposal?: string;
  evolutionId?: string;
  error?: string;
}

async function runReflection(): Promise<ReflectionResult> {
  const runStarted = Date.now();

  try {
    // 1. Gather context
    const ctx = gatherContext();

    // Count structured logs too for the "enough data" check
    const structuredLogCount =
      Object.values(ctx.errorCountsByCategory).reduce((a, b) => a + b, 0) +
      ctx.toolCallStats.reduce((a, t) => a + t.totalCalls, 0);

    const totalDataPoints = ctx.totalSignals + structuredLogCount;

    // Skip if not enough data
    if (totalDataPoints < MIN_SIGNALS_FOR_REFLECTION) {
      log.info(`Skipping reflection — only ${totalDataPoints} data points (need ${MIN_SIGNALS_FOR_REFLECTION})`);
      recordReflectionRun(runStarted, "skipped", 0, null, null, null);
      return { outcome: "skipped" };
    }

    log.info(`Running reflection with ${ctx.totalSignals} signals + ${structuredLogCount} structured log entries...`);

    // 2. Build prompt and call Claude
    const prompt = buildReflectionPrompt(ctx);

    const response = await anthropicClient.messages.create({
      model: getReflectionModel(),
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const responseText = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    // 3. Parse the response
    let proposal: {
      has_proposal: boolean;
      title?: string;
      description?: string;
      type?: string;
      priority?: string;
      reasoning?: string;
    };

    try {
      // Extract JSON from potential markdown code block
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }
      proposal = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      log.error("Failed to parse reflection response", parseErr);
      log.info(`Raw response: ${responseText.slice(0, 500)}`);
      recordReflectionRun(runStarted, "error", ctx.totalSignals, null, null, `Parse error: ${parseErr}`);
      return { outcome: "error", error: `Parse error: ${parseErr}` };
    }

    // 4. Act on the proposal
    if (!proposal.has_proposal) {
      log.info(`Reflection concluded: no action needed. Reason: ${proposal.reasoning}`);
      recordReflectionRun(runStarted, "no_action", ctx.totalSignals, null, null, null);
      return { outcome: "no_action" };
    }

    const proposalText = `**${proposal.title}**\n\n${proposal.description}\n\n**Type:** ${proposal.type} | **Priority:** ${proposal.priority}\n**Reasoning:** ${proposal.reasoning}`;

    // Record as an evolution idea
    const evolution = recordSuggestion({
      what: proposal.title || "Untitled improvement",
      why: `${proposal.description}\n\n[Auto-discovered by reflection daemon]\nType: ${proposal.type}\nPriority: ${proposal.priority}\nReasoning: ${proposal.reasoning}`,
      triggeredBy: "reflection-daemon",
    });

    log.info(`Reflection found improvement: "${proposal.title}" (${proposal.type}/${proposal.priority})`);

    // 5. Notify Discord (Level 1: human must approve)
    if (_sendToDiscord && _reflectionChannelId) {
      try {
        const discordMessage = [
          `🔮 **Self-Reflection Report**`,
          ``,
          `I analyzed ${ctx.totalSignals} signals + ${structuredLogCount} structured log entries from the last ${Math.round(SIGNAL_LOOKBACK_MS / 3600000)} hours and found a potential improvement:`,
          ``,
          proposalText,
          ``,
          `---`,
          `💡 Recorded as idea \`${evolution.id}\``,
          `To implement, tell me: "implement evolution idea ${evolution.id}"`,
        ].join("\n");

        await _sendToDiscord(_reflectionChannelId, discordMessage);
      } catch (err) {
        log.error("Failed to send reflection to Discord", err);
      }
    }

    recordReflectionRun(
      runStarted,
      _reflectionChannelId ? "proposal_sent" : "idea_recorded",
      ctx.totalSignals,
      proposalText,
      evolution.id,
      null,
    );

    return {
      outcome: _reflectionChannelId ? "proposal_sent" : "idea_recorded",
      proposal: proposalText,
      evolutionId: evolution.id,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Reflection failed", err);
    recordReflectionRun(runStarted, "error", 0, null, null, msg);
    return { outcome: "error", error: msg };
  }
}

// ---------------------------------------------------------------------------
// Record reflection run in DB
// ---------------------------------------------------------------------------

function recordReflectionRun(
  startedAt: number,
  outcome: string,
  signalsAnalyzed: number,
  proposal: string | null,
  evolutionId: string | null,
  error: string | null,
): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO reflection_runs (started_at, completed_at, signals_analyzed, outcome, proposal, evolution_id, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        startedAt,
        Date.now(),
        signalsAnalyzed,
        outcome,
        proposal,
        evolutionId,
        error,
        Date.now(),
      );
  } catch (err) {
    log.error("Failed to record reflection run", err);
  }
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

let _reflectionTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the reflection daemon. Runs reflection on a fixed interval.
 * The first run happens after one full interval (not immediately on startup).
 */
export function startReflectionDaemon(): void {
  if (_reflectionTimer) {
    log.info("Daemon already running");
    return;
  }

  const hours = REFLECTION_INTERVAL_MS / 3600000;
  log.info(`Starting reflection daemon (every ${hours}h, lookback ${SIGNAL_LOOKBACK_MS / 3600000}h, min signals: ${MIN_SIGNALS_FOR_REFLECTION})`);

  if (!_reflectionChannelId) {
    log.warn("No REFLECTION_CHANNEL_ID set — ideas will be recorded but not posted to Discord");
  }

  _reflectionTimer = setInterval(async () => {
    try {
      // Prune old signals first
      const pruned = pruneSignals(Date.now() - SIGNAL_RETENTION_MS);
      if (pruned > 0) {
        log.info(`Pruned ${pruned} old signals`);
      }

      // Prune old structured logs too
      const logsPruned = pruneLogs();
      const totalLogsPruned = logsPruned.appPruned + logsPruned.errorPruned + logsPruned.toolPruned;
      if (totalLogsPruned > 0) {
        log.info(`Pruned ${totalLogsPruned} old log entries (app=${logsPruned.appPruned}, error=${logsPruned.errorPruned}, tool=${logsPruned.toolPruned})`);
      }

      await runReflection();
    } catch (err) {
      log.error("Daemon tick error", err);
    }
  }, REFLECTION_INTERVAL_MS);

  log.info("Reflection daemon started");
}

/**
 * Stop the reflection daemon.
 */
export function stopReflectionDaemon(): void {
  if (_reflectionTimer) {
    clearInterval(_reflectionTimer);
    _reflectionTimer = null;
    log.info("Reflection daemon stopped");
  }
}

/**
 * Manually trigger a reflection cycle (for testing/debugging).
 */
export async function triggerReflection(): Promise<ReflectionResult> {
  log.info("Manual reflection triggered");
  return runReflection();
}
