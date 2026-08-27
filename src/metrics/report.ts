// ---------------------------------------------------------------------------
// Invocation metrics — queries & reports
// ---------------------------------------------------------------------------
//
// Reading these numbers:
//   dead      count = 0 and not marked `rare` → strong dead-code candidate
//   rare-idle count = 0 but declared `rare` → an error/fallback path that is
//             *supposed* to be idle; not a deletion candidate
//   low-use   ran, but under a threshold → candidate for simplification
//   stale     ran once upon a time, nothing recently → probably obsolete
//
// A zero count only ever means "not observed since instrumentation landed".
// It is evidence, not proof: check `firstSeen` on the table as a whole before
// concluding anything from a short observation window.
// ---------------------------------------------------------------------------

import { getDb } from "../db/index.js";
import type { PathKind } from "./registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricRow {
  path: string;
  kind: PathKind;
  description: string | null;
  /** Expected to be idle (error handler / fallback) */
  rare: boolean;
  count: number;
  firstSeen: number | null;
  lastSeen: number | null;
}

export interface MetricsSummary {
  kind: string;
  /** Declared paths of this kind */
  declared: number;
  /** Declared but never observed (excluding `rare`) */
  dead: number;
  /** Total invocations recorded */
  invocations: number;
}

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function toMetricRow(row: Record<string, unknown>): MetricRow {
  return {
    path: row.path as string,
    kind: row.kind as PathKind,
    description: (row.description as string) ?? null,
    rare: !!row.rare,
    count: row.count as number,
    firstSeen: (row.first_seen as number) ?? null,
    lastSeen: (row.last_seen as number) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** All recorded paths, busiest first. */
export function getMetrics(opts?: {
  kind?: PathKind;
  minCount?: number;
  limit?: number;
}): MetricRow[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts?.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts?.minCount !== undefined) {
    where.push("count >= ?");
    params.push(opts.minCount);
  }

  const sql = `SELECT * FROM invocation_metrics
               ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY count DESC, path ASC
               LIMIT ?`;
  params.push(opts?.limit ?? 500);

  const rows = getDb().prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(toMetricRow);
}

/**
 * Declared paths that have never been invoked — the dead-code candidates.
 * Paths marked `rare` are excluded unless includeRare is set, because an idle
 * error handler is working as intended.
 */
export function getDeadPaths(opts?: { kind?: PathKind; includeRare?: boolean }): MetricRow[] {
  const where = ["count = 0"];
  const params: unknown[] = [];

  if (!opts?.includeRare) where.push("rare = 0");
  if (opts?.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }

  const rows = getDb()
    .prepare(
      `SELECT * FROM invocation_metrics
       WHERE ${where.join(" AND ")}
       ORDER BY kind ASC, path ASC`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(toMetricRow);
}

/** Paths that ran, but rarely — candidates for removal or simplification. */
export function getLowUsePaths(opts?: {
  threshold?: number;
  kind?: PathKind;
  limit?: number;
}): MetricRow[] {
  const threshold = opts?.threshold ?? 5;
  const where = ["count > 0", "count <= ?"];
  const params: unknown[] = [threshold];

  if (opts?.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }

  const rows = getDb()
    .prepare(
      `SELECT * FROM invocation_metrics
       WHERE ${where.join(" AND ")}
       ORDER BY count ASC, path ASC
       LIMIT ?`,
    )
    .all(...params, opts?.limit ?? 200) as Record<string, unknown>[];
  return rows.map(toMetricRow);
}

/** Paths used at some point but not within the given window. */
export function getStalePaths(opts?: { days?: number; limit?: number }): MetricRow[] {
  const cutoff = Date.now() - (opts?.days ?? 30) * 24 * 60 * 60 * 1000;
  const rows = getDb()
    .prepare(
      `SELECT * FROM invocation_metrics
       WHERE count > 0 AND last_seen IS NOT NULL AND last_seen < ?
       ORDER BY last_seen ASC
       LIMIT ?`,
    )
    .all(cutoff, opts?.limit ?? 200) as Record<string, unknown>[];
  return rows.map(toMetricRow);
}

/** Per-kind rollup: how much of each surface is actually used. */
export function getMetricsSummary(): MetricsSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT kind,
              COUNT(*) AS declared,
              SUM(CASE WHEN count = 0 AND rare = 0 THEN 1 ELSE 0 END) AS dead,
              SUM(count) AS invocations
       FROM invocation_metrics
       GROUP BY kind
       ORDER BY kind ASC`,
    )
    .all() as Record<string, unknown>[];

  return rows.map((row) => ({
    kind: row.kind as string,
    declared: row.declared as number,
    dead: (row.dead as number) ?? 0,
    invocations: (row.invocations as number) ?? 0,
  }));
}

/**
 * When instrumentation first observed anything. Use it to judge whether a zero
 * count is meaningful yet — a one-hour window says very little about a feature
 * someone uses monthly.
 */
export function getObservationWindow(): { since: number | null; until: number | null } {
  const row = getDb()
    .prepare(
      `SELECT MIN(first_seen) AS since, MAX(last_seen) AS until
       FROM invocation_metrics WHERE first_seen IS NOT NULL`,
    )
    .get() as Record<string, unknown> | undefined;

  return {
    since: (row?.since as number) ?? null,
    until: (row?.until as number) ?? null,
  };
}
