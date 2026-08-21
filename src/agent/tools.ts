// ---------------------------------------------------------------------------
// Discord tool definitions for the Anthropic Messages API
// ---------------------------------------------------------------------------

import { existsSync, statSync } from "fs";
import { basename } from "path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { registerBotThread } from "../bot/messages.js";
import { getThreadClearCutoff } from "../bot/thread-history.js";
import {
  isGuildTextChannel,
  ensureThread,
  generateThreadName,
  sendChunked,
  MAX_THREAD_NAME_LENGTH,
} from "../shared/discord-utils.js";
import {
  createQuestion,
  setQuestionMessageId,
  waitForAnswer,
  encodeQuestionCustomId,
  encodeQuestionSelectCustomId,
  MAX_BUTTON_OPTIONS,
  MAX_SELECT_OPTIONS,
  MAX_WAIT_SECONDS,
  DEFAULT_WAIT_SECONDS,
} from "./questions.js";
import {
  registerArtifactFromFile,
  getArtifactDownloadUrl,
  updateArtifactDiscordInfo,
  formatFileSize,
} from "../artifacts/index.js";

export const discordTools = [
  {
    name: "send_message",
    description: "Send a message to a Discord channel",
    input_schema: {
      type: "object" as const,
      properties: {
        channel_id: { type: "string", description: "Discord channel ID" },
        text: { type: "string", description: "Message text to send" },
      },
      required: ["channel_id", "text"],
    },
  },
  {
    name: "send_file",
    description:
      "Send a file (attachment) to a Discord channel. Optionally include a text message alongside the file. Use this to share PDFs, images, HTML files, or any other file from disk.",
    input_schema: {
      type: "object" as const,
      properties: {
        channel_id: { type: "string", description: "Discord channel ID" },
        file_path: {
          type: "string",
          description:
            "Absolute path to the file on disk to send as an attachment",
        },
        message: {
          type: "string",
          description:
            "Optional text message to include with the file attachment",
        },
        filename: {
          type: "string",
          description:
            "Optional custom filename for the attachment (defaults to the original filename)",
        },
      },
      required: ["channel_id", "file_path"],
    },
  },
  {
    name: "add_reaction",
    description: "React to a message with an emoji",
    input_schema: {
      type: "object" as const,
      properties: {
        channel_id: { type: "string", description: "Channel ID" },
        message_id: {
          type: "string",
          description: "Message ID to react to",
        },
        emoji: {
          type: "string",
          description: "Emoji to react with (unicode or custom :name:id)",
        },
      },
      required: ["channel_id", "message_id", "emoji"],
    },
  },
  {
    name: "get_channel_history",
    description:
      "FALLBACK for Discord scrollback that is NOT already in your context. " +
      "Thread/DM history is loaded into your conversation automatically — see " +
      "'Messages already in context' in Current Context. Only call this when " +
      "that count is 0/unknown, when you need messages older than the loaded " +
      "window, or when reading a DIFFERENT channel than the current one. " +
      "Calling it on the current conversation duplicates history you already have.",
    input_schema: {
      type: "object" as const,
      properties: {
        channel_id: { type: "string", description: "Channel ID" },
        limit: {
          type: "number",
          description: "Number of messages (default 20, max 100)",
        },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "create_thread",
    description:
      "Create a new thread in a Discord channel. Returns the thread's channel ID which you can then use with send_message to post inside it.",
    input_schema: {
      type: "object" as const,
      properties: {
        channel_id: {
          type: "string",
          description: "Parent channel ID to create the thread in",
        },
        name: {
          type: "string",
          description:
            "Thread name (max 100 characters, e.g. '4/10' for a date-based thread)",
        },
        message: {
          type: "string",
          description:
            "Optional initial message to send in the thread. If omitted, creates an empty thread.",
        },
      },
      required: ["channel_id", "name"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user a question with a proper Discord interface (embed + clickable buttons) and @mention them so they get a real notification. Blocks until they answer, they reply with text, or the wait times out. Use this whenever you need a decision, a clarification, or an approval instead of guessing. With `options`, the user clicks a choice (or a dropdown if more than 5). Without `options`, they answer by replying in the channel.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description: "The question to ask. Keep it short and specific.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            `Optional answer choices (max ${MAX_SELECT_OPTIONS}). 1-${MAX_BUTTON_OPTIONS} render as buttons, more render as a dropdown. Omit for a free-text answer.`,
        },
        channel_id: {
          type: "string",
          description:
            "Channel or thread ID to ask in. Defaults to the current conversation.",
        },
        user_id: {
          type: "string",
          description:
            "User ID to @mention. Defaults to the user in the current conversation.",
        },
        mention: {
          type: "boolean",
          description:
            "Whether to @mention the user so they get a notification (default true).",
        },
        wait_seconds: {
          type: "number",
          description:
            `How long to wait for an answer (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}).`,
        },
        context: {
          type: "string",
          description:
            "Optional extra context shown under the question (why you're asking, tradeoffs).",
        },
      },
      required: ["question"],
    },
  },
];

// ---------------------------------------------------------------------------
// Discord client reference
// ---------------------------------------------------------------------------

// Using `any` for the Discord client and channel types intentionally — this
// module is a thin bridge and fully typing discord.js internals here adds
// complexity with no safety benefit.

let discordClient: any = null;

export function setDiscordClient(client: any): void {
  discordClient = client;
}

// ---------------------------------------------------------------------------
// Session context for artifact tracking and thread routing
// ---------------------------------------------------------------------------

/** Current session ID, set by the message handler before tool dispatch. */
let currentSessionId: string | null = null;

/**
 * Current thread ID, set by the message handler before tool dispatch.
 * When set, tools like send_message and send_file will route to this
 * existing thread instead of creating a new one — prevents duplicate
 * threads when the conversation is already happening in a thread.
 */
let currentThreadId: string | null = null;

/** Current user ID, used by ask_user to @mention the right person. */
let currentUserId: string | null = null;

export function setToolSessionContext(
  sessionId: string | null,
  threadId?: string | null,
  userId?: string | null,
): void {
  currentSessionId = sessionId;
  currentThreadId = threadId ?? null;
  currentUserId = userId ?? null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discord's max file upload size for bots (default tier: 25 MB). */
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helper: resolve send target for guild text channels
// ---------------------------------------------------------------------------

/**
 * Given a guild text channel, resolve where to actually send the message/file.
 * If we're already in a thread (currentThreadId is set), reuse it.
 * Otherwise, create a new thread.
 *
 * @returns [sendTarget, threadId] — the channel to send to and its ID if it's a thread.
 */
async function resolveThreadTarget(
  channel: any,
  threadName: string,
  source: string,
): Promise<[any, string | undefined]> {
  // If the conversation is already in a thread, reuse it instead of creating a new one
  if (currentThreadId) {
    try {
      const existingThread = await discordClient.channels.fetch(currentThreadId);
      if (existingThread && existingThread.send) {
        console.log(
          `[${source}] Reusing existing thread ${currentThreadId} (skipping new thread creation)`,
        );
        return [existingThread, currentThreadId];
      }
    } catch (err) {
      // Thread may have been deleted/archived — fall through to create a new one
      console.warn(
        `[${source}] Could not fetch existing thread ${currentThreadId}, creating new one:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // No existing thread context — create a new thread
  const sendTarget = await ensureThread(channel, threadName, source);
  return [sendTarget, sendTarget.id];
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export async function handleDiscordTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  if (!discordClient) {
    return JSON.stringify({ error: "Discord client not available" });
  }

  try {
    switch (name) {
      case "send_message": {
        const channelId = input.channel_id as string;
        const text = input.text as string;
        console.log(`[agent] send_message -> channel ${channelId}`);
        const channel: any = await discordClient.channels.fetch(channelId);
        if (!channel || !channel.send) {
          return JSON.stringify({
            error: `Channel ${channelId} not found or not a text channel`,
          });
        }

        // If targeting a guild text channel, route to existing thread or create one
        let sendTarget = channel;
        let threadId: string | undefined;
        if (isGuildTextChannel(channel)) {
          const threadName = generateThreadName(text);
          [sendTarget, threadId] = await resolveThreadTarget(
            channel,
            threadName,
            "agent",
          );
        }

        // Use sendChunked to automatically split messages exceeding 2000 chars
        const sent = await sendChunked(sendTarget, text);
        return JSON.stringify({
          success: true,
          message_id: sent.id,
          channel_id: threadId ?? channelId,
          ...(threadId ? { thread_id: threadId, parent_channel_id: channelId } : {}),
        });
      }

      case "send_file": {
        const channelId = input.channel_id as string;
        const filePath = input.file_path as string;
        const message = (input.message as string) || undefined;
        const customFilename = (input.filename as string) || undefined;

        console.log(
          `[agent] send_file -> channel ${channelId}, file ${filePath}`,
        );

        // Validate the file exists
        if (!existsSync(filePath)) {
          return JSON.stringify({
            error: `File not found: ${filePath}`,
          });
        }

        // Check file size
        const stats = statSync(filePath);
        const filename = customFilename || basename(filePath);

        // Register as output artifact (regardless of whether we can send via Discord)
        let artifactId: string | undefined;
        if (currentSessionId) {
          try {
            const artifact = registerArtifactFromFile(
              {
                sessionId: currentSessionId,
                direction: "output",
                filename,
                sizeBytes: stats.size,
              },
              filePath,
            );
            artifactId = artifact.id;
          } catch (err) {
            console.error("[agent] Failed to register output artifact:", err);
          }
        }

        // If file is too large for Discord, provide gateway download link instead
        if (stats.size > MAX_FILE_SIZE_BYTES) {
          if (artifactId && currentSessionId) {
            const downloadUrl = getArtifactDownloadUrl(currentSessionId, artifactId);
            return JSON.stringify({
              success: true,
              too_large_for_discord: true,
              download_url: downloadUrl,
              filename,
              size: formatFileSize(stats.size),
              size_bytes: stats.size,
              artifact_id: artifactId,
              note: `File is ${formatFileSize(stats.size)} which exceeds Discord's 25 MB limit. Share the download_url with the user instead.`,
            });
          }
          return JSON.stringify({
            error: `File too large (${formatFileSize(stats.size)}). Discord limit is 25 MB. No gateway URL available (no session context).`,
          });
        }

        const channel: any = await discordClient.channels.fetch(channelId);
        if (!channel || !channel.send) {
          return JSON.stringify({
            error: `Channel ${channelId} not found or not a text channel`,
          });
        }

        // Enforce thread-only policy for files: if targeting a guild text
        // channel, route to existing thread or create a new one so
        // files/artifacts stay organized and don't clutter the main channel.
        let sendTarget = channel;
        let threadId: string | undefined;
        if (isGuildTextChannel(channel)) {
          const threadName = generateThreadName(
            message || filename,
            `File: ${filename}`,
          );
          [sendTarget, threadId] = await resolveThreadTarget(
            channel,
            threadName,
            "agent:send_file",
          );
        }

        const attachment: { attachment: string; name?: string } = {
          attachment: filePath,
        };
        if (customFilename) {
          attachment.name = customFilename;
        }

        const sendPayload: { files: typeof attachment[]; content?: string } = {
          files: [attachment],
        };
        if (message) {
          sendPayload.content = message;
        }

        const sent = await sendTarget.send(sendPayload);
        const sentAttachment = sent.attachments?.first();

        // Update artifact with Discord info
        if (artifactId && sentAttachment?.url) {
          try {
            updateArtifactDiscordInfo(artifactId, sentAttachment.url, sent.id);
          } catch (err) {
            console.error("[agent] Failed to update artifact Discord info:", err);
          }
        }

        return JSON.stringify({
          success: true,
          message_id: sent.id,
          channel_id: threadId ?? channelId,
          filename: sentAttachment?.name ?? filename,
          size: formatFileSize(stats.size),
          size_bytes: stats.size,
          ...(artifactId ? { artifact_id: artifactId } : {}),
          ...(threadId ? { thread_id: threadId, parent_channel_id: channelId } : {}),
        });
      }

      case "add_reaction": {
        const channelId = input.channel_id as string;
        const messageId = input.message_id as string;
        const emoji = input.emoji as string;
        console.log(
          `[agent] add_reaction -> channel ${channelId}, message ${messageId}, emoji ${emoji}`,
        );
        const channel: any = await discordClient.channels.fetch(channelId);
        if (!channel || !channel.messages) {
          return JSON.stringify({
            error: `Channel ${channelId} not found or not a text channel`,
          });
        }
        const message = await channel.messages.fetch(messageId);
        await message.react(emoji);
        return JSON.stringify({
          success: true,
          channel_id: channelId,
          message_id: messageId,
          emoji,
        });
      }

      case "get_channel_history": {
        const channelId = input.channel_id as string;
        const limit = Math.min((input.limit as number) || 20, 100);
        console.log(
          `[agent] get_channel_history -> channel ${channelId}, limit ${limit}`,
        );
        const channel: any = await discordClient.channels.fetch(channelId);
        if (!channel || !channel.messages) {
          return JSON.stringify({
            error: `Channel ${channelId} not found or not a text channel`,
          });
        }
        const messages = await channel.messages.fetch({ limit });

        // Honour /clear: messages at or before the cutoff were explicitly
        // forgotten for this thread and must not be resurrected here.
        const cutoff = getThreadClearCutoff(channelId);
        const all = Array.from(messages.values()) as any[];
        const visible = cutoff
          ? all.filter((msg: any) => msg.createdTimestamp > cutoff)
          : all;

        const formatted: {
          id: string;
          author: string;
          content: string;
          timestamp: number;
        }[] = [];

        for (const msg of visible) {
          // Mirror the thread-history reader: messages with no text still
          // carry meaning via embeds/attachments (the bot sends replies that
          // way), so describe them instead of returning an empty content
          // string that reads as "said nothing".
          let content: string = msg.content || "";

          const attachmentNames = msg.attachments?.size
            ? msg.attachments
                .map((att: any) => att.name)
                .filter(Boolean)
                .join(", ")
            : "";
          if (attachmentNames) {
            content = content
              ? `${content}\n\n[Attachments: ${attachmentNames}]`
              : `[Attachments: ${attachmentNames}]`;
          }

          if (!content && msg.embeds?.length) {
            const embedText = msg.embeds
              .map((e: any) =>
                [e.title, e.description].filter(Boolean).join(" — "),
              )
              .filter(Boolean)
              .join("\n");
            content = embedText || `[Embed x${msg.embeds.length}]`;
          }

          // Truly empty (system messages, joins) — nothing to report.
          if (!content) continue;

          formatted.push({
            id: msg.id,
            author: msg.author?.tag ?? "unknown",
            content,
            timestamp: msg.createdTimestamp,
          });
        }

        const notes: string[] = [];
        if (cutoff && visible.length < all.length) {
          notes.push(
            `${all.length - visible.length} message(s) hidden by /clear`,
          );
        }
        const emptySkipped = visible.length - formatted.length;
        if (emptySkipped > 0) {
          notes.push(`${emptySkipped} empty message(s) skipped`);
        }

        return JSON.stringify({
          fetched: all.length,
          returned: formatted.length,
          ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
          messages: formatted,
        });
      }

      case "create_thread": {
        const channelId = input.channel_id as string;
        const threadName = (input.name as string).slice(
          0,
          MAX_THREAD_NAME_LENGTH,
        );
        const initialMessage = (input.message as string) || undefined;

        console.log(
          `[agent] create_thread -> channel ${channelId}, name "${threadName}"`,
        );

        const channel: any = await discordClient.channels.fetch(channelId);
        if (!channel || !channel.threads) {
          return JSON.stringify({
            error: `Channel ${channelId} not found or doesn't support threads`,
          });
        }

        const thread = await channel.threads.create({
          name: threadName,
          // ChannelType.PublicThread = 11
          type: 11,
        });

        // Register as bot-created thread
        registerBotThread(thread.id);

        // Send initial message if provided, using chunking for long messages
        if (initialMessage) {
          await sendChunked(thread, initialMessage);
        }

        return JSON.stringify({
          success: true,
          thread_id: thread.id,
          thread_name: thread.name,
          parent_channel_id: channelId,
        });
      }

      case "ask_user": {
        const question = (input.question as string)?.trim();
        if (!question) {
          return JSON.stringify({ error: "question is required" });
        }
        const channelId =
          (input.channel_id as string) || currentThreadId || "";
        if (!channelId) {
          return JSON.stringify({
            error: "channel_id is required (no current conversation context)",
          });
        }
        const userId = (input.user_id as string) || currentUserId || null;
        const mention = input.mention !== false;
        const extraContext = (input.context as string) || undefined;

        const rawOptions = Array.isArray(input.options)
          ? (input.options as unknown[])
              .map((o) => String(o).trim())
              .filter((o) => o.length > 0)
          : [];
        if (rawOptions.length > MAX_SELECT_OPTIONS) {
          return JSON.stringify({
            error: `Too many options (${rawOptions.length}). Max is ${MAX_SELECT_OPTIONS}.`,
          });
        }
        const options = rawOptions.slice(0, MAX_SELECT_OPTIONS);

        const waitSeconds = Math.max(
          1,
          Math.min(
            Math.round((input.wait_seconds as number) || DEFAULT_WAIT_SECONDS),
            MAX_WAIT_SECONDS,
          ),
        );

        const channel: any = await discordClient.channels.fetch(channelId);
        if (!channel || !channel.send) {
          return JSON.stringify({
            error: `Channel ${channelId} not found or not a text channel`,
          });
        }

        const record = createQuestion({
          channelId,
          userId,
          question,
          options,
        });

        console.log(
          `[agent] ask_user -> channel ${channelId}, question ${record.id}, options ${options.length}, wait ${waitSeconds}s`,
        );

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("❓ Question")
          .setDescription(question);
        if (extraContext) {
          embed.addFields({ name: "Context", value: extraContext.slice(0, 1024) });
        }
        embed.setFooter({
          text: options.length
            ? `Pick an option or just reply · waiting up to ${waitSeconds}s`
            : `Reply in this channel to answer · waiting up to ${waitSeconds}s`,
        });

        const components: any[] = [];
        if (options.length > 0 && options.length <= MAX_BUTTON_OPTIONS) {
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            options.map((opt, i) =>
              new ButtonBuilder()
                .setCustomId(encodeQuestionCustomId(record.id, i))
                .setLabel(opt.slice(0, 80))
                .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
            ),
          );
          components.push(row);
        } else if (options.length > MAX_BUTTON_OPTIONS) {
          const menu = new StringSelectMenuBuilder()
            .setCustomId(encodeQuestionSelectCustomId(record.id))
            .setPlaceholder("Choose an answer")
            .addOptions(
              options.map((opt, i) => ({
                label: opt.slice(0, 100),
                value: String(i),
              })),
            );
          components.push(
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
          );
        }

        const sent = await channel.send({
          // Plain-text mention is what actually triggers a Discord
          // notification — mentions inside embeds do not ping.
          content: mention && userId ? `<@${userId}>` : undefined,
          embeds: [embed],
          components,
          allowedMentions: { users: userId ? [userId] : [] },
        });
        setQuestionMessageId(record.id, sent.id);

        const result = await waitForAnswer(record, waitSeconds);

        if (result) {
          return JSON.stringify({
            answered: true,
            question_id: record.id,
            answer: result.answer,
            answer_source: result.source,
            channel_id: channelId,
          });
        }

        // Timed out — disable the controls so a stale click can't confuse the user.
        try {
          const timedOutEmbed = EmbedBuilder.from(embed).setFooter({
            text: "⏳ Timed out — no answer received",
          });
          await sent.edit({ embeds: [timedOutEmbed], components: [] });
        } catch {
          // Non-fatal: the message may have been deleted.
        }

        return JSON.stringify({
          answered: false,
          status: "timeout",
          question_id: record.id,
          channel_id: channelId,
          note: `No answer within ${waitSeconds}s. Do NOT keep waiting — either proceed with a stated default assumption or tell the user you'll wait for their reply.`,
        });
      }

      default:
        return JSON.stringify({ error: `Unknown discord tool: ${name}` });
    }
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : "Unknown error";
    console.error(`[agent] Discord tool "${name}" failed:`, errorMessage);
    return JSON.stringify({ error: errorMessage });
  }
}
