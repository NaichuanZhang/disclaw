#!/bin/bash
set -euo pipefail
# Migration: 005-add-resource-registry
# Adds the resource_registry table for tracking all evolvable resources
# with version lineage (Autogenesis Phase 1).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="$SCRIPT_DIR/../data/discordclaw.db"

sqlite3 "$DB_PATH" <<'SQL'
CREATE TABLE IF NOT EXISTS resource_registry (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,       -- 'skill', 'prompt', 'soul', 'code', 'config'
  resource_name TEXT NOT NULL,       -- e.g. 'web-access', 'SOUL.md', 'agent.ts'
  version INTEGER NOT NULL,          -- monotonically increasing per resource
  content_hash TEXT NOT NULL,        -- SHA-256 prefix for change detection
  parent_version_id TEXT,            -- lineage: which version this superseded
  status TEXT NOT NULL DEFAULT 'active',  -- 'active', 'superseded', 'rolled_back', 'deleted'
  change_description TEXT,           -- human-readable description of what changed
  changed_by TEXT,                   -- who/what triggered the change ('system', user ID, 'reflection-daemon')
  metadata TEXT,                     -- JSON blob for extra data (rollback info, metrics, etc.)
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_resource_registry_type_name ON resource_registry(resource_type, resource_name);
CREATE INDEX IF NOT EXISTS idx_resource_registry_status ON resource_registry(status);
CREATE INDEX IF NOT EXISTS idx_resource_registry_created_at ON resource_registry(created_at);
SQL

echo "Resource registry table ready."
