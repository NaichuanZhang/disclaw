#!/bin/bash
set -euo pipefail
# Migration: 006-dedup-evolution-ideas
# Deduplicates the evolution ideas backlog by consolidating near-duplicate ideas.
# Groups ideas by theme and keeps only the most recent one per group,
# marking others as 'rejected' with a note.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="$SCRIPT_DIR/../data/discordclaw.db"

# Mark duplicate ideas as rejected, keeping only the most recent in each category.
# Categories identified by pattern matching on trigger_message:
#   1. Reflection JSON parsing (5+ dupes)
#   2. Bash timeout/kill logic (5+ dupes)
#   3. Signal collection hooks (5+ dupes)
#   4. Batch/parallel bash commands (5+ dupes)
#   5. Memory search caching (2 dupes)
#   6. Retry logic for connection errors (2 dupes)
#   7. Progress reporting for bash (2 dupes)

sqlite3 "$DB_PATH" <<'SQL'
-- Keep the most recent of each duplicate group, reject the rest

-- 1. Reflection JSON parsing duplicates
UPDATE evolutions SET status = 'rejected', changes_summary = 'Deduped: reflection JSON parsing (consolidated)'
WHERE status = 'idea'
  AND trigger_message LIKE '%reflection%JSON%pars%'
  AND id NOT IN (
    SELECT id FROM evolutions
    WHERE status = 'idea' AND trigger_message LIKE '%reflection%JSON%pars%'
    ORDER BY created_at DESC LIMIT 1
  );

-- 2. Bash timeout/kill duplicates
UPDATE evolutions SET status = 'rejected', changes_summary = 'Deduped: bash timeout/kill (consolidated)'
WHERE status = 'idea'
  AND (trigger_message LIKE '%bash%timeout%' OR trigger_message LIKE '%bash%kill%' OR trigger_message LIKE '%timeout%bash%')
  AND id NOT IN (
    SELECT id FROM evolutions
    WHERE status = 'idea' AND (trigger_message LIKE '%bash%timeout%' OR trigger_message LIKE '%bash%kill%' OR trigger_message LIKE '%timeout%bash%')
    ORDER BY created_at DESC LIMIT 1
  );

-- 3. Signal collection hook duplicates
UPDATE evolutions SET status = 'rejected', changes_summary = 'Deduped: signal collection hooks (consolidated)'
WHERE status = 'idea'
  AND trigger_message LIKE '%signal%collection%'
  AND id NOT IN (
    SELECT id FROM evolutions
    WHERE status = 'idea' AND trigger_message LIKE '%signal%collection%'
    ORDER BY created_at DESC LIMIT 1
  );

-- 4. Batch/parallel bash command duplicates
UPDATE evolutions SET status = 'rejected', changes_summary = 'Deduped: batch/parallel bash (consolidated)'
WHERE status = 'idea'
  AND (trigger_message LIKE '%batch%bash%' OR trigger_message LIKE '%parallel%bash%' OR trigger_message LIKE '%command chaining%')
  AND id NOT IN (
    SELECT id FROM evolutions
    WHERE status = 'idea' AND (trigger_message LIKE '%batch%bash%' OR trigger_message LIKE '%parallel%bash%' OR trigger_message LIKE '%command chaining%')
    ORDER BY created_at DESC LIMIT 1
  );

-- 5. Memory search caching duplicates
UPDATE evolutions SET status = 'rejected', changes_summary = 'Deduped: memory search caching (consolidated)'
WHERE status = 'idea'
  AND trigger_message LIKE '%memory_search%cach%'
  AND id NOT IN (
    SELECT id FROM evolutions
    WHERE status = 'idea' AND trigger_message LIKE '%memory_search%cach%'
    ORDER BY created_at DESC LIMIT 1
  );

-- 6. Retry logic duplicates
UPDATE evolutions SET status = 'rejected', changes_summary = 'Deduped: retry logic (consolidated)'
WHERE status = 'idea'
  AND trigger_message LIKE '%retry%'
  AND id NOT IN (
    SELECT id FROM evolutions
    WHERE status = 'idea' AND trigger_message LIKE '%retry%'
    ORDER BY created_at DESC LIMIT 1
  );

-- 7. Progress reporting duplicates
UPDATE evolutions SET status = 'rejected', changes_summary = 'Deduped: progress reporting (consolidated)'
WHERE status = 'idea'
  AND trigger_message LIKE '%progress%'
  AND id NOT IN (
    SELECT id FROM evolutions
    WHERE status = 'idea' AND trigger_message LIKE '%progress%'
    ORDER BY created_at DESC LIMIT 1
  );

SQL

# Report results
REMAINING=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM evolutions WHERE status='idea'")
REJECTED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM evolutions WHERE status='rejected' AND changes_summary LIKE 'Deduped:%'")

echo "Deduplication complete: $REJECTED ideas consolidated, $REMAINING unique ideas remaining."
