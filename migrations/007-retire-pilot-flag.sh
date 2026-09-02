#!/bin/bash
set -euo pipefail
# Migration: 007-retire-pilot-flag
#
# The Claude Agent SDK is now the only agent runtime, so the per-channel
# `settings.pilot` flag no longer selects anything. It did carry a second,
# unrelated meaning though: a pilot channel answered every message without
# needing a mention. That behaviour lives in `settings.monitor`, so every
# pilot-flagged channel is promoted to monitored before the flag is dropped —
# otherwise those channels would silently go quiet after the deploy.
#
# Also renames the persisted session id key (`pilotSessionId` -> `sdkSessionId`)
# so live sessions resume instead of starting cold. The reader still falls back
# to the old key, so running this is safe either way.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="$SCRIPT_DIR/../data/discordclaw.db"

if [ ! -f "$DB_PATH" ]; then
  echo "[007] No database at $DB_PATH, nothing to migrate."
  exit 0
fi

# json_set/json_remove need SQLite's JSON1 extension; bail out loudly if absent
# rather than corrupting the settings column.
if ! sqlite3 "$DB_PATH" "SELECT json_valid('{}');" >/dev/null 2>&1; then
  echo "[007] SQLite lacks JSON1 support; skipping (settings left untouched)."
  exit 0
fi

before=$(sqlite3 "$DB_PATH" "
  SELECT COUNT(*) FROM channel_configs
  WHERE settings IS NOT NULL
    AND json_valid(settings)
    AND json_extract(settings, '\$.pilot') = 1;
")
echo "[007] Pilot-flagged channels: $before"

sqlite3 "$DB_PATH" <<'SQL'
-- A pilot channel answered every message; keep that by making it monitored.
UPDATE channel_configs
SET settings = json_set(settings, '$.monitor', json('true'))
WHERE settings IS NOT NULL
  AND json_valid(settings)
  AND json_extract(settings, '$.pilot') = 1;

-- Carry the persisted session id over to its new key.
UPDATE channel_configs
SET settings = json_remove(
      json_set(settings, '$.sdkSessionId', json_extract(settings, '$.pilotSessionId')),
      '$.pilotSessionId'
    )
WHERE settings IS NOT NULL
  AND json_valid(settings)
  AND json_extract(settings, '$.pilotSessionId') IS NOT NULL;

-- The flag itself no longer means anything.
UPDATE channel_configs
SET settings = json_remove(settings, '$.pilot')
WHERE settings IS NOT NULL
  AND json_valid(settings)
  AND json_extract(settings, '$.pilot') IS NOT NULL;
SQL

# The `pilot.*` invocation metrics are now `sdk.*`; carry the counts over so the
# dead-code report does not show three brand-new features and three that vanished.
sqlite3 "$DB_PATH" <<'SQL'
UPDATE OR REPLACE invocation_metrics
SET path = 'sdk.' || substr(path, length('pilot.') + 1),
    description = replace(replace(description, 'pilot session', 'SDK session'), 'Pilot session', 'SDK session')
WHERE path LIKE 'pilot.%';
SQL

remaining=$(sqlite3 "$DB_PATH" "
  SELECT COUNT(*) FROM channel_configs
  WHERE settings IS NOT NULL
    AND json_valid(settings)
    AND (json_extract(settings, '\$.pilot') IS NOT NULL
         OR json_extract(settings, '\$.pilotSessionId') IS NOT NULL);
")
echo "[007] Remaining pilot keys: $remaining"
