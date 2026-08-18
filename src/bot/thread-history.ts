import { getMessagesByDiscordKey, type Message as DbMessage } from "../db/index.js";

/**
 * Thread conversation history cache.
 *
 * Threads are the primary conversation surface, so losing their history means
 * the agent loses the conversation. Discord's `messages.fetch()` can fail
 * (rate limits, permissions, transient API errors) or return an incomplete
 * view (only the newest N messages, bot replies sent as embeds/files with no
 * text content). When that happens the agent used to receive an empty history.
 *
 * This module keeps an in-memory cache of the assembled history per thread and
 * merges it with the durable DB records so a full history is always available:
 *
 *   1. Discord fetch (authoritative for recent messages, when it works)
 *   2. In-memory cache (survives Discord API failures within a process)
 *   3. DB messages for `thread:<id>` incl. the archived history (survives restarts)
 */

/** Max messages kept per thread in the cache */
const MAX_CACHED_MESSAGES = 200;

/** Max threads tracked in memory before evicting the least recently used */
const MAX_TRACKED_THREADS = 200;

/** Insertion-ordered map used as a simple LRU (re-inserted on access) */
const cache = new Map<string, DbMessage[]>();

/** threadId -> timestamp of the last /clear, so cleared turns stay forgotten */
const clearedAt = new Map<string, number>();

function touch(threadId: string, messages: DbMessage[]): void {
  cache.delete(threadId);
  cache.set(threadId, messages);
  while (cache.size > MAX_TRACKED_THREADS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Stable-ish identity for a message, used to drop duplicates when merging. */
function dedupeKey(msg: DbMessage): string {
  if (msg.discordMessageId) return `id:${msg.discordMessageId}`;
  // Fall back to role + content; assistant rows logged by the bot have no
  // Discord message id, and the same reply must not appear twice.
  return `${msg.role}:${msg.content.slice(0, 400)}`;
}

/**
 * Merge several history lists into one chronological list without duplicates.
 * Earlier lists win when two entries collide.
 */
export function mergeThreadHistories(lists: DbMessage[][]): DbMessage[] {
  const seen = new Set<string>();
  const merged: DbMessage[] = [];

  for (const list of lists) {
    for (const msg of list) {
      const key = dedupeKey(msg);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(msg);
    }
  }

  merged.sort((a, b) => a.createdAt - b.createdAt);
  return merged;
}

/** Read the cached history for a thread (chronological, may be empty). */
export function getCachedThreadHistory(threadId: string): DbMessage[] {
  const cached = cache.get(threadId);
  if (!cached) return [];
  touch(threadId, cached);
  return cached;
}

/**
 * Load the durable history for a thread from the DB (live + archived rows).
 * Returns chronological order.
 */
export function getStoredThreadHistory(threadId: string, limit = MAX_CACHED_MESSAGES): DbMessage[] {
  try {
    return getMessagesByDiscordKey(`thread:${threadId}`, limit);
  } catch (err) {
    console.error("[thread-history] Failed to load stored thread history:", err);
    return [];
  }
}

/**
 * Build the history to send to the agent for a thread turn.
 *
 * `discordHistory` is what Discord returned (possibly empty on failure).
 * Cached and stored messages fill in whatever Discord did not provide.
 * The result is cached so the next turn survives a Discord fetch failure.
 */
export function buildThreadHistory(opts: {
  threadId: string;
  discordHistory: DbMessage[];
  sessionHistory?: DbMessage[];
  /** Discord message id of the current message, excluded from history */
  currentMessageId?: string;
  /** Max messages handed to the agent */
  limit?: number;
}): DbMessage[] {
  const limit = opts.limit ?? 50;

  const cutoff = clearedAt.get(opts.threadId) ?? 0;

  const merged = mergeThreadHistories([
    opts.discordHistory,
    getCachedThreadHistory(opts.threadId),
    opts.sessionHistory ?? [],
    getStoredThreadHistory(opts.threadId),
  ]).filter(
    (msg) =>
      msg.createdAt > cutoff &&
      (!opts.currentMessageId || msg.discordMessageId !== opts.currentMessageId),
  );

  // Cache the full merged view (larger than what the agent gets), so older
  // turns are not lost once Discord's 50-message window slides past them.
  touch(opts.threadId, merged.slice(-MAX_CACHED_MESSAGES));

  return merged.slice(-limit);
}

/** Append a turn to the cache after it happened (keeps the cache warm). */
export function appendThreadMessages(threadId: string, messages: DbMessage[]): void {
  if (messages.length === 0) return;
  const merged = mergeThreadHistories([cache.get(threadId) ?? [], messages]);
  touch(threadId, merged.slice(-MAX_CACHED_MESSAGES));
}

/**
 * Forget a thread's history (used by /clear). Drops the in-memory cache and
 * records a cutoff timestamp so older Discord/DB messages are not resurrected.
 */
export function clearThreadHistoryCache(threadId: string): void {
  cache.delete(threadId);
  clearedAt.set(threadId, Date.now());
}

/** Cache stats, for debugging. */
export function threadHistoryCacheStats(): { threads: number; messages: number } {
  let messages = 0;
  for (const list of cache.values()) messages += list.length;
  return { threads: cache.size, messages };
}
