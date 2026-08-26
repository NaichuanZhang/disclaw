import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "../shared/anthropic.js";
import { resolveModel } from "../shared/models.js";
import { conversationHistoryTools, handleConversationHistoryTool } from "../shared/conversation-history.js";
import { getSoul } from "../soul/soul.js";
import { getMemoryTools, handleMemoryTool } from "../memory/tools.js";
import { discordTools, handleDiscordTool, setToolSessionContext } from "./tools.js";
import { skillTools, handleSkillTool } from "../skills/tools.js";
import { dangerousTools, handleDangerousTool } from "./dangerous-tools.js";
import { evolutionTools, handleEvolutionTool, setEvolutionContext } from "../evolution/tools.js";
import { EVOLUTION_INSTRUCTIONS } from "../evolution/instructions.js";
import type { Message, ChannelConfig, TokenUsage } from "../db/index.js";
import { recordSignal } from "../reflection/signals.js";
import {
  MEMORY_RECALL_INSTRUCTIONS,
  CAVEMAN_LEVELS,
  buildCavemanInstructions,
  getCavemanLevel,
  type CavemanLevel,
} from "../shared/prompt-fragments.js";
import { getSkillService } from "../skills/service.js";
import { createLogger, toolCallLog } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger("agent");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentImage {
  /** URL (web) or absolute file path (local) */
  source: string;
  /** Whether this is a local file path or a web URL */
  type: "url" | "file";
  /** Alt text from markdown */
  alt?: string;
}

export interface AgentResponse {
  /** The text portion of the response (with image markdown stripped) */
  text: string;
  /** Images extracted from the response */
  images: AgentImage[];
  /** Aggregated token usage across all API calls in this turn */
  usage?: TokenUsage;
}

// ---------------------------------------------------------------------------
// Tool call progress callback types
// ---------------------------------------------------------------------------

export interface ToolCallProgress {
  /** Tool name being invoked */
  toolName: string;
  /** Tool input arguments */
  toolInput: Record<string, unknown>;
  /** Result of the tool call (only set when phase is "result") */
  result?: string;
  /** Phase of the tool call */
  phase: "start" | "result";
}

/**
 * Callback fired during the agentic loop to report tool call progress.
 * messages.ts uses this to send intermediate Discord messages.
 */
export type OnToolCallProgress = (progress: ToolCallProgress) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TOKENS = 16384;
const MAX_CONSECUTIVE_DUPES = 2; // Break loop after this many identical consecutive tool calls

// ---------------------------------------------------------------------------
// Caveman mode — definitions live in shared/prompt-fragments.ts so pilot mode
// honours /caveman too. Re-exported here for existing importers (commands.ts).
// ---------------------------------------------------------------------------

export { CAVEMAN_LEVELS, getCavemanLevel };
export type { CavemanLevel };

// ---------------------------------------------------------------------------
// Token usage aggregation
// ---------------------------------------------------------------------------

