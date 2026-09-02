// ---------------------------------------------------------------------------
// SDK sessions — in-process MCP bridge
//
// Re-exports a curated subset of this bot's own tools to the Claude Agent SDK
// session via `createSdkMcpServer`, so they run in our process (no stdio
// subprocess, no extra auth).
//
// Includes the full `evolve_*` tool set, so sessions self-modify through
// the same worktree -> PR -> CI -> auto-merge path as the main agent. The
// plan-approval gate still applies and is enforced in code: evolve_start
// refuses to run without an approved plan of at least 80 characters.
//
// Deliberately NOT exposed: bash/read_file/write_file — the SDK session already
// has its own native Bash/Read/Write (ungated — sessions run with
// bypassPermissions).
// ---------------------------------------------------------------------------

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { handleDiscordTool } from "../agent/tools.js";
import { handleMemoryTool } from "../memory/tools.js";
import { handleSkillTool } from "../skills/tools.js";
import { handleConversationHistoryTool } from "../shared/conversation-history.js";
import { handleEvolutionTool, setEvolutionContext } from "../evolution/tools.js";

export interface SdkBridgeOptions {
  /** Channel the session lives in — used as the default target. */
  channelId: string;
  /**
   * Who the session is talking to *right now*, as a getter rather than a value.
   * The MCP server is built once per session, so a captured string would freeze
   * the first speaker forever — `ask_user` would mention them and every
   * `evolve_*` call would be attributed to them no matter who is talking.
   */
  getUserId?: () => string | undefined;
}

/** MCP server name; tools appear to the model as `mcp__discordclaw__<name>`. */
export const BRIDGE_MCP_SERVER_NAME = "discordclaw";

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

function runHistoryTool(
  name: string,
  input: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }> } {
  return textResult(handleConversationHistoryTool(name, input));
}

/**
 * Evolution tools mutate module-global context (triggering channel/user) before
 * dispatching, so set it immediately before every call.
 */
