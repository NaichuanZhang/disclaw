// ---------------------------------------------------------------------------
// Per-bot health monitor for the watchdog daemon
//
// A monitor belongs to exactly one bot process. It owns its own timers and its
// own failure count, `stop()` removes every one of them, and nothing it started
// can report after it has been stopped.
//
// That is the point of the rewrite. The previous version kept the grace period
// in a bare `setTimeout` whose handle was never stored, cleared only the
// interval on stop, and counted failures in a module-level variable. A bot that
// died inside its grace period (every doomed respawn does) left the timer
// pending; it later installed a fresh interval that judged whichever bot was
// running by then — with no grace period of its own — and added to the shared
// counter. Three of those landing together killed a bot that was still booting
// (`Health check failed (1/3)` at +0s, `(2/3)` and `(3/3)` at +5s).
//
// ZERO imports from the main bot codebase (see daemon/index.ts).
// ---------------------------------------------------------------------------

export interface HealthMonitorOptions {
  /** Time after start before the first probe. */
  graceMs: number;
  /** Time between probes after the first. */
  intervalMs: number;
  /** Consecutive failed probes that make the bot "unhealthy". */
  maxFailures: number;
  /** One probe. Resolves true when the bot answered healthy. */
  check: () => Promise<boolean>;
  /** Called once, after `maxFailures` consecutive failures. The monitor is done. */
  onUnhealthy: () => void;
  /** Called after every failed probe with (consecutive failures, maxFailures). */
  onFailure?: (failures: number, max: number) => void;
  /** Called after every healthy probe with the failures it just recovered from. */
  onHealthy?: (failuresBefore: number) => void;
  /**
   * Whether the bot this monitor was started for is still the current one.
   * A probe that finds it false stops the monitor instead of judging a bot it
   * was never started for. Belt and braces next to `stop()`.
   */
  alive?: () => boolean;
  /** A callback or the probe itself threw. Never allowed to escape. */
  onError?: (err: unknown) => void;
}

export interface HealthMonitor {
  /** Cancel every timer and discard any probe still in flight. Idempotent. */
  stop(): void;
}

export function startHealthMonitor(opts: HealthMonitorOptions): HealthMonitor {
  let stopped = false;
  let failures = 0;
  let inFlight = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    stopped = true;
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  };

  const stale = (): boolean => {
    if (stopped) return true;
    if (opts.alive && !opts.alive()) {
      stop();
      return true;
    }
    return false;
  };

  /**
   * Run a callback so that it cannot escape and cannot take the monitor's own
   * bookkeeping down with it. In particular a throwing `onFailure` must not
   * swallow the `onUnhealthy` verdict that follows it.
   */
  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      try {
        opts.onError?.(err);
      } catch {
        // nothing left to tell
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (stale() || inFlight) return;
    inFlight = true;

    let healthy = false;
    try {
      healthy = await opts.check();
    } catch (err) {
      // A probe that blows up is an unhealthy probe, not a daemon crash.
      healthy = false;
      safely(() => {
        throw err;
      });
    } finally {
      inFlight = false;
    }

    // The verdict may arrive after the bot it was about is gone.
    if (stale()) return;

    if (healthy) {
      const before = failures;
      failures = 0;
      safely(() => opts.onHealthy?.(before));
      return;
    }

    failures += 1;
    safely(() => opts.onFailure?.(failures, opts.maxFailures));
    if (failures >= opts.maxFailures) {
      stop();
      safely(() => opts.onUnhealthy());
    }
  };

  graceTimer = setTimeout(() => {
    graceTimer = null;
    if (stopped) return;
    void tick();
    interval = setInterval(() => void tick(), opts.intervalMs);
  }, opts.graceMs);

  return { stop };
}
