// ---------------------------------------------------------------------------
// Evolution Engine — worktree lifecycle, git operations, PR creation
// ---------------------------------------------------------------------------
// Supports multiple concurrent evolutions, each with its own isolated
// git worktree under worktrees/<evolution-id>/.
// A single user can have multiple active evolutions simultaneously.
// All state-mutating operations are protected by an async mutex.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, symlinkSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, WORKTREES_DIR, getWorktreeDir } from "../shared/paths.js";
import { triggerRestart } from "../restart.js";
import { evolutionLock } from "./lock.js";
import {
  createEvolution,
  getActiveEvolutionForUser,
  getActiveEvolutions,
  getActiveEvolutionsForUser,
  getEvolution,
  listEvolutions,
  updateEvolution,
  type Evolution,
} from "./log.js";
import {
  runSandboxValidation,
  isSandboxCIAvailable,
  type SandboxValidationResult,
} from "./sandbox.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT = 30_000;
const GH_TIMEOUT = 30_000;

/** Max retries for transient merge states (e.g. CI still running) */
const MERGE_CHECK_MAX_RETRIES = 5;
/** Delay between merge-readiness retries (10 seconds) */
const MERGE_CHECK_RETRY_DELAY_MS = 10_000;

// Channel where deployment notifications are posted as threads
const DEPLOY_NOTIFY_CHANNEL_ID = "1493291137908216080";

/**
 * Delay before the process actually restarts after a merge, so the tool result
 * can return and in-flight Discord messages can flush.
 */
const RESTART_DELAY_MS = 5_000;

/**
 * Auto-merge: after a PR is created AND all quality gates pass, the evolution
 * is merged and deployed with no human diff review. The human gate has moved
 * earlier in the process (build-plan approval before evolve_start).
 *
 * Set EVOLUTION_AUTO_MERGE=false to restore the old manual behaviour
 * (evolve_review + evolve_merge by hand).
 */
