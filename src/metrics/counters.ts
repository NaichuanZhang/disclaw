// ---------------------------------------------------------------------------
// Invocation metrics — counters
// ---------------------------------------------------------------------------
//
// count(path) bumps an in-memory Map (one hash lookup, no I/O). A batched
// flush folds the deltas into the `invocation_metrics` table every 60s and on
// shutdown, so hot paths cost nothing per call.
//
// Every write is try/catch'd: metrics must never be able to crash the bot,
// same rule as logging/logger.ts.
// ---------------------------------------------------------------------------

import { getDb } from "../db/index.js";
import {
  FEATURE_PATHS,
  commandPath,
  routePath,
  skillPath,
  toolPath,
  type PathKind,
  type PathSpec,
} from "./registry.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Un-flushed deltas, path → count since the last flush */
const pending = new Map<string, number>();

/** Everything declared this process, path → spec (used to seed + label rows) */
const declared = new Map<string, PathSpec>();

const DEFAULT_FLUSH_INTERVAL_MS = 60_000;

let flushTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/**
 * Record one invocation of a code path. Cheap enough for hot paths and safe
 * to call before initMetrics() — deltas accumulate until the first flush.
 */
export function count(path: string, n = 1): void {
  pending.set(path, (pending.get(path) ?? 0) + n);
}

/** Count a slash command (or `command.<name>.<subcommand>`) invocation. */
export function countCommand(name: string, subcommand?: string): void {
  count(commandPath(name));
  if (subcommand) count(commandPath(name, subcommand));
}

/** Count an agent tool invocation. */
export function countTool(name: string): void {
  count(toolPath(name));
}

/** Count a gateway route hit. */
export function countRoute(method: string, path: string): void {
  count(routePath(method, path));
}

/** Count a skill being read. */
export function countSkill(name: string): void {
  count(skillPath(name));
}

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

/**
 * Declare paths so they exist in the table with count 0 even if never hit.
 * This is what makes dead-code detection possible. Idempotent; re-declaring
 * refreshes kind/description without touching the accumulated count.
 */
export function declarePaths(specs: PathSpec[]): void {
  if (specs.length === 0) return;
  for (const spec of specs) declared.set(spec.path, spec);

  try {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO invocation_metrics (path, kind, description, rare, count, first_seen, last_seen)
       VALUES (?, ?, ?, ?, 0, NULL, NULL)
       ON CONFLICT(path) DO UPDATE SET
         kind = excluded.kind,
         description = excluded.description,
         rare = excluded.rare`,
    );
    const insertAll = db.transaction((rows: PathSpec[]) => {
      for (const spec of rows) {
        stmt.run(spec.path, spec.kind, spec.description, spec.rare ? 1 : 0);
      }
    });
    insertAll(specs);
  } catch {
    // Never let metrics crash the app
  }
}

/** Declare slash commands (and their subcommands) from the command manifest. */
export function declareCommandPaths(
  commands: ReadonlyArray<{
    name: string;
    description?: string;
    options?: ReadonlyArray<{ name: string; description?: string; type?: number }>;
  }>,
): void {
  const specs: PathSpec[] = [];
  for (const cmd of commands) {
    specs.push({
      path: commandPath(cmd.name),
      kind: "command",
      description: cmd.description ?? `/${cmd.name}`,
    });
    // Discord option type 1 = Subcommand, 2 = SubcommandGroup. Only direct
    // subcommands are counted; groups are represented by their children.
    for (const opt of cmd.options ?? []) {
      if (opt.type !== 1) continue;
      specs.push({
        path: commandPath(cmd.name, opt.name),
        kind: "command",
        description: opt.description ?? `/${cmd.name} ${opt.name}`,
      });
    }
  }
  declarePaths(specs);
}

/** Declare every registered agent tool, so unused tools surface as dead. */
export function declareToolPaths(
  tools: ReadonlyArray<{ name: string; description?: string }>,
): void {
  declarePaths(
    tools.map((t) => ({
      path: toolPath(t.name),
      kind: "tool" as PathKind,
      description: (t.description ?? t.name).split("\n")[0].slice(0, 200),
    })),
  );
}

/** Declare gateway routes by walking the Express router stack. */
export function declareRoutePaths(router: {
  stack?: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>;
}): void {
  const specs: PathSpec[] = [];
  for (const layer of router.stack ?? []) {
    const route = layer.route;
    if (!route?.path) continue;
    for (const [method, enabled] of Object.entries(route.methods ?? {})) {
      if (!enabled || method === "_all") continue;
      specs.push({
        path: routePath(method, route.path),
        kind: "route",
        description: `Gateway ${method.toUpperCase()} ${route.path}`,
      });
    }
  }
  declarePaths(specs);
}

/** Declare installed skills, so never-read skills surface as dead. */
export function declareSkillPaths(
  skills: ReadonlyArray<{ name: string; description?: string }>,
): void {
  declarePaths(
    skills.map((s) => ({
      path: skillPath(s.name),
      kind: "skill" as PathKind,
      description: (s.description ?? s.name).slice(0, 200),
    })),
  );
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

/**
 * Fold pending deltas into the table. Returns the number of distinct paths
 * written. Safe to call at any time; a failed flush drops that batch rather
 * than retrying, since usage stats are advisory.
 */
export function flushMetrics(): number {
  if (pending.size === 0) return 0;

  const batch = [...pending.entries()];
  pending.clear();
  const now = Date.now();

  try {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO invocation_metrics (path, kind, description, rare, count, first_seen, last_seen)
       VALUES (?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         count = count + excluded.count,
         first_seen = COALESCE(invocation_metrics.first_seen, excluded.first_seen),
         last_seen = excluded.last_seen`,
    );
    const writeAll = db.transaction((rows: Array<[string, number]>) => {
      for (const [path, delta] of rows) {
        const spec = declared.get(path);
        // Undeclared paths are still recorded (kind "feature") so a missed
        // declaration shows up as data rather than vanishing.
        stmt.run(path, spec?.kind ?? "feature", spec?.description ?? null, delta, now, now);
      }
    });
    writeAll(batch);
    return batch.length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Seed the hand-instrumented paths and start the periodic flush.
 * Call once after initDb(). The timer is unref'd so it never holds the
 * process open.
 */
export function initMetrics(opts?: { flushIntervalMs?: number }): void {
  declarePaths(FEATURE_PATHS);

  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => {
    flushMetrics();
  }, opts?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

/** Stop the periodic flush and persist whatever is pending. */
export function stopMetrics(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  flushMetrics();
}

/** Test/introspection helper — pending deltas that have not been written yet. */
export function pendingMetrics(): Record<string, number> {
  return Object.fromEntries(pending);
}
