// ---------------------------------------------------------------------------
// Process-group signalling for the watchdog daemon
//
// The daemon launches the bot as `npx tsx src/index.ts`, which is a chain:
//
//   npx -> sh -c "tsx src/index.ts" -> tsx -> node (the actual bot)
//
// `ChildProcess.kill()` signals only the pid that was spawned, i.e. the npx
// wrapper. A SIGKILL there (the health-check kill) removes npx and leaves the
// real bot running with nobody supervising it: it keeps the gateway port and the
// Discord session, every replacement the daemon spawns dies on EADDRINUSE, and
// the replacements' boot sweep kills the live bot's SDK sessions.
//
// So the bot is spawned `detached: true` — its own process group, pgid == the
// pid we hold — and every signal goes to the group (`kill(-pgid)`).
//
// ZERO imports from the main bot codebase (see daemon/index.ts).
// ---------------------------------------------------------------------------

export type GroupSignalResult = "sent" | "gone";
export type TerminateResult = "gone" | "terminated" | "killed";

function assertGroupId(pgid: number): void {
  // kill(-1, sig) is "every process I may signal", 0 is our own group and 1 is
  // init. None of those is ever what a caller of this module means, and a
  // garbage id (NaN, a float) must not turn into one of them.
  if (!Number.isInteger(pgid) || pgid <= 1) {
    throw new RangeError(`refusing to signal process group ${pgid}`);
  }
}

/**
 * Send `signal` to every process in group `pgid`. Returns "gone" when the group
 * has no members left (a normal outcome, not an error). Signal 0 only checks
 * for existence.
 */
export function signalGroup(
  pgid: number,
  signal: NodeJS.Signals | 0,
): GroupSignalResult {
  assertGroupId(pgid);
  try {
    process.kill(-pgid, signal);
    return "sent";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return "gone";
    throw err;
  }
}

/** Whether any process is still a member of group `pgid`. */
export function groupAlive(pgid: number): boolean {
  assertGroupId(pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // EPERM means the group exists but holds something we may not signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * SIGKILL whatever is left in group `pgid`. Called once the wrapper we spawned
 * has exited: nothing the bot started may outlive it. Returns whether anything
 * had to be killed.
 */
export function reapGroup(pgid: number): boolean {
  if (!groupAlive(pgid)) return false;
  return signalGroup(pgid, "SIGKILL") === "sent";
}

/** Resolve true once the group is empty, false if `timeoutMs` passes first. */
export async function waitForGroupExit(
  pgid: number,
  timeoutMs: number,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

export interface TerminateOptions {
  /** How long the group gets to exit after SIGTERM before SIGKILL. */
  graceMs?: number;
  pollMs?: number;
}

/**
 * Ask a group to exit (SIGTERM), wait for the *whole* group — not just its
 * leader — and escalate to SIGKILL if it overruns.
 */
export async function terminateGroup(
  pgid: number,
  { graceMs = 10_000, pollMs = 100 }: TerminateOptions = {},
): Promise<TerminateResult> {
  if (signalGroup(pgid, "SIGTERM") === "gone") return "gone";
  if (await waitForGroupExit(pgid, graceMs, pollMs)) return "terminated";

  signalGroup(pgid, "SIGKILL");
  // SIGKILL cannot be ignored; this only waits for the kernel to finish.
  await waitForGroupExit(pgid, 2_000, pollMs);
  return "killed";
}
