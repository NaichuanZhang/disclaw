/**
 * Voice-optimized agent, on Anthropic (Claude).
 *
 * Uses a short max_tokens limit and a voice-specific system prompt that produces
 * spoken-style responses (no markdown, no lists, 1-3 sentences). Pick the model
 * with VOICE_MODEL (e.g. bedrock-claude-haiku-4-5 for ~900ms TTFT).
 *
 * Supports streaming mode: sentences are delivered via callback as the LLM
 * generates them, enabling sentence-level TTS pipelining.
 */

import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "../shared/anthropic.js";
import { conversationHistoryTools, handleConversationHistoryTool } from "../shared/conversation-history.js";
import { getSoul } from "../soul/soul.js";
import { getMemoryTools, handleMemoryTool } from "../memory/tools.js";
import { discordTools, handleDiscordTool } from "../agent/tools.js";
import { skillTools, handleSkillTool } from "../skills/tools.js";
import { dangerousTools, handleDangerousTool } from "../agent/dangerous-tools.js";
import { getSkillService } from "../skills/service.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_VOICE_MODEL = "claude-sonnet-4-20250514";
const VOICE_MAX_TOKENS = parseInt(process.env.VOICE_MAX_TOKENS || "512", 10);
const MAX_TOOL_ROUNDS = 5; // Max tool-use rounds before forcing a text response

function getVoiceModel(): string {
  return process.env.VOICE_MODEL || DEFAULT_VOICE_MODEL;
}

// ---------------------------------------------------------------------------
// Voice system prompt
// ---------------------------------------------------------------------------

const VOICE_SYSTEM_PROMPT = `You are a voice assistant in a Discord voice channel. You hear what users say and speak back to them.

CRITICAL RULES FOR VOICE RESPONSES:
- Respond in 1-3 SHORT spoken sentences. Maximum.
- NO markdown formatting (no bold, no code blocks, no headers, no lists).
- NO URLs or links — describe them verbally instead.
- NO bullet points or numbered lists.
- NO emojis.
- Speak naturally, like a smart friend in the room.
- Use contractions (I'm, you're, that's, etc.)
- If you don't know something, say so briefly.
- Be direct and concise — every word should earn its place.
- Numbers should be spoken form (say "about three thousand" not "3,000").

You have access to the full set of tools: memory, Discord, bash, file I/O, and skills. Use them when needed, but keep your spoken responses brief.`;

// ---------------------------------------------------------------------------
// Voice tools — everything except evolution (built dynamically for mem9)
// ---------------------------------------------------------------------------

function getFullVoiceTools(): Anthropic.Messages.Tool[] {
  return [
    ...conversationHistoryTools,
    ...getMemoryTools(),
    ...discordTools,
    ...skillTools,
    ...dangerousTools,
  ] as Anthropic.Messages.Tool[];
}

function getMinimalVoiceTools(): Anthropic.Messages.Tool[] {
  return [
    ...conversationHistoryTools,
    ...getMemoryTools(),
  ] as Anthropic.Messages.Tool[];
}

const VOICE_TOOLS_MODE = process.env.VOICE_TOOLS_MODE || "full";

function getVoiceTools(): Anthropic.Messages.Tool[] {
  return VOICE_TOOLS_MODE === "minimal" ? getMinimalVoiceTools() : getFullVoiceTools();
}

// ---------------------------------------------------------------------------
// Memory tool name matching (shared with agent.ts)
// ---------------------------------------------------------------------------

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

async function executeVoiceTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  // Memory tools (async — local FTS5 + mem9 cloud)
  if (MEMORY_TOOL_NAMES.has(name)) {
    return await handleMemoryTool(name, input);
  }
  // Discord tools (async)
  if (
    name === "send_message" ||
    name === "send_file" ||
    name === "add_reaction" ||
    name === "get_channel_history" ||
    name === "create_thread"
  ) {
    return await handleDiscordTool(name, input);
  }
  // Skill tools (sync)
  if (name === "read_skill" || name === "list_skill_files") {
    return handleSkillTool(name, input);
  }
  // Dangerous tools (async)
  if (name === "bash" || name === "read_file" || name === "write_file") {
    return await handleDangerousTool(name, input);
  }
  // Conversation history tools (sync)
  if (name === "get_conversation_history" || name === "get_conversation_stats") {
    return handleConversationHistoryTool(name, input);
  }

  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

// ---------------------------------------------------------------------------
// Conversation history (ephemeral per voice session)
// ---------------------------------------------------------------------------

interface VoiceTurn {
  role: "user" | "assistant";
  content: string;
}

const MAX_VOICE_HISTORY = 10;
let voiceHistory: VoiceTurn[] = [];

/**
 * Clear voice conversation history (call on disconnect).
 */
