import {
  type Client,
  type Message as DiscordMessage,
  type TextChannel,
  type ThreadChannel,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
  ChannelType,
} from "discord.js";
import { existsSync } from "fs";
import { basename, extname } from "path";
import { processMessage } from "../agent/agent.js";
import type { AgentResponse, AgentImage, ToolCallProgress } from "../agent/agent.js";
import { resolveSession, getSessionHistory } from "../agent/sessions.js";
import { getChannelConfig, addMessage } from "../db/index.js";
import {
  findLiveQuestionForMessage,
  resolveQuestion,
} from "../agent/questions.js";
import {
  buildThreadHistory,
  appendThreadMessages,
  clearThreadHistoryCache,
} from "./thread-history.js";
import type { Message as DbMessage, TokenUsage } from "../db/index.js";
import { broadcastLog } from "../gateway/server.js";
import { isRestarting } from "../restart.js";
import { transcribeAudio, getLastTranscriptionFailureSummary } from "../audio/transcribe.js";
import { recordSignal } from "../reflection/signals.js";
import { splitMessage, DISCORD_MAX_LENGTH } from "../shared/discord-utils.js";
import { acquireSessionLock, SessionAbortedError } from "../agent/session-lock.js";
import {
  isPilotChannelId,
  submitToPilotSession,
  type PilotChannelTarget,
} from "../pilot/index.js";
import { registerArtifactFromBuffer } from "../artifacts/index.js";
import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Bot client reference (needed for mention checks)
// ---------------------------------------------------------------------------

let botClient: Client | null = null;

export function setMessageClient(client: Client): void {
  botClient = client;
}

// ---------------------------------------------------------------------------
// Track threads created by the bot so we can respond without mentions
// ---------------------------------------------------------------------------

/**
 * Set of thread IDs that the bot created. Messages in these threads
 * don't require an @mention — the bot responds to everything.
 * Persisted in-memory; threads that get archived/deleted naturally
 * expire from Discord's side.
 */
const botCreatedThreads = new Set<string>();

/**
 * Register a thread ID as bot-created, so the bot responds to all
 * messages in it without requiring @mentions.
 */
export function registerBotThread(threadId: string): void {
  botCreatedThreads.add(threadId);
}

// ---------------------------------------------------------------------------
// URL validation helper
// ---------------------------------------------------------------------------

/**
 * Validate and optionally sanitize a URL for use in Discord embeds.
 * Returns the sanitized URL string if valid, or null if the URL is malformed.
 *
 * Attempts basic fixes:
 * - Prepend "https://" if protocol is missing
 * - Encode spaces as %20
 */
