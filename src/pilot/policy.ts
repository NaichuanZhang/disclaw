// ---------------------------------------------------------------------------
// Pilot mode — tool-call policy rules (CURRENTLY NOT ENFORCED)
//
// These pure functions used to back pilot mode's `canUseTool` gate. Pilot
// sessions now run with `permissionMode: 'bypassPermissions'` (see
// session.ts), so nothing in this file is consulted at runtime — tool calls
// are unguarded by operator choice. The module is kept (and unit-tested) so
// the gate can be re-wired by restoring `canUseTool` or adding a `PreToolUse`
// hook.
//
// The rules, if re-enabled, are intentionally conservative:
//   - our own source tree, git metadata and secrets are off limits
//   - shell commands that push code, escalate privileges or exfiltrate
//     credentials are refused
//   - everything else is allowed, so the session stays useful
// ---------------------------------------------------------------------------

import path from "node:path";

export interface PilotPolicyContext {
  /** Absolute path of the sandboxed working directory for pilot sessions. */
  workspaceDir: string;
  /** Absolute path of this bot's repository root. */
  repoRoot: string;
  /** Absolute path of the user's home directory. */
  homeDir: string;
}

export interface PolicyDecision {
  allow: boolean;
  reason?: string;
}

/** Tools whose input names a file/directory we should check. */
const PATH_INPUT_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
  "target_file",
];

/**
 * Repo-relative path prefixes the pilot session may never read or write.
 * `src/**` in particular keeps pilot mode from side-stepping the evolution
 * plan-approval gate.
 */
const PROTECTED_REPO_PREFIXES = [
  "src",
  ".git",
  ".github",
  "worktrees",
  "node_modules/.bin",
  "migrations",
  "start.sh",
  ".env",
];

/** Home-relative paths that hold credentials. */
const PROTECTED_HOME_PREFIXES = [
  ".ssh",
  ".aws",
  ".config/gh",
  ".claude/.credentials.json",
  ".gnupg",
  ".npmrc",
  ".git-credentials",
];