function aggregateUsage(
  existing: TokenUsage | undefined,
  response: Anthropic.Messages.Message,
  model: string,
): TokenUsage {
  const usage = response.usage;
  const prev = existing ?? {
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  return {
    model, // Use the latest model (should be consistent within a session)
    inputTokens: prev.inputTokens + (usage.input_tokens ?? 0),
    outputTokens: prev.outputTokens + (usage.output_tokens ?? 0),
    cacheCreationTokens: prev.cacheCreationTokens + (usage.cache_creation_input_tokens ?? 0),
    cacheReadTokens: prev.cacheReadTokens + (usage.cache_read_input_tokens ?? 0),
  };
}

/** Get the current date/time as a human-readable string for the system prompt. */
function getCurrentTimestamp(): string {
  const now = new Date();
  // e.g. "Saturday, April 6, 2026, 3:45 PM PDT"
  return now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

const BASE_INSTRUCTIONS = `You are a Discord assistant. You participate in conversations, answer questions, and help users. You can use tools to interact with Discord channels and to recall information from memory.

Guidelines:
- Be concise and conversational — this is Discord, not an essay.
- Match the tone of the channel. Casual channels get casual responses.
- Use Discord markdown when helpful (bold, code blocks, etc.).
- If you don't know something, say so rather than guessing.
- When users reference past conversations, search your memory first.`;

// MEMORY_RECALL_INSTRUCTIONS lives in shared/prompt-fragments.ts (shared with pilot).


// ---------------------------------------------------------------------------
// All tools combined (built dynamically to include mem9 tools when configured)
// ---------------------------------------------------------------------------

function getAllTools(): Anthropic.Messages.Tool[] {
  return [
    ...conversationHistoryTools,
    ...getMemoryTools(),
    ...discordTools,
    ...skillTools,
    ...dangerousTools,
    ...evolutionTools,
  ] as Anthropic.Messages.Tool[];
}

/** Tools available in cron/agent-turn context (memory + discord + conversation history) */
function getCronTools(): Anthropic.Messages.Tool[] {
  return [
    ...getMemoryTools(),
    ...discordTools,
    ...conversationHistoryTools,
    ...dangerousTools,
  ] as Anthropic.Messages.Tool[];
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(opts: {
  context: {
    guildName?: string;
    channelName: string;
    channelId?: string;
    threadId?: string;
    userName: string;
    userId: string;
  };
  channelConfig?: ChannelConfig;
  /**
   * How many prior messages were loaded into this turn's conversation history.
   * Surfaced in the prompt so the agent can tell that scrollback is already in
   * context and treat `get_channel_history` as a fallback rather than a reflex.
   */
  historyCount?: number;
}): string {
  const parts: string[] = [];

  // 1. Base instructions
  parts.push(BASE_INSTRUCTIONS);

  // 2. Soul content
  const soul = getSoul();
  if (soul) {
    parts.push(`## Soul\n\n${soul}`);
  }

  // 2.5. Skills content
  const skillsPrompt = getSkillService()?.buildSkillsPromptSection();
  if (skillsPrompt) {
    parts.push(skillsPrompt);
  }

  // 3. Memory recall instructions
  parts.push(MEMORY_RECALL_INSTRUCTIONS);

  // 3.5 Evolution instructions
  parts.push(EVOLUTION_INSTRUCTIONS);

  // 4. Channel-specific instructions
  if (opts.channelConfig?.systemPrompt) {
    parts.push(
      `## Channel Instructions\n\n${opts.channelConfig.systemPrompt}`,
    );
  }

  // 4.5. Caveman mode, if enabled for this channel via /caveman
  const cavemanLevel = getCavemanLevel(opts.channelConfig);
  if (cavemanLevel) {
    parts.push(buildCavemanInstructions(cavemanLevel));
  }

  // 5. Context info (including current date/time)
  const ctx = opts.context;
  const contextLines = [`## Current Context`];
  contextLines.push(`- Current time: ${getCurrentTimestamp()}`);
  if (ctx.guildName) {
    contextLines.push(`- Server: ${ctx.guildName}`);
  }
  contextLines.push(`- Channel: #${ctx.channelName}`);
  // Include channel/thread IDs so tools that take a channel_id (send_message,
  // add_reaction, create_thread) use the correct IDs instead of hallucinating
  // them. Deliberately does NOT point at get_channel_history — see below.
  if (ctx.threadId) {
    contextLines.push(`- Thread ID: ${ctx.threadId}`);
  }
  if (ctx.channelId) {
    contextLines.push(`- Channel ID: ${ctx.channelId}`);
  }
  contextLines.push(`- Speaking with: ${ctx.userName} (ID: ${ctx.userId})`);

  // History visibility: the bot loads thread/DM scrollback into the
  // conversation before the model sees it, but the model has no way to know
  // how much. State it explicitly so get_channel_history stays a fallback.
  if (opts.historyCount !== undefined && opts.historyCount > 0) {
    contextLines.push(
      `- Messages already in context: ${opts.historyCount} (loaded automatically — do NOT call get_channel_history for this conversation unless you need messages older than these)`,
    );
  } else {
    contextLines.push(
      `- Messages already in context: 0 (no history loaded — if you need prior context here, get_channel_history is your fallback)`,
    );
  }
  parts.push(contextLines.join("\n"));

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// History converter
// ---------------------------------------------------------------------------

/**
 * Regex to match usage/cost footer line(s) appended to assistant messages.
 * Matches lines like: -# 📊 claude-opus-4 · 13.5k in / 429 out · $0.0462 · 12.3s
 * This footer is added by the bot for display but should NOT be included in
 * conversation history sent to the model (otherwise the model mimics it).
 */
const USAGE_FOOTER_RE = /(\n-# 📊 .+)+$/;

/**
 * Strip the usage/cost footer from an assistant message's content.
 * The footer is appended by the bot for Discord display but pollutes
 * history — the model sees it and mimics it, causing duplicate footers.
 */
function stripUsageFooter(content: string): string {
  return content.replace(USAGE_FOOTER_RE, "");
}

function buildMessageHistory(
  history: Message[],
): Anthropic.Messages.MessageParam[] {
  const messages: Anthropic.Messages.MessageParam[] = [];

  for (const msg of history) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    // Strip usage footer from assistant messages to prevent the model from mimicking it
    const content = role === "assistant" ? stripUsageFooter(msg.content) : msg.content;
    // Merge consecutive same-role messages (Anthropic API requires alternation)
    const last = messages[messages.length - 1];
    if (last && last.role === role && typeof last.content === "string") {
      last.content += `\n${content}`;
    } else {
      messages.push({ role, content });
    }
  }

  // Ensure the conversation starts with a user message
  if (messages.length > 0 && messages[0].role === "assistant") {
    messages.shift();
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Memory tool name matching
// ---------------------------------------------------------------------------

/** All tool names that route to handleMemoryTool (local + mem9) */
const MEMORY_TOOL_NAMES = new Set([
  "memory_search",
  "memory_get",
  "mem9_store",
  "mem9_update",
  "mem9_delete",
]);

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context?: { sessionId?: string; userId?: string; toolContext?: "interactive" | "cron" | "voice" },
): Promise<{ result: string; durationMs: number }> {
  const startTime = Date.now();
  let result: string;

  // Memory tools (async — queries local FTS5 + mem9 cloud in parallel)
  if (MEMORY_TOOL_NAMES.has(name)) {
    result = await handleMemoryTool(name, input);
  }
  // Discord tools are async
  else if (name === "send_message" || name === "send_file" || name === "add_reaction" || name === "get_channel_history" || name === "create_thread" || name === "ask_user") {
    result = await handleDiscordTool(name, input);
  }
  // Skill tools are synchronous
  else if (name === "read_skill" || name === "list_skill_files") {
    result = handleSkillTool(name, input);
  }
  // Dangerous tools (bash, read_file, write_file)
  else if (name === "bash" || name === "read_file" || name === "write_file") {
    result = await handleDangerousTool(name, input);
  }
  // Evolution tools
  else if (
    name === "evolve_start" ||
    name === "evolve_read" ||
    name === "evolve_write" ||
    name === "evolve_bash" ||
    name === "evolve_propose" ||
    name === "evolve_suggest" ||
    name === "evolve_cancel" ||
    name === "evolve_review" ||
    name === "evolve_merge"
  ) {
    result = await handleEvolutionTool(name, input);
  }
  // Conversation history tools
  else if (name === "get_conversation_history" || name === "get_conversation_stats") {
    result = handleConversationHistoryTool(name, input);
  } else {
    result = JSON.stringify({ error: `Unknown tool: ${name}` });
  }

  const durationMs = Date.now() - startTime;

  // Determine success/failure and record structured tool call log
  let success = true;
  let errorMsg: string | undefined;
  try {
    const parsed = JSON.parse(result);
    if (parsed.error) {
      success = false;
      errorMsg = typeof parsed.error === "string" ? parsed.error.slice(0, 300) : JSON.stringify(parsed.error).slice(0, 300);

      // Also record as signal for reflection (backward compat)
      recordSignal({
        type: "tool_failure",
        source: "agent",
        detail: `Tool "${name}" failed: ${errorMsg}`,
        metadata: {
          tool: name,
          input: JSON.stringify(input).slice(0, 500),
          error: parsed.error,
        },
        sessionId: context?.sessionId,
        userId: context?.userId,
      });
    }
  } catch {
    // Result wasn't JSON or parsing failed — that's fine
  }

  // Record structured tool call log
  toolCallLog({
    tool: name,
    input,
    result,
    success,
    error: errorMsg,
    durationMs,
    context: context?.toolContext,
    sessionId: context?.sessionId,
    userId: context?.userId,
  });

  return { result, durationMs };
}

// ---------------------------------------------------------------------------
// Image extraction from markdown
// ---------------------------------------------------------------------------

/** Common image file extensions */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i;

/** Match markdown image syntax: ![alt](source) */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Extract images from response text and return cleaned text + image list.
 * Recognizes:
 * - Markdown images: ![alt](url or filepath)
 * - Web URLs are classified as "url"
 * - Absolute file paths are classified as "file"
 */
export function extractImages(text: string): { cleanText: string; images: AgentImage[] } {
  const images: AgentImage[] = [];

  const cleanText = text.replace(MARKDOWN_IMAGE_RE, (match, alt: string, src: string) => {
    const trimmedSrc = src.trim();

    if (trimmedSrc.startsWith("http://") || trimmedSrc.startsWith("https://")) {
      images.push({ source: trimmedSrc, type: "url", alt: alt || undefined });
      return ""; // Strip from text
    }

    if (trimmedSrc.startsWith("/") && IMAGE_EXTENSIONS.test(trimmedSrc)) {
      images.push({ source: trimmedSrc, type: "file", alt: alt || undefined });
      return ""; // Strip from text
    }

    // Not a recognized image — leave the markdown in place
    return match;
  });

  // Clean up extra blank lines left behind by stripping images
  const finalText = cleanText.replace(/\n{3,}/g, "\n\n").trim();

  return { cleanText: finalText, images };
}

// ---------------------------------------------------------------------------
// Abort check helper
// ---------------------------------------------------------------------------

/**
 * Check if an AbortSignal has been triggered and throw if so.
 * Used between turns in the agentic loop to allow early exit.
 */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Session aborted");
  }
}

// ---------------------------------------------------------------------------
// processMessage — main conversation entry point
// ---------------------------------------------------------------------------

export async function processMessage(opts: {
  message: string | Anthropic.Messages.ContentBlockParam[];
  sessionId: string;
  context: {
    guildName?: string;
    channelName: string;
    channelId?: string;
    threadId?: string;
    userName: string;
    userId: string;
  };
  history: Message[];
  channelConfig?: ChannelConfig;
  /** Optional callback to report tool call progress for live Discord updates */
  onToolCallProgress?: OnToolCallProgress;
  /** Optional abort signal — checked between agentic loop turns */
  signal?: AbortSignal;
  /** Thread ID for the current conversation — prevents creating duplicate threads */
  threadId?: string;
}): Promise<AgentResponse> {
  const systemPrompt = buildSystemPrompt({
    context: opts.context,
    channelConfig: opts.channelConfig,
    historyCount: opts.history.length,
  });

  // Set evolution context so tools know the triggering user
  setEvolutionContext(undefined, opts.context.userId);

  // Set session context so Discord tools (send_file) can register artifacts
  setToolSessionContext(opts.sessionId, opts.threadId, opts.context.userId);

  // Build conversation history and append the current message
  const messages: Anthropic.Messages.MessageParam[] = [
    ...buildMessageHistory(opts.history),
    { role: "user", content: opts.message },
  ];

  const collectedText: string[] = [];
  let turns = 0;
  let totalUsage: TokenUsage | undefined;
  const model = resolveModel();

  // Build tool list dynamically (includes mem9 tools when configured)
  const allTools = getAllTools();

  // Duplicate tool call detection — track previous turn's calls
  let prevCallSignatures: string[] = [];
  let consecutiveDupes = 0;

  try {
    while (true) {
      // Check for abort between turns
      checkAbort(opts.signal);

      turns++;

      const response = await anthropicClient.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
        tools: allTools,
      });

      // Check for abort after API call
      checkAbort(opts.signal);

      // Aggregate token usage
      totalUsage = aggregateUsage(totalUsage, response, response.model);

      // Collect text blocks from the response
      for (const block of response.content) {
        if (block.type === "text") {
          collectedText.push(block.text);
        }
      }

      // If the model didn't ask to use a tool, we're done
      if (response.stop_reason !== "tool_use") {
        break;
      }

      // Build signatures for this turn's tool calls
      const currentSignatures: string[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          currentSignatures.push(`${block.name}:${JSON.stringify(block.input)}`);
        }
      }

      // Check for duplicate calls (same tools+args as previous turn)
      const isDuplicate =
        currentSignatures.length > 0 &&
        currentSignatures.length === prevCallSignatures.length &&
        currentSignatures.every((sig, i) => sig === prevCallSignatures[i]);

      if (isDuplicate) {
        consecutiveDupes++;
        log.warn(
          `Duplicate tool call detected (${consecutiveDupes}/${MAX_CONSECUTIVE_DUPES})`,
          { tools: currentSignatures.map((s) => s.split(":")[0]) },
        );
      } else {
        consecutiveDupes = 0;
      }
      prevCallSignatures = currentSignatures;

      // If we've hit the dupe limit, force the model to stop looping
      if (consecutiveDupes >= MAX_CONSECUTIVE_DUPES) {
        log.warn("Breaking loop — repeated duplicate tool calls", {
          tools: currentSignatures.map((s) => s.split(":")[0]),
        });

        // Record as a signal — duplicate loops indicate a potential issue
        recordSignal({
          type: "pattern",
          source: "agent",
          detail: `Duplicate tool call loop broken: ${currentSignatures[0]?.split(":")[0] || "unknown"}`,
          metadata: {
            tools: currentSignatures.map((s) => s.split(":")[0]),
          },
          sessionId: opts.sessionId,
          userId: opts.context.userId,
        });

        // Give the model one last chance with a nudge instead of tools
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content:
            "[System: You have called the same tools with identical inputs multiple times. Stop calling tools and produce your final response now using the information you already have.]",
        });
        // One final turn without tools to force a text response
        const final = await anthropicClient.messages.create({
          model,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages,
        });

        // Aggregate usage from the final call too
        totalUsage = aggregateUsage(totalUsage, final, final.model);

        for (const block of final.content) {
          if (block.type === "text") {
            collectedText.push(block.text);
          }
        }
        break;
      }

      // Process tool calls: append the assistant response, then tool results
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          // Check abort before each tool call
          checkAbort(opts.signal);

          // Fire progress callback: tool starting
          if (opts.onToolCallProgress) {
            try {
              await opts.onToolCallProgress({
                toolName: block.name,
                toolInput: block.input as Record<string, unknown>,
                phase: "start",
              });
            } catch (err) {
              log.error("onToolCallProgress (start) error", err);
            }
          }

          const { result } = await executeTool(
            block.name,
            block.input as Record<string, unknown>,
            { sessionId: opts.sessionId, userId: opts.context.userId, toolContext: "interactive" },
          );

          // Fire progress callback: tool completed with result
          if (opts.onToolCallProgress) {
            try {
              await opts.onToolCallProgress({
                toolName: block.name,
                toolInput: block.input as Record<string, unknown>,
                result,
                phase: "result",
              });
            } catch (err) {
              log.error("onToolCallProgress (result) error", err);
            }
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
    }
  } finally {
    // Clear session context after processing
    setToolSessionContext(null);
  }

  const rawText = collectedText.join("\n").trim();
  if (!rawText) {
    return { text: "I processed your request but had nothing to say.", images: [], usage: totalUsage };
  }

  // Extract images from the response text
  const { cleanText, images } = extractImages(rawText);

  return {
    text: cleanText || rawText, // Fall back to raw if extraction stripped everything
    images,
    usage: totalUsage,
  };
}

