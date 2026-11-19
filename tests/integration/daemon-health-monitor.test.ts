// ---------------------------------------------------------------------------
// Daemon health monitor
//
// The bug this pins down (seen in the journal on 2026-11-18 17:19–17:48):
//
//   [daemon] Spawning bot...
//   [daemon] Health check failed (1/3)      <- 0s after spawn; grace is 30s
//   [daemon] Health check failed (2/3)      <- 5s
//   [daemon] Health check failed (3/3)      <- 5s
//   [daemon] Sending SIGKILL to bot (PID …) <- uptime=4s, while it was still booting
//
// The monitor used to schedule its grace period with a bare setTimeout whose
// handle was never kept, and stopHealthMonitor() only cleared the interval.
// A bot that died inside its grace period (every doomed respawn does) left the
// timer pending; it later installed a fresh interval, and those stale intervals
// shared one global failure counter and judged whichever bot happened to be
// running — with no grace period of its own.
//
// So the properties that matter are about *lifetimes*: a monitor belongs to one
// bot, stopping it leaves no timer behind, and nothing it started can ever
// speak for a later bot.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startHealthMonitor,
  type HealthMonitorOptions,
} from "../../src/daemon/health-monitor.js";

const GRACE = 30_000;
const INTERVAL = 60_000;

function make(over: Partial<HealthMonitorOptions> = {}) {
  // Hand back the probe that is actually wired in, overridden or not.
  const check = (over.check ?? vi.fn(async () => true)) as ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  const onUnhealthy = vi.fn();
  const onFailure = vi.fn();
  const onHealthy = vi.fn();
  const monitor = startHealthMonitor({
    graceMs: GRACE,
    intervalMs: INTERVAL,
    maxFailures: 3,
    check,
    onUnhealthy,
    onFailure,
    onHealthy,
    ...over,
  });
  return { monitor, check, onUnhealthy, onFailure, onHealthy };
}

