import { Cron } from "croner";
import { CronStore } from "./store.js";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronRunEntry,
} from "./types.js";

function log(...args: unknown[]): void {
  console.log("[cron]", ...args);
}

const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_TIMER_DELAY_MS = 60_000;
const CRON_JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (default)

/**
 * Wraps a promise with a timeout. Rejects with an error if the promise
 * doesn't resolve within the given milliseconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: ${label} exceeded ${ms / 1000}s limit`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Identity and delivery target of the job being run, handed to the agent-turn
 * callback so it can pick a runtime (main agent vs pilot session) and name the
 * thread it posts into.
 */
export interface CronAgentTurnContext {
  channelId?: string;
  jobId: string;
  jobName: string;
}

export class CronService {
  private store: CronStore;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private sendToDiscord:
    | ((channelId: string, text: string, mentionUser?: string) => Promise<void>)
    | null = null;
  private executeAgentTurn:
    | ((
        message: string,
        model?: string,
        context?: CronAgentTurnContext,
      ) => Promise<string>)
    | null = null;
  private adminDmChannelId: string | null = null;

  constructor() {
    this.store = new CronStore();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    log("Starting cron service");
    this.store.load();
    this.running = true;

    // Compute next run times for all enabled jobs
    for (const job of this.store.getJobs()) {
      if (!job.enabled) continue;
      const next = this.computeNextRun(job);
      this.store.updateJobState(job.id, { nextRunAtMs: next });
    }

    this.armTimer();
    log(
      `Cron service started with ${this.store.getJobs().length} job(s)`,
    );
  }