export function isAutoMergeEnabled(): boolean {
  return (process.env.EVOLUTION_AUTO_MERGE ?? "true").trim().toLowerCase() !== "false";
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(...args: unknown[]): void {
  console.log("[evolution]", ...args);
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function git(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: opts?.cwd ?? PROJECT_ROOT,
    timeout: GIT_TIMEOUT,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function gh(
  args: string[],
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("gh", args, {
    cwd: opts?.cwd ?? PROJECT_ROOT,
    timeout: GH_TIMEOUT,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// ---------------------------------------------------------------------------
// Slug helper
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Discord notification callbacks
// ---------------------------------------------------------------------------

let _sendToDiscord: ((channelId: string, text: string) => Promise<void>) | null =
  null;

let _createDiscordThread:
  | ((channelId: string, name: string, message: string) => Promise<void>)
  | null = null;

export function setEvolutionSendToDiscord(
  fn: (channelId: string, text: string) => Promise<void>,
): void {
  _sendToDiscord = fn;
}

export function setEvolutionCreateThread(
  fn: (channelId: string, name: string, message: string) => Promise<void>,
): void {
  _createDiscordThread = fn;
}

// ---------------------------------------------------------------------------
// Merge readiness check
// ---------------------------------------------------------------------------

interface MergeReadiness {
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | string;
  mergeStateStatus: "CLEAN" | "BLOCKED" | "BEHIND" | "DIRTY" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE" | string;
  state: "OPEN" | "CLOSED" | "MERGED" | string;
}

/**
 * Check if a PR is ready to merge. Returns the merge state or throws
 * a descriptive error for permanent failures (conflicts, closed, etc.).
 * For transient states (CI pending), retries with backoff.
 */
async function waitForMergeReady(prNumber: number): Promise<void> {
  for (let attempt = 1; attempt <= MERGE_CHECK_MAX_RETRIES; attempt++) {
    log(`Checking mergeability for PR #${prNumber} (attempt ${attempt}/${MERGE_CHECK_MAX_RETRIES})...`);

    const { stdout } = await gh([
      "pr",
      "view",
      String(prNumber),
      "--json",
      "mergeable,mergeStateStatus,state",
    ]);

    let status: MergeReadiness;
    try {
      status = JSON.parse(stdout) as MergeReadiness;
    } catch {
      log(`Failed to parse PR status JSON: ${stdout.slice(0, 200)}`);
      throw new Error(`Could not parse PR #${prNumber} merge status`);
    }

    log(`PR #${prNumber} status: state=${status.state}, mergeable=${status.mergeable}, mergeState=${status.mergeStateStatus}`);

    // PR already merged or closed — permanent states
    if (status.state === "MERGED") {
      throw new Error(`PR #${prNumber} has already been merged.`);
    }
    if (status.state === "CLOSED") {
      throw new Error(`PR #${prNumber} is closed. Reopen it first.`);
    }

    // Merge conflicts — permanent, needs manual resolution
    if (status.mergeable === "CONFLICTING") {
      throw new Error(
        `PR #${prNumber} has merge conflicts. Resolve the conflicts and try again.`,
      );
    }

    // Clean and mergeable — good to go!
    if (status.mergeable === "MERGEABLE" && status.mergeStateStatus === "CLEAN") {
      log(`PR #${prNumber} is ready to merge`);
      return;
    }

    // BEHIND means branch is out of date with base — we can still merge with squash
    if (status.mergeable === "MERGEABLE" && status.mergeStateStatus === "BEHIND") {
      log(`PR #${prNumber} is behind base branch but mergeable — proceeding`);
      return;
    }

    // HAS_HOOKS means pre-merge hooks exist but it's mergeable
    if (status.mergeable === "MERGEABLE" && status.mergeStateStatus === "HAS_HOOKS") {
      log(`PR #${prNumber} has merge hooks but is mergeable — proceeding`);
      return;
    }

    // UNSTABLE means some checks failed but it's technically mergeable
    if (status.mergeable === "MERGEABLE" && status.mergeStateStatus === "UNSTABLE") {
      log(`PR #${prNumber} has failing checks but is mergeable — proceeding with caution`);
      return;
    }

    // BLOCKED typically means CI is still running or required reviews pending
    // UNKNOWN means GitHub hasn't computed mergeability yet
    // These are transient — retry
    const isTransient =
      status.mergeStateStatus === "BLOCKED" ||
      status.mergeable === "UNKNOWN" ||
      status.mergeStateStatus === "UNKNOWN";

    if (isTransient && attempt < MERGE_CHECK_MAX_RETRIES) {
      log(`PR #${prNumber} not yet mergeable (transient state) — retrying in ${MERGE_CHECK_RETRY_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, MERGE_CHECK_RETRY_DELAY_MS));
      continue;
    }

    // Exhausted retries or unexpected state
    if (status.mergeStateStatus === "BLOCKED") {
      throw new Error(
        `PR #${prNumber} is blocked from merging. This usually means required status checks haven't passed or required reviews are missing. Check the PR on GitHub for details.`,
      );
    }

    throw new Error(
      `PR #${prNumber} is not mergeable (mergeable=${status.mergeable}, mergeState=${status.mergeStateStatus}). Check the PR on GitHub for details.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Local validation (fallback when Daytona is not available)
// ---------------------------------------------------------------------------

async function runLocalValidation(worktreeDir: string): Promise<void> {
  // 1. Run typecheck in worktree
  log("Running typecheck in worktree (local)...");
  try {
    await execFileAsync("npx", ["tsc", "--noEmit"], {
      cwd: worktreeDir,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (err: any) {
    const output = (err.stdout || "") + "\n" + (err.stderr || "");
    throw new Error(`Typecheck failed in worktree:\n${output.slice(0, 4000)}`);
  }

  // 2. Run integration tests in worktree
  log("Running integration tests in worktree (local)...");
  try {
    await execFileAsync("npx", ["vitest", "run"], {
      cwd: worktreeDir,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (err: any) {
    const output = (err.stdout || "") + "\n" + (err.stderr || "");
    throw new Error(`Integration tests failed in worktree:\n${output.slice(0, 4000)}`);
  }
}

// ---------------------------------------------------------------------------
// Worktree cleanup helper
// ---------------------------------------------------------------------------

/**
 * Clean up a worktree directory. Tries `git worktree remove` first,
 * falls back to manual deletion.
 */
async function cleanupWorktree(worktreeDir: string): Promise<void> {
  if (!existsSync(worktreeDir)) return;

  try {
    await git(["worktree", "remove", worktreeDir, "--force"]);
  } catch {
    rmSync(worktreeDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Legacy beta/ cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up the old beta/ worktree if it exists (migration from single-worktree).
 */
async function cleanupLegacyBeta(): Promise<void> {
  const legacyBeta = join(PROJECT_ROOT, "beta");
  if (existsSync(legacyBeta)) {
    log("Cleaning up legacy beta/ worktree...");
    try {
      await git(["worktree", "remove", "beta", "--force"]);
    } catch {
      rmSync(legacyBeta, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Engine functions
// ---------------------------------------------------------------------------

/**
 * Start a new evolution session. Creates a git worktree at worktrees/<id>/.
 * Protected by the evolution lock to prevent race conditions.
 *
 * Multiple evolutions can run concurrently. A single user can have
 * multiple active evolutions simultaneously, each on its own worktree.
 */
export async function startEvolution(opts: {
  reason: string;
  triggeredBy: string;
  /** Human-approved build plan (the pre-work approval gate) */
  plan?: string;
  channelId?: string;
}): Promise<Evolution> {
  return evolutionLock.withLock(async () => {
    // Clean up legacy beta/ if it exists
    await cleanupLegacyBeta();

    // Create branch name
    const slug = slugify(opts.reason);
    const ts = Date.now();
    const branch = `evolve/${slug}-${ts}`;

    // Create evolution record first to get the ID
    const evolution = createEvolution({
      triggeredBy: opts.triggeredBy,
      triggerMessage: opts.reason,
      plan: opts.plan,
      branch,
      status: "proposing",
    });

    // Determine worktree directory
    const worktreeDir = getWorktreeDir(evolution.id);

    // Clean up orphaned worktree if it exists at this path
    if (existsSync(worktreeDir)) {
      log(`Cleaning up orphaned worktree at ${worktreeDir}...`);
      await cleanupWorktree(worktreeDir);
    }

    // Ensure worktrees base directory exists
    if (!existsSync(WORKTREES_DIR)) {
      mkdirSync(WORKTREES_DIR, { recursive: true });
    }

    // Create worktree
    log(`Creating worktree at ${worktreeDir} on branch ${branch}`);
    await git(["worktree", "add", worktreeDir, "-b", branch]);

    // Symlink node_modules so typecheck works in worktree
    const worktreeNodeModules = join(worktreeDir, "node_modules");
    const mainNodeModules = join(PROJECT_ROOT, "node_modules");
    if (
      worktreeNodeModules !== mainNodeModules &&
      !existsSync(worktreeNodeModules) &&
      existsSync(mainNodeModules)
    ) {
      symlinkSync(mainNodeModules, worktreeNodeModules);
    }

    // Store worktree dir in the evolution record
    updateEvolution(evolution.id, { worktreeDir });
    evolution.worktreeDir = worktreeDir;

    // Log how many active evolutions this user now has
    const userEvolutions = getActiveEvolutionsForUser(opts.triggeredBy);
    log(`Evolution ${evolution.id} started on ${branch} at ${worktreeDir} (user now has ${userEvolutions.length} active evolution(s))`);
    return evolution;
  });
}

/**
 * Finalize an evolution: commit, push, validate (sandbox or local), create PR.
 * Protected by the evolution lock.
 *
 * Flow:
 *   1. Run local typecheck as a fast pre-flight (catches obvious errors quickly)
 *   2. Stage + commit + push the branch
 *   3. If Daytona is available: run full validation in an ephemeral sandbox
 *      (clean install, typecheck, integration boot test, full test suite — true isolation)
 *   4. If Daytona is not available: run tests locally in worktree as fallback
 *   5. Create the PR with quality gate results
 *   6. Clean up worktree
 */
export async function finalizeEvolution(opts: {
  id: string;
  summary: string;
  channelId?: string;
}): Promise<{
  prUrl: string;
  prNumber: number;
  merged: boolean;
  mergeError?: string;
}> {
  const evolution = getEvolution(opts.id);
  if (!evolution || evolution.status !== "proposing") {
    throw new Error(`No active evolution with id ${opts.id}`);
  }

  const worktreeDir = evolution.worktreeDir;
  if (!worktreeDir || !existsSync(worktreeDir)) {
    throw new Error(`Worktree does not exist for evolution ${opts.id} (expected at ${worktreeDir})`);
  }

  // ---------------------------------------------------------------------------
  // 1. Local pre-flight typecheck (fast, catches syntax errors before pushing)
  // ---------------------------------------------------------------------------
  log(`Running local pre-flight typecheck for ${opts.id}...`);
  try {
    await execFileAsync("npx", ["tsc", "--noEmit"], {
      cwd: worktreeDir,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (err: any) {
    const output = (err.stdout || "") + "\n" + (err.stderr || "");
    throw new Error(`Typecheck failed (pre-flight):\n${output.slice(0, 4000)}`);
  }
  log("Pre-flight typecheck passed");

  // ---------------------------------------------------------------------------
  // 2. Stage, commit, push
  // ---------------------------------------------------------------------------
  await git(["add", "-A"], { cwd: worktreeDir });

  const { stdout: diffOutput } = await git(
    ["diff", "--cached", "--name-only"],
    { cwd: worktreeDir },
  );
  const filesChanged = diffOutput
    .split("\n")
    .filter((f) => f.length > 0);

  if (filesChanged.length === 0) {
    throw new Error("No changes to commit in worktree");
  }

  await git(
    ["commit", "-m", `feat(evolution): ${opts.summary}`],
    { cwd: worktreeDir },
  );

  log(`Pushing branch ${evolution.branch}...`);
  await git(["push", "-u", "origin", evolution.branch!], { cwd: worktreeDir });

  // ---------------------------------------------------------------------------
  // 3. Validate: Daytona sandbox (preferred) or local fallback
  // ---------------------------------------------------------------------------
  let validationMethod: "sandbox" | "local";
  let sandboxResult: SandboxValidationResult | null = null;

  if (isSandboxCIAvailable()) {
    validationMethod = "sandbox";
    log("Daytona sandbox CI available — running isolated validation...");

    try {
      sandboxResult = await runSandboxValidation({
        branch: evolution.branch!,
        onLog: (line) => log(`[sandbox] ${line}`),
      });

      if (!sandboxResult.success) {
        const errors: string[] = [];
        if (!sandboxResult.typecheckPassed) {
          errors.push(`**Typecheck failed:**\n\`\`\`\n${sandboxResult.typecheckOutput.slice(0, 2000)}\n\`\`\``);
        }
        if (!sandboxResult.bootTestPassed) {
          errors.push(`**Integration boot test failed:**\n\`\`\`\n${sandboxResult.bootTestOutput.slice(0, 2000)}\n\`\`\``);
        }
        if (!sandboxResult.testsPassed) {
          errors.push(`**Test suite failed:**\n\`\`\`\n${sandboxResult.testsOutput.slice(0, 2000)}\n\`\`\``);
        }
        throw new Error(
          `Sandbox validation failed (${Math.round(sandboxResult.durationMs / 1000)}s):\n${errors.join("\n\n")}`,
        );
      }

      log(`Sandbox validation passed in ${Math.round(sandboxResult.durationMs / 1000)}s`);
    } catch (err: any) {
      // If the error is a validation failure (tests/typecheck failed), re-throw it
      if (err.message?.includes("Sandbox validation failed")) {
        throw err;
      }
      // If sandbox infrastructure failed (API down, timeout, etc.), fall back to local
      log(`Sandbox CI infrastructure error, falling back to local: ${err.message}`);
      validationMethod = "local";
      await runLocalValidation(worktreeDir);
      log("Local fallback validation passed");
    }
  } else {
    validationMethod = "local";
    log("Daytona not configured — running local validation...");
    await runLocalValidation(worktreeDir);
    log("Local validation passed");
  }

  // ---------------------------------------------------------------------------
  // 4. Create PR
  // ---------------------------------------------------------------------------
  log("Creating PR...");
  const migrationFiles = filesChanged.filter((f) => f.startsWith("migrations/"));

  const qualityGates = validationMethod === "sandbox" && sandboxResult
    ? [
        "### Quality Gates (Daytona Sandbox CI ☁️)",
        `- ✅ Pre-flight typecheck passed (local)`,
        `- ${sandboxResult.typecheckPassed ? "✅" : "❌"} TypeScript typecheck (sandbox)`,
        `- ${sandboxResult.bootTestPassed ? "✅" : "❌"} Integration boot test (sandbox) — DB, Soul, Memory, Skills, Tools`,
        `- ${sandboxResult.testsPassed ? "✅" : "❌"} Full test suite (sandbox)`,
        `- ⏱️ Sandbox validation: ${Math.round(sandboxResult.durationMs / 1000)}s`,
        sandboxResult.sandboxId ? `- 🆔 Sandbox: \`${sandboxResult.sandboxId}\`` : "",
      ].filter(Boolean)
    : [
        "### Quality Gates (Local)",
        "- ✅ TypeScript typecheck passed",
        "- ✅ Integration tests passed",
      ];

  const prBody = [
    `## Evolution: ${opts.summary}`,
    "",
    `**Triggered by:** <@${evolution.triggeredBy}>`,
    `**Reason:** ${evolution.triggerMessage}`,
    "",
    ...(evolution.plan
      ? ["### Approved build plan", evolution.plan, ""]
      : []),
    "### Changes",
    ...filesChanged.map((f) => `- \`${f}\``),
    "",
    "### Migrations",
    migrationFiles.length > 0
      ? migrationFiles.map((f) => `- \`${f}\``).join("\n")
      : "None",
    "",
    ...qualityGates,
    "",
    "---",
    "*This PR was created by the Evolution Engine.*",
  ].join("\n");

  const { stdout: prOutput } = await gh([
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    evolution.branch!,
    "--title",
    `feat(evolution): ${opts.summary}`,
    "--body",
    prBody,
  ]);

  // Parse PR URL and number from gh output
  const prUrl = prOutput.trim();
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : 0;

  // ---------------------------------------------------------------------------
  // 5. Update evolution record
  // ---------------------------------------------------------------------------
  updateEvolution(opts.id, {
    status: "proposed",
    prUrl,
    prNumber,
    changesSummary: opts.summary,
    filesChanged,
    proposedAt: Date.now(),
  });

  // ---------------------------------------------------------------------------
  // 6. Clean up worktree (inside lock to prevent races)
  // ---------------------------------------------------------------------------
  log(`Cleaning up worktree for evolution ${opts.id}...`);
  await evolutionLock.withLock(async () => {
    await cleanupWorktree(worktreeDir);
  });

  // ---------------------------------------------------------------------------
  // 7. Notify Discord
  // ---------------------------------------------------------------------------
  const autoMerge = isAutoMergeEnabled();

  if (_sendToDiscord && opts.channelId) {
    try {
      const ciLabel = validationMethod === "sandbox" ? "☁️ sandbox CI" : "🖥️ local CI";
      const suffix = autoMerge
        ? "\nAll gates green — merging and deploying automatically."
        : "";
      await _sendToDiscord(
        opts.channelId,
        `I've created a PR for this: ${prUrl}\n**${opts.summary}** (${filesChanged.length} files changed, validated via ${ciLabel})${suffix}`,
      );
    } catch (err) {
      log("Failed to send Discord notification:", err);
    }
  }

  log(`Evolution ${opts.id} proposed: ${prUrl}`);

  // ---------------------------------------------------------------------------
  // 8. Auto-merge + deploy (no human diff review)
  // ---------------------------------------------------------------------------
  if (!autoMerge) {
    log("Auto-merge disabled (EVOLUTION_AUTO_MERGE=false) — awaiting manual evolve_merge");
    return { prUrl, prNumber, merged: false };
  }

  try {
    await mergeEvolution({ id: opts.id, channelId: opts.channelId });
    return { prUrl, prNumber, merged: true };
  } catch (err: unknown) {
    const mergeError = err instanceof Error ? err.message : String(err);
    log(`Auto-merge failed for evolution ${opts.id}: ${mergeError}`);

    // The PR stays open and the evolution stays in "proposed" status, so a
    // human can inspect it with evolve_review and merge it with evolve_merge.
    if (_sendToDiscord && opts.channelId) {
      try {
        await _sendToDiscord(
          opts.channelId,
          `⚠️ Auto-merge failed for ${prUrl}\n\`\`\`\n${mergeError.slice(0, 1200)}\n\`\`\`\nPR is still open — needs a manual \`evolve_merge\`.`,
        );
      } catch (notifyErr) {
        log("Failed to send auto-merge failure notification:", notifyErr);
      }
    }

    return { prUrl, prNumber, merged: false, mergeError };
  }
}

/**
 * Cancel an active evolution. Cleans up worktree and branch.
 * Protected by the evolution lock.
 */
export async function cancelEvolution(id: string): Promise<void> {
  return evolutionLock.withLock(async () => {
    const evolution = getEvolution(id);
    if (!evolution) {
      throw new Error(`Evolution not found: ${id}`);
    }

    // Remove worktree if it exists
    if (evolution.worktreeDir) {
      await cleanupWorktree(evolution.worktreeDir);
    }

    // Delete branch locally and remotely
    if (evolution.branch) {
      try {
        await git(["branch", "-D", evolution.branch]);
      } catch {
        // Branch may not exist locally
      }
      try {
        await git(["push", "origin", "--delete", evolution.branch]);
      } catch {
        // Branch may not exist remotely
      }
    }

    updateEvolution(id, { status: "cancelled" });
    log(`Evolution ${id} cancelled`);
  });
}

/**
 * Merge a proposed evolution PR and trigger a restart to deploy it.
 * Checks PR mergeability first and retries for transient states (CI pending).
 */
export async function mergeEvolution(opts: {
  id: string;
  channelId?: string;
}): Promise<void> {
  const evolution = getEvolution(opts.id);
  if (!evolution) {
    throw new Error(`Evolution not found: ${opts.id}`);
  }
  if (evolution.status !== "proposed") {
    throw new Error(`Evolution ${opts.id} is not in "proposed" status (current: ${evolution.status})`);
  }
  if (!evolution.prNumber) {
    throw new Error(`Evolution ${opts.id} has no PR number`);
  }

  // Pre-check: wait for PR to be in a mergeable state
  await waitForMergeReady(evolution.prNumber);

  log(`Merging PR #${evolution.prNumber} for evolution ${opts.id}...`);
  await gh(["pr", "merge", String(evolution.prNumber), "--squash", "--delete-branch"]);

  updateEvolution(opts.id, {
    status: "deployed",
    deployedAt: Date.now(),
  });

  log(`Evolution ${opts.id} merged — triggering restart`);

  if (_sendToDiscord && opts.channelId) {
    try {
      await _sendToDiscord(
        opts.channelId,
        `PR #${evolution.prNumber} merged. Restarting to deploy...`,
      );
    } catch (err) {
      log("Failed to send Discord notification:", err);
    }
  }

  // Post deployment notification as a thread in the deploy channel
  if (_createDiscordThread) {
    try {
      const summary = evolution.changesSummary || `PR #${evolution.prNumber}`;
      const threadName = summary.slice(0, 100);
      const filesChanged = evolution.filesChanged ?? [];
      const threadBody = [
        `✅ **Deployed** — PR #${evolution.prNumber}`,
        "",
        `**Summary:** ${summary}`,
        `**Triggered by:** <@${evolution.triggeredBy}>`,
        `**Files changed:** ${filesChanged.length}`,
        ...(filesChanged.length > 0
          ? ["", ...filesChanged.map((f) => `- \`${f}\``)]
          : []),
        "",
        evolution.prUrl ? `🔗 ${evolution.prUrl}` : "",
      ]
        .filter((line) => line !== undefined)
        .join("\n");

      await _createDiscordThread(
        DEPLOY_NOTIFY_CHANNEL_ID,
        threadName,
        threadBody,
      );
      log(`Deployment thread created in ${DEPLOY_NOTIFY_CHANNEL_ID}`);
    } catch (err) {
      log("Failed to create deployment notification thread:", err);
    }
  }

  // Defer the restart slightly so the caller's tool result can return and any
  // in-flight Discord messages can flush before the process exits.
  setTimeout(() => triggerRestart(), RESTART_DELAY_MS);
}

/**
 * Record a suggestion for a potential improvement (no worktree needed).
 */
export function recordSuggestion(opts: {
  what: string;
  why: string;
  triggeredBy: string;
}): Evolution {
  const evolution = createEvolution({
    triggeredBy: opts.triggeredBy,
    triggerMessage: `${opts.what}\n\nWhy: ${opts.why}`,
    status: "idea",
  });
  log(`Suggestion recorded: ${evolution.id}`);
  return evolution;
}

/**
 * On startup, check if any proposed evolutions have been merged.
 * Also cleans up any orphaned worktrees.
 */
export async function syncDeployedEvolutions(): Promise<number> {
  const proposed = listEvolutions({ status: "proposed" });
  let deployed = 0;

  for (const evo of proposed) {
    if (!evo.branch) continue;
    try {
      // Check if branch is merged into HEAD
      const { stdout } = await git([
        "branch",
        "--merged",
        "HEAD",
        "--list",
        evo.branch,
      ]);
      if (stdout.trim().length > 0) {
        updateEvolution(evo.id, {
          status: "deployed",
          deployedAt: Date.now(),
        });
        log(`Evolution ${evo.id} marked as deployed (branch ${evo.branch} merged)`);
        deployed++;
      }
    } catch {
      // Branch may have been deleted after merge — check if PR was merged
      if (evo.prNumber) {
        try {
          const { stdout: prState } = await gh([
            "pr",
            "view",
            String(evo.prNumber),
            "--json",
            "state",
            "-q",
            ".state",
          ]);
          if (prState.trim() === "MERGED") {
            updateEvolution(evo.id, {
              status: "deployed",
              deployedAt: Date.now(),
            });
            log(`Evolution ${evo.id} marked as deployed (PR #${evo.prNumber} merged)`);
            deployed++;
          }
        } catch {
          // gh CLI may not be available; skip
        }
      }
    }
  }

  // Clean up orphaned worktrees for evolutions that are no longer active
  await cleanupOrphanedWorktrees();

  // Clean up legacy beta/ directory
  await cleanupLegacyBeta();

  return deployed;
}

/**
 * Clean up worktrees for evolutions that are no longer in 'proposing' status.
 */
async function cleanupOrphanedWorktrees(): Promise<void> {
  if (!existsSync(WORKTREES_DIR)) return;

  const { readdirSync } = await import("node:fs");
  const entries = readdirSync(WORKTREES_DIR);

  for (const entry of entries) {
    const worktreeDir = join(WORKTREES_DIR, entry);
    const evolution = getEvolution(entry);

    // If evolution doesn't exist or is no longer active, clean up
    if (!evolution || evolution.status !== "proposing") {
      log(`Cleaning up orphaned worktree: ${worktreeDir}`);
      await cleanupWorktree(worktreeDir);
    }
  }
}

/**
 * Get the worktree directory for a specific evolution.
 */
export function getEvolutionWorktreeDir(evolutionId: string): string {
  return getWorktreeDir(evolutionId);
}

/**
 * Check if gh CLI is available.
 */
export async function checkGhCli(): Promise<boolean> {
  try {
    await execFileAsync("gh", ["auth", "status"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
