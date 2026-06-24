// ---------------------------------------------------------------------------
// Structured Logging — lightweight, queryable log system
// ---------------------------------------------------------------------------
//
// Three log streams:
//   1. application_log — general operational events (info, warn, debug)
//   2. error_log       — errors & exceptions (error, fatal)
//   3. tool_call_log   — every tool invocation with input, result, timing
//
// Storage: SQLite tables (queryable by reflection daemon, evolve, debug).
// Console output: preserved for daemon log buffer & human readability.
// ---------------------------------------------------------------------------

import { getDb } from "../db/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type LogCategory =
  | "agent"
  | "bot"
  | "cron"
  | "daemon"
  | "db"
  | "evolution"
  | "gateway"
  | "memory"
  | "reflection"
  | "registry"
  | "session-lock"
  | "skills"
  | "soul"
  | "voice"
  | "startup"
  | "shutdown";

export interface LogEntry {
  level: LogLevel;
  category: LogCategory;
  message: string;
  /** Arbitrary structured data */
  metadata?: Record<string, unknown>;
  /** Associated session ID if available */
  sessionId?: string;
  /** Associated user ID if available */
  userId?: string;
}

export interface ToolCallEntry {
  /** Tool name */
  tool: string;
  /** Tool input arguments */
  input: Record<string, unknown>;
  /** Tool result string (truncated for storage) */
  result?: string;
  /** Whether the tool call succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Invoking context */
  context?: "interactive" | "cron" | "voice";
  /** Associated session ID */
  sessionId?: string;
  /** Associated user ID */
  userId?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum length of stored tool input/result JSON strings */
const MAX_STORED_LENGTH = 2000;

/** Minimum log level to record in DB. Console always gets everything. */
let minDbLevel: LogLevel = "info";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

/**
 * Set the minimum log level for DB persistence.
 * Logs below this level still go to console but aren't stored.
 */
export function setMinLogLevel(level: LogLevel): void {
  minDbLevel = level;
}

function shouldPersist(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minDbLevel];
}

// ---------------------------------------------------------------------------
// Truncation helper
// ---------------------------------------------------------------------------

function truncate(s: string, max: number = MAX_STORED_LENGTH): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 20) + `... [truncated ${s.length - max + 20} chars]`;
}

// ---------------------------------------------------------------------------
// Application log
// ---------------------------------------------------------------------------

/**
 * Write an application log entry.
 * Always writes to console. Persists to DB if level >= minDbLevel.
 */
export function appLog(entry: LogEntry): void {
  const prefix = `[${entry.category}]`;

  // Console output (matches existing format for backward compat)
  const consoleFn =
    entry.level === "error" || entry.level === "fatal"
      ? console.error
      : entry.level === "warn"
        ? console.warn
        : console.log;
  consoleFn(prefix, entry.message);

  // DB persistence
  if (!shouldPersist(entry.level)) return;

  try {
    getDb()
      .prepare(
        `INSERT INTO application_log (level, category, message, metadata, session_id, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.level,
        entry.category,
        truncate(entry.message, 5000),
        entry.metadata ? truncate(JSON.stringify(entry.metadata), MAX_STORED_LENGTH) : null,
        entry.sessionId ?? null,
        entry.userId ?? null,
        Date.now(),
      );
  } catch {
    // Never let logging crash the app
  }
}

// ---------------------------------------------------------------------------
// Error log
// ---------------------------------------------------------------------------

/**
 * Write an error log entry.
 * Always persists to DB (errors are always worth recording).
 */
export function errorLog(opts: {
  category: LogCategory;
  message: string;
  error?: Error | unknown;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  userId?: string;
}): void {
  const stack =
    opts.error instanceof Error
      ? opts.error.stack ?? opts.error.message
      : opts.error
        ? String(opts.error)
        : null;

  // Console output
  console.error(`[${opts.category}]`, opts.message, opts.error ?? "");

  try {
    getDb()
      .prepare(
        `INSERT INTO error_log (level, category, message, stack, metadata, session_id, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "error",
        opts.category,
        truncate(opts.message, 5000),
        stack ? truncate(stack, 5000) : null,
        opts.metadata ? truncate(JSON.stringify(opts.metadata), MAX_STORED_LENGTH) : null,
        opts.sessionId ?? null,
        opts.userId ?? null,
        Date.now(),
      );
  } catch {
    // Never let logging crash the app
  }
}

// ---------------------------------------------------------------------------
// Tool call log
// ---------------------------------------------------------------------------

/**
 * Record a tool call with timing and result.
 * Always persists (tool calls are high-value debug info).
 */
export function toolCallLog(entry: ToolCallEntry): void {
  // Console output (keep existing format)
  const prefix = entry.context === "cron" ? "[agent] Cron tool call:" : "[agent] Tool call:";
  console.log(prefix, entry.tool, JSON.stringify(entry.input));

  try {
    getDb()
      .prepare(
        `INSERT INTO tool_call_log (tool, input, result, success, error, duration_ms, context, session_id, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.tool,
        truncate(JSON.stringify(entry.input), MAX_STORED_LENGTH),
        entry.result ? truncate(entry.result, MAX_STORED_LENGTH) : null,
        entry.success ? 1 : 0,
        entry.error ? truncate(entry.error, 1000) : null,
        entry.durationMs,
        entry.context ?? null,
        entry.sessionId ?? null,
        entry.userId ?? null,
        Date.now(),
      );
  } catch {
    // Never let logging crash the app
  }
}

// ---------------------------------------------------------------------------
// Convenience logger factory (for modules)
// ---------------------------------------------------------------------------

export interface Logger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, error?: Error | unknown, metadata?: Record<string, unknown>): void;
  fatal(message: string, error?: Error | unknown, metadata?: Record<string, unknown>): void;
}

/**
 * Create a scoped logger for a module.
 * Returns functions that auto-set the category.
 *
 * Usage:
 *   const log = createLogger("agent");
 *   log.info("Processing message", { userId: "123" });
 *   log.error("Failed to process", someError);
 */
export function createLogger(category: LogCategory): Logger {
  return {
    debug(message: string, metadata?: Record<string, unknown>) {
      appLog({ level: "debug", category, message, metadata });
    },
    info(message: string, metadata?: Record<string, unknown>) {
      appLog({ level: "info", category, message, metadata });
    },
    warn(message: string, metadata?: Record<string, unknown>) {
      appLog({ level: "warn", category, message, metadata });
    },
    error(message: string, error?: Error | unknown, metadata?: Record<string, unknown>) {
      errorLog({ category, message, error, metadata });
    },
    fatal(message: string, error?: Error | unknown, metadata?: Record<string, unknown>) {
      errorLog({ category, message: `FATAL: ${message}`, error, metadata });
    },
  };
}