async function runEvolutionTool(
  name: string,
  input: Record<string, unknown>,
  ctx: SdkBridgeOptions,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    setEvolutionContext(ctx.channelId, ctx.getUserId?.());
    const result = await handleEvolutionTool(name, input);
    return textResult(result);
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
 * session.
 */
export function createBridgeMcpServer(options: SdkBridgeOptions) {
  const { channelId } = options;

  return createSdkMcpServer({
    name: BRIDGE_MCP_SERVER_NAME,
    version: "1.0.0",
    instructions:
      "Tools from the host Discord bot. Use send_message to post to a channel, " +
      "ask_user to ask the human a question with buttons, and the memory tools " +
      "to recall or store durable facts. read_skill/list_skill_files load the " +
      "host bot's skill library on demand. get_channel_history / " +
      "get_conversation_history / get_conversation_stats read Discord scrollback and " +
      "cross-session history. The evolve_* tools modify this bot's own " +
      "source code through an isolated worktree and an auto-merged PR — they " +
      "require an explicitly approved build plan first.",
    alwaysLoad: true,
    tools: [
      tool(
        "send_message",
        "Send a message to a Discord channel. Defaults to the current channel.",
        {
          text: z.string().describe("Message text to send"),
          channel_id: z
            .string()
            .optional()
            .describe("Discord channel ID (defaults to the current channel)"),
        },
        async (args) =>
          runDiscordTool("send_message", {
            text: args.text,
            channel_id: args.channel_id ?? channelId,
          }),
      ),

      tool(
        "send_file",
        "Send a file from disk as a Discord attachment. Defaults to the current channel.",
        {
          file_path: z.string().describe("Absolute path to the file on disk"),
          channel_id: z
            .string()
            .optional()
            .describe("Discord channel ID (defaults to the current channel)"),
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
            .describe("Discord channel ID (defaults to the current channel)"),
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
            .describe("Channel ID to ask in (defaults to the current channel)"),
          user_id: z
            .string()
            .optional()
            .describe("User ID to mention (defaults to the current user)"),
        },
        async (args) =>
          runDiscordTool("ask_user", {
            question: args.question,
            options: args.options,
            context: args.context,
            wait_seconds: args.wait_seconds,
            channel_id: args.channel_id ?? channelId,
            user_id: args.user_id ?? options.getUserId?.(),
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

      // ---------------------------------------------------------------------
      // Read-only context tools — same handlers the voice agent uses, so a
      // session can look past its own SDK transcript (older scrollback, other
      // channels, cross-session history) instead of guessing.
      // ---------------------------------------------------------------------

      tool(
        "get_channel_history",
        "Read recent Discord messages from a channel. Use for scrollback that is not already in this session's context: messages older than what you have seen, or a different channel. Defaults to the current channel.",
        {
          channel_id: z
            .string()
            .optional()
            .describe("Discord channel ID (defaults to the current channel)"),
          limit: z
            .number()
            .optional()
            .describe("Number of messages (default 20, max 100)"),
        },
        async (args) =>
          runDiscordTool("get_channel_history", {
            channel_id: args.channel_id ?? channelId,
            limit: args.limit,
          }),
      ),

      tool(
        "create_thread",
        "Create a new thread in a Discord channel. Returns the thread's channel ID, which you can pass to send_message to post inside it.",
        {
          name: z.string().describe("Thread name (max 100 characters)"),
          channel_id: z
            .string()
            .optional()
            .describe("Parent channel ID (defaults to the current channel)"),
          message: z
            .string()
            .optional()
            .describe("Optional initial message to send in the thread"),
        },
        async (args) =>
          runDiscordTool("create_thread", {
            name: args.name,
            channel_id: args.channel_id ?? channelId,
            message: args.message,
          }),
      ),

      tool(
        "get_conversation_history",
        "Get recent conversation messages from the bot's database, spanning all sessions and channels (including archived ones). Returns messages newest-first.",
        {
          hours: z
            .number()
            .optional()
            .describe("How many hours back to look (default 24)"),
          limit: z
            .number()
            .optional()
            .describe("Max messages to return (default 100, max 500)"),
          role: z
            .string()
            .optional()
            .describe("Filter by role: 'user' or 'assistant' (default both)"),
        },
        async (args) =>
          runHistoryTool("get_conversation_history", {
            hours: args.hours,
            limit: args.limit,
            role: args.role,
          }),
      ),

      tool(
        "get_conversation_stats",
        "Get statistics about recent conversations: total sessions, messages, unique users.",
        {
          hours: z
            .number()
            .optional()
            .describe("How many hours back to look (default 24)"),
        },
        async (args) => runHistoryTool("get_conversation_stats", { hours: args.hours }),
      ),

      // ---------------------------------------------------------------------
      // Self-evolution — same worktree -> PR -> auto-merge path as the main
      // agent. evolve_start enforces the plan-approval gate in code.
      // ---------------------------------------------------------------------

      tool(
        "evolve_start",
        "Start a new evolution session. Creates an isolated git worktree for making source code changes. Changes are submitted as a GitHub PR and, once all quality gates pass, merged and deployed AUTOMATICALLY — there is no human diff review afterwards. Therefore you MUST post the build plan in the channel and get the user's explicit approval FIRST, then pass that plan here with plan_approved=true.",
        {
          reason: z
            .string()
            .describe("Why this evolution is needed — what capability to add or change"),
          plan: z
            .string()
            .describe(
              "The build plan you posted to the user and they approved: which files change, what each change does, and any risks/tradeoffs. Minimum 80 characters.",
            ),
          plan_approved: z
            .boolean()
            .describe(
              "Must be true. Set this ONLY after the user has explicitly approved the plan in the conversation. Never assume approval.",
            ),
        },
        async (args) =>
          runEvolutionTool(
            "evolve_start",
            {
              reason: args.reason,
              plan: args.plan,
              plan_approved: args.plan_approved,
            },
            options,
          ),
      ),

      tool(
        "evolve_read",
        "Read a file from the worktree during an active evolution. Use this to understand existing code before modifying it.",
        {
          path: z
            .string()
            .describe("File path relative to repo root (e.g. 'src/agent/agent.ts')"),
          id: z
            .string()
            .optional()
            .describe(
              "Evolution id to target. If omitted, uses the most recent active evolution for the current user.",
            ),
        },
        async (args) =>
          runEvolutionTool("evolve_read", { path: args.path, id: args.id }, options),
      ),

      tool(
        "evolve_write",
        "Write a file in the worktree during an active evolution. Creates parent directories as needed. For source code changes to src/, TypeScript files, start.sh, or migrations.",
        {
          path: z
            .string()
            .describe("File path relative to repo root (e.g. 'src/evolution/new-feature.ts')"),
          content: z.string().describe("Content to write to the file"),
          id: z
            .string()
            .optional()
            .describe(
              "Evolution id to target. If omitted, uses the most recent active evolution for the current user.",
            ),
        },
        async (args) =>
          runEvolutionTool(
            "evolve_write",
            { path: args.path, content: args.content, id: args.id },
            options,
          ),
      ),

      tool(
        "evolve_bash",
        "Execute a shell command in the worktree context during an active evolution. Use for running typecheck, inspecting state, etc.",
        {
          command: z
            .string()
            .describe("The shell command to execute (cwd is the evolution worktree)"),
          timeout: z
            .number()
            .optional()
            .describe("Timeout in milliseconds (default 30000, max 60000)"),
          id: z
            .string()
            .optional()
            .describe(
              "Evolution id to target. If omitted, uses the most recent active evolution for the current user.",
            ),
        },
        async (args) =>
          runEvolutionTool(
            "evolve_bash",
            { command: args.command, timeout: args.timeout, id: args.id },
            options,
          ),
      ),

      tool(
        "evolve_propose",
        "Finalize the current evolution: runs typecheck, commits all changes, pushes the branch, runs full validation, creates a GitHub PR, then automatically merges it and restarts to deploy. Fails without merging if typecheck, the boot test, or the test suite don't pass.",
        {
          summary: z
            .string()
            .describe("Short description for the PR title and commit message"),
          id: z
            .string()
            .optional()
            .describe(
              "Evolution id to propose. If omitted, uses the most recent active evolution for the current user.",
            ),
        },
        async (args) =>
          runEvolutionTool(
            "evolve_propose",
            { summary: args.summary, id: args.id },
            options,
          ),
      ),

      tool(
        "evolve_suggest",
        "Record an idea for a potential improvement. Does NOT start an evolution — just records the idea for later review.",
        {
          what: z
            .string()
            .describe("What capability is missing or what could be improved"),
          why: z.string().describe("Context for why this improvement would be useful"),
        },
        async (args) =>
          runEvolutionTool(
            "evolve_suggest",
            { what: args.what, why: args.why },
            options,
          ),
      ),

      tool(
        "evolve_cancel",
        "Cancel an active evolution session. Cleans up the worktree and deletes the branch.",
        {
          id: z
            .string()
            .optional()
            .describe(
              "Evolution id to cancel. If omitted, cancels the most recent active evolution for the current user.",
            ),
        },
        async (args) => runEvolutionTool("evolve_cancel", { id: args.id }, options),
      ),

      tool(
        "evolve_review",
        "Review a proposed evolution PR. Shows summary, changed files, and diff. If no id is provided, shows the most recent proposed evolution.",
        {
          id: z
            .string()
            .optional()
            .describe(
              "Evolution id to review. If omitted, reviews the most recent proposed evolution.",
            ),
        },
        async (args) => runEvolutionTool("evolve_review", { id: args.id }, options),
      ),

      tool(
        "evolve_merge",
        "Manually merge a proposed evolution PR and restart the bot to deploy. Normally unnecessary — evolve_propose auto-merges. Fallback when auto-merge failed.",
        {
          id: z.string().describe("Evolution id to merge"),
        },
        async (args) => runEvolutionTool("evolve_merge", { id: args.id }, options),
      ),
    ],
  });
}