describe("daemon health monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not probe during the grace period, then probes once per interval", async () => {
    const { check } = make();

    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(check).not.toHaveBeenCalled();

    // Grace elapses: the first probe runs immediately, not a full interval later.
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("stop() during the grace period leaves no timer and no probe ever runs", async () => {
    const { monitor, check } = make();

    await vi.advanceTimersByTimeAsync(9_000); // a doomed bot dies after ~9s
    monitor.stop();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(check).not.toHaveBeenCalled();
  });

  it("stop() after the interval started clears it", async () => {
    const { monitor, check } = make();

    await vi.advanceTimersByTimeAsync(GRACE);
    expect(check).toHaveBeenCalledTimes(1);

    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("a stopped monitor can never judge the next bot (the leaked-grace-timer regression)", async () => {
    // Bot A dies 9s after it spawned; bot B spawns 11s later (t=20s) — i.e. A's
    // 30s grace would expire at t=30s, 10s into B's life. With the old code that
    // stale timer fired then, probed B with no grace of its own and counted
    // against B.
    const a = make({ check: vi.fn(async () => false) });
    await vi.advanceTimersByTimeAsync(9_000);
    a.monitor.stop();
    await vi.advanceTimersByTimeAsync(11_000);

    const b = make({ check: vi.fn(async () => false) });

    // Everything that was left of A's life (and then some) passes inside B's grace.
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(a.check).not.toHaveBeenCalled();
    expect(b.check).not.toHaveBeenCalled();
    expect(a.onFailure).not.toHaveBeenCalled();
    expect(b.onFailure).not.toHaveBeenCalled();
    expect(b.onUnhealthy).not.toHaveBeenCalled();
  });

  it("many short-lived bots accumulate no timers (a doomed-respawn loop)", async () => {
    for (let i = 0; i < 25; i++) {
      const { monitor } = make();
      await vi.advanceTimersByTimeAsync(9_000);
      monitor.stop();
      await vi.advanceTimersByTimeAsync(10_000); // backoff
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports onUnhealthy exactly once, after maxFailures consecutive failures, then goes quiet", async () => {
    const { check, onUnhealthy, onFailure } = make({ check: vi.fn(async () => false) });

    await vi.advanceTimersByTimeAsync(GRACE); // 1
    await vi.advanceTimersByTimeAsync(INTERVAL); // 2
    expect(onUnhealthy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERVAL); // 3

    expect(onFailure.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(onUnhealthy).toHaveBeenCalledTimes(1);

    // The monitor is finished once it has given its verdict.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(check).toHaveBeenCalledTimes(3);
    expect(onUnhealthy).toHaveBeenCalledTimes(1);
  });

  it("a success resets the consecutive-failure count", async () => {
    const results = [false, false, true, false, false, true];
    const check = vi.fn(async () => results.shift() ?? true);
    const { onUnhealthy, onHealthy } = make({ check });

    await vi.advanceTimersByTimeAsync(GRACE + 5 * INTERVAL);

    expect(check).toHaveBeenCalledTimes(6);
    expect(onUnhealthy).not.toHaveBeenCalled();
    // onHealthy carries how many failures it just recovered from.
    expect(onHealthy.mock.calls.map((c) => c[0])).toEqual([2, 2]);
  });

  it("ignores a probe that was still in flight when stop() was called", async () => {
    let settle!: (healthy: boolean) => void;
    const check = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const { monitor, onUnhealthy, onFailure } = make({ check, maxFailures: 1 });

    await vi.advanceTimersByTimeAsync(GRACE);
    expect(check).toHaveBeenCalledTimes(1);

    monitor.stop(); // the bot exited while its probe was pending
    settle(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(onFailure).not.toHaveBeenCalled();
    expect(onUnhealthy).not.toHaveBeenCalled();
  });

  it("never overlaps probes when one outlives the interval", async () => {
    let settle!: (healthy: boolean) => void;
    const check = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    make({ check, intervalMs: 1_000, graceMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000); // five more ticks, probe still pending
    expect(check).toHaveBeenCalledTimes(1);

    settle(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("stops itself when the bot it was started for is no longer current", async () => {
    let current = true;
    const { check, onFailure, onUnhealthy } = make({
      check: vi.fn(async () => false),
      alive: () => current,
    });

    await vi.advanceTimersByTimeAsync(GRACE);
    expect(check).toHaveBeenCalledTimes(1);

    current = false; // another bot took over (or the daemon is shutting down)
    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(check).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onUnhealthy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a probe that throws as an unhealthy probe and reports the error", async () => {
    const boom = new Error("socket exploded");
    const check = vi.fn(async () => {
      throw boom;
    });
    const onError = vi.fn();
    const { onFailure } = make({ check, onError });

    await vi.advanceTimersByTimeAsync(GRACE);

    expect(onFailure).toHaveBeenCalledWith(1, 3);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("a throwing onFailure cannot swallow the unhealthy verdict", async () => {
    // The verdict is the whole point: a callback that blows up (a logger, say)
    // must not leave a dead bot unkilled.
    const onError = vi.fn();
    const onFailure = vi.fn(() => {
      throw new Error("logger exploded");
    });
    const { onUnhealthy } = make({ check: vi.fn(async () => false), onFailure, onError });

    await vi.advanceTimersByTimeAsync(GRACE + 2 * INTERVAL);

    expect(onFailure).toHaveBeenCalledTimes(3);
    expect(onUnhealthy).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it("a throwing onUnhealthy is reported, never thrown, and the monitor still stops", async () => {
    const onError = vi.fn();
    const onUnhealthy = vi.fn(() => {
      throw new Error("kill failed");
    });
    const { check } = make({ check: vi.fn(async () => false), onUnhealthy, onError, maxFailures: 1 });

    await vi.advanceTimersByTimeAsync(GRACE);

    expect(onUnhealthy).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("a throwing onHealthy does not lose the recovery", async () => {
    const results = [false, true, false];
    const check = vi.fn(async () => results.shift() ?? true);
    const onHealthy = vi.fn(() => {
      throw new Error("logger exploded");
    });
    const { onFailure } = make({ check, onHealthy, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(GRACE + 2 * INTERVAL);

    // Failure, throwing recovery, failure: the count restarted at 1 after the
    // recovery, even though the recovery callback threw.
    expect(onFailure.mock.calls.map((c) => c[0])).toEqual([1, 1]);
  });

  it("monitors are independent: one bot's failures are not another's", async () => {
    const a = make({ check: vi.fn(async () => false) });
    const b = make({ check: vi.fn(async () => true) });

    await vi.advanceTimersByTimeAsync(GRACE + INTERVAL);

    expect(a.onFailure).toHaveBeenCalledTimes(2);
    expect(b.onFailure).not.toHaveBeenCalled();
    expect(b.onHealthy).toHaveBeenCalledTimes(2);
  });
});
