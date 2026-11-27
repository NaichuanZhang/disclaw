#!/bin/bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Discordclaw deployment pipeline — pull, deps, migrate, build
# Called by start.sh (initial deploy) and daemon (redeploys).
# No process management — just deployment steps.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load .env if present (for DISCORD_WEBHOOK_URL)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

PREVIOUS_HEAD=$(git rev-parse HEAD)
DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"

# ---------------------------------------------------------------------------
# Notification helper (best-effort, never blocks)
# ---------------------------------------------------------------------------
notify() {
  if [ -n "$DISCORD_WEBHOOK_URL" ]; then
    curl -sf -X POST "$DISCORD_WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "{\"content\":\"$1\"}" > /dev/null 2>&1 || true
  fi
}

# ---------------------------------------------------------------------------
# 1. Pull latest
# ---------------------------------------------------------------------------
echo "[deploy] Pulling latest from origin/main..."
if ! git pull origin main; then
  notify "❌ discordclaw: git pull failed on $(hostname)"
  echo "[deploy] ERROR: git pull failed"
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Install deps if lockfile changed
# ---------------------------------------------------------------------------
if git diff --name-only "$PREVIOUS_HEAD" HEAD 2>/dev/null | grep -q "package-lock.json"; then
  echo "[deploy] package-lock.json changed, running npm ci..."
  # --include=dev: the systemd unit sets NODE_ENV=production, which makes a
  # plain `npm ci` drop devDependencies — and tsc/vite (needed by step 4) are
  # devDependencies. PR #170 hit this: build failed with `tsc: not found` and
  # the dashboard kept serving a stale dist/ui for a week.
  npm ci --include=dev
fi

# ---------------------------------------------------------------------------
# 3. Run migrations (idempotent — each tracks its own completion)
# ---------------------------------------------------------------------------
MIGRATION_DIR="$SCRIPT_DIR/migrations"
MARKER_DIR="$SCRIPT_DIR/data/.migrations"
mkdir -p "$MARKER_DIR"

if [ -d "$MIGRATION_DIR" ]; then
  for f in "$MIGRATION_DIR"/*.sh; do
    [ -f "$f" ] || continue
    MIGRATION_NAME=$(basename "$f" .sh)
    MARKER="$MARKER_DIR/$MIGRATION_NAME.done"

    if [ ! -f "$MARKER" ]; then
      echo "[deploy] Running migration: $MIGRATION_NAME..."
      if bash "$f"; then
        date -Iseconds > "$MARKER"
        echo "[deploy] Migration $MIGRATION_NAME completed"
      else
        notify "❌ discordclaw: migration $MIGRATION_NAME failed. Bot NOT started."
        echo "[deploy] ERROR: migration $MIGRATION_NAME failed"
        exit 1
      fi
    fi
  done
fi

# ---------------------------------------------------------------------------
# 3.5. Seed cron jobs if not present
# ---------------------------------------------------------------------------
mkdir -p "$SCRIPT_DIR/data/cron"
if [ ! -f "$SCRIPT_DIR/data/cron/jobs.json" ]; then
  if [ -f "$SCRIPT_DIR/data/cron/jobs.seed.json" ]; then
    echo "[deploy] Seeding cron jobs from jobs.seed.json..."
    cp "$SCRIPT_DIR/data/cron/jobs.seed.json" "$SCRIPT_DIR/data/cron/jobs.json"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Build
# ---------------------------------------------------------------------------
echo "[deploy] Building..."
npm run build

echo "[deploy] Deployment complete ($(git log --oneline -1))"