/** Shell command patterns that are refused outright. */
const DENIED_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\b/, reason: "git push is not allowed in pilot mode" },
  { pattern: /\bgit\s+remote\s+(add|set-url)\b/, reason: "changing git remotes is not allowed" },
  { pattern: /\bgh\s+(pr|release|auth|api|secret)\b/, reason: "gh write/auth commands are not allowed" },
  { pattern: /\bsudo\b|\bdoas\b|\bsu\s+-\b/, reason: "privilege escalation is not allowed" },
  { pattern: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f?\s+\/(?:\s|$)/, reason: "recursive delete of / is not allowed" },
  { pattern: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/, reason: "publishing packages is not allowed" },
  { pattern: /\bcurl\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/, reason: "piping downloads into a shell is not allowed" },
  { pattern: /\bwget\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/, reason: "piping downloads into a shell is not allowed" },
  { pattern: /\bshutdown\b|\breboot\b|\bsystemctl\s+(stop|disable|restart)\b/, reason: "service/host control is not allowed" },
  { pattern: /(^|\s)\.env(\s|$|\.|\/)/, reason: "reading .env is not allowed" },
  { pattern: /\.credentials\.json\b/, reason: "reading Claude credentials is not allowed" },
  { pattern: /\bcrontab\b/, reason: "editing crontabs is not allowed" },
  // The child env carries the model auth token, so environment inspection is
  // treated as credential access.
  { pattern: /\benv\b\s*(\||;|$)|\bprintenv\b|\bexport\s*(\||;|$)|^\s*set\s*$/, reason: "dumping the environment is not allowed" },
  { pattern: /\/proc\/(self|\d+)\/environ/, reason: "reading process environment is not allowed" },
  { pattern: /\$\{?ANTHROPIC[A-Z_]*/i, reason: "reading model credentials from the environment is not allowed" },
  { pattern: /\$\{?(DISCORD|GH|GITHUB|EIGENAI|DAYTONA|ELEVENLABS|STRAVA|APCA)[A-Z_]*/i, reason: "reading credentials from the environment is not allowed" },
];

/** Substrings that indicate a protected target inside a shell command. */
function protectedSubstrings(ctx: PilotPolicyContext): string[] {
  return [
    ...PROTECTED_REPO_PREFIXES.map((p) => path.join(ctx.repoRoot, p)),
    ...PROTECTED_HOME_PREFIXES.map((p) => path.join(ctx.homeDir, p)),
  ];
}

/** Resolve a possibly-relative path against the pilot workspace. */
function resolveInWorkspace(ctx: PilotPolicyContext, candidate: string): string {
  if (path.isAbsolute(candidate)) return path.normalize(candidate);
  if (candidate.startsWith("~/")) {
    return path.normalize(path.join(ctx.homeDir, candidate.slice(2)));
  }
  return path.normalize(path.resolve(ctx.workspaceDir, candidate));
}

/** True when `child` is `parent` or lives inside it. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Check a resolved absolute path against the protected lists. */
export function checkPilotPath(
  ctx: PilotPolicyContext,
  absolutePath: string,
): PolicyDecision {
  for (const prefix of PROTECTED_REPO_PREFIXES) {
    const protectedPath = path.join(ctx.repoRoot, prefix);
    if (isWithin(protectedPath, absolutePath)) {
      return {
        allow: false,
        reason: `\`${prefix}\` in the bot repository is protected in pilot mode`,
      };
    }
  }
  for (const prefix of PROTECTED_HOME_PREFIXES) {
    const protectedPath = path.join(ctx.homeDir, prefix);
    if (isWithin(protectedPath, absolutePath)) {
      return {
        allow: false,
        reason: `\`~/${prefix}\` holds credentials and is protected in pilot mode`,
      };
    }
  }
  return { allow: true };
}

/** Check a shell command string. */
export function checkPilotCommand(
  ctx: PilotPolicyContext,
  command: string,
): PolicyDecision {
  for (const { pattern, reason } of DENIED_COMMAND_PATTERNS) {
    if (pattern.test(command)) return { allow: false, reason };
  }
  for (const target of protectedSubstrings(ctx)) {
    if (command.includes(target)) {
      return {
        allow: false,
        reason: `command references protected path \`${target}\``,
      };
    }
  }
  return { allow: true };
}

/**
 * Pure policy evaluation for a single tool call. Exported separately from the
 * SDK callback so it can be unit tested without spawning anything.
 */
export function evaluatePilotToolCall(
  ctx: PilotPolicyContext,
  toolName: string,
  input: Record<string, unknown>,
): PolicyDecision {
  // Shell — the widest surface, checked first.
  if (toolName === "Bash" || toolName === "BashOutput" || toolName === "KillShell") {
    const command = typeof input.command === "string" ? input.command : "";
    if (!command) return { allow: true };
    return checkPilotCommand(ctx, command);
  }

  // Anything carrying a path gets the path check.
  for (const key of PATH_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      const decision = checkPilotPath(ctx, resolveInWorkspace(ctx, value));
      if (!decision.allow) return decision;
    }
  }

  // Multi-edit style payloads: check every nested path we can find.
  const edits = input.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === "object") {
        for (const key of PATH_INPUT_KEYS) {
          const value = (edit as Record<string, unknown>)[key];
          if (typeof value === "string" && value.length > 0) {
            const decision = checkPilotPath(ctx, resolveInWorkspace(ctx, value));
            if (!decision.allow) return decision;
          }
        }
      }
    }
  }

  return { allow: true };
}

/** Default policy context derived from the process. */
export function defaultPilotPolicyContext(
  workspaceDir: string,
  repoRoot: string,
): PilotPolicyContext {
  return {
    workspaceDir,
    repoRoot,
    homeDir: process.env.HOME || "/root",
  };
}