export function clearVoiceHistory(): void {
  voiceHistory = [];
}

// ---------------------------------------------------------------------------
// Sentence boundary detection
// ---------------------------------------------------------------------------

/** Common abbreviations that should NOT trigger a sentence split. */
const ABBREVIATIONS = /(?:Mr|Mrs|Ms|Dr|Jr|Sr|St|Prof|vs|etc|e\.g|i\.e)\s*$/i;

/**
 * Find the first sentence boundary in text.
 * Returns the index AFTER the punctuation mark, or -1 if no boundary found.
 * For voice output, splitting too eagerly is better than waiting too long.
 */
function findSentenceBoundary(text: string): number {
  const pattern = /[.!?]\s/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    // Skip common abbreviations
    const before = text.slice(Math.max(0, match.index - 6), match.index);
    if (ABBREVIATIONS.test(before)) continue;
    return match.index + 1; // position after the punctuation mark
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Build voice context (shared between streaming and non-streaming)
// ---------------------------------------------------------------------------

function buildVoiceContext(
  text: string,
  displayName: string,
): { systemPrompt: string; messages: Anthropic.Messages.MessageParam[] } {
  const systemParts: string[] = [VOICE_SYSTEM_PROMPT];
  const soul = getSoul();
  if (soul) {
    const soulBrief = soul.split("\n").slice(0, 5).join("\n");
    systemParts.push(`Personality: ${soulBrief}`);
  }

  const skillsPrompt = getSkillService()?.buildSkillsPromptSection();
  if (skillsPrompt) {
    systemParts.push(skillsPrompt);
  }

  const now = new Date().toLocaleString("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  systemParts.push(`Current time: ${now}`);
  systemParts.push(`Speaking with: ${displayName}`);

  const systemPrompt = systemParts.join("\n\n");

  const messages: Anthropic.Messages.MessageParam[] = [];
  for (const turn of voiceHistory) {
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: "user", content: text });

  return { systemPrompt, messages };
}

// ---------------------------------------------------------------------------
// Streaming voice utterance processing (main entry point)
// ---------------------------------------------------------------------------

/**
 * Process a voice utterance with streaming — delivers sentences via callback
 * as the LLM generates them, enabling sentence-level TTS pipelining.
 *
 * @param text Transcribed speech from the user
 * @param displayName Display name of the speaker
 * @param onSentence Called with each complete sentence as it becomes available
 * @param signal Optional AbortSignal to cancel mid-stream
 * @returns Full response text when complete
 */
export async function processVoiceUtteranceStreaming(
  text: string,
  displayName: string,
  onSentence: (sentence: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const startTime = Date.now();

  console.log(`[voice-agent] Streaming utterance from ${displayName}: "${text}"`);
  console.log(`[voice-agent] Voice history: ${voiceHistory.length} turns, model: ${getVoiceModel()}`);

  const { systemPrompt, messages } = buildVoiceContext(text, displayName);
  const tools = getVoiceTools();

  const allText: string[] = [];
  let sentenceBuffer = "";
  let toolRound = 0;

  function flushSentences(): void {
    let boundary = findSentenceBoundary(sentenceBuffer);
    while (boundary > 0) {
      const sentence = sentenceBuffer.slice(0, boundary).trim();
      sentenceBuffer = sentenceBuffer.slice(boundary).trimStart();
      if (sentence) {
        allText.push(sentence);
        onSentence(sentence);
      }
      boundary = findSentenceBoundary(sentenceBuffer);
    }
  }

  let continueLoop = true;

  while (continueLoop) {
    if (signal?.aborted) break;

    const stream = anthropicClient.messages.stream({
      model: getVoiceModel(),
      max_tokens: VOICE_MAX_TOKENS,
      system: systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    });

    // Wire up abort signal to cancel the stream
    if (signal) {
      const onAbort = () => stream.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      // Clean up listener when stream ends (avoid leak)
      stream.on("end", () => signal.removeEventListener("abort", onAbort));
    }

    // Accumulate text deltas and flush sentences as they complete
    stream.on("text", (delta: string) => {
      sentenceBuffer += delta;
      flushSentences();
    });

    let finalMessage: Anthropic.Message;
    try {
      finalMessage = await stream.finalMessage();
    } catch (err) {
      if (signal?.aborted) break;
      throw err;
    }

    console.log(`[voice-agent] Stream complete: stop_reason=${finalMessage.stop_reason}, blocks=${finalMessage.content.length}`);

    // Flush any remaining text from this round
    if (sentenceBuffer.trim()) {
      allText.push(sentenceBuffer.trim());
      onSentence(sentenceBuffer.trim());
      sentenceBuffer = "";
    }

    // Handle tool use
    if (finalMessage.stop_reason === "tool_use" && toolRound < MAX_TOOL_ROUNDS) {
      toolRound++;
      console.log(`[voice-agent] Tool round ${toolRound}/${MAX_TOOL_ROUNDS}`);

      messages.push({ role: "assistant", content: finalMessage.content });

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const block of finalMessage.content) {
        if (block.type === "tool_use") {
          console.log(`[voice-agent] Executing tool: ${block.name}`);
          const result = await executeVoiceTool(
            block.name,
            block.input as Record<string, unknown>,
          );
          console.log(`[voice-agent] Tool result (${block.name}): ${result.slice(0, 200)}`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
      // Continue loop — will make another streaming call
    } else {
      continueLoop = false;
    }
  }

  const fullResponse = allText.join(" ").trim();
  const elapsed = Date.now() - startTime;

  console.log(`[voice-agent] ✅ Streaming response in ${elapsed}ms (${toolRound} tool rounds): "${fullResponse}"`);

  // Update history
  voiceHistory.push({ role: "user", content: text });
  voiceHistory.push({ role: "assistant", content: fullResponse || "..." });

  while (voiceHistory.length > MAX_VOICE_HISTORY * 2) {
    voiceHistory.shift();
  }

  return fullResponse || "Sorry, I didn't have anything to say to that.";
}

// ---------------------------------------------------------------------------
// Non-streaming fallback (kept for compatibility)
// ---------------------------------------------------------------------------

/**
 * Process a transcribed voice utterance and return the text response.
 * @param text Transcribed speech from the user
 * @param userName Display name of the speaker
 * @returns Response text suitable for TTS
 */
export async function processVoiceUtterance(
  text: string,
  userName: string,
): Promise<string> {
  const startTime = Date.now();

  console.log(`[voice-agent] Processing utterance from ${userName}: "${text}"`);
  console.log(`[voice-agent] Voice history: ${voiceHistory.length} turns, model: ${getVoiceModel()}`);

  const { systemPrompt, messages } = buildVoiceContext(text, userName);
  const tools = getVoiceTools();

  // Call Claude with tool loop
  const collectedText: string[] = [];

  console.log(`[voice-agent] Calling Claude (${messages.length} messages)...`);
  let response = await anthropicClient.messages.create({
    model: getVoiceModel(),
    max_tokens: VOICE_MAX_TOKENS,
    system: systemPrompt,
    messages,
    tools: tools.length > 0 ? tools : undefined,
  });

  console.log(`[voice-agent] Claude response: stop_reason=${response.stop_reason}, content blocks=${response.content.length}`);

  // Collect text from initial response
  for (const block of response.content) {
    if (block.type === "text") {
      collectedText.push(block.text);
      console.log(`[voice-agent] Text block: "${block.text}"`);
    } else if (block.type === "tool_use") {
      console.log(`[voice-agent] Tool use block: ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`);
    }
  }

  // Tool loop — handle multiple rounds of tool calls
  let toolRound = 0;
  while (response.stop_reason === "tool_use" && toolRound < MAX_TOOL_ROUNDS) {
    toolRound++;
    console.log(`[voice-agent] Tool round ${toolRound}/${MAX_TOOL_ROUNDS}`);

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`[voice-agent] Executing tool: ${block.name}`);
        const result = await executeVoiceTool(
          block.name,
          block.input as Record<string, unknown>,
        );
        console.log(`[voice-agent] Tool result (${block.name}): ${result.slice(0, 200)}`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });

    // Follow-up call
    console.log(`[voice-agent] Follow-up Claude call after tool round ${toolRound}...`);
    response = await anthropicClient.messages.create({
      model: getVoiceModel(),
      max_tokens: VOICE_MAX_TOKENS,
      system: systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    });

    console.log(`[voice-agent] Follow-up response: stop_reason=${response.stop_reason}, blocks=${response.content.length}`);

    for (const block of response.content) {
      if (block.type === "text") {
        collectedText.push(block.text);
        console.log(`[voice-agent] Follow-up text: "${block.text}"`);
      } else if (block.type === "tool_use") {
        console.log(`[voice-agent] Tool use block: ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`);
      }
    }
  }

  const responseText = collectedText.join(" ").trim();
  const elapsed = Date.now() - startTime;

  console.log(`[voice-agent] ✅ Response in ${elapsed}ms (${toolRound} tool rounds): "${responseText}"`);

  // Update history
  voiceHistory.push({ role: "user", content: text });
  voiceHistory.push({ role: "assistant", content: responseText });

  // Trim history to max
  while (voiceHistory.length > MAX_VOICE_HISTORY * 2) {
    voiceHistory.shift();
  }

  return responseText || "Sorry, I didn't have anything to say to that.";
}
