// ---------------------------------------------------------------------------
// SDK sessions — per-session folders
//
// Every session owns a folder under the workspace, and the layout mirrors
// Discord's own channel -> thread hierarchy. That folder is also the session's
// cwd, so artifacts land in it by default rather than by discipline, and the
// CLI loads its CLAUDE.md along with the workspace and repo ones above it.
// It is the durable record of the conversation: the CLI prunes its own
// transcripts and a failed resume silently starts a fresh session, at which
// point this folder is all that is left.
//
// Split out of session.ts on purpose. These are pure path helpers, but
// session.ts reaches the database, so importing it drags the whole db module
// graph along — enough to matter in a test worker. attachments.ts avoids the
// same import for the same reason, and derives its path from DATA_DIR too; a
// test pins the two definitions in agreement.
// ---------------------------------------------------------------------------

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
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
 * Is `child` the directory `parent`, or something inside it?
 *
 * The separator in the prefix is the whole point: a plain `startsWith` would
 * also match a *sibling* whose name merely begins with the parent's, so
 * `<workspace>-old` would look like it lived inside `<workspace>`.
 */
export function isInsideDir(parent: string, child: string): boolean {
  const root = path.resolve(parent);
  const resolved = path.resolve(child);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Where a session's Discord attachments are downloaded.
 *
 * Inside the session folder, so an upload lands next to the work it belongs to
 * and the 24h pruner is scoped to one conversation instead of a shared inbox.
 */
export function sdkSessionInboxDir(
  channelId: string,
  parentId?: string | null,
): string {
  return path.join(sdkSessionDir(channelId, parentId), "inbox");
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

// ---------------------------------------------------------------------------
// Transcript location
//
// The CLI stores a session's transcript at
// `~/.claude/projects/<project-key>/<session-id>.jsonl`, and derives the
// project key from **cwd**. Per-session cwd therefore moves the key, so a
// session id stored while cwd was the workspace root points at a transcript the
// CLI will no longer look for — the resume fails before the `system/init`
// handshake, and session.ts starts fresh. `migrateTranscript()` closes that gap.
// ---------------------------------------------------------------------------

/** Where the CLI keeps per-project transcript directories. */
export const CLAUDE_PROJECTS_DIR = path.join(homedir(), ".claude", "projects");

/**
 * The CLI's project key for a working directory: the absolute path with every
 * separator replaced by `-` (so `/a/b` -> `-a-b`, leading dash included).
 *
 * Confirmed empirically against the shipped CLI rather than read off a
 * contract, so `session.ts` cross-checks it against the `transcript_path` in
 * `system/init` and warns on a mismatch instead of trusting it blindly.
 */
export function claudeProjectKey(cwd: string): string {
  return path.resolve(cwd).split(path.sep).join("-");
}

/** The transcript directory the CLI will use for a session running in `cwd`. */
export function claudeProjectDir(
  cwd: string,
  projectsRoot: string = CLAUDE_PROJECTS_DIR,
): string {
  return path.join(projectsRoot, claudeProjectKey(cwd));
}

export type TranscriptMigrationStatus =
  /** The destination already has it — nothing to do, the common case. */
  | "already-present"
  /** Found elsewhere and copied into place. */
  | "copied"
  /** Not under any project key: the CLI has already pruned it. */
  | "source-missing"
  /** Something went wrong; the caller carries on and lets the resume fail. */
  | "failed";

export interface TranscriptMigrationResult {
  status: TranscriptMigrationStatus;
  /** Directory the transcript was copied from, when status is "copied". */
  from?: string;
  /** Directory it now lives in, when it is there. */
  to?: string;
  /** Human-readable reason, for "failed". */
  detail?: string;
}

export interface MigrateTranscriptOptions {
  /** The CLI's session id (a UUID), i.e. the `<id>.jsonl` basename. */
  sessionId: string;
  /** The cwd the session is about to run in. */
  toCwd: string;
  /** Injected for tests. Defaults to CLAUDE_PROJECTS_DIR. */
  projectsRoot?: string;
}

/**
 * Make a session's transcript findable from a new cwd.
 *
 * **Copies, never moves.** The project key is derived from an empirically
 * confirmed rule rather than a documented one, so a wrong derivation must not
 * be able to destroy history: leaving the original in place means the worst
 * outcome is a duplicated file, and reverting the cwd change still resumes.
 * Transcripts are small (hundreds of KB) and only the handful the CLI has not
 * yet pruned are ever copied.
 *
 * Subagent transcripts live in a sibling `<session-id>/` directory, so they are
 * copied too — otherwise a resumed session loses its nested agent history.
 *
 * Never throws: a failure here costs at most the resume, which session.ts
 * already recovers from by clearing the stored id and starting fresh.
 */
export function migrateTranscript(
  options: MigrateTranscriptOptions,
): TranscriptMigrationResult {
  const { sessionId, toCwd } = options;
  const projectsRoot = options.projectsRoot ?? CLAUDE_PROJECTS_DIR;

  // The id becomes a filename, so it must not be able to escape the directory.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    return { status: "failed", detail: `unsafe session id: ${sessionId}` };
  }

  try {
    const destDir = claudeProjectDir(toCwd, projectsRoot);
    const destFile = path.join(destDir, `${sessionId}.jsonl`);
    if (existsSync(destFile)) {
      return { status: "already-present", to: destDir };
    }

    if (!existsSync(projectsRoot)) {
      return { status: "source-missing" };
    }

    let sourceDir: string | undefined;
    for (const entry of readdirSync(projectsRoot)) {
      const candidateDir = path.join(projectsRoot, entry);
      if (path.resolve(candidateDir) === path.resolve(destDir)) continue;
      if (existsSync(path.join(candidateDir, `${sessionId}.jsonl`))) {
        sourceDir = candidateDir;
        break;
      }
    }
    if (!sourceDir) {
      return { status: "source-missing" };
    }

    mkdirSync(destDir, { recursive: true });
    copyFileSync(
      path.join(sourceDir, `${sessionId}.jsonl`),
      destFile,
    );

    // Subagent transcripts, if this session spawned any.
    const sourceSubagents = path.join(sourceDir, sessionId);
    if (existsSync(sourceSubagents) && statSync(sourceSubagents).isDirectory()) {
      cpSync(sourceSubagents, path.join(destDir, sessionId), {
        recursive: true,
      });
    }

    return { status: "copied", from: sourceDir, to: destDir };
  } catch (err) {
    return {
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
