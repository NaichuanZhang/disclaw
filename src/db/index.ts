import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../shared/paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  discordKey: string;
  agentSessionId?: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
  createdAt: number;
  lastActive: number;
}

export interface Message {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  discordMessageId?: string;
  createdAt: number;
  // Token usage (populated for assistant messages)
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

/** A message with session context for cross-session queries */
export interface MessageWithContext extends Message {
  discordKey?: string;
  channelId?: string;
  userId?: string;
}

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface ChannelConfig {
  channelId: string;
  guildId?: string;
  enabled: boolean;
  systemPrompt?: string;
  settings: Record<string, unknown>;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Database path
// ---------------------------------------------------------------------------

const DB_PATH = join(DATA_DIR, "discordclaw.db");

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  return db;
}

// ---------------------------------------------------------------------------
// Schema initialisation
// ---------------------------------------------------------------------------

export function initDb(): void {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      discord_key TEXT NOT NULL UNIQUE,
      agent_session_id TEXT,
      guild_id TEXT,
      channel_id TEXT,
      user_id TEXT,
      created_at INTEGER NOT NULL,
      last_active INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      discord_message_id TEXT,
      created_at INTEGER NOT NULL,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_creation_tokens INTEGER,
      cache_read_tokens INTEGER
    );

    CREATE TABLE IF NOT EXISTS channel_configs (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT,
      enabled INTEGER DEFAULT 1,
      system_prompt TEXT,
      settings TEXT DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      path,
      chunk_text,
      start_line UNINDEXED,
      end_line UNINDEXED
    );

