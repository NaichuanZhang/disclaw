// ---------------------------------------------------------------------------
// Evolution tools — agent-facing tools for self-modification
// ---------------------------------------------------------------------------
// Supports multiple concurrent evolutions per user. Each evolution gets
// its own worktree. Tools accept an optional `id` parameter to target a
// specific evolution; when omitted, the most recently created active
// evolution for the current user is used.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  startEvolution,
  finalizeEvolution,
  cancelEvolution,
  mergeEvolution,
  recordSuggestion,
  getEvolutionWorktreeDir,
  gh,
} from "./engine.js";
import {
  getActiveEvolutionForUser,
  getActiveEvolutions,
  getActiveEvolutionsForUser,
  getEvolution,
  listEvolutions,
  resolveEvolution,
  type Evolution,
} from "./log.js";

const execFileAsync = promisify(execFile);

const MAX_OUTPUT = 8192;
const BASH_TIMEOUT = 30_000;

/** Minimum length of an approved build plan required by evolve_start */
const MIN_PLAN_LENGTH = 80;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const evolutionTools = [
  {
    name: "evolve_start",
    description:
      "Start a new evolution session. Creates an isolated git worktree for making source code changes. Changes are submitted as a GitHub PR and, once all quality gates pass, merged and deployed AUTOMATICALLY — there is no human diff review afterwards. Therefore you MUST post the build plan in the channel and get the user's explicit approval FIRST, then pass that plan here with plan_approved=true. Each user can have multiple active evolutions at a time, and multiple users can evolve concurrently.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Why this evolution is needed — what capability to add or change",
        },
        plan: {
          type: "string",
          description:
            "The build plan you posted to the user and they approved: which files change, what each change does, and any risks/tradeoffs. Minimum 80 characters. Stored in the DB and embedded in the PR body.",
        },
        plan_approved: {
          type: "boolean",
          description:
            "Must be true. Set this ONLY after the user has explicitly approved the plan in the conversation (e.g. 'yes', 'go ahead', 'lgtm'). Never assume approval.",
        },
      },
      required: ["reason", "plan", "plan_approved"],
    },
  },
  {
    name: "evolve_read",
    description:
      "Read a file from the worktree during an active evolution. Use this to understand existing code before modifying it.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path relative to repo root (e.g. 'src/agent/agent.ts')",
        },
        id: {
          type: "string",
          description: "Evolution id to target. If omitted, uses the most recent active evolution for the current user.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "evolve_write",
    description:
      "Write a file in the worktree during an active evolution. Creates parent directories as needed. For source code changes to src/, TypeScript files, start.sh, or migrations.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path relative to repo root (e.g. 'src/evolution/new-feature.ts')",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
        id: {
          type: "string",
          description: "Evolution id to target. If omitted, uses the most recent active evolution for the current user.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "evolve_bash",
    description:
      "Execute a shell command in the worktree context during an active evolution. Use for running typecheck, inspecting state, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute (cwd is the evolution worktree)",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default 30000, max 60000)",
        },
        id: {
          type: "string",
          description: "Evolution id to target. If omitted, uses the most recent active evolution for the current user.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "evolve_propose",
    description:
      "Finalize the current evolution: runs typecheck, commits all changes, pushes the branch, runs full validation (sandbox or local CI), creates a GitHub PR, then automatically merges it and restarts to deploy. Fails without merging if typecheck, the boot test, or the test suite don't pass. Auto-merge can be disabled with EVOLUTION_AUTO_MERGE=false.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description: "Short description for the PR title and commit message",
        },
        id: {
          type: "string",
          description: "Evolution id to propose. If omitted, uses the most recent active evolution for the current user.",
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "evolve_suggest",
    description:
      "Record an idea for a potential improvement. Use this when you encounter a limitation you could fix by modifying your own code. Does NOT start an evolution — just records the idea for later review.",
    input_schema: {
      type: "object" as const,
      properties: {
        what: {
          type: "string",
          description: "What capability is missing or what could be improved",
        },
        why: {
          type: "string",
          description: "Context for why this improvement would be useful",
        },
      },
      required: ["what", "why"],
    },
  },
  {
    name: "evolve_cancel",
    description:
      "Cancel an active evolution session. Cleans up the worktree and deletes the branch. Use if you need to abandon an in-progress evolution.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Evolution id to cancel. If omitted, cancels the most recent active evolution for the current user.",
        },
      },
      required: [],
    },
  },
  {
    name: "evolve_review",
    description:
      "Review a proposed evolution PR. Shows summary, changed files, and diff. If no id is provided, shows the most recent proposed evolution.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Evolution id to review. If omitted, reviews the most recent proposed evolution.",
        },
      },
      required: [],
    },
  },
  {
    name: "evolve_merge",
    description:
      "Manually merge a proposed evolution PR and restart the bot to deploy. Normally unnecessary — evolve_propose auto-merges. Use this as the fallback when auto-merge failed (merge conflict, transient CI/GitHub error) or when EVOLUTION_AUTO_MERGE=false.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Evolution id to merge",
        },
      },
      required: ["id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Path safety for worktree
// ---------------------------------------------------------------------------

function safeWorktreePath(worktreeDir: string, relativePath: string): string | null {
  const resolved = path.resolve(worktreeDir, relativePath);
  if (!resolved.startsWith(worktreeDir + "/") && resolved !== worktreeDir) {
    return null; // Path traversal attempt
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Context for tracking the triggering channel/user
// ---------------------------------------------------------------------------

let _currentChannelId: string | undefined;
let _currentUserId: string | undefined;

export function setEvolutionContext(channelId?: string, userId?: string): void {
  _currentChannelId = channelId;
  _currentUserId = userId;
}

// ---------------------------------------------------------------------------
// Helper: resolve an evolution for the current user
// ---------------------------------------------------------------------------

/**
 * Resolve which evolution to operate on.
 *
 * If `explicitId` is provided, look it up directly (must be in "proposing" status
 * and belong to the current user).
 *
 * If `explicitId` is omitted, return the most recent active evolution for
 * the current user. If the user has multiple active evolutions, include a
 * hint about the others in the error message.
 */
function resolveActiveEvolution(explicitId?: string): Evolution {
  if (!_currentUserId) {
    throw new Error("No user context — cannot determine active evolution.");
  }

  if (explicitId) {
    const evolution = getEvolution(explicitId);
    if (!evolution) {
      throw new Error(`Evolution not found: ${explicitId}`);
    }
    if (evolution.status !== "proposing") {
      throw new Error(
        `Evolution ${explicitId} is not active (status: ${evolution.status}). Only "proposing" evolutions can be modified.`,
      );
    }
    // Allow operating on any evolution (not just the user's own) — the user
    // explicitly specified the id, so they know what they're doing.
    return evolution;
  }

  // No explicit id — find the most recent active evolution for this user
  const userEvolutions = getActiveEvolutionsForUser(_currentUserId);

  if (userEvolutions.length === 0) {
    // Check if there are other users' active evolutions for a helpful message
    const allActive = getActiveEvolutions();
    if (allActive.length > 0) {
      throw new Error(
        `No active evolution for you. There ${allActive.length === 1 ? "is" : "are"} ${allActive.length} other active evolution(s). Call evolve_start first.`,
      );
    }
    throw new Error("No active evolution. Call evolve_start first.");
  }

  // Use the most recent one (first in the list, since they're ordered DESC)
  const active = userEvolutions[0];

  // If the user has more than one, include a hint
  if (userEvolutions.length > 1) {
    const others = userEvolutions.slice(1).map((e) => `  - ${e.id}: ${e.triggerMessage?.slice(0, 60) ?? "(no reason)"}`);
    console.log(
      `[evolution] User ${_currentUserId} has ${userEvolutions.length} active evolutions. ` +
      `Defaulting to most recent: ${active.id}. Others:\n${others.join("\n")}`,
    );
  }

  return active;
}

/**
 * Get the worktree directory for an active evolution.
 * Throws if the worktree doesn't exist.
 */
function requireWorktreeDir(evolution: Evolution): string {
  const worktreeDir = evolution.worktreeDir;
  if (!worktreeDir) {
    throw new Error(`Evolution ${evolution.id} has no worktree directory recorded.`);
  }
  if (!fs.existsSync(worktreeDir)) {
    throw new Error(
      `Worktree for evolution ${evolution.id} does not exist at ${worktreeDir}. ` +
      `The evolution may be corrupted — try cancelling and starting fresh.`,
    );
  }
  return worktreeDir;
}

// ---------------------------------------------------------------------------
// GitHub PR query helpers (live data, no DB)
// ---------------------------------------------------------------------------

interface GitHubPR {
  number: number;
  title: string;
  state: string;
  url: string;
  headRefName: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  files?: { path: string }[];
}

/**
 * List open PRs from GitHub. Always fresh data.
 */
async function listOpenPRs(): Promise<GitHubPR[]> {
  try {
    const { stdout } = await gh([
      "pr", "list",
      "--state", "open",
      "--json", "number,title,state,url,headRefName,changedFiles,additions,deletions",
    ]);
    return JSON.parse(stdout) as GitHubPR[];
  } catch {
    return [];
  }
}

/**
 * Get a single PR by number from GitHub.
 */
async function getPRByNumber(prNumber: number): Promise<GitHubPR | null> {
  try {
    const { stdout } = await gh([
      "pr", "view", String(prNumber),
      "--json", "number,title,state,url,headRefName,changedFiles,additions,deletions,files",
    ]);
    return JSON.parse(stdout) as GitHubPR;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export async function handleEvolutionTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case "evolve_start": {
        const reason = input.reason as string;
        const plan = typeof input.plan === "string" ? input.plan.trim() : "";
        const planApproved = input.plan_approved === true;

        // Plan-approval gate. Deploys are automatic, so this is the only place
        // a human signs off — refuse to start without an approved plan.
        if (!plan || plan.length < MIN_PLAN_LENGTH) {
          return JSON.stringify({
            error:
              `A build plan of at least ${MIN_PLAN_LENGTH} characters is required before starting an evolution. ` +
              `Post the plan (files to change, what each change does, risks) in the channel, wait for the user to approve it, then call evolve_start again with 'plan' and plan_approved=true.`,
          });
        }
        if (!planApproved) {
          return JSON.stringify({
            error:
              "plan_approved must be true. Post the build plan in the channel and wait for the user's explicit approval before starting the evolution. " +
              "Evolutions merge and deploy automatically, so there is no diff review later — this approval is the only human gate.",
          });
        }

        const evolution = await startEvolution({
          reason,
          plan,
          triggeredBy: _currentUserId ?? "unknown",
          channelId: _currentChannelId,
        });

        // Include info about other active evolutions for the user
        const userEvolutions = _currentUserId
          ? getActiveEvolutionsForUser(_currentUserId)
          : [];
        const otherActive = userEvolutions.filter((e) => e.id !== evolution.id);

        const response: Record<string, unknown> = {
          success: true,
          evolution_id: evolution.id,
          branch: evolution.branch,
          worktree: evolution.worktreeDir,
          message: `Evolution started (plan approved). Make changes using evolve_write/evolve_read/evolve_bash, then call evolve_propose — it validates, opens the PR, merges, and deploys automatically.`,
        };

        if (otherActive.length > 0) {
          response.other_active_evolutions = otherActive.map((e) => ({
            id: e.id,
            reason: e.triggerMessage?.slice(0, 80),
          }));
          response.message =
            `Evolution started. You now have ${userEvolutions.length} active evolutions. ` +
            `Use the 'id' parameter on evolve_read/write/bash/propose/cancel to target a specific one, ` +
            `or omit it to default to the most recent (${evolution.id}).`;
        }

        return JSON.stringify(response);
      }

      case "evolve_read": {
        const explicitId = input.id as string | undefined;
        const active = resolveActiveEvolution(explicitId);
        const worktreeDir = requireWorktreeDir(active);

        const filePath = input.path as string;
        const absPath = safeWorktreePath(worktreeDir, filePath);
        if (!absPath) {
          return JSON.stringify({ error: "Invalid path — must be within the repository" });
        }

        if (!fs.existsSync(absPath)) {
          return JSON.stringify({ error: `File not found: ${filePath}` });
        }

        const stat = fs.statSync(absPath);
        if (stat.isDirectory()) {
          return JSON.stringify({ error: `"${filePath}" is a directory` });
        }
        if (stat.size > 256 * 1024) {
          return JSON.stringify({ error: `File too large: ${stat.size} bytes (max 256KB)` });
        }

        const content = fs.readFileSync(absPath, "utf-8");
        return JSON.stringify({ path: filePath, content, evolution_id: active.id });
      }

      case "evolve_write": {
        const explicitId = input.id as string | undefined;
        const active = resolveActiveEvolution(explicitId);
        const worktreeDir = requireWorktreeDir(active);

        const filePath = input.path as string;
        const content = input.content as string;
        const absPath = safeWorktreePath(worktreeDir, filePath);
        if (!absPath) {
          return JSON.stringify({ error: "Invalid path — must be within the repository" });
        }

        const dir = path.dirname(absPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(absPath, content, "utf-8");
        return JSON.stringify({ success: true, path: filePath, evolution_id: active.id });
      }

      case "evolve_bash": {
        const explicitId = input.id as string | undefined;
        const active = resolveActiveEvolution(explicitId);
        const worktreeDir = requireWorktreeDir(active);

        const command = input.command as string;
        const timeout = Math.min(
          (input.timeout as number) || BASH_TIMEOUT,
          60_000,
        );

        try {
          const { stdout, stderr } = await execFileAsync(
            "/bin/bash",
            ["-c", command],
            { cwd: worktreeDir, timeout, maxBuffer: 1024 * 1024 },
          );

          const out = stdout.length > MAX_OUTPUT
            ? stdout.slice(0, MAX_OUTPUT) + "\n... (truncated)"
            : stdout;
          const err = stderr.length > MAX_OUTPUT
            ? stderr.slice(0, MAX_OUTPUT) + "\n... (truncated)"
            : stderr;

          return JSON.stringify({ exit_code: 0, stdout: out, stderr: err || undefined, evolution_id: active.id });
        } catch (execErr: any) {
          return JSON.stringify({
            exit_code: execErr.code ?? 1,
            stdout: (execErr.stdout || "").slice(0, MAX_OUTPUT),
            stderr: (execErr.stderr || execErr.message || "").slice(0, MAX_OUTPUT),
            evolution_id: active.id,
          });
        }
      }

      case "evolve_propose": {
        const explicitId = input.id as string | undefined;
        const active = resolveActiveEvolution(explicitId);

        const summary = input.summary as string;
        const result = await finalizeEvolution({
          id: active.id,
          summary,
          channelId: _currentChannelId,
        });

        return JSON.stringify({
          success: true,
          pr_url: result.prUrl,
          pr_number: result.prNumber,
          evolution_id: active.id,
          merged: result.merged,
          merge_error: result.mergeError,
          message: result.merged
            ? `PR #${result.prNumber} validated, merged, and deploying now (restart in progress): ${result.prUrl}`
            : result.mergeError
              ? `PR created but auto-merge failed: ${result.mergeError}. PR is still open: ${result.prUrl} — needs a manual evolve_merge.`
              : `PR created (auto-merge disabled): ${result.prUrl}`,
        });
      }

      case "evolve_suggest": {
        const what = input.what as string;
        const why = input.why as string;
        const evolution = recordSuggestion({
          what,
          why,
          triggeredBy: _currentUserId ?? "unknown",
        });

        return JSON.stringify({
          success: true,
          idea_id: evolution.id,
          message: "Suggestion recorded. It can be reviewed and implemented later.",
        });
      }

      case "evolve_cancel": {
        const explicitId = input.id as string | undefined;
        const active = resolveActiveEvolution(explicitId);
        await cancelEvolution(active.id);
        return JSON.stringify({
          success: true,
          evolution_id: active.id,
          message: `Evolution ${active.id} cancelled.`,
        });
      }

      case "evolve_review": {
        const id = input.id as string | undefined;

        // If an evolution id is provided, look it up (supports both nanoid and PR number)
        if (id) {
          const evolution = resolveEvolution(id);
          if (!evolution) {
            return JSON.stringify({ error: `Evolution not found: ${id}. Try the nanoid or PR number.` });
          }
          if (!evolution.prNumber) {
            return JSON.stringify({ error: `Evolution ${evolution.id} has no PR number.` });
          }

          // Fetch live PR data from GitHub
          const pr = await getPRByNumber(evolution.prNumber);
          if (!pr) {
            return JSON.stringify({ error: `PR #${evolution.prNumber} not found on GitHub. It may have been closed or merged.` });
          }

          let diff = "";
          try {
            const { stdout } = await gh(["pr", "diff", String(pr.number)]);
            diff = stdout.length > MAX_OUTPUT
              ? stdout.slice(0, MAX_OUTPUT) + "\n... (truncated)"
              : stdout;
          } catch (err: any) {
            diff = `(Failed to fetch diff: ${err.message})`;
          }

          return JSON.stringify({
            id: evolution.id,
            pr_number: pr.number,
            pr_url: pr.url,
            title: pr.title,
            state: pr.state,
            branch: pr.headRefName,
            summary: evolution.changesSummary,
            files_changed: pr.files?.map((f) => f.path) ?? evolution.filesChanged,
            additions: pr.additions,
            deletions: pr.deletions,
            diff,
          });
        }

        // No id provided — find most recent open PR from GitHub
        const openPRs = await listOpenPRs();
        if (openPRs.length === 0) {
          return JSON.stringify({ error: "No open PRs found on GitHub." });
        }

        // Pick the most recent (highest number)
        const latestPR = openPRs.reduce((a, b) => a.number > b.number ? a : b);

        let diff = "";
        try {
          const { stdout } = await gh(["pr", "diff", String(latestPR.number)]);
          diff = stdout.length > MAX_OUTPUT
            ? stdout.slice(0, MAX_OUTPUT) + "\n... (truncated)"
            : stdout;
        } catch (err: any) {
          diff = `(Failed to fetch diff: ${err.message})`;
        }

        // Try to find matching DB evolution for extra context
        const proposed = listEvolutions({ status: "proposed" });
        const matchingEvo = proposed.find((e) => e.prNumber === latestPR.number);

        return JSON.stringify({
          id: matchingEvo?.id ?? null,
          pr_number: latestPR.number,
          pr_url: latestPR.url,
          title: latestPR.title,
          state: latestPR.state,
          branch: latestPR.headRefName,
          summary: matchingEvo?.changesSummary ?? latestPR.title,
          changed_files: latestPR.changedFiles,
          additions: latestPR.additions,
          deletions: latestPR.deletions,
          diff,
        });
      }

      case "evolve_merge": {
        const id = input.id as string;
        // Resolve by nanoid or PR number
        const evolution = resolveEvolution(id);
        if (!evolution) {
          return JSON.stringify({ error: `Evolution not found: ${id}. Try the nanoid or PR number.` });
        }
        await mergeEvolution({ id: evolution.id, channelId: _currentChannelId });
        return JSON.stringify({
          success: true,
          message: "PR merged. Restarting to deploy...",
        });
      }

      default:
        return JSON.stringify({ error: `Unknown evolution tool: ${name}` });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[evolution] Tool "${name}" failed:`, msg);
    return JSON.stringify({ error: msg });
  }
}
