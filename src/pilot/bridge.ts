// ---------------------------------------------------------------------------
// Pilot mode — in-process MCP bridge
//
// Re-exports a curated subset of this bot's own tools to the Claude Agent SDK
// session via `createSdkMcpServer`, so they run in our process (no stdio
// subprocess, no extra auth).
//
// Deliberately NOT exposed: every `evolve_*` tool. Pilot sessions must not be
// able to open/merge a self-modifying PR, since that would route around the
// plan-approval gate. Also not exposed: bash/read_file/write_file — the SDK
// session already has its own native Bash/Read/Write (ungated — pilot runs with
// bypassPermissions).
// ---------------------------------------------------------------------------

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { handleDiscordTool } from "../agent/tools.js";
import { handleMemoryTool } from "../memory/tools.js";
import { handleSkillTool } from "../skills/tools.js";

export interface PilotBridgeOptions {
  /** Channel the pilot session lives in — used as the default target. */
  channelId: string;
  /** User the pilot session is talking to — used as the default mention. */
  userId?: string;
}

/** MCP server name; tools appear to the model as `mcp__discordclaw__<name>`. */
export const PILOT_MCP_SERVER_NAME = "discordclaw";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function runDiscordTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    const result = await handleDiscordTool(name, input);
    return textResult(result);
  } catch (err) {
    return textResult(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

async function runMemoryTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    const result = await handleMemoryTool(name, input);
    return textResult(result);
  } catch (err) {
    return textResult(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function runSkillTool(
  name: string,
  input: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  try {
    return textResult(handleSkillTool(name, input));
  } catch (err) {
    return textResult(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Build the in-process MCP server exposing our Discord + memory tools to a
 * pilot session.
 */
export function createPilotMcpServer(options: PilotBridgeOptions) {
  const { channelId, userId } = options;

  return createSdkMcpServer({
    name: PILOT_MCP_SERVER_NAME,
    version: "1.0.0",
    instructions:
      "Tools from the host Discord bot. Use send_message to post to a channel, " +
      "ask_user to ask the human a question with buttons, and the memory tools " +
      "to recall or store durable facts. read_skill/list_skill_files load the " +
      "host bot's skill library on demand. Evolution/self-modification tools are " +
      "intentionally unavailable here.",
    alwaysLoad: true,
    tools: [
      tool(
        "send_message",
        "Send a message to a Discord channel. Defaults to the current pilot channel.",
        {
          text: z.string().describe("Message text to send"),
          channel_id: z
            .string()
            .optional()
            .describe("Discord channel ID (defaults to the pilot channel)"),
        },
        async (args) =>
          runDiscordTool("send_message", {
            text: args.text,
            channel_id: args.channel_id ?? channelId,
          }),
      ),

      tool(
        "send_file",
        "Send a file from disk as a Discord attachment. Defaults to the current pilot channel.",
        {
          file_path: z.string().describe("Absolute path to the file on disk"),
          channel_id: z
            .string()
            .optional()
            .describe("Discord channel ID (defaults to the pilot channel)"),
          message: z
            .string()
            .optional()
            .describe("Optional text to include with the attachment"),
          filename: z
            .string()
            .optional()
            .describe("Optional custom filename for the attachment"),
        },
        async (args) =>
          runDiscordTool("send_file", {
            file_path: args.file_path,
            channel_id: args.channel_id ?? channelId,
            message: args.message,
            filename: args.filename,
          }),
      ),

      tool(
        "add_reaction",
        "React to a Discord message with an emoji.",
        {
          message_id: z.string().describe("Message ID to react to"),
          emoji: z.string().describe("Emoji (unicode or custom :name:id)"),
          channel_id: z
            .string()
            .optional()
            .describe("Discord channel ID (defaults to the pilot channel)"),
        },
        async (args) =>
          runDiscordTool("add_reaction", {
            message_id: args.message_id,
            emoji: args.emoji,
            channel_id: args.channel_id ?? channelId,
          }),
      ),

      tool(
        "ask_user",
        "Ask the human a question with a Discord embed and clickable buttons. Blocks until they answer or it times out. Use instead of guessing.",
        {
          question: z.string().describe("The question. Short and specific."),
          options: z
            .array(z.string())
            .optional()
            .describe("Answer choices (1-5 render as buttons, more as a dropdown)"),
          context: z
            .string()
            .optional()
            .describe("Extra context shown under the question"),
          wait_seconds: z
            .number()
            .optional()
            .describe("How long to wait for an answer (default 120, max 300)"),
          channel_id: z
            .string()
            .optional()
            .describe("Channel ID to ask in (defaults to the pilot channel)"),
          user_id: z
            .string()
            .optional()
            .describe("User ID to mention (defaults to the pilot user)"),
        },
        async (args) =>
          runDiscordTool("ask_user", {
            question: args.question,
            options: args.options,
            context: args.context,
            wait_seconds: args.wait_seconds,
            channel_id: args.channel_id ?? channelId,
            user_id: args.user_id ?? userId,
          }),
      ),

      tool(
        "memory_search",
        "Search the bot's local memory files for prior context (decisions, preferences, people, facts).",
        {
          query: z.string().describe("Search query"),
          max_results: z
            .number()
            .optional()
            .describe("Maximum results to return (default 5)"),
        },
        async (args) =>
          runMemoryTool("memory_search", {
            query: args.query,
            max_results: args.max_results,
          }),
      ),

      tool(
        "memory_get",
        "Read specific lines from a memory file (use after memory_search for full context).",
        {
          path: z.string().describe("Path to the memory file, relative to data/"),
          from: z.number().optional().describe("Starting line number (1-based)"),
          lines: z.number().optional().describe("Number of lines to read"),
        },
        async (args) =>
          runMemoryTool("memory_get", {
            path: args.path,
            from: args.from,
            lines: args.lines,
          }),
      ),

      tool(
        "mem9_store",
        "Store a durable fact in mem9 cloud memory.",
        {
          content: z.string().describe("The fact or information to remember"),
          metadata: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Optional metadata, e.g. { topic: 'project-x' }"),
        },
        async (args) =>
          runMemoryTool("mem9_store", {
            content: args.content,
            metadata: args.metadata,
          }),
      ),

      tool(
        "mem9_update",
        "Update an existing mem9 cloud memory by ID.",
        {
          memory_id: z.string().describe("ID of the memory to update"),
          content: z.string().describe("New content for the memory"),
        },
        async (args) =>
          runMemoryTool("mem9_update", {
            memory_id: args.memory_id,
            content: args.content,
          }),
      ),

      tool(
        "read_skill",
        "Read the full content of an installed skill's SKILL.md or any companion file within the skill directory. Use this when a task matches a skill's description from the available skills list.",
        {
          skill_name: z
            .string()
            .describe("Name of the skill (from <available_skills>)"),
          file: z
            .string()
            .optional()
            .describe(
              "Relative path within the skill directory (default: SKILL.md)",
            ),
        },
        async (args) =>
          runSkillTool("read_skill", {
            skill_name: args.skill_name,
            file: args.file,
          }),
      ),

      tool(
        "list_skill_files",
        "List all files in an installed skill's directory to discover companion scripts, references, and resources.",
        {
          skill_name: z.string().describe("Name of the skill"),
        },
        async (args) =>
          runSkillTool("list_skill_files", { skill_name: args.skill_name }),
      ),

      tool(
        "mem9_delete",
        "Delete a mem9 cloud memory by ID.",
        {
          memory_id: z.string().describe("ID of the memory to delete"),
        },
        async (args) => runMemoryTool("mem9_delete", { memory_id: args.memory_id }),
      ),
    ],
  });
}