function sanitizeImageUrl(url: string): string | null {
  let candidate = url.trim();

  // Quick reject: empty strings or obvious non-URLs
  if (!candidate || candidate.length < 5) return null;

  // Attempt fix: prepend https:// if no protocol
  if (!candidate.match(/^https?:\/\//i)) {
    // Only prepend if it looks like a domain (contains a dot)
    if (candidate.includes(".")) {
      candidate = `https://${candidate}`;
    } else {
      return null;
    }
  }

  // Attempt fix: encode spaces
  candidate = candidate.replace(/ /g, "%20");

  // Validate with URL constructor
  try {
    const parsed = new URL(candidate);
    // Ensure it's actually http(s) — reject data: URIs, javascript:, etc.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Image handling helpers
// ---------------------------------------------------------------------------

/** Discord supports up to 10 embeds per message. */
const MAX_EMBEDS_PER_MESSAGE = 10;

/**
 * Build Discord embeds for URL-based images.
 * Each image gets its own embed so Discord renders them all.
 * Invalid URLs are filtered out with a warning log to prevent
 * Discord API rejections (URL_TYPE_INVALID_URL).
 */
function buildImageEmbeds(images: AgentImage[]): EmbedBuilder[] {
  const urlImages = images.filter((img) => img.type === "url");
  const embeds: EmbedBuilder[] = [];

  for (const img of urlImages.slice(0, MAX_EMBEDS_PER_MESSAGE)) {
    const validUrl = sanitizeImageUrl(img.source);
    if (!validUrl) {
      console.warn(
        `[bot] Skipping invalid image URL for embed: "${img.source.slice(0, 200)}"`,
      );
      continue;
    }

    const embed = new EmbedBuilder().setImage(validUrl);
    if (img.alt) {
      embed.setDescription(img.alt);
    }
    embeds.push(embed);
  }

  return embeds;
}

/**
 * Build Discord attachment builders for local file images.
 */
function buildImageAttachments(images: AgentImage[]): AttachmentBuilder[] {
  const fileImages = images.filter(
    (img) => img.type === "file" && existsSync(img.source),
  );
  return fileImages.map((img) => {
    const name = basename(img.source);
    return new AttachmentBuilder(img.source, { name, description: img.alt });
  });
}

// ---------------------------------------------------------------------------
// Token usage formatting
// ---------------------------------------------------------------------------

/** Per-million-token pricing */
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreate: number }> = {
  default: { input: 3.0, output: 15.0, cacheRead: 0.30, cacheCreate: 3.75 },
};

function getModelPricing(model: string) {
  // Could add model-specific pricing here in the future
  void model;
  return PRICING.default;
}

/** Format token count: 1234 → "1.2k", 123456 → "123.5k" */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Format duration in seconds: 45200 → "45.2s", 125000 → "2m 5s" */
function fmtDuration(ms: number): string {
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = Math.round(secs % 60);
  return `${mins}m ${remainSecs}s`;
}

/** Build a single-line usage string for appending to the message */
function formatUsageLine(usage: TokenUsage, durationMs?: number): string {
  const pricing = getModelPricing(usage.model);
  const cost =
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheReadTokens * pricing.cacheRead +
      usage.cacheCreationTokens * pricing.cacheCreate) /
    1e6;

  const durationPart = durationMs != null ? ` · ${fmtDuration(durationMs)}` : "";
  return `-# 📊 ${usage.model} · ${fmtTokens(usage.inputTokens)} in / ${fmtTokens(usage.outputTokens)} out · $${cost.toFixed(4)}${durationPart}`;
}

// ---------------------------------------------------------------------------
// Voice message detection & transcription
// ---------------------------------------------------------------------------

/** Audio file extensions that we can transcribe. */
const AUDIO_EXTENSIONS = /\.(ogg|mp3|wav|m4a|webm|mp4|mpeg|mpga|oga|flac)$/i;

/**
 * Check if a Discord message is a voice message.
 * Discord voice messages have the IsVoiceMessage flag (8192) and
 * include an audio attachment (typically .ogg).
 */
function isVoiceMessage(message: DiscordMessage): boolean {
  return message.flags.has(MessageFlags.IsVoiceMessage);
}

/**
 * Check if a message has audio attachments (even without the voice flag).
 */
function hasAudioAttachments(message: DiscordMessage): boolean {
  return message.attachments.some((att) =>
    AUDIO_EXTENSIONS.test(att.name || ""),
  );
}

/**
 * Attempt to transcribe audio attachments from a message.
 * Tries fully local transcription (NVIDIA Parakeet) first, falling back to
 * OpenAI's Whisper API only if local transcription is unavailable/fails and
 * OPENAI_API_KEY is set (see ../audio/transcribe.ts).
 * Returns transcribed text or null if transcription isn't possible.
 *
 * @param onStatus - optional callback for surfacing progress (e.g. one-time
 *   local model setup) to the user.
 */
async function transcribeVoiceMessage(
  message: DiscordMessage,
  onStatus?: (msg: string) => void,
): Promise<string | null> {
  // Get audio attachments
  const audioAttachments = message.attachments.filter((att) =>
    AUDIO_EXTENSIONS.test(att.name || ""),
  );

  if (audioAttachments.size === 0) return null;

  const transcriptions: string[] = [];

  for (const [, attachment] of audioAttachments) {
    try {
      const text = await transcribeAudio(attachment.url, attachment.name, onStatus);
      if (text) {
        transcriptions.push(text);
      }
    } catch (err) {
      console.error(
        `[bot] Failed to transcribe attachment ${attachment.name}:`,
        err,
      );
    }
  }

  return transcriptions.length > 0 ? transcriptions.join("\n") : null;
}

// ---------------------------------------------------------------------------
// Image attachment handling — convert Discord images to Claude content blocks
// ---------------------------------------------------------------------------

/** Image MIME types that Claude supports. */
const SUPPORTED_IMAGE_TYPES: Record<string, Anthropic.Messages.Base64ImageSource["media_type"]> = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

/** Max image size to fetch (20 MB). Discord CDN allows up to 25 MB. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Check if a Discord message has image attachments.
 */
function hasImageAttachments(message: DiscordMessage): boolean {
  return message.attachments.some((att) => {
    const ct = att.contentType?.toLowerCase() || "";
    return ct in SUPPORTED_IMAGE_TYPES;
  });
}

/**
 * Fetch image attachments from a Discord message and convert them to
 * Anthropic ImageBlockParam content blocks (base64-encoded).
 *
 * Also registers each image as an input artifact when sessionId is provided.
 *
 * Skips images that are too large or fail to download.
 */
async function buildImageContentBlocks(
  message: DiscordMessage,
  sessionId?: string,
): Promise<Anthropic.Messages.ImageBlockParam[]> {
  const imageAttachments = message.attachments.filter((att) => {
    const ct = att.contentType?.toLowerCase() || "";
    return ct in SUPPORTED_IMAGE_TYPES;
  });

  if (imageAttachments.size === 0) return [];

  const blocks: Anthropic.Messages.ImageBlockParam[] = [];

  for (const [, attachment] of imageAttachments) {
    try {
      // Skip overly large images
      if (attachment.size && attachment.size > MAX_IMAGE_BYTES) {
        console.log(
          `[bot] Skipping image ${attachment.name} — too large (${(attachment.size / 1024 / 1024).toFixed(1)} MB)`,
        );
        continue;
      }

      const response = await fetch(attachment.url);
      if (!response.ok) {
        console.error(
          `[bot] Failed to fetch image ${attachment.name}: HTTP ${response.status}`,
        );
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString("base64");
      const mediaType =
        SUPPORTED_IMAGE_TYPES[attachment.contentType?.toLowerCase() || ""];

      if (!mediaType) continue;

      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: base64,
        },
      });

      // Register as input artifact (fire-and-forget — don't block on this)
      if (sessionId) {
        registerArtifactFromBuffer(
          {
            sessionId,
            direction: "input",
            filename: attachment.name || "image",
            mimeType: mediaType,
            discordUrl: attachment.url,
            discordMessageId: message.id,
            sizeBytes: buffer.length,
            metadata: {
              width: attachment.width ?? undefined,
              height: attachment.height ?? undefined,
            },
          },
          buffer,
        ).catch((err) =>
          console.error(`[bot] Failed to register image artifact:`, err),
        );
      }

      console.log(
        `[bot] Loaded image attachment: ${attachment.name} (${mediaType}, ${(buffer.length / 1024).toFixed(0)} KB)`,
      );
    } catch (err) {
      console.error(
        `[bot] Failed to process image attachment ${attachment.name}:`,
        err,
      );
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Text file & document attachment handling
// ---------------------------------------------------------------------------

/**
 * Text-based file extensions we recognize (by extension).
 * These are fetched and their contents injected as document blocks.
 */
const TEXT_FILE_EXTENSIONS = new Set([
  // Plain text & docs
  ".txt", ".md", ".markdown", ".rst", ".org",
  // Config / data
  ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".env", ".env.example", ".properties",
  ".csv", ".tsv",
  ".xml", ".svg",
  // Programming languages
  ".js", ".mjs", ".cjs", ".jsx",
  ".ts", ".mts", ".cts", ".tsx",
  ".py", ".pyw",
  ".rb", ".rake",
  ".go",
  ".rs",
  ".java", ".kt", ".kts", ".scala",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx",
  ".cs",
  ".swift",
  ".php",
  ".r",
  ".lua",
  ".pl", ".pm",
  ".sh", ".bash", ".zsh", ".fish",
  ".bat", ".cmd", ".ps1",
  ".zig", ".nim", ".ex", ".exs", ".erl", ".hrl",
  ".hs", ".lhs",
  ".clj", ".cljs", ".cljc",
  ".ml", ".mli", ".elm",
  ".dart", ".v", ".sol",
  // Web
  ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".vue", ".svelte", ".astro",
  // Build / CI
  ".dockerfile", ".dockerignore",
  ".gitignore", ".gitattributes",
  ".editorconfig",
  ".eslintrc", ".prettierrc",
  // SQL
  ".sql",
  // Misc
  ".log", ".diff", ".patch",
  ".graphql", ".gql",
  ".proto",
  ".tf", ".hcl",
  ".makefile",
]);

/**
 * MIME type prefixes that indicate a text-based file
 * (used as fallback when extension is unknown).
 */
const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/toml",
  "application/sql",
  "application/graphql",
  "application/x-sh",
];

/** Max text file size to fetch (1 MB — text files can be large but we need to be reasonable). */
const MAX_TEXT_FILE_BYTES = 1 * 1024 * 1024;

/** Max characters to include from a single text file (to avoid blowing up context). */
const MAX_TEXT_FILE_CHARS = 500_000;

/**
 * Check if an attachment is a text-based file we can read.
 */
function isTextFileAttachment(att: { name: string | null; contentType: string | null; size: number }): boolean {
  const name = att.name || "";
  const ct = att.contentType?.toLowerCase() || "";

  // Check by extension
  const ext = extname(name).toLowerCase();

  // Special case: files with no extension but a known name
  const baseName = basename(name).toLowerCase();
  const knownNames = new Set(["makefile", "dockerfile", "rakefile", "gemfile", "procfile", "jenkinsfile", "vagrantfile"]);

  if (ext && TEXT_FILE_EXTENSIONS.has(ext)) return true;
  if (knownNames.has(baseName)) return true;

  // Fallback: check MIME type
  if (ct && TEXT_MIME_PREFIXES.some((prefix) => ct.startsWith(prefix))) return true;

  return false;
}

/**
 * Check if an attachment is a PDF file.
 */
function isPdfAttachment(att: { name: string | null; contentType: string | null }): boolean {
  const name = att.name || "";
  const ct = att.contentType?.toLowerCase() || "";
  return ct === "application/pdf" || extname(name).toLowerCase() === ".pdf";
}

/**
 * Check if a Discord message has text file attachments (not images, not audio).
 */
function hasTextFileAttachments(message: DiscordMessage): boolean {
  return message.attachments.some((att) => isTextFileAttachment(att));
}

/**
 * Check if a Discord message has PDF attachments.
 */
function hasPdfAttachments(message: DiscordMessage): boolean {
  return message.attachments.some((att) => isPdfAttachment(att));
}

/**
 * Fetch text file attachments and build Anthropic DocumentBlockParam blocks.
 * Uses PlainTextSource for text files.
 *
 * Also registers each file as an input artifact when sessionId is provided.
 */
async function buildTextFileContentBlocks(
  message: DiscordMessage,
  sessionId?: string,
): Promise<Anthropic.Messages.DocumentBlockParam[]> {
  const textAttachments = message.attachments.filter((att) => isTextFileAttachment(att));

  if (textAttachments.size === 0) return [];

  const blocks: Anthropic.Messages.DocumentBlockParam[] = [];

  for (const [, attachment] of textAttachments) {
    try {
      // Skip overly large files
      if (attachment.size && attachment.size > MAX_TEXT_FILE_BYTES) {
        console.log(
          `[bot] Skipping text file ${attachment.name} — too large (${(attachment.size / 1024).toFixed(0)} KB, max ${(MAX_TEXT_FILE_BYTES / 1024).toFixed(0)} KB)`,
        );
        continue;
      }

      const response = await fetch(attachment.url);
      if (!response.ok) {
        console.error(
          `[bot] Failed to fetch text file ${attachment.name}: HTTP ${response.status}`,
        );
        continue;
      }

      let text = await response.text();

      // Register as input artifact (save full content before truncation)
      if (sessionId) {
        const textBuffer = Buffer.from(text, "utf-8");
        registerArtifactFromBuffer(
          {
            sessionId,
            direction: "input",
            filename: attachment.name || "file.txt",
            mimeType: attachment.contentType || "text/plain",
            discordUrl: attachment.url,
            discordMessageId: message.id,
            sizeBytes: textBuffer.length,
            metadata: { charCount: text.length },
          },
          textBuffer,
        ).catch((err) =>
          console.error(`[bot] Failed to register text file artifact:`, err),
        );
      }

      // Truncate if too long
      if (text.length > MAX_TEXT_FILE_CHARS) {
        text = text.slice(0, MAX_TEXT_FILE_CHARS) + `\n\n[... truncated at ${MAX_TEXT_FILE_CHARS.toLocaleString()} characters]`;
        console.log(
          `[bot] Truncated text file ${attachment.name} to ${MAX_TEXT_FILE_CHARS.toLocaleString()} characters`,
        );
      }

      blocks.push({
        type: "document",
        source: {
          type: "text",
          media_type: "text/plain",
          data: text,
        },
        title: attachment.name || undefined,
      });

      console.log(
        `[bot] Loaded text file: ${attachment.name} (${text.length.toLocaleString()} chars)`,
      );
    } catch (err) {
      console.error(
        `[bot] Failed to process text file ${attachment.name}:`,
        err,
      );
    }
  }

  return blocks;
}

/**
 * Fetch PDF attachments and build Anthropic DocumentBlockParam blocks.
 * Uses Base64PDFSource for PDFs.
 *
 * Also registers each PDF as an input artifact when sessionId is provided.
 */
async function buildPdfContentBlocks(
  message: DiscordMessage,
  sessionId?: string,
): Promise<Anthropic.Messages.DocumentBlockParam[]> {
  const pdfAttachments = message.attachments.filter((att) => isPdfAttachment(att));

  if (pdfAttachments.size === 0) return [];

  const blocks: Anthropic.Messages.DocumentBlockParam[] = [];

  for (const [, attachment] of pdfAttachments) {
    try {
      // Skip overly large files (PDFs can be up to 32MB for Claude)
      const maxPdfBytes = 32 * 1024 * 1024;
      if (attachment.size && attachment.size > maxPdfBytes) {
        console.log(
          `[bot] Skipping PDF ${attachment.name} — too large (${(attachment.size / 1024 / 1024).toFixed(1)} MB, max 32 MB)`,
        );
        continue;
      }

      const response = await fetch(attachment.url);
      if (!response.ok) {
        console.error(
          `[bot] Failed to fetch PDF ${attachment.name}: HTTP ${response.status}`,
        );
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString("base64");

      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: base64,
        },
        title: attachment.name || undefined,
      });

      // Register as input artifact (fire-and-forget)
      if (sessionId) {
        registerArtifactFromBuffer(
          {
            sessionId,
            direction: "input",
            filename: attachment.name || "document.pdf",
            mimeType: "application/pdf",
            discordUrl: attachment.url,
            discordMessageId: message.id,
            sizeBytes: buffer.length,
          },
          buffer,
        ).catch((err) =>
          console.error(`[bot] Failed to register PDF artifact:`, err),
        );
      }

      console.log(
        `[bot] Loaded PDF: ${attachment.name} (${(buffer.length / 1024).toFixed(0)} KB)`,
      );
    } catch (err) {
      console.error(
        `[bot] Failed to process PDF ${attachment.name}:`,
        err,
      );
    }
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Thread creation helper
// ---------------------------------------------------------------------------

/** Maximum length for a Discord thread name */
const MAX_THREAD_NAME_LENGTH = 100;

/**
 * Generate a short thread name from the user's message.
 * Uses the first line/sentence, truncated to Discord's limit.
 */
function generateThreadName(userMessage: string, userName: string): string {
  // Take first line or first 80 chars
  let name = userMessage.split("\n")[0].trim();

  // If the message is very short or empty after stripping, use a generic name
  if (!name || name.length < 3) {
    name = `Chat with ${userName}`;
  }

  // Truncate to Discord's limit (leave room for ellipsis)
  if (name.length > MAX_THREAD_NAME_LENGTH - 1) {
    name = name.slice(0, MAX_THREAD_NAME_LENGTH - 1) + "…";
  }

  return name;
}

/**
 * Create a thread on the user's message and return it.
 * Returns null if thread creation fails.
 */
async function createThreadForReply(
  message: DiscordMessage,
  cleanContent: string,
): Promise<ThreadChannel | null> {
  try {
    const threadName = generateThreadName(
      cleanContent,
      message.author.displayName ?? message.author.username,
    );

    const thread = await message.startThread({
      name: threadName,
      autoArchiveDuration: 1440, // 24 hours
    });

    // Track this as a bot-created thread
    botCreatedThreads.add(thread.id);

    console.log(
      `[bot] Created thread "${threadName}" (${thread.id}) for message ${message.id}`,
    );

    return thread;
  } catch (err) {
    console.error("[bot] Failed to create thread:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Channel type helpers
// ---------------------------------------------------------------------------

/**
 * Check if a message is in a guild text channel (not a thread, not a DM).
 * These are the messages that should spawn a new thread.
 */
function isGuildTextChannel(message: DiscordMessage): boolean {
  const channelType = message.channel.type;
  return (
    channelType === ChannelType.GuildText ||
    channelType === ChannelType.GuildAnnouncement
  );
}

/**
 * Check if a message is inside a thread.
 */
function isThreadChannel(message: DiscordMessage): boolean {
  const channelType = message.channel.type;
  return (
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread
  );
}

/**
 * Check if a thread was created by the bot (and thus doesn't need @mentions).
 */
function isBotCreatedThread(message: DiscordMessage): boolean {
  if (!isThreadChannel(message)) return false;

  // Check our in-memory set first
  if (botCreatedThreads.has(message.channel.id)) return true;

  // Fallback: check if the thread owner is the bot
  const thread = message.channel as ThreadChannel;
  if (thread.ownerId && botClient?.user?.id && thread.ownerId === botClient.user.id) {
    // Cache it for future lookups
    botCreatedThreads.add(thread.id);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Monitored channel helpers
// ---------------------------------------------------------------------------

/**
 * Check if a channel is "monitored" — meaning the bot should respond to all
 * messages without requiring an @mention, creating threads for top-level
 * messages and responding directly in threads under monitored channels.
 *
 * The `monitor` flag is stored in the channel_configs settings JSON:
 *   { "monitor": true }
 */
function isMonitoredChannel(message: DiscordMessage): boolean {
  // Determine the base channel ID to check config for
  let channelIdToCheck: string;

  if (isThreadChannel(message)) {
    // For threads, check the parent channel's config
    const parentId = (message.channel as ThreadChannel).parentId;
    if (!parentId) return false;
    channelIdToCheck = parentId;
  } else {
    channelIdToCheck = message.channelId;
  }

  const config = getChannelConfig(channelIdToCheck);
  return config?.settings?.monitor === true;
}

/**
 * True when this message belongs to a channel running in pilot mode
 * (Claude Agent SDK sessions instead of our own agent loop).
 *
 * Pilot mode is a per-channel data flag: channel_configs.settings.pilot.
 * Threads under a pilot channel are NOT pilot — they fall back to the normal
 * agent path, so pilot stays a single-channel experiment.
 */
function isPilotChannel(message: DiscordMessage): boolean {
  if (message.channel.isDMBased()) return false;
  if (isThreadChannel(message)) return false;
  return isPilotChannelId(message.channelId);
}

// ---------------------------------------------------------------------------
// Discord thread history fetching
// ---------------------------------------------------------------------------

/** Max messages to fetch from Discord thread history */
const MAX_THREAD_HISTORY_MESSAGES = 50;

/**
 * Fetch message history from a Discord thread and convert to DbMessage format.
 * This provides context when the DB session is new/empty but the thread
 * already has conversation history.
 *
 * Excludes the current message (which will be sent separately).
 * Returns messages in chronological order (oldest first).
 */
async function fetchDiscordThreadHistory(
  thread: ThreadChannel,
  currentMessageId: string,
  sessionId: string,
): Promise<DbMessage[]> {
  try {
    const botUserId = botClient?.user?.id;

    // Fetch recent messages from the thread (Discord returns newest-first)
    const discordMessages = await thread.messages.fetch({
      limit: MAX_THREAD_HISTORY_MESSAGES,
    });

    if (discordMessages.size === 0) return [];

    // Convert to array, filter out the current message, and sort chronologically
    const sorted = Array.from(discordMessages.values())
      .filter((msg) => msg.id !== currentMessageId)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (sorted.length === 0) return [];

    // Convert Discord messages to DbMessage format
    const messages: DbMessage[] = [];
    let idCounter = 0;

    for (const msg of sorted) {
      // Determine role: bot messages are "assistant", everything else is "user"
      const isBot = msg.author.bot && msg.author.id === botUserId;
      const role = isBot ? "assistant" : "user";

      // Get message content — prefix user messages with the author name
      // for multi-user threads so the agent knows who said what
      let content = msg.content || "";

      // Skip empty messages (e.g. embeds-only from the bot, system messages)
      if (!content && msg.attachments.size === 0) continue;

      // For user messages, prefix with author name
      if (role === "user" && content) {
        const authorName = msg.author.displayName ?? msg.author.username;
        content = `${authorName}: ${content}`;
      }

      // Note attachments if present
      if (msg.attachments.size > 0 && role === "user") {
        const attachmentNames = msg.attachments.map((att) => att.name).filter(Boolean).join(", ");
        if (attachmentNames) {
          content = content
            ? `${content}\n\n[Attachments: ${attachmentNames}]`
            : `[Attachments: ${attachmentNames}]`;
        }
      }

      if (!content) continue;

      // Strip bot mentions from content (clean up for context)
      if (botUserId) {
        content = content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
      }

      if (!content) continue;

      messages.push({
        id: idCounter++,
        sessionId,
        role,
        content,
        discordMessageId: msg.id,
        createdAt: msg.createdTimestamp,
      });
    }

    return messages;
  } catch (err) {
    console.error("[bot] Failed to fetch Discord thread history:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool call progress → Discord message formatting
// ---------------------------------------------------------------------------

/** Emoji map for tool categories */
const TOOL_EMOJI: Record<string, string> = {
  // Memory
  memory_search: "🔍",
  memory_get: "📖",
  mem9_store: "💾",
  mem9_update: "✏️",
  mem9_delete: "🗑️",
  // Discord
  send_message: "💬",
  send_file: "📎",
  add_reaction: "😀",
  get_channel_history: "📜",
  create_thread: "🧵",
  // Skills
  read_skill: "📚",
  list_skill_files: "📂",
  // Dangerous / system
  bash: "⚙️",
  read_file: "📄",
  write_file: "✍️",
  // Evolution
  evolve_start: "🧬",
  evolve_read: "🧬",
  evolve_write: "🧬",
  evolve_bash: "🧬",
  evolve_propose: "🧬",
  evolve_suggest: "💡",
  evolve_cancel: "🧬",
  evolve_review: "🧬",
  evolve_merge: "🧬",
  // Conversation history
  get_conversation_history: "📜",
  get_conversation_stats: "📊",
};

/** Max length for tool input/result preview in Discord message */


/** Truncate a string and add ellipsis if too long */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Format a tool input object into a brief human-readable preview.
 * Shows key parameters without overwhelming the Discord channel.
 */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  // For specific tools, show the most relevant parameter
  switch (toolName) {
    case "memory_search":
      return input.query ? `\`${truncate(String(input.query), 80)}\`` : "";
    case "memory_get":
      return input.path ? `\`${truncate(String(input.path), 80)}\`` : "";
    case "mem9_store":
      return input.content ? `\`${truncate(String(input.content), 100)}\`` : "";
    case "bash":
      return input.command ? `\`${truncate(String(input.command), 120)}\`` : "";
    case "read_file":
    case "write_file":
      return input.path ? `\`${truncate(String(input.path), 100)}\`` : "";
    case "read_skill":
      return input.skill_name ? `\`${String(input.skill_name)}\`` : "";
    case "send_message":
      return input.text ? `\`${truncate(String(input.text), 80)}\`` : "";
    case "evolve_start":
      return input.reason ? `\`${truncate(String(input.reason), 100)}\`` : "";
    case "evolve_read":
    case "evolve_write":
      return input.path ? `\`${truncate(String(input.path), 100)}\`` : "";
    case "evolve_bash":
      return input.command ? `\`${truncate(String(input.command), 120)}\`` : "";
    case "evolve_propose":
      return input.summary ? `\`${truncate(String(input.summary), 100)}\`` : "";
    case "evolve_suggest":
      return input.what ? `\`${truncate(String(input.what), 100)}\`` : "";
    default: {
      // Generic: show first string-valued key
      const firstKey = Object.keys(input).find((k) => typeof input[k] === "string");
      if (firstKey) {
        return `\`${truncate(String(input[firstKey]), 80)}\``;
      }
      return "";
    }
  }
}

/**
 * Extract an error message from a tool result, if any.
 * Returns an error string if the tool failed, or null if it succeeded.
 */
function extractToolError(result: string): string | null {
  try {
    const parsed = JSON.parse(result);
    if (parsed.error) {
      return truncate(String(parsed.error), 120);
    }
  } catch {
    // Not JSON
  }
  // Check for common error patterns in raw text
  if (result.startsWith("Error:") || result.startsWith("error:")) {
    return truncate(result, 120);
  }
  return null;
}

/**
 * Build the Discord message text for a tool call progress event.
 * Shows tool name + input only. Appends error info if the tool failed.
 * Returns null if this tool call should be silently skipped.
 */
function formatToolCallMessage(progress: ToolCallProgress): string | null {
  const emoji = TOOL_EMOJI[progress.toolName] || "\u{1f527}";
  const inputPreview = formatToolInput(progress.toolName, progress.toolInput);
  const inputPart = inputPreview ? ` ${inputPreview}` : "";

  if (progress.phase === "start") {
    return `-# ${emoji} **${progress.toolName}**${inputPart}`;
  }

  // phase === "result" — show tool name + input, append error only if failed
  if (progress.result !== undefined) {
    const error = extractToolError(progress.result);
    if (error) {
      return `-# ${emoji} **${progress.toolName}**${inputPart} \u2014 \u274c ${error}`;
    }
    // Success — just show tool name + input (no result preview)
    return `-# ${emoji} **${progress.toolName}**${inputPart}`;
  }

  return null;
}


// ---------------------------------------------------------------------------
// Rate-limited tool call progress sender
// ---------------------------------------------------------------------------

/**
 * Creates an onToolCallProgress callback that sends tool call updates
 * to a Discord channel as separate messages.
 *
 * Batches rapid tool calls to respect Discord rate limits (~5 msgs / 5s).
 * Only sends "result" phase messages (start + result would double the noise).
 */
function createToolCallProgressHandler(
  replyTarget: DiscordMessage["channel"] | ThreadChannel,
): (progress: ToolCallProgress) => Promise<void> {
  // Rate limiting: track messages sent in the current window
  let messagesSentInWindow = 0;
  let windowStart = Date.now();
  const MAX_MESSAGES_PER_WINDOW = 4; // Leave headroom for the final response
  const WINDOW_MS = 5000; // 5 second window

  // Batch buffer for when rate limited
  let pendingBatch: string[] = [];
  let batchFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const sendToDiscord = async (text: string) => {
    if (!("send" in replyTarget)) return;

    // Ensure within Discord's 2000 char limit
    const truncatedText = text.length > DISCORD_MAX_LENGTH
      ? text.slice(0, DISCORD_MAX_LENGTH - 3) + "..."
      : text;

    try {
      await (replyTarget as TextChannel | ThreadChannel).send(truncatedText);
    } catch (err) {
      console.error("[bot] Failed to send tool progress message:", err);
    }
  };

  const flushBatch = async () => {
    if (pendingBatch.length === 0) return;
    const combined = pendingBatch.join("\n");
    pendingBatch = [];
    batchFlushTimer = null;
    await sendToDiscord(combined);
    messagesSentInWindow++;
  };

  return async (progress: ToolCallProgress) => {
    // Only send "result" phase to reduce noise — shows both input and output in one message
    if (progress.phase !== "result") return;

    const msgText = formatToolCallMessage(progress);
    if (!msgText) return;

    // Reset rate limit window if enough time has passed
    const now = Date.now();
    if (now - windowStart > WINDOW_MS) {
      messagesSentInWindow = 0;
      windowStart = now;
    }

    // If under rate limit, send immediately (flushing any pending batch first)
    if (messagesSentInWindow < MAX_MESSAGES_PER_WINDOW) {
      if (pendingBatch.length > 0) {
        pendingBatch.push(msgText);
        await flushBatch();
      } else {
        await sendToDiscord(msgText);
        messagesSentInWindow++;
      }
    } else {
      // Over rate limit — batch the message
      pendingBatch.push(msgText);

      // Set a flush timer if not already set
      if (!batchFlushTimer) {
        const timeToWindowEnd = WINDOW_MS - (now - windowStart);
        batchFlushTimer = setTimeout(async () => {
          messagesSentInWindow = 0;
          windowStart = Date.now();
          await flushBatch();
        }, timeToWindowEnd + 100); // Small buffer after window resets
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Main message handler
// ---------------------------------------------------------------------------

export async function handleMessage(message: DiscordMessage): Promise<void> {
  // 0. Filter: ignore messages during restart (prevents double replies)
  if (isRestarting()) return;

  // 1. Filter: skip bot messages
  if (message.author.bot) return;

  const isDM = message.channel.isDMBased();
  const isVoice = isVoiceMessage(message);
  const hasAudio = hasAudioAttachments(message);
  const hasImages = hasImageAttachments(message);
  const hasTextFiles = hasTextFileAttachments(message);
  const hasPdfs = hasPdfAttachments(message);
  const hasDocuments = hasTextFiles || hasPdfs;
  const inBotThread = isBotCreatedThread(message);
  const inMonitoredChannel = !isDM && isMonitoredChannel(message);
  const inPilotChannel = isPilotChannel(message);

  console.log(
    `[bot] Message from ${message.author.tag} isDM=${isDM} isVoice=${isVoice} hasAudio=${hasAudio} hasImages=${hasImages} hasTextFiles=${hasTextFiles} hasPdfs=${hasPdfs} inBotThread=${inBotThread} monitored=${inMonitoredChannel} content="${message.content.slice(0, 80)}"`,
  );

  // 2. Filter: in guild channels, respond when mentioned OR when in a bot-created thread OR when in a monitored channel
  if (!isDM) {
    const botUser = botClient?.user;
    if (!botUser) {
      console.log("[bot] Skipping — botClient.user is null");
      return;
    }
    // In bot-created threads, monitored channels (and their threads), respond to all messages (no mention needed)
    // In other channels/threads, require a mention
    if (
      !inBotThread &&
      !inMonitoredChannel &&
      !inPilotChannel &&
      !message.mentions.has(botUser)
    ) {
      console.log("[bot] Skipping — bot not mentioned and not in bot thread or monitored channel");
      return;
    }
  }

  // 3. Filter: check channel config
  // For threads, check the parent channel's config
  const configChannelId = isThreadChannel(message)
    ? (message.channel as ThreadChannel).parentId ?? message.channelId
    : message.channelId;
  const channelConfig = getChannelConfig(configChannelId);
  if (channelConfig?.enabled === false) return;

  // 3b. If a pending ask_user question is waiting in this channel, this
  // message IS the answer — hand it to the blocked agent turn instead of
  // starting a new one.
  const liveQuestion = findLiveQuestionForMessage(
    message.channelId,
    message.author.id,
  );
  if (liveQuestion) {
    const answerText = message.content.replace(/<@!?\d+>/g, "").trim();
    if (answerText) {
      const recorded = resolveQuestion(liveQuestion.id, answerText, "message");
      if (recorded !== null) {
        console.log(
          `[bot] Routed message as answer to question ${liveQuestion.id}`,
        );
        await message.react("✅").catch(() => {});
        return;
      }
    }
  }

  // 4. Determine if we need to create a thread
  // Create thread for guild text channel messages (not DMs, not already in threads)
  const shouldCreateThread = !isDM && isGuildTextChannel(message);

  // 5. Session resolve — use thread ID for isolation
  const isThread = isThreadChannel(message);

  // For new thread creation, we'll update the session after creating the thread
  // For existing threads, use the thread ID
  // For DMs, use existing behavior
  let sessionThreadId: string | undefined;
  if (isThread) {
    sessionThreadId = message.channel.id;
  }
  // If shouldCreateThread, we'll set this after thread creation

  // 6. Build context
  // Strip bot mention from content before sending to the agent
  let cleanContent = message.content.replace(/<@!?\d+>/g, "").trim();

  // 6b. Handle voice messages — transcribe audio and use as message content
  if (isVoice || hasAudio) {
    // Show typing while we transcribe
    if ("sendTyping" in message.channel) {
      message.channel.sendTyping().catch(() => {});
    }

    // Surface first-time local model setup progress (one-time, can take a
    // few minutes) directly in the channel instead of leaving the user
    // guessing.
    const onTranscriptionStatus = (msg: string) => {
      if ("send" in message.channel) {
        (message.channel as TextChannel | ThreadChannel).send(msg).catch(() => {});
      }
    };

    const transcript = await transcribeVoiceMessage(message, onTranscriptionStatus);

    if (transcript) {
      console.log(
        `[bot] Voice transcription: "${transcript.slice(0, 100)}${transcript.length > 100 ? "..." : ""}"`,
      );

      // Combine any text content with the transcription
      if (cleanContent) {
        cleanContent = `${cleanContent}\n\n[Voice message transcription]: ${transcript}`;
      } else {
        cleanContent = transcript;
      }
    } else if (!cleanContent && !hasImages && !hasDocuments) {
      // No transcription available and no text content and no images and no documents.
      // Log full diagnostics (why local + fallback both failed) so this is easy to
      // debug from server logs, even though the user only sees a friendly message.
      const failureSummary = getLastTranscriptionFailureSummary();
      const voiceChannelName =
        "name" in message.channel && message.channel.name ? message.channel.name : "DM";
      console.error(
        `[bot] Voice transcription unavailable for ${message.author.tag} in ${voiceChannelName}. ${failureSummary || "No diagnostic details captured."}`,
      );

      recordSignal({
        type: "error",
        source: "messages",
        detail: `Voice transcription failed: ${failureSummary || "no diagnostic details"}`,
        metadata: { channelName: voiceChannelName, attachmentCount: message.attachments.size },
        userId: message.author.id,
      });

      await message.reply(
        "🎤 I couldn't transcribe your voice message — local transcription setup may still be running or failed, and no fallback is configured. Please try again shortly, or type your message instead.",
      );
      return;
    }
  }

  // 6e. Pilot mode — hand the channel over to a Claude Agent SDK session
  // instead of our own agent loop. Placed after transcription so voice still
  // works, and before thread creation so pilot stays in-channel (a persistent
  // session per channel is what allows mid-turn message injection).
  if (inPilotChannel) {
    if (!cleanContent) {
      if (hasImages || hasDocuments) {
        await message
          .reply(
            "🧪 Pilot mode doesn't handle image/document attachments yet — send text (or a path to the file) instead.",
          )
          .catch(() => {});
      }
      return;
    }

    const target = message.channel as unknown as PilotChannelTarget;
    submitToPilotSession(target, {
      text: cleanContent,
      userId: message.author.id,
      userName: message.author.displayName ?? message.author.username,
    });
    console.log(
      `[bot] Routed message to pilot session for channel ${message.channelId}`,
    );
    return;
  }

  // 7. Create thread if needed (before resolving session so session uses thread ID)
  let replyTarget: DiscordMessage["channel"] | ThreadChannel = message.channel;

  if (shouldCreateThread) {
    const thread = await createThreadForReply(message, cleanContent || "[Attachment]");
    if (thread) {
      replyTarget = thread;
      sessionThreadId = thread.id;
    }
    // If thread creation fails, fall back to replying in channel directly
  }

  // 8. Now resolve session with the correct thread ID
  const session = resolveSession({
    threadId: sessionThreadId,
    channelId: message.channelId,
    userId: message.author.id,
    guildId: message.guildId || undefined,
    isDM,
  });

  // 6c. Handle image attachments — build Claude vision content blocks
  // (Now done AFTER session resolution so we can register artifacts)
  let imageBlocks: Anthropic.Messages.ImageBlockParam[] = [];
  if (hasImages) {
    // Show typing while we fetch images
    if ("sendTyping" in message.channel) {
      message.channel.sendTyping().catch(() => {});
    }

    imageBlocks = await buildImageContentBlocks(message, session.id);

    if (imageBlocks.length > 0) {
      console.log(
        `[bot] Prepared ${imageBlocks.length} image(s) for vision`,
      );
    }
  }

  // 6d. Handle text file & PDF attachments — build Claude document content blocks
  // (Now done AFTER session resolution so we can register artifacts)
  let documentBlocks: Anthropic.Messages.DocumentBlockParam[] = [];
  if (hasDocuments) {
    // Show typing while we fetch documents
    if ("sendTyping" in message.channel) {
      message.channel.sendTyping().catch(() => {});
    }

    const [textBlocks, pdfBlocks] = await Promise.all([
      hasTextFiles ? buildTextFileContentBlocks(message, session.id) : Promise.resolve([]),
      hasPdfs ? buildPdfContentBlocks(message, session.id) : Promise.resolve([]),
    ]);

    documentBlocks = [...textBlocks, ...pdfBlocks];

    if (documentBlocks.length > 0) {
      console.log(
        `[bot] Prepared ${documentBlocks.length} document(s) (${textBlocks.length} text, ${pdfBlocks.length} PDF)`,
      );
    }
  }

  // If no text, no images, and no documents — nothing to send
  if (!cleanContent && imageBlocks.length === 0 && documentBlocks.length === 0) return;

  // Build the message content — either a plain string or content blocks with media
  let messageContent: string | Anthropic.Messages.ContentBlockParam[];
  const hasContentBlocks = imageBlocks.length > 0 || documentBlocks.length > 0;

  if (hasContentBlocks) {
    // Build content block array: documents first, then images, then text
    const blocks: Anthropic.Messages.ContentBlockParam[] = [
      ...documentBlocks,
      ...imageBlocks,
    ];
    if (cleanContent) {
      blocks.push({ type: "text", text: cleanContent });
    } else if (imageBlocks.length > 0 && documentBlocks.length === 0) {
      // Images with no text and no documents — add a prompt so Claude knows to describe/analyze
      blocks.push({ type: "text", text: "What do you see in this image?" });
    } else {
      // Documents with no text — add a neutral prompt
      const fileNames = message.attachments
        .filter((att) => isTextFileAttachment(att) || isPdfAttachment(att))
        .map((att) => att.name)
        .filter(Boolean)
        .join(", ");
      blocks.push({
        type: "text",
        text: `I've uploaded the following file(s): ${fileNames}. Please review ${documentBlocks.length === 1 ? "it" : "them"}.`,
      });
    }
    messageContent = blocks;
  } else {
    messageContent = cleanContent;
  }

  // 8b. Acquire session lock — if another message is being processed for this
  // session, we wait here until it finishes before proceeding.
  let signal: AbortSignal;
  let releaseLock: () => void;

  try {
    const lock = await acquireSessionLock(session.id);
    signal = lock.signal;
    releaseLock = lock.release;
  } catch (err) {
    if (err instanceof SessionAbortedError) {
      console.log(`[bot] Session ${session.id} was aborted while waiting in queue`);
      return; // Silently drop — the /stop command already notified the user
    }
    throw err;
  }

  // If the session was aborted while we were waiting in the queue
  if (signal.aborted) {
    console.log(`[bot] Session ${session.id} aborted before processing started`);
    return;
  }

  // 8c. Get conversation history — always use Discord thread history for threads
  let history: DbMessage[];

  if (isThread) {
    // Always fetch the thread's message history directly from Discord.
    // The thread IS the conversation — this ensures we always have the full
    // context regardless of DB session state (restarts, expiry, etc.).
    const thread = message.channel as ThreadChannel;
    const discordHistory = await fetchDiscordThreadHistory(
      thread,
      message.id,
      session.id,
    );

    // Merge Discord's view with the cached + stored history for this thread.
    // Discord's fetch can fail or be incomplete (rate limits, permissions,
    // embed-only bot replies, >50 message threads) — merging guarantees the
    // agent still receives the full conversation.
    history = buildThreadHistory({
      threadId: thread.id,
      discordHistory,
      sessionHistory: getSessionHistory(session.id),
      currentMessageId: message.id,
      limit: MAX_THREAD_HISTORY_MESSAGES,
    });

    console.log(
      `[bot] Thread ${thread.id} history: ${discordHistory.length} from Discord, ` +
        `${history.length} after merge with cache/DB`,
    );
  } else {
    // For DMs and non-thread channels, use the DB session history
    history = getSessionHistory(session.id);
  }

  // Resolve context details
  const guildName = message.guild?.name;
  const channelName =
    "name" in message.channel && message.channel.name
      ? message.channel.name
      : "DM";

  // 9. Show typing indicator in the reply target — refresh every 8s
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  const startTyping = () => {
    if (!("sendTyping" in replyTarget)) return;
    (replyTarget as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
    typingInterval = setInterval(() => {
      (replyTarget as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
    }, 8_000);
  };
  const stopTyping = () => {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
  };

  startTyping();

  // For DB logging, use the text portion only (attachments are noted as counts)
  const attachmentParts: string[] = [];
  if (imageBlocks.length > 0) attachmentParts.push(`${imageBlocks.length} image(s)`);
  if (documentBlocks.length > 0) attachmentParts.push(`${documentBlocks.length} document(s)`);
  const attachmentNote = attachmentParts.length > 0 ? `\n\n[${attachmentParts.join(", ")} attached]` : "";

  const logContent = cleanContent
    ? `${cleanContent}${attachmentNote}`
    : (attachmentNote ? attachmentNote.trim() : "");

  // 9b. Create tool call progress handler for live Discord updates
  const onToolCallProgress = createToolCallProgressHandler(replyTarget);

  try {
    // 10. Agent dispatch — track latency
    const startTime = Date.now();
    const response: AgentResponse = await processMessage({
      message: messageContent,
      sessionId: session.id,
      context: {
        guildName,
        channelName,
        channelId: configChannelId,
        threadId: sessionThreadId,
        userName: message.author.displayName ?? message.author.username,
        userId: message.author.id,
      },
      history,
      channelConfig,
      onToolCallProgress,
      threadId: sessionThreadId,
      signal,
    });
    const durationMs = Date.now() - startTime;

    stopTyping();

    // Check if aborted during processing
    if (signal.aborted) {
      console.log(`[bot] Session ${session.id} was aborted during processing — discarding response`);
      releaseLock();
      return;
    }

    // 11. Log both messages to DB (store the full text with images for history)
    const fullResponseText =
      response.text +
      (response.images.length > 0
        ? "\n" +
          response.images
            .map((img) => `![${img.alt || ""}](${img.source})`)
            .join("\n")
        : "");

    addMessage({
      sessionId: session.id,
      role: "user",
      content: logContent,
      discordMessageId: message.id,
    });

    addMessage({
      sessionId: session.id,
      role: "assistant",
      content: fullResponseText,
      usage: response.usage,
    });

    // 11b. Broadcast to WebSocket log viewers
    broadcastLog({
      type: "message",
      sessionId: session.id,
      role: "user",
      content: logContent,
      channel: channelName,
      user: message.author.username,
      timestamp: Date.now(),
    });
    broadcastLog({
      type: "message",
      sessionId: session.id,
      role: "assistant",
      content: fullResponseText,
      channel: channelName,
      timestamp: Date.now(),
    });

    // 12. Build image embeds and attachments
    const embeds = buildImageEmbeds(response.images);
    const files = buildImageAttachments(response.images);
    const hasMedia = embeds.length > 0 || files.length > 0;

    // 12b. Append usage line to the display text (with latency)
    let displayText = response.text;
    if (response.usage) {
      const usageLine = formatUsageLine(response.usage, durationMs);
      displayText = displayText ? `${displayText}\n${usageLine}` : usageLine;
    }

    // 13. Send reply — in thread if we created one, otherwise reply to original message
    const chunks = splitMessage(displayText);
    const sendInTarget = "send" in replyTarget;
    const sentMessageIds: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        const replyPayload: {
          content: string;
          embeds?: EmbedBuilder[];
          files?: AttachmentBuilder[];
        } = { content: chunks[i] };

        if (hasMedia) {
          if (embeds.length > 0) replyPayload.embeds = embeds;
          if (files.length > 0) replyPayload.files = files;
        }

        let sent: DiscordMessage | undefined;
        if (shouldCreateThread && sendInTarget) {
          // Send in thread (not as a reply — we're already in the thread context)
          sent = await (replyTarget as TextChannel | ThreadChannel).send(replyPayload);
        } else if (isThread && sendInTarget) {
          // In an existing thread, send directly (not as a reply to avoid clutter)
          sent = await (replyTarget as TextChannel | ThreadChannel).send(replyPayload);
        } else {
          // DMs or fallback: use message.reply
          sent = await message.reply(replyPayload);
        }
        if (sent) sentMessageIds.push(sent.id);
      } else {
        if (sendInTarget) {
          const sent = await (replyTarget as TextChannel | ThreadChannel).send(chunks[i]);
          sentMessageIds.push(sent.id);
        }
      }
    }

    // Edge case: if there's no text but there are images, send images alone
    if (!displayText && hasMedia) {
      const replyPayload: {
        embeds?: EmbedBuilder[];
        files?: AttachmentBuilder[];
      } = {};
      if (embeds.length > 0) replyPayload.embeds = embeds;
      if (files.length > 0) replyPayload.files = files;

      if ((shouldCreateThread || isThread) && sendInTarget) {
        await (replyTarget as TextChannel | ThreadChannel).send(replyPayload);
      } else {
        await message.reply(replyPayload);
      }
    }

    // 13b. Warm the thread history cache with this turn, so the next turn has
    // full context even if Discord's history fetch fails or is incomplete.
    if (sessionThreadId) {
      const authorName = message.author.displayName ?? message.author.username;
      appendThreadMessages(sessionThreadId, [
        {
          id: -1,
          sessionId: session.id,
          role: "user",
          content: `${authorName}: ${logContent}`,
          discordMessageId: message.id,
          createdAt: message.createdTimestamp,
        },
        {
          id: -2,
          sessionId: session.id,
          role: "assistant",
          content: fullResponseText,
          discordMessageId: sentMessageIds[0],
          createdAt: Date.now(),
        },
      ]);
    }

    const imageCount = response.images.length;
    // Log usage info (with latency)
    if (response.usage) {
      const u = response.usage;
      console.log(
        `[bot] Usage: model=${u.model} in=${u.inputTokens} out=${u.outputTokens} cache_create=${u.cacheCreationTokens} cache_read=${u.cacheReadTokens} latency=${fmtDuration(durationMs)}`,
      );
    }
    console.log(
      `[bot] Replied to ${message.author.tag} in ${channelName}${sessionThreadId ? ` (thread ${sessionThreadId})` : ""}${inMonitoredChannel ? " [monitored]" : ""} (session ${session.id})${imageCount > 0 ? ` with ${imageCount} image(s)` : ""}${isVoice ? " [voice]" : ""}${imageBlocks.length > 0 ? ` [${imageBlocks.length} input image(s)]` : ""}${documentBlocks.length > 0 ? ` [${documentBlocks.length} document(s)]` : ""}`,
    );
  } catch (err) {
    stopTyping();

    // Don't log/report abort errors — they're intentional
    if (err instanceof SessionAbortedError || signal.aborted) {
      console.log(`[bot] Session ${session.id} processing aborted`);
      releaseLock();
      return;
    }

    console.error("[bot] Error processing message:", err);

    // Record error signal for reflection
    recordSignal({
      type: "error",
      source: "messages",
      detail: `Message processing error: ${err instanceof Error ? err.message : String(err)}`,
      metadata: {
        error: err instanceof Error ? err.stack : String(err),
        channelName,
        userMessage: logContent.slice(0, 200),
      },
      sessionId: session.id,
      userId: message.author.id,
    });

    try {
      // Send error in the thread if we created one, otherwise reply to the original message
      if ((shouldCreateThread || isThread) && "send" in replyTarget) {
        await (replyTarget as TextChannel | ThreadChannel).send(
          "Sorry, I ran into an error processing your message. Please try again.",
        );
      } else {
        await message.reply(
          "Sorry, I ran into an error processing your message. Please try again.",
        );
      }
    } catch {
      // If even the error reply fails, just log it
      console.error("[bot] Failed to send error reply");
    }
  } finally {
    releaseLock();
  }
}
