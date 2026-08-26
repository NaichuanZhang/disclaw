// ---------------------------------------------------------------------------
// Prompt fragments shared between the main agent and pilot mode
//
// These strings are part of the bot's identity, not of one runtime's plumbing:
// how it uses memory, and how it talks when /caveman is on. Both the main agent
// (src/agent/agent.ts) and the pilot SDK session (src/pilot/session.ts) build a
// system prompt, and when the text lived in only one of them the two runtimes
// drifted — a pilot channel silently lost memory habits and caveman mode. Keep
// new cross-runtime prompt text here rather than in either caller.
// ---------------------------------------------------------------------------

import type { ChannelConfig } from "../db/index.js";

/**
 * How to use the memory system. Tool names are unprefixed here; pilot's bridge
 * exposes the same tools as `mcp__discordclaw__memory_search` etc. and its
 * prompt already explains that mapping once.
 */
export const MEMORY_RECALL_INSTRUCTIONS = `## Memory

You have access to a persistent memory system. Use it proactively:
- **memory_search**: Search for prior context before answering questions about people, preferences, past decisions, or facts you may have stored. When in doubt, search.
- **memory_get**: Read full context around a search result when you need more detail.

Search memory when:
- A user asks "do you remember…" or references something from the past
- You need context about a user, project, or ongoing topic
- You want to check if you've discussed something before`;

// ---------------------------------------------------------------------------
// Caveman mode
// ---------------------------------------------------------------------------

/** Valid intensity levels for the caveman-speak skill, set via /caveman. */
export const CAVEMAN_LEVELS = ["lite", "full", "ultra"] as const;
export type CavemanLevel = (typeof CAVEMAN_LEVELS)[number];

/** Read the active caveman level for a channel, if any. */
export function getCavemanLevel(config?: ChannelConfig): CavemanLevel | undefined {
  const raw = config?.settings?.cavemanLevel;
  return typeof raw === "string" && (CAVEMAN_LEVELS as readonly string[]).includes(raw)
    ? (raw as CavemanLevel)
    : undefined;
}

export function buildCavemanInstructions(level: CavemanLevel): string {
  return (
    `## Caveman Mode — ACTIVE (level: ${level})\n\n` +
    `Apply the \`caveman-speak\` skill's compression rules to every reply in this channel/thread ` +
    `at intensity **${level}**, until turned off via \`/caveman level:off\`. If you have not already ` +
    `loaded the full rule set this conversation, call \`read_skill\` with skill_name \`caveman-speak\` once. ` +
    `Technical accuracy, code, numbers, and negations must stay exact — only the prose gets terser.`
  );
}
