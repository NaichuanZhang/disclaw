// ---------------------------------------------------------------------------
// Resource Registry — tracks all evolvable resources with version lineage
// ---------------------------------------------------------------------------
//
// Implements the RSPL (Resource/State/Parameter Layer) concept from Autogenesis:
// Every evolvable entity (skill, prompt, code module) gets a versioned entry
// so we can track lineage, rollback independently, and measure fitness.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { getDb } from "../db/index.js";
import { createLogger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = createLogger("registry");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResourceType = "skill" | "prompt" | "soul" | "code" | "config";

export type ResourceStatus = "active" | "superseded" | "rolled_back" | "deleted";

export interface ResourceVersion {
  id: string;
  resourceType: ResourceType;
  resourceName: string;
  version: number;
  contentHash: string;
  parentVersionId: string | null;
  status: ResourceStatus;
  changeDescription: string | null;
  changedBy: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export interface ResourceSummary {
  resourceType: ResourceType;
  resourceName: string;
  currentVersion: number;
  currentVersionId: string;
  totalVersions: number;
  lastChangedAt: number;
  lastChangedBy: string | null;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToResourceVersion(row: Record<string, unknown>): ResourceVersion {
  return {
    id: row.id as string,
    resourceType: row.resource_type as ResourceType,
    resourceName: row.resource_name as string,
    version: row.version as number,
    contentHash: row.content_hash as string,
    parentVersionId: (row.parent_version_id as string) ?? null,
    status: row.status as ResourceStatus,
    changeDescription: (row.change_description as string) ?? null,
    changedBy: (row.changed_by as string) ?? null,
    metadata: row.metadata
      ? (JSON.parse(row.metadata as string) as Record<string, unknown>)
      : null,
    createdAt: row.created_at as number,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hash of content for change detection.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Register a new version of a resource.
 * If the content hash matches the current version, no new version is created (idempotent).
 * Returns the version entry (new or existing).
 */
export function registerVersion(opts: {
  type: ResourceType;
  name: string;
  contentHash: string;
  changeDescription?: string;
  changedBy?: string;
  metadata?: Record<string, unknown>;
}): ResourceVersion {
  const db = getDb();

  // Get current active version for this resource
  const currentRow = db
    .prepare(
      `SELECT * FROM resource_registry
       WHERE resource_type = ? AND resource_name = ? AND status = 'active'
       ORDER BY version DESC LIMIT 1`,
    )
    .get(opts.type, opts.name) as Record<string, unknown> | undefined;

  const current = currentRow ? rowToResourceVersion(currentRow) : null;

  // If content hasn't changed, return existing version
  if (current && current.contentHash === opts.contentHash) {
    return current;
  }

  // Create new version
  const id = nanoid();
  const version = current ? current.version + 1 : 1;
  const now = Date.now();

  // Mark previous version as superseded
  if (current) {
    db.prepare(
      `UPDATE resource_registry SET status = 'superseded' WHERE id = ?`,
    ).run(current.id);
  }

  db.prepare(
    `INSERT INTO resource_registry (id, resource_type, resource_name, version, content_hash, parent_version_id, status, change_description, changed_by, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
  ).run(
    id,
    opts.type,
    opts.name,
    version,
    opts.contentHash,
    current?.id ?? null,
    opts.changeDescription ?? null,
    opts.changedBy ?? null,
    opts.metadata ? JSON.stringify(opts.metadata) : null,
    now,
  );

  log.info(`Registered ${opts.type}/${opts.name} v${version} (hash: ${opts.contentHash})`);

  return {
    id,
    resourceType: opts.type,
    resourceName: opts.name,
    version,
    contentHash: opts.contentHash,
    parentVersionId: current?.id ?? null,
    status: "active",
    changeDescription: opts.changeDescription ?? null,
    changedBy: opts.changedBy ?? null,
    metadata: opts.metadata ?? null,
    createdAt: now,
  };
}

/**
 * Rollback a resource to a previous version.
 * Marks the current version as 'rolled_back' and creates a new version
 * pointing to the target version's content hash.
 */
export function rollbackResource(opts: {
  type: ResourceType;
  name: string;
  targetVersionId: string;
  changedBy?: string;
}): ResourceVersion {
  const db = getDb();

  const targetRow = db
    .prepare("SELECT * FROM resource_registry WHERE id = ?")
    .get(opts.targetVersionId) as Record<string, unknown> | undefined;

  if (!targetRow) {
    throw new Error(`Target version ${opts.targetVersionId} not found`);
  }

  const target = rowToResourceVersion(targetRow);

  if (target.resourceType !== opts.type || target.resourceName !== opts.name) {
    throw new Error(
      `Target version belongs to ${target.resourceType}/${target.resourceName}, not ${opts.type}/${opts.name}`,
    );
  }

  // Mark current active version as rolled back
  const currentRow = db
    .prepare(
      `SELECT * FROM resource_registry
       WHERE resource_type = ? AND resource_name = ? AND status = 'active'
       ORDER BY version DESC LIMIT 1`,
    )
    .get(opts.type, opts.name) as Record<string, unknown> | undefined;

  if (currentRow) {
    db.prepare(`UPDATE resource_registry SET status = 'rolled_back' WHERE id = ?`).run(
      (currentRow as { id: string }).id,
    );
  }

  // Register new version with the rolled-back-to content hash
  return registerVersion({
    type: opts.type,
    name: opts.name,
    contentHash: target.contentHash,
    changeDescription: `Rollback to v${target.version} (${opts.targetVersionId})`,
    changedBy: opts.changedBy,
    metadata: { rolledBackTo: opts.targetVersionId },
  });
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Get the current active version of a resource.
 */
export function getCurrentVersion(
  type: ResourceType,
  name: string,
): ResourceVersion | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM resource_registry
       WHERE resource_type = ? AND resource_name = ? AND status = 'active'
       ORDER BY version DESC LIMIT 1`,
    )
    .get(type, name) as Record<string, unknown> | undefined;

  return row ? rowToResourceVersion(row) : undefined;
}

/**
 * Get full version history for a resource.
 */
export function getVersionHistory(
  type: ResourceType,
  name: string,
  opts?: { limit?: number },
): ResourceVersion[] {
  const limit = opts?.limit ?? 50;
  const rows = getDb()
    .prepare(
      `SELECT * FROM resource_registry
       WHERE resource_type = ? AND resource_name = ?
       ORDER BY version DESC
       LIMIT ?`,
    )
    .all(type, name, limit) as Record<string, unknown>[];

  return rows.map(rowToResourceVersion);
}

/**
 * Get a specific version by ID.
 */
export function getVersion(id: string): ResourceVersion | undefined {
  const row = getDb()
    .prepare("SELECT * FROM resource_registry WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  return row ? rowToResourceVersion(row) : undefined;
}

/**
 * List all tracked resources with their current version info.
 */
export function listResources(filter?: {
  type?: ResourceType;
}): ResourceSummary[] {
  const db = getDb();

  let sql = `
    SELECT resource_type, resource_name,
           MAX(version) as current_version,
           COUNT(*) as total_versions,
           MAX(created_at) as last_changed_at
    FROM resource_registry
    WHERE status IN ('active', 'superseded', 'rolled_back')
  `;
  const params: unknown[] = [];

  if (filter?.type) {
    sql += " AND resource_type = ?";
    params.push(filter.type);
  }

  sql += " GROUP BY resource_type, resource_name ORDER BY last_changed_at DESC";

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  return rows.map((row) => {
    // Get the current active version ID and changed_by
    const activeRow = db
      .prepare(
        `SELECT id, changed_by FROM resource_registry
         WHERE resource_type = ? AND resource_name = ? AND status = 'active'
         ORDER BY version DESC LIMIT 1`,
      )
      .get(row.resource_type, row.resource_name) as
      | { id: string; changed_by: string | null }
      | undefined;

    return {
      resourceType: row.resource_type as ResourceType,
      resourceName: row.resource_name as string,
      currentVersion: row.current_version as number,
      currentVersionId: activeRow?.id ?? "",
      totalVersions: row.total_versions as number,
      lastChangedAt: row.last_changed_at as number,
      lastChangedBy: activeRow?.changed_by ?? null,
    };
  });
}

/**
 * Get resources that changed within a time window (for evaluation).
 */
export function getRecentChanges(sinceMs?: number): ResourceVersion[] {
  const since = Date.now() - (sinceMs ?? 24 * 60 * 60 * 1000);
  const rows = getDb()
    .prepare(
      `SELECT * FROM resource_registry
       WHERE created_at > ? AND version > 1
       ORDER BY created_at DESC`,
    )
    .all(since) as Record<string, unknown>[];

  return rows.map(rowToResourceVersion);
}

// ---------------------------------------------------------------------------
// Snapshot — capture current state of all skills/prompts on startup
// ---------------------------------------------------------------------------

/**
 * Snapshot all skills currently on disk and register them if not already tracked.
 * Used on startup to establish baseline versions.
 */
export function snapshotSkills(skillsDir: string): number {
  if (!existsSync(skillsDir)) return 0;

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  let registered = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    try {
      const content = readFileSync(skillMdPath, "utf-8");
      const hash = hashContent(content);

      const existing = getCurrentVersion("skill", entry.name);
      if (!existing || existing.contentHash !== hash) {
        registerVersion({
          type: "skill",
          name: entry.name,
          contentHash: hash,
          changeDescription: existing ? "Content changed on disk" : "Initial snapshot",
          changedBy: "system",
        });
        registered++;
      }
    } catch (err) {
      log.warn(`Failed to snapshot skill ${entry.name}: ${err}`);
    }
  }

  if (registered > 0) {
    log.info(`Snapshotted ${registered} skill(s) with changes`);
  }

  return registered;
}

/**
 * Snapshot the SOUL.md file.
 */
export function snapshotSoul(soulPath: string): void {
  if (!existsSync(soulPath)) return;

  try {
    const content = readFileSync(soulPath, "utf-8");
    const hash = hashContent(content);

    const existing = getCurrentVersion("soul", "SOUL.md");
    if (!existing || existing.contentHash !== hash) {
      registerVersion({
        type: "soul",
        name: "SOUL.md",
        contentHash: hash,
        changeDescription: existing ? "Soul updated" : "Initial snapshot",
        changedBy: "system",
      });
    }
  } catch (err) {
    log.warn(`Failed to snapshot SOUL.md: ${err}`);
  }
}

/**
 * Run all snapshots on startup.
 * Call this after initDb() during boot.
 */
export function snapshotAllResources(opts: {
  skillsDir: string;
  soulPath: string;
}): void {
  log.info("Snapshotting evolvable resources...");
  const skillChanges = snapshotSkills(opts.skillsDir);
  snapshotSoul(opts.soulPath);

  const resources = listResources();
  log.info(`Resource registry: ${resources.length} resources tracked (${skillChanges} new/changed)`);
}
