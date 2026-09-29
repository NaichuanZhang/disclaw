import { nanoid } from "nanoid";
import {
  getDb,
  getSession,
  createSession,
  updateSessionActivity,
  getSessionMessages,
  deleteSession,
  pruneMessageHistory,
  type Session,
  type Message,
} from "../db/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL_HOURS = 24;
const DEFAULT_MAX_MESSAGES = 50;

/** Archived messages are kept for 30 days by default */
const MESSAGE_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function getSessionTtlMs(): number {
  const hours = Number(process.env.SESSION_TTL_HOURS) || DEFAULT_TTL_HOURS;
  return hours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Discord key builders
// ---------------------------------------------------------------------------

function buildDiscordKey(opts: {
  threadId?: string;
  channelId: string;
  userId: string;
  isDM: boolean;
}): string {
  if (opts.threadId) return `thread:${opts.threadId}`;
  if (opts.isDM) return `dm:${opts.userId}`;
  return `channel:${opts.channelId}`;
}

// ---------------------------------------------------------------------------
// Expiry check
// ---------------------------------------------------------------------------

function isThreadKey(discordKey: string): boolean {
  return discordKey.startsWith("thread:");
}

function isExpired(session: Session): boolean {
  // Thread sessions never expire — Discord thread messages persist,
  // so the session should live as long as the thread exists.
  if (isThreadKey(session.discordKey)) return false;
  return Date.now() - session.lastActive > getSessionTtlMs();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve or create a session for the given Discord context.
 *
 * Key priority: thread > DM > channel.
 */
export function resolveSession(opts: {
  threadId?: string;
  channelId: string;
  userId: string;
  guildId?: string;
  isDM: boolean;
}): Session {
  const discordKey = buildDiscordKey(opts);
  const existing = getSession(discordKey);

  if (existing) {
    if (isExpired(existing)) {
      console.log(`[sessions] Session ${existing.id} expired (key=${discordKey}), replacing`);
      // deleteSession now archives messages to message_history before removing
      deleteSession(existing.id);
    } else {
      updateSessionActivity(existing.id);
      return { ...existing, lastActive: Date.now() };
    }
  }

  const id = nanoid();
  const session = createSession({
    id,
    discordKey,
    guildId: opts.guildId,
    channelId: opts.channelId,
    userId: opts.userId,
  });
  console.log(`[sessions] Created session ${id} (key=${discordKey})`);
  return session;
}

/**
 * Return the most recent messages for a session, for context building.
 */
export function getSessionHistory(
  sessionId: string,
  maxMessages: number = DEFAULT_MAX_MESSAGES,
): Message[] {
  return getSessionMessages(sessionId, maxMessages);
}

/**
 * Delete a session and archive its messages.
 */
export function clearSession(sessionId: string): void {
  console.log(`[sessions] Clearing session ${sessionId}`);
  deleteSession(sessionId);
}

/**
 * Store the Claude SDK agent session ID so we can resume conversations.
 */
export function setAgentSessionId(sessionId: string, agentSessionId: string): void {
  getDb()
    .prepare("UPDATE sessions SET agent_session_id = ? WHERE id = ?")
    .run(agentSessionId, sessionId);
}

/**
 * List sessions with optional guild filter and pagination.
 */
export function listSessions(opts?: {
  guildId?: string;
  limit?: number;
  offset?: number;
}): { sessions: Session[]; total: number } {
  const db = getDb();
  const guildId = opts?.guildId;
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  let total: number;
  let rows: Record<string, unknown>[];

  if (guildId) {
    total = (db.prepare("SELECT COUNT(*) as total FROM sessions WHERE guild_id = ?")
      .get(guildId) as { total: number }).total;
    rows = db.prepare("SELECT * FROM sessions WHERE guild_id = ? ORDER BY last_active DESC LIMIT ? OFFSET ?")
      .all(guildId, limit, offset) as Record<string, unknown>[];
  } else {
    total = (db.prepare("SELECT COUNT(*) as total FROM sessions")
      .get() as { total: number }).total;
    rows = db.prepare("SELECT * FROM sessions ORDER BY last_active DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as Record<string, unknown>[];
  }

  const sessions: Session[] = rows.map((row) => ({
    id: row.id as string,
    discordKey: row.discord_key as string,
    agentSessionId: (row.agent_session_id as string) ?? undefined,
    guildId: (row.guild_id as string) ?? undefined,
    channelId: (row.channel_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    createdAt: row.created_at as number,
    lastActive: row.last_active as number,
  }));

  return { sessions, total };
}

/**
 * Delete all sessions that have been inactive longer than the TTL.
 * Thread sessions are exempt — they never expire.
 * Messages are archived to message_history before deletion.
 * Also prunes very old archived messages (30 days).
 * Returns the number of sessions deleted.
 */
export function cleanExpiredSessions(): number {
  const cutoff = Date.now() - getSessionTtlMs();
  const db = getDb();

  // Only expire non-thread sessions
  const expired = db
    .prepare("SELECT id FROM sessions WHERE last_active < ? AND discord_key NOT LIKE 'thread:%'")
    .all(cutoff) as { id: string }[];

  if (expired.length === 0) {
    // Still prune old archived messages periodically
    const pruned = pruneMessageHistory(MESSAGE_HISTORY_RETENTION_MS);
    if (pruned > 0) {
      console.log(`[sessions] Pruned ${pruned} old archived message(s)`);
    }
    return 0;
  }

  // deleteSession archives messages before deleting
  for (const { id } of expired) {
    deleteSession(id);
  }

  console.log(`[sessions] Cleaned ${expired.length} expired session(s) (messages archived)`);

  // Also prune very old archived messages
  const pruned = pruneMessageHistory(MESSAGE_HISTORY_RETENTION_MS);
  if (pruned > 0) {
    console.log(`[sessions] Pruned ${pruned} old archived message(s)`);
  }

  return expired.length;
}