    CREATE TABLE IF NOT EXISTS evolutions (
      id TEXT PRIMARY KEY,
      triggered_by TEXT,
      trigger_message TEXT,
      branch TEXT,
      pr_url TEXT,
      pr_number INTEGER,
      status TEXT NOT NULL DEFAULT 'idea',
      changes_summary TEXT,
      files_changed TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      proposed_at INTEGER,
      merged_at INTEGER,
      deployed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      source TEXT,
      detail TEXT NOT NULL,
      metadata TEXT,
      session_id TEXT,
      user_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS reflection_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      signals_analyzed INTEGER DEFAULT 0,
      outcome TEXT,
      proposal TEXT,
      evolution_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS resource_registry (
      id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL,
      resource_name TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      parent_version_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      change_description TEXT,
      changed_by TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS agent_questions (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      user_id TEXT,
      question TEXT NOT NULL,
      options_json TEXT,
      answer TEXT,
      answer_source TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      answered_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_agent_questions_status ON agent_questions(status);
    CREATE INDEX IF NOT EXISTS idx_agent_questions_channel ON agent_questions(channel_id);
  `);

  // ---------------------------------------------------------------------------
  // Migrations — add message_history table for archived messages
  // ---------------------------------------------------------------------------

  // Check if message_history table exists
  const hasMessageHistory = d.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='message_history'"
  ).get();

  if (!hasMessageHistory) {
    d.exec(`
      CREATE TABLE message_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        discord_key TEXT,
        channel_id TEXT,
        user_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        discord_message_id TEXT,
        created_at INTEGER NOT NULL,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_creation_tokens INTEGER,
        cache_read_tokens INTEGER,
        archived_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE INDEX idx_message_history_created_at ON message_history(created_at);
      CREATE INDEX idx_message_history_user_id ON message_history(user_id);
      CREATE INDEX idx_message_history_channel_id ON message_history(channel_id);
    `);
  }

  // ---------------------------------------------------------------------------
  // Migrations — add artifacts table for persistent file tracking
  // ---------------------------------------------------------------------------

  const hasArtifacts = d.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'"
  ).get();

  if (!hasArtifacts) {
    d.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT,
        disk_path TEXT NOT NULL,
        discord_url TEXT,
        discord_message_id TEXT,
        size_bytes INTEGER,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_artifacts_session ON artifacts(session_id);
      CREATE INDEX idx_artifacts_direction ON artifacts(direction);
      CREATE INDEX idx_artifacts_created_at ON artifacts(created_at);
    `);
  }

  // ---------------------------------------------------------------------------
  // Migrations — add worktree_dir column to evolutions for multi-worktree support
  // ---------------------------------------------------------------------------

  const evolutionColumns = d.prepare("PRAGMA table_info(evolutions)").all() as { name: string }[];
  const hasWorktreeDir = evolutionColumns.some((c) => c.name === "worktree_dir");

  if (!hasWorktreeDir) {
    d.exec(`ALTER TABLE evolutions ADD COLUMN worktree_dir TEXT`);
  }

  // Migration — add plan column: the human-approved build plan captured at
  // evolve_start time. Required because deploys are auto-merged, so the plan
  // approval is the primary human gate and must be auditable.
  const hasPlan = evolutionColumns.some((c) => c.name === "plan");

  if (!hasPlan) {
    d.exec(`ALTER TABLE evolutions ADD COLUMN plan TEXT`);
  }

  // Create indexes (idempotent — CREATE INDEX IF NOT EXISTS)
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(type);
    CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_resource_registry_type_name ON resource_registry(resource_type, resource_name);
    CREATE INDEX IF NOT EXISTS idx_resource_registry_status ON resource_registry(status);
    CREATE INDEX IF NOT EXISTS idx_resource_registry_created_at ON resource_registry(created_at);
  `);

  // ---------------------------------------------------------------------------
  // Structured logging tables
  // ---------------------------------------------------------------------------

  d.exec(`
    CREATE TABLE IF NOT EXISTS application_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT,
      session_id TEXT,
      user_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT,
      metadata TEXT,
      session_id TEXT,
      user_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE TABLE IF NOT EXISTS tool_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool TEXT NOT NULL,
      input TEXT,
      result TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      context TEXT,
      session_id TEXT,
      user_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_application_log_created_at ON application_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_application_log_level ON application_log(level);
    CREATE INDEX IF NOT EXISTS idx_application_log_category ON application_log(category);

    CREATE INDEX IF NOT EXISTS idx_error_log_created_at ON error_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_error_log_category ON error_log(category);

    CREATE INDEX IF NOT EXISTS idx_tool_call_log_created_at ON tool_call_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_tool_call_log_tool ON tool_call_log(tool);
    CREATE INDEX IF NOT EXISTS idx_tool_call_log_success ON tool_call_log(success);
  `);
}

// ---------------------------------------------------------------------------
// Row <-> interface mapping helpers
// ---------------------------------------------------------------------------

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    discordKey: row.discord_key as string,
    agentSessionId: (row.agent_session_id as string) ?? undefined,
    guildId: (row.guild_id as string) ?? undefined,
    channelId: (row.channel_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
    createdAt: row.created_at as number,
    lastActive: row.last_active as number,
  };
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    role: row.role as string,
    content: row.content as string,
    discordMessageId: (row.discord_message_id as string) ?? undefined,
    createdAt: row.created_at as number,
    model: (row.model as string) ?? undefined,
    inputTokens: (row.input_tokens as number) ?? undefined,
    outputTokens: (row.output_tokens as number) ?? undefined,
    cacheCreationTokens: (row.cache_creation_tokens as number) ?? undefined,
    cacheReadTokens: (row.cache_read_tokens as number) ?? undefined,
  };
}

function rowToMessageWithContext(row: Record<string, unknown>): MessageWithContext {
  return {
    ...rowToMessage(row),
    discordKey: (row.discord_key as string) ?? undefined,
    channelId: (row.channel_id as string) ?? undefined,
    userId: (row.user_id as string) ?? undefined,
  };
}

function rowToChannelConfig(row: Record<string, unknown>): ChannelConfig {
  return {
    channelId: row.channel_id as string,
    guildId: (row.guild_id as string) ?? undefined,
    enabled: (row.enabled as number) === 1,
    systemPrompt: (row.system_prompt as string) ?? undefined,
    settings: JSON.parse((row.settings as string) || "{}") as Record<string, unknown>,
    updatedAt: row.updated_at as number,
  };
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

export function getSession(discordKey: string): Session | undefined {
  const row = getDb()
    .prepare("SELECT * FROM sessions WHERE discord_key = ?")
    .get(discordKey) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export function createSession(opts: {
  id: string;
  discordKey: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
}): Session {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, discord_key, guild_id, channel_id, user_id, created_at, last_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(opts.id, opts.discordKey, opts.guildId ?? null, opts.channelId ?? null, opts.userId ?? null, now, now);

  return {
    id: opts.id,
    discordKey: opts.discordKey,
    guildId: opts.guildId,
    channelId: opts.channelId,
    userId: opts.userId,
    createdAt: now,
    lastActive: now,
  };
}

export function updateSessionActivity(id: string): void {
  getDb()
    .prepare("UPDATE sessions SET last_active = ? WHERE id = ?")
    .run(Date.now(), id);
}

/**
 * Delete a session but archive its messages to message_history first.
 */
export function deleteSession(id: string): void {
  const d = getDb();
  const del = d.transaction(() => {
    // Archive messages before deleting
    d.prepare(`
      INSERT INTO message_history (session_id, discord_key, channel_id, user_id, role, content, discord_message_id, created_at, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, archived_at)
      SELECT m.session_id, s.discord_key, s.channel_id, s.user_id, m.role, m.content, m.discord_message_id, m.created_at, m.model, m.input_tokens, m.output_tokens, m.cache_creation_tokens, m.cache_read_tokens, ?
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.session_id = ?
    `).run(Date.now(), id);

    d.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    d.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  });
  del();
}

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

export function getSessionMessages(sessionId: string, limit?: number): Message[] {
  const sql = limit
    ? "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?"
    : "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC";

  const rows = limit
    ? (getDb().prepare(sql).all(sessionId, limit) as Record<string, unknown>[])
    : (getDb().prepare(sql).all(sessionId) as Record<string, unknown>[]);

  return rows.map(rowToMessage);
}

/**
 * Get messages for a Discord conversation key (e.g. `thread:123`), across
 * both live sessions and the archived `message_history` table.
 *
 * This is the durable fallback for thread context: even if the live session
 * was expired/deleted or the process restarted, the messages that were logged
 * for that thread are still recoverable.
 *
 * Returns messages in chronological order (oldest first), newest `limit` kept.
 */
export function getMessagesByDiscordKey(discordKey: string, limit = 50): Message[] {
  const sql = `
    SELECT * FROM (
      SELECT m.id, m.session_id, m.role, m.content, m.discord_message_id, m.created_at,
             m.model, m.input_tokens, m.output_tokens, m.cache_creation_tokens, m.cache_read_tokens
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE s.discord_key = @key

      UNION ALL

      SELECT id, session_id, role, content, discord_message_id, created_at,
             model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
      FROM message_history
      WHERE discord_key = @key
    )
    ORDER BY created_at DESC
    LIMIT @limit
  `;

  const rows = getDb().prepare(sql).all({ key: discordKey, limit }) as Record<string, unknown>[];
  return rows.map(rowToMessage).reverse();
}

export function addMessage(opts: {
  sessionId: string;
  role: string;
  content: string;
  discordMessageId?: string;
  usage?: TokenUsage;
}): void {
  getDb()
    .prepare(
      `INSERT INTO messages (session_id, role, content, discord_message_id, created_at, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.sessionId,
      opts.role,
      opts.content,
      opts.discordMessageId ?? null,
      Date.now(),
      opts.usage?.model ?? null,
      opts.usage?.inputTokens ?? null,
      opts.usage?.outputTokens ?? null,
      opts.usage?.cacheCreationTokens ?? null,
      opts.usage?.cacheReadTokens ?? null,
    );
}

// ---------------------------------------------------------------------------
// Cross-session message queries (for reflection, cron, history review)
// ---------------------------------------------------------------------------

/**
 * Get recent messages across all sessions (active + archived).
 * Queries both the live `messages` table and the `message_history` archive.
 * Returns messages ordered by created_at DESC (newest first).
 */
export function getRecentMessages(opts?: {
  /** How far back to look in milliseconds (default: 24 hours) */
  sinceMs?: number;
  /** Max messages to return (default: 100) */
  limit?: number;
  /** Filter by user ID */
  userId?: string;
  /** Filter by role (user/assistant) */
  role?: string;
}): MessageWithContext[] {
  const since = Date.now() - (opts?.sinceMs ?? 24 * 60 * 60 * 1000);
  const limit = opts?.limit ?? 100;
  const userId = opts?.userId ?? null;
  const role = opts?.role ?? null;
  const d = getDb();

  const sql = `
    SELECT * FROM (
      SELECT m.id, m.session_id, m.role, m.content, m.discord_message_id, m.created_at,
             m.model, m.input_tokens, m.output_tokens, m.cache_creation_tokens, m.cache_read_tokens,
             s.discord_key, s.channel_id, s.user_id
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.created_at > @since
        AND (@userId IS NULL OR s.user_id = @userId)
        AND (@role IS NULL OR m.role = @role)

      UNION ALL

      SELECT id, session_id, role, content, discord_message_id, created_at,
             model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
             discord_key, channel_id, user_id
      FROM message_history
      WHERE created_at > @since
        AND (@userId IS NULL OR user_id = @userId)
        AND (@role IS NULL OR role = @role)
    )
    ORDER BY created_at DESC
    LIMIT @limit
  `;

  const rows = d.prepare(sql).all({ since, userId, role, limit }) as Record<string, unknown>[];
  return rows.map(rowToMessageWithContext);
}

/**
 * Get conversation history stats for a time period.
 */
export function getConversationStats(sinceMs?: number): {
  totalSessions: number;
  activeSessions: number;
  totalMessages: number;
  totalUserMessages: number;
  totalAssistantMessages: number;
  uniqueUsers: number;
} {
  const since = Date.now() - (sinceMs ?? 24 * 60 * 60 * 1000);
  const d = getDb();

  const activeSessions = (d.prepare(
    "SELECT COUNT(*) as count FROM sessions WHERE last_active > ?"
  ).get(since) as { count: number }).count;

  const archivedSessions = (d.prepare(
    "SELECT COUNT(DISTINCT session_id) as count FROM message_history WHERE created_at > ?"
  ).get(since) as { count: number }).count;

  const liveMessages = (d.prepare(
    "SELECT COUNT(*) as count FROM messages WHERE created_at > ?"
  ).get(since) as { count: number }).count;

  const archivedMessages = (d.prepare(
    "SELECT COUNT(*) as count FROM message_history WHERE created_at > ?"
  ).get(since) as { count: number }).count;

  const liveUserMessages = (d.prepare(
    "SELECT COUNT(*) as count FROM messages WHERE created_at > ? AND role = 'user'"
  ).get(since) as { count: number }).count;

  const archivedUserMessages = (d.prepare(
    "SELECT COUNT(*) as count FROM message_history WHERE created_at > ? AND role = 'user'"
  ).get(since) as { count: number }).count;

  const uniqueUsers = (d.prepare(`
    SELECT COUNT(DISTINCT user_id) as count FROM (
      SELECT user_id FROM sessions WHERE last_active > ? AND user_id IS NOT NULL
      UNION
      SELECT user_id FROM message_history WHERE created_at > ? AND user_id IS NOT NULL
    )
  `).get(since, since) as { count: number }).count;

  const totalMessages = liveMessages + archivedMessages;
  const totalUserMessages = liveUserMessages + archivedUserMessages;

  return {
    totalSessions: activeSessions + archivedSessions,
    activeSessions,
    totalMessages,
    totalUserMessages,
    totalAssistantMessages: totalMessages - totalUserMessages,
    uniqueUsers,
  };
}

/**
 * Prune archived messages older than a retention period.
 * Default retention: 30 days.
 */
export function pruneMessageHistory(retentionMs?: number): number {
  const cutoff = Date.now() - (retentionMs ?? 30 * 24 * 60 * 60 * 1000);
  const result = getDb()
    .prepare("DELETE FROM message_history WHERE created_at < ?")
    .run(cutoff);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Channel config helpers
// ---------------------------------------------------------------------------

export function getChannelConfig(channelId: string): ChannelConfig | undefined {
  const row = getDb()
    .prepare("SELECT * FROM channel_configs WHERE channel_id = ?")
    .get(channelId) as Record<string, unknown> | undefined;
  return row ? rowToChannelConfig(row) : undefined;
}

export function setChannelConfig(channelId: string, config: Partial<ChannelConfig>): void {
  const now = Date.now();
  const existing = getChannelConfig(channelId);

  if (existing) {
    const guildId = config.guildId ?? existing.guildId ?? null;
    const enabled = config.enabled !== undefined ? (config.enabled ? 1 : 0) : (existing.enabled ? 1 : 0);
    const systemPrompt = config.systemPrompt ?? existing.systemPrompt ?? null;
    const settings = config.settings
      ? JSON.stringify(config.settings)
      : JSON.stringify(existing.settings);

    getDb()
      .prepare(
        `UPDATE channel_configs
         SET guild_id = ?, enabled = ?, system_prompt = ?, settings = ?, updated_at = ?
         WHERE channel_id = ?`
      )
      .run(guildId, enabled, systemPrompt, settings, now, channelId);
  } else {
    const guildId = config.guildId ?? null;
    const enabled = config.enabled !== undefined ? (config.enabled ? 1 : 0) : 1;
    const systemPrompt = config.systemPrompt ?? null;
    const settings = config.settings ? JSON.stringify(config.settings) : "{}";

    getDb()
      .prepare(
        `INSERT INTO channel_configs (channel_id, guild_id, enabled, system_prompt, settings, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(channelId, guildId, enabled, systemPrompt, settings, now);
  }
}

// ---------------------------------------------------------------------------
// Global config helpers
// ---------------------------------------------------------------------------

export function getConfig(key: string): string | undefined {
  const row = getDb()
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setConfig(key: string, value: string): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)")
    .run(key, value);
}

export function deleteConfig(key: string): void {
  getDb().prepare("DELETE FROM config WHERE key = ?").run(key);
}