  stop(): void {
    log("Stopping cron service");
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Callback setters
  // ---------------------------------------------------------------------------

  setSendToDiscord(
    fn: (
      channelId: string,
      text: string,
      mentionUser?: string,
    ) => Promise<void>,
  ): void {
    this.sendToDiscord = fn;
    log("Discord send callback registered");
  }

  setExecuteAgentTurn(
    fn: (
      message: string,
      model?: string,
      context?: CronAgentTurnContext,
    ) => Promise<string>,
  ): void {
    this.executeAgentTurn = fn;
    log("Agent turn callback registered");
  }

  /**
   * Set the admin's DM channel ID as a fallback delivery target.
   * When a job has no `delivery` configured, output will be sent here.
   */
  setAdminDmChannelId(channelId: string): void {
    this.adminDmChannelId = channelId;
    log(`Admin DM fallback set: ${channelId}`);
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  add(input: CronJobCreate): CronJob {
    const job = this.store.addJob(input);
    const next = this.computeNextRun(job);
    this.store.updateJobState(job.id, { nextRunAtMs: next });
    log(`Job added: "${job.name}" (${job.id}), next run: ${next ? new Date(next).toISOString() : "none"}`);
    if (this.running) this.armTimer();
    return job;
  }

  update(id: string, patch: CronJobPatch): CronJob | undefined {
    const job = this.store.updateJob(id, patch);
    if (!job) return undefined;

    // Recompute next run if schedule or enabled changed
    if (patch.schedule !== undefined || patch.enabled !== undefined) {
      const next = job.enabled ? this.computeNextRun(job) : undefined;
      this.store.updateJobState(id, { nextRunAtMs: next });
    }

    if (this.running) this.armTimer();
    return job;
  }

  remove(id: string): boolean {
    const removed = this.store.removeJob(id);
    if (removed && this.running) this.armTimer();
    return removed;
  }

  list(): CronJob[] {
    return this.store.getJobs();
  }

  get(id: string): CronJob | undefined {
    return this.store.getJob(id);
  }

  async forceRun(id: string): Promise<void> {
    const job = this.store.getJob(id);
    if (!job) {
      log(`forceRun: job ${id} not found`);
      return;
    }
    log(`Force-running job "${job.name}" (${job.id})`);
    await this.executeJob(job);
  }

  getRunHistory(jobId: string, limit?: number): CronRunEntry[] {
    return this.store.getRunHistory(jobId, limit);
  }

  // ---------------------------------------------------------------------------
  // Schedule computation
  // ---------------------------------------------------------------------------

  private computeNextRun(job: CronJob): number | undefined {
    const schedule = job.schedule;

    switch (schedule.type) {
      case "at": {
        // One-shot: fire if still in the future
        return schedule.timestamp > Date.now() ? schedule.timestamp : undefined;
      }

      case "every": {
        const base = job.state.lastRunAtMs ?? Date.now();
        return base + schedule.intervalMs;
      }

      case "cron": {
        try {
          const cron = new Cron(schedule.expression, {
            timezone: schedule.tz,
          });
          const next = cron.nextRun();
          return next ? next.getTime() : undefined;
        } catch (err) {
          log(`Error parsing cron expression for job ${job.id}:`, err);
          return undefined;
        }
      }

      default:
        return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Timer management
  // ---------------------------------------------------------------------------

  private armTimer(): void {
    // Clear any existing timer
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.running) return;

    // Find the earliest nextRunAtMs among enabled jobs
    let earliest: number | undefined;
    for (const job of this.store.getJobs()) {
      if (!job.enabled) continue;
      const next = job.state.nextRunAtMs;
      if (next !== undefined && (earliest === undefined || next < earliest)) {
        earliest = next;
      }
    }

    if (earliest === undefined) {
      log("No enabled jobs with scheduled runs; timer idle");
      return;
    }

    const delay = Math.max(0, earliest - Date.now());
    const cappedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

    this.timer = setTimeout(() => this.tick(), cappedDelay);
    log(
      `Timer armed: next check in ${Math.round(cappedDelay / 1000)}s`,
    );
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    // Hot-reload: pick up any jobs added/changed externally on disk
    const hasNewJobs = this.store.reload();
    if (hasNewJobs) {
      // Compute next run times for newly discovered jobs (those without a nextRunAtMs)
      for (const job of this.store.getJobs()) {
        if (!job.enabled) continue;
        if (job.state.nextRunAtMs === undefined) {
          const next = this.computeNextRun(job);
          this.store.updateJobState(job.id, { nextRunAtMs: next });
        }
      }
    }

    const now = Date.now();
    const dueJobs = this.store
      .getJobs()
      .filter(
        (j) =>
          j.enabled &&
          j.state.nextRunAtMs !== undefined &&
          j.state.nextRunAtMs <= now,
      );

    // Execute due jobs sequentially
    for (const job of dueJobs) {
      await this.executeJob(job);
    }

    // Re-arm the timer for the next cycle
    this.armTimer();
  }

  // ---------------------------------------------------------------------------
  // Delivery target resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve the delivery channel for a job.
   * Falls back to admin DM if no delivery is configured.
   */
  private resolveDelivery(job: CronJob): { channelId: string; mentionUser?: string } | null {
    if (job.delivery) {
      return job.delivery;
    }
    // Fallback: deliver to admin DM
    if (this.adminDmChannelId) {
      return { channelId: this.adminDmChannelId };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Job execution
  // ---------------------------------------------------------------------------

  private async executeJob(job: CronJob): Promise<void> {
    const startedAt = Date.now();
    let status: "ok" | "error" = "ok";
    let result: string | undefined;
    let error: string | undefined;

    // Use per-job timeout if specified, otherwise fall back to global default
    const timeoutMs = job.timeoutMs ?? CRON_JOB_TIMEOUT_MS;

    try {
      if (job.payload.kind === "systemEvent") {
        // For system events, log the text. Delivery to Discord happens below
        // if a delivery channel is configured.
        log(`[systemEvent] ${job.name}: ${job.payload.text}`);
        result = job.payload.text;
      } else if (job.payload.kind === "agentTurn") {
        if (!this.executeAgentTurn) {
          throw new Error("Agent turn callback not registered");
        }
        log(`[agentTurn] ${job.name}: executing agent turn (timeout: ${timeoutMs / 1000}s)`);
        result = await withTimeout(
          this.executeAgentTurn(
            job.payload.message,
            job.payload.model,
            {
              // The delivery channel decides which runtime runs this job: a
              // pilot-flagged channel is served by the SDK session, not the
              // main agent loop. Resolving it here keeps that decision with
              // the caller, which is the only place that has a Discord client.
              channelId: this.resolveDelivery(job)?.channelId,
              jobId: job.id,
              jobName: job.name,
            },
          ),
          timeoutMs,
          `job "${job.name}"`,
        );
      }

      // Deliver result to Discord — but ONLY for systemEvent jobs.
      // agentTurn jobs handle their own delivery via tools (create_thread,
      // send_message, etc.), so posting the result here would duplicate
      // content outside the thread the agent created.
      if (job.payload.kind !== "agentTurn") {
        const delivery = this.resolveDelivery(job);
        if (delivery && result !== undefined) {
          if (this.sendToDiscord) {
            await this.sendToDiscord(
              delivery.channelId,
              result,
              delivery.mentionUser,
            );
          } else {
            log(`Warning: delivery target available for job ${job.id} but no Discord send callback`);
          }
        } else if (result !== undefined && !delivery) {
          log(`Warning: job ${job.id} produced output but no delivery target and no admin DM fallback`);
        }
      }

      // Update state on success
      this.store.updateJobState(job.id, {
        lastRunAtMs: Date.now(),
        lastRunStatus: "ok",
        lastError: undefined,
        consecutiveErrors: 0,
      });
    } catch (err) {
      status = "error";
      error =
        err instanceof Error ? err.message : String(err);
      log(`Error executing job "${job.name}" (${job.id}):`, error);

      const consecutiveErrors = (job.state?.consecutiveErrors ?? 0) + 1;

      this.store.updateJobState(job.id, {
        lastRunAtMs: Date.now(),
        lastRunStatus: "error",
        lastError: error,
        consecutiveErrors,
      });

      // Auto-disable after too many consecutive failures
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log(
          `Job "${job.name}" (${job.id}) disabled after ${consecutiveErrors} consecutive errors`,
        );
        this.store.updateJob(job.id, { enabled: false });
      }
    }

    // Record the run entry
    const completedAt = Date.now();
    this.store.appendRunEntry({
      jobId: job.id,
      startedAt,
      completedAt,
      status,
      result,
      error,
    });

    // For one-shot jobs: remove after successful execution
    if (status === "ok" && job.deleteAfterRun) {
      log(`One-shot job "${job.name}" (${job.id}) completed, removing`);
      this.store.removeJob(job.id);
      return;
    }

    // Recompute next run time (re-fetch job in case state was updated)
    const updatedJob = this.store.getJob(job.id);
    if (updatedJob && updatedJob.enabled) {
      const next = this.computeNextRun(updatedJob);
      this.store.updateJobState(job.id, { nextRunAtMs: next });
    }
  }
}
