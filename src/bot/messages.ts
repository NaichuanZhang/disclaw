import {
  type Client,
  type Message as DiscordMessage,
  type TextChannel,
  type ThreadChannel,
  MessageFlags,
  ChannelType,
} from "discord.js";
import { basename, extname } from "path";
import { resolveSession } from "../agent/sessions.js";
import { getChannelConfig, addMessage } from "../db/index.js";
import {
  findLiveQuestionForMessage,
  resolveQuestion,
} from "../agent/questions.js";
import { broadcastLog } from "../gateway/server.js";
import {
  saveSdkAttachments,
  formatAttachmentBlock,
} from "../sdk/attachments.js";
import { isRestarting } from "../restart.js";
import { transcribeAudio, getLastTranscriptionFailureSummary } from "../audio/transcribe.js";
import { recordSignal } from "../reflection/signals.js";
import {
  sdkSessionInboxDir,
  submitToSdkSession,
  type SdkChannelTarget,
} from "../sdk/index.js";
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


/**
 * Check if a Discord message has image attachments.
 */
function hasImageAttachments(message: DiscordMessage): boolean {
  return message.attachments.some((att) => {
    const ct = att.contentType?.toLowerCase() || "";
    return ct in SUPPORTED_IMAGE_TYPES;
  });
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

  // 6a. Handle voice messages — transcribe audio and use as message content
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

  // 6b. Bail out before thread creation when there is nothing the session could
  // act on, so we never leave an empty thread behind. Placed after
  // transcription so voice messages still work.
  if (!cleanContent && message.attachments.size === 0) {
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

  // 7b. Hand the conversation to the Claude Agent SDK session for this channel.
  // Runs *after* thread creation so the session is keyed to the thread id: one
  // isolated session per thread, with mid-turn message injection inside it. If
  // thread creation failed, replyTarget is still the channel, so we degrade to
  // an in-channel session.
  //
  // A Discord thread already carries `parentId`, and SdkChannelTarget declares
  // it — the session needs that link because it is keyed to the thread while
  // channel settings and channel-level commands live on the parent. Cast, don't
  // clone: cloning would drop the channel's own methods.
  const target = replyTarget as unknown as SdkChannelTarget;

  // A session takes plain text, not content blocks, but it has its own Read
  // tool — so attachments are downloaded into the session's own folder and
  // handed over as absolute paths. Skipped ones are named, never silently
  // dropped. The inbox is per-session, which is also why it has to be passed
  // here: attachments.ts is resolved before the session exists.
  let text = cleanContent;
  if (message.attachments.size > 0) {
    if ("sendTyping" in message.channel) {
      message.channel.sendTyping().catch(() => {});
    }
    const result = await saveSdkAttachments(
      message.id,
      [...message.attachments.values()].map((a) => ({
        name: a.name,
        url: a.url,
        size: a.size,
        contentType: a.contentType,
      })),
      { inboxDir: sdkSessionInboxDir(target.id, target.parentId) },
    );
    const block = formatAttachmentBlock(result);
    if (block) text = text ? `${text}\n${block}` : block.trim();
    console.log(
      `[bot] Attachments for ${target.id}: ${result.saved.length} saved, ${result.skipped.length} skipped`,
    );
  }

  // Log the human side into the normal conversation tables so the thread is
  // visible to /history, the archive and get_conversation_history. The assistant
  // side is written by the session itself, once per turn.
  const channelName =
    "name" in message.channel && message.channel.name ? message.channel.name : "DM";
  let logSessionId: string | undefined;
  try {
    const sessionRow = resolveSession({
      threadId: sessionThreadId,
      channelId: message.channelId,
      userId: message.author.id,
      guildId: message.guildId || undefined,
      isDM,
    });
    logSessionId = sessionRow.id;
    addMessage({
      sessionId: sessionRow.id,
      role: "user",
      content: text,
      discordMessageId: message.id,
    });
    broadcastLog({
      type: "message",
      sessionId: sessionRow.id,
      role: "user",
      content: text,
      channel: channelName,
      user: message.author.username,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error(
      `[bot] Failed to log message for ${target.id}:`,
      err instanceof Error ? err.message : err,
    );
  }

  submitToSdkSession(target, {
    text,
    userId: message.author.id,
    userName: message.author.displayName ?? message.author.username,
    logSessionId,
    channelName,
    react: (emoji) => message.react(emoji),
  });
  console.log(
    `[bot] Routed message to SDK session ${target.id} (channel ${message.channelId})`,
  );

}
