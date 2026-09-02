// ---------------------------------------------------------------------------
// SDK sessions — per-session folders
//
// Every session owns a folder under the workspace, and the layout mirrors
// Discord's own channel -> thread hierarchy. Artifacts belong in there rather
// than in the workspace root, so the folder is also the durable record of the
// conversation: the CLI prunes its own transcripts and a failed resume silently
// starts a fresh session, at which point this folder is all that is left.
//
// Split out of session.ts on purpose. These are pure path helpers, but
// session.ts reaches the database, so importing it drags the whole db module
// graph along — enough to matter in a test worker. attachments.ts avoids the
// same import for the same reason, and derives its path from DATA_DIR too; a
// test pins the two definitions in agreement.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../shared/paths.js";

/**
 * Root for per-session folders.
 *
 * Derived from DATA_DIR rather than imported from session.ts, per the note
 * above. A test asserts this stays equal to `<SDK_WORKSPACE_DIR>/sessions`.
 */
export const SDK_SESSIONS_DIR = path.join(DATA_DIR, "sdk", "workspace", "sessions");

/**
 * One path segment, safe to join. Discord ids are numeric snowflakes, but this
 * also takes cron and test ids (`chan-1`, `dm-1`) — so the rule is an allowlist
 * rather than digits-only, which would collapse `chan-1` and `dm-1` onto the
 * same folder. Everything outside [A-Za-z0-9_-] becomes `_`, which also makes
 * `.`/`..` traversal impossible.
 */
function safeSegment(id: string): string {
  const cleaned = id.trim().replace(/[^A-Za-z0-9_-]+/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown";
}

/**
 * The folder a session owns, mirroring Discord's channel -> thread hierarchy.
 *
 * A thread is keyed by its *own* snowflake (see `SdkChannelTarget.id`), and
 * snowflakes are globally unique — so a flat `sessions/<id>` would never
 * collide, and a composite `<parent>-<child>` name would buy nothing while
 * making the id harder to paste back into a Discord URL. The parent id is used
 * for *nesting* instead, so a channel's work and its threads' work group
 * together the way settings and `/clear` already resolve thread-then-parent.
 *
 * No parent (a text channel, a DM, a group DM) stays flat at the top level.
 */
export function sdkSessionDir(
  channelId: string,
  parentId?: string | null,
): string {
  const own = safeSegment(channelId);
  if (!parentId || parentId.trim().length === 0) {
    return path.join(SDK_SESSIONS_DIR, own);
  }
  return path.join(SDK_SESSIONS_DIR, safeSegment(parentId), "threads", own);
}

/**
 * Create the folder a session owns, and seed its CLAUDE.md if absent.
 *
 * An existing file is never overwritten — it holds notes we must not clobber.
 * Failure is non-fatal: a session that cannot write its folder still runs.
 */
export function ensureSdkSessionDir(
  channelId: string,
  parentId?: string | null,
  channelName?: string,
): string {
  const dir = sdkSessionDir(channelId, parentId);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const claudeMd = path.join(dir, "CLAUDE.md");
    if (!existsSync(claudeMd)) {
      writeFileSync(claudeMd, sessionClaudeMd(channelId, parentId, channelName));
    }
  } catch (err) {
    console.error(
      `[sdk] could not scaffold session folder ${dir}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return dir;
}

/**
 * Seed contents for a session's CLAUDE.md. The heading carries the human label
 * because that is the one thing that can be renamed in Discord — the ids below
 * it cannot, which is why the folder is named after them.
 */
function sessionClaudeMd(
  channelId: string,
  parentId?: string | null,
  channelName?: string,
): string {
  return [
    `# ${channelName?.trim() || channelId}`,
    "",
    `- **Session id:** ${channelId}`,
    `- **Parent:** ${parentId || "none"}`,
    "- **Status:** active",
    "- **Goal:** _not recorded yet_",
    "",
    "## Key paths",
    "",
    "## Notes",
    "",
    "<!-- Scaffolded by the SDK session. Keep Status current and log decisions",
    "     here as you go: this file outlives the transcript. -->",
    "",
  ].join("\n");
}
