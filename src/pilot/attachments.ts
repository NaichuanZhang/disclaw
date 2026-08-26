// ---------------------------------------------------------------------------
// Pilot mode — Discord attachments
//
// The main agent turns attachments into Claude vision/document content blocks.
// A pilot session can't take content blocks: its prompt is plain text and it
// has its own native Read tool. So pilot goes the other way — the attachment is
// downloaded into the session's own workspace and the *path* is handed over, and
// the model reads (or ignores) it like any other local file.
//
// Files land in <workspace>/inbox/<messageId>/<name>. Names are sanitised,
// downloads are size-capped, and the inbox is pruned on a rolling window so a
// busy pilot channel can't fill the disk.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../shared/paths.js";

/**
 * Where downloaded attachments land, inside the pilot workspace.
 *
 * Derived from DATA_DIR rather than imported from session.ts on purpose: this
 * module is loaded from bot/messages.ts alongside session.ts, and importing the
 * constant across the cycle evaluated to `undefined`. A test asserts this stays
 * equal to `<PILOT_WORKSPACE_DIR>/inbox`.
 */
export const PILOT_INBOX_DIR = path.join(DATA_DIR, "pilot", "workspace", "inbox");

/** Per-file download cap. Discord's own limit is 25 MB for most uploads. */
const DEFAULT_MAX_BYTES = Number(
  process.env.PILOT_ATTACHMENT_MAX_BYTES || 25 * 1024 * 1024,
);

/** How long a message's inbox directory is kept before pruning. */
const DEFAULT_MAX_AGE_MS = Number(
  process.env.PILOT_INBOX_MAX_AGE_MS || 24 * 60 * 60 * 1000,
);

/** Longest filename we write, before the extension is preserved. */
const MAX_NAME_CHARS = 120;

/** The subset of a Discord attachment we need — plain data, easy to fabricate. */
export interface PilotAttachmentInput {
  name: string;
  url: string;
  size?: number;
  contentType?: string | null;
}

export interface SavedPilotAttachment {
  /** Name as written to disk (sanitised, possibly de-duplicated). */
  name: string;
  /** Absolute path handed to the session. */
  path: string;
  bytes: number;
  contentType?: string;
}

export interface SkippedPilotAttachment {
  name: string;
  reason: string;
}

export interface PilotAttachmentResult {
  saved: SavedPilotAttachment[];
  skipped: SkippedPilotAttachment[];
}

export interface SavePilotAttachmentsOptions {
  /** Override the per-file cap (bytes). */
  maxBytes?: number;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to PILOT_INBOX_DIR. */
  inboxDir?: string;
  /** Skip the rolling prune (tests). */
  prune?: boolean;
}

/**
 * Make a Discord-supplied filename safe to write.
 *
 * Discord allows names we must not pass to the filesystem verbatim: path
 * separators, `..`, leading dots, control characters. Everything outside a
 * conservative set becomes `_`, and the extension is preserved when the name is
 * truncated so the model (and any tool it uses) still sees the file type.
 */
export function sanitizeAttachmentName(raw: string): string {
  // Basename only: kills "../" and any directory component outright.
  const base = path.basename(String(raw ?? ""));
  // Whitelist in one pass, so control characters and separators are covered.
  let name = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (!name) return "file";

  if (name.length > MAX_NAME_CHARS) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, MAX_NAME_CHARS - ext.length) + ext;
  }
  return name;
}

/** First free name in `dir`, appending -1, -2, … before the extension. */
function uniqueName(dir: string, name: string): string {
  if (!existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** Human-readable size for the block the model reads. */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Download a message's attachments into the pilot inbox.
 *
 * Never throws: a failed or oversized attachment becomes a `skipped` entry so
 * the session is told about it rather than silently losing it.
 */
export async function savePilotAttachments(
  messageId: string,
  attachments: PilotAttachmentInput[],
  options: SavePilotAttachmentsOptions = {},
): Promise<PilotAttachmentResult> {
  const result: PilotAttachmentResult = { saved: [], skipped: [] };
  if (attachments.length === 0) return result;

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const inboxRoot = options.inboxDir ?? PILOT_INBOX_DIR;
  const doFetch = options.fetchImpl ?? fetch;
  const dir = path.join(inboxRoot, sanitizeAttachmentName(messageId) || "message");

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    for (const a of attachments) {
      result.skipped.push({
        name: a.name,
        reason: `could not create inbox dir: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return result;
  }

  for (const attachment of attachments) {
    // Trust the declared size for the cheap rejection, then verify the real
    // body length — a lying header must not get us to write 2 GB.
    if (typeof attachment.size === "number" && attachment.size > maxBytes) {
      result.skipped.push({
        name: attachment.name,
        reason: `too large (${fmtBytes(attachment.size)} > ${fmtBytes(maxBytes)})`,
      });
      continue;
    }

    try {
      const response = await doFetch(attachment.url);
      if (!response.ok) {
        result.skipped.push({
          name: attachment.name,
          reason: `download failed (HTTP ${response.status})`,
        });
        continue;
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) {
        result.skipped.push({
          name: attachment.name,
          reason: `too large (${fmtBytes(bytes.byteLength)} > ${fmtBytes(maxBytes)})`,
        });
        continue;
      }

      const name = uniqueName(dir, sanitizeAttachmentName(attachment.name));
      const filePath = path.join(dir, name);
      writeFileSync(filePath, bytes);
      result.saved.push({
        name,
        path: filePath,
        bytes: bytes.byteLength,
        contentType: attachment.contentType ?? undefined,
      });
    } catch (err) {
      result.skipped.push({
        name: attachment.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (options.prune !== false) {
    try {
      prunePilotInbox({ inboxDir: inboxRoot });
    } catch {
      // Pruning is housekeeping; never let it affect the turn.
    }
  }

  return result;
}

/**
 * The text appended to the message the session receives. Absolute paths, so the
 * model can Read them without guessing the workspace layout. Returns "" when
 * there was nothing to report.
 */
export function formatAttachmentBlock(result: PilotAttachmentResult): string {
  const lines: string[] = [];

  if (result.saved.length > 0) {
    lines.push(
      "",
      "[Attachments saved to disk — read them with your own tools (Read/Bash); they are deleted after 24h]",
    );
    for (const file of result.saved) {
      const meta = [file.contentType, fmtBytes(file.bytes)].filter(Boolean).join(", ");
      lines.push(`- ${file.path}${meta ? ` (${meta})` : ""}`);
    }
  }

  if (result.skipped.length > 0) {
    lines.push("", "[Attachments that could not be saved]");
    for (const file of result.skipped) {
      lines.push(`- ${file.name}: ${file.reason}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

export interface PrunePilotInboxOptions {
  maxAgeMs?: number;
  inboxDir?: string;
  /** Injected for tests. */
  now?: () => number;
}

/**
 * Delete inbox directories older than the window. Returns how many were
 * removed. Best-effort per directory: one unreadable entry doesn't stop the rest.
 */
export function prunePilotInbox(options: PrunePilotInboxOptions = {}): number {
  const dir = options.inboxDir ?? PILOT_INBOX_DIR;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now?.() ?? Date.now();
  if (!existsSync(dir)) return 0;

  let removed = 0;
  for (const entry of readdirSync(dir)) {
    const target = path.join(dir, entry);
    try {
      const stats = statSync(target);
      if (now - stats.mtimeMs > maxAgeMs) {
        rmSync(target, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // Vanished or unreadable — nothing to do.
    }
  }
  return removed;
}