// ---------------------------------------------------------------------------
// processAgentTurn — agentic turn for cron jobs with full tool access
// ---------------------------------------------------------------------------

export async function processAgentTurn(opts: {
  message: string;
  model?: string;
}): Promise<string> {
  const soul = getSoul();
  const systemParts: string[] = [BASE_INSTRUCTIONS];
  if (soul) {
    systemParts.push(`## Soul\n\n${soul}`);
  }
  const skillsPrompt = getSkillService()?.buildSkillsPromptSection();
  if (skillsPrompt) {
    systemParts.push(skillsPrompt);
  }
  systemParts.push(MEMORY_RECALL_INSTRUCTIONS);

  // Add current time context for cron jobs too
  systemParts.push(`## Current Context\n- Current time: ${getCurrentTimestamp()}`);

  const systemPrompt = systemParts.join("\n\n");

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: opts.message },
  ];

  // Build cron tools dynamically (includes mem9 tools when configured)
  const cronTools = getCronTools();

  const collectedText: string[] = [];
  let turns = 0;
  let prevCallSignatures: string[] = [];
  let consecutiveDupes = 0;

  while (true) {
    turns++;

    const response = await anthropicClient.messages.create({
      model: resolveModel(opts.model),
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages,
      tools: cronTools,
    });

    for (const block of response.content) {
      if (block.type === "text") {
        collectedText.push(block.text);
      }
    }

    if (response.stop_reason !== "tool_use") {
      break;
    }

    // Duplicate detection
    const currentSignatures: string[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        currentSignatures.push(`${block.name}:${JSON.stringify(block.input)}`);
      }
    }

    const isDuplicate =
      currentSignatures.length > 0 &&
      currentSignatures.length === prevCallSignatures.length &&
      currentSignatures.every((sig, i) => sig === prevCallSignatures[i]);

    if (isDuplicate) {
      consecutiveDupes++;
      log.warn(`Cron duplicate tool call (${consecutiveDupes}/${MAX_CONSECUTIVE_DUPES})`);
    } else {
      consecutiveDupes = 0;
    }
    prevCallSignatures = currentSignatures;

    if (consecutiveDupes >= MAX_CONSECUTIVE_DUPES) {
      log.warn("Cron loop broken — repeated duplicate tool calls");
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content:
          "[System: You have called the same tools with identical inputs multiple times. Stop calling tools and produce your final response now.]",
      });
      const final = await anthropicClient.messages.create({
        model: resolveModel(opts.model),
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
      });
      for (const block of final.content) {
        if (block.type === "text") {
          collectedText.push(block.text);
        }
      }
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        // Route to the unified executeTool dispatcher (with cron context)
        const { result } = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
          { toolContext: "cron" },
        );

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  return collectedText.join("\n").trim() || "";
}
