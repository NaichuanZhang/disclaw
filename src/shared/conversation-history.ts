// ---------------------------------------------------------------------------
// Shared conversation history tools — bridged into every SDK session
// ---------------------------------------------------------------------------

import type Anthropic from "@anthropic-ai/sdk";
import { getRecentMessages, getConversationStats } from "../db/index.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const conversationHistoryTools: Anthropic.Messages.Tool[] = [
  {
    name: "get_conversation_history",
    description:
      "Get recent conversation messages from the database, spanning across all sessions (including archived ones). " +
      "Use this to review what conversations happened recently. Returns messages newest-first.",
    input_schema: {
      type: "object" as const,
      properties: {
        hours: {
          type: "number",
          description: "How many hours back to look (default: 24)",
        },
        limit: {
          type: "number",
          description: "Max messages to return (default: 100, max: 500)",
        },
        role: {
          type: "string",
          description: "Filter by role: 'user' or 'assistant' (default: both)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_conversation_stats",
    description:
      "Get statistics about recent conversations: total sessions, messages, unique users, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        hours: {
          type: "number",
          description: "How many hours back to look (default: 24)",
        },
      },
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export function handleConversationHistoryTool(
  name: string,
  input: Record<string, unknown>,
): string {
  try {
    switch (name) {
      case "get_conversation_history": {
        const hours = (input.hours as number) || 24;
        const limit = Math.min((input.limit as number) || 100, 500);
        const role = input.role as string | undefined;

        const messages = getRecentMessages({
          sinceMs: hours * 60 * 60 * 1000,
          limit,
          role,
        });

        const formatted = messages.map((m) => ({
          role: m.role,
          content: m.content.slice(0, 500), // Truncate long messages
          channel: m.discordKey || m.channelId || "unknown",
          userId: m.userId,
          timestamp: new Date(m.createdAt).toISOString(),
          hasMore: m.content.length > 500,
        }));

        return JSON.stringify({
          count: formatted.length,
          hours_back: hours,
          messages: formatted,
        });
      }

      case "get_conversation_stats": {
        const hours = (input.hours as number) || 24;
        const stats = getConversationStats(hours * 60 * 60 * 1000);
        return JSON.stringify(stats);
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
