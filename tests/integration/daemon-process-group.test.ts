// ---------------------------------------------------------------------------
// Daemon process-group signalling
//
// The daemon launches the bot as `npx tsx src/index.ts`, which is a chain:
//
//   npx  ->  sh -c "tsx src/index.ts"  ->  tsx  ->  node (the actual bot)
//
// The daemon used to signal only the pid it spawned (the npx wrapper). On a
// health-check SIGKILL that took out npx and left the real bot alive and
// unsupervised: still holding the gateway port and the Discord session, so
// every replacement the daemon spawned died on EADDRINUSE (and, via the boot
// sweep, took the live bot's SDK sessions with it).
//
// The fix is to give the bot its own process group (spawn `detached: true`,
// pgid == child pid) and signal the *group*. These tests use real processes,
// because the whole point is what the kernel does with a tree.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  groupAlive,
  reapGroup,
  signalGroup,
  terminateGroup,
} from "../../src/daemon/process-group.js";

const live: ChildProcess[] = [];
const livePgids = new Set<number>();

/** Spawn `sh -c script` as a group leader, like the daemon spawns the bot. */
function spawnGroup(script: string): ChildProcess {
  const child = spawn("sh", ["-c", script], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.push(child);
  if (child.pid) livePgids.add(child.pid);
  return child;
}

/**
 * Spawn `node -e script` as a group leader. For tests that deliver SIGTERM: a
 * shell script races. A signal that lands between the shell's fork and exec is
 * consumed by the forked shell's inherited trap handler and never reaches the
 * program it was about to exec (a `sleep` in a trapped `sh` survives roughly
 * 4% of immediate group SIGTERMs under load). Node prints "ready" only after
 * its handlers are installed, so there is no such window.
 */
function spawnNodeGroup(script: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.push(child);
  if (child.pid) livePgids.add(child.pid);
  return child;
}

/** A leader and one grandchild, both exiting 0 on SIGTERM; "ready" once both listen. */
const COOPERATIVE_TREE = [
  "const { spawn } = require('node:child_process');",
  "process.on('SIGTERM', () => process.exit(0));",
  "const kid = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => process.exit(0)); console.log('up'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] });",
  "kid.stdout.once('data', () => console.log('ready'));",
  "setInterval(() => {}, 1000);",
].join("\n");

/** The same tree, but both processes swallow SIGTERM. */
const STUBBORN_TREE = COOPERATIVE_TREE.replaceAll("process.exit(0)", "undefined");

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(buf.slice(0, nl));
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`exited before printing: ${buf}`)));
  });
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  // Never leak a process out of the test run, whatever failed.
  for (const pgid of livePgids) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  livePgids.clear();
  live.length = 0;
});

/**
 * Whether orphans get reaped on this machine. A killed grandchild is reparented
 * to PID 1 and only disappears if PID 1 reaps it. In a container whose PID 1
 * does not (a bare `sleep infinity`, an app run as PID 1) it stays a zombie —
 * and a zombie still answers kill(-pgid, 0), so "wait for the group to empty"
 * can never finish there. That is a property of the environment, not of the
 * code under test, and must not turn a CI gate red.
 */
async function initReapsOrphans(): Promise<boolean> {
  const wrapper = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    const grandchild = Number(await firstLine(wrapper));
    wrapper.kill("SIGKILL"); // the grandchild is now reparented to init…
    await exited(wrapper);
    process.kill(grandchild, "SIGKILL"); // …and, once dead, must be reaped by it
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (!pidAlive(grandchild)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  } catch {
    return false;
  } finally {
    try {
      if (wrapper.pid) process.kill(-wrapper.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

const REAL_PROCESSES_OK = process.platform === "linux" && (await initReapsOrphans());

// ---------------------------------------------------------------------------
// The id guard. Pure: needs no processes, so it runs everywhere.
//
// process.kill is replaced for the whole test. If this guard ever regressed,
// the calls below would otherwise be kill(-1, SIGTERM) — "every process this
// user may signal", the live daemon and bot included — or kill(0, …) on the
// test runner's own group. A test of a safety guard must fail by asserting,
// never by doing the dangerous thing.
// ---------------------------------------------------------------------------

describe("daemon process-group id guard", () => {
  it("refuses ids that would signal more than the bot, without reaching the kernel", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      for (const bad of [0, 1, -1, -42, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => signalGroup(bad, "SIGTERM"), `signalGroup(${bad})`).toThrow(RangeError);
        expect(() => signalGroup(bad, 0), `signalGroup(${bad}, 0)`).toThrow(RangeError);
        expect(() => groupAlive(bad), `groupAlive(${bad})`).toThrow(RangeError);
        expect(() => reapGroup(bad), `reapGroup(${bad})`).toThrow(RangeError);
        await expect(terminateGroup(bad), `terminateGroup(${bad})`).rejects.toThrow(RangeError);
      }
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("does pass a valid id through as a *negative* pid (a group), and as nothing else", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      expect(signalGroup(4242, "SIGTERM")).toBe("sent");
      expect(kill).toHaveBeenCalledExactlyOnceWith(-4242, "SIGTERM");
    } finally {
      kill.mockRestore();
    }
  });

  it("maps ESRCH to 'gone' and EPERM to 'still there', and lets nothing else through", () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    const kill = vi.spyOn(process, "kill");
    try {
      kill.mockImplementation(() => {
        throw err("ESRCH");
      });
      expect(signalGroup(4242, "SIGTERM")).toBe("gone");
      expect(groupAlive(4242)).toBe(false);

      kill.mockImplementation(() => {
        throw err("EPERM");
      });
      expect(groupAlive(4242)).toBe(true);
      expect(() => signalGroup(4242, "SIGTERM")).toThrow(/EPERM/);
    } finally {
      kill.mockRestore();
    }
  });
});

describe.skipIf(!REAL_PROCESSES_OK)("daemon process-group signalling", () => {
  it("documents the bug: killing only the spawned wrapper orphans its descendants", async () => {
    // wrapper prints its grandchild's pid, then waits on it — same shape as
    // npx -> sh -> tsx -> node.
    const wrapper = spawnGroup("sleep 60 & echo $!; wait");
    const grandchild = Number(await firstLine(wrapper));
    expect(pidAlive(grandchild)).toBe(true);

    wrapper.kill("SIGKILL"); // what killBot() used to do
    await exited(wrapper);

    // The wrapper is gone but the "bot" is still running, and the group is
    // still occupied — exactly the invisible orphan from the incident.
    expect(pidAlive(grandchild)).toBe(true);
    expect(groupAlive(wrapper.pid!)).toBe(true);
  });

  it("signalGroup kills the whole tree, not just the group leader", async () => {
    const wrapper = spawnGroup("sleep 60 & echo $!; wait");
    const grandchild = Number(await firstLine(wrapper));

    expect(signalGroup(wrapper.pid!, "SIGKILL")).toBe("sent");
    await exited(wrapper);
    await until(() => !pidAlive(grandchild));

    expect(groupAlive(wrapper.pid!)).toBe(false);
  });

  it("reapGroup removes members that outlive their wrapper", async () => {
    const wrapper = spawnGroup("sleep 60 & echo $!; wait");
    const grandchild = Number(await firstLine(wrapper));
    wrapper.kill("SIGKILL");
    await exited(wrapper);
    expect(groupAlive(wrapper.pid!)).toBe(true);

    expect(reapGroup(wrapper.pid!)).toBe(true);
    await until(() => !pidAlive(grandchild));
    expect(groupAlive(wrapper.pid!)).toBe(false);
  });

  it("reapGroup is a no-op for an empty group", async () => {
    const child = spawnGroup("true");
    await exited(child);
    await until(() => !groupAlive(child.pid!));

    expect(reapGroup(child.pid!)).toBe(false);
  });

  it("signalGroup reports 'gone' instead of throwing when nothing is left", async () => {
    const child = spawnGroup("true");
    await exited(child);
    await until(() => !groupAlive(child.pid!));

    expect(signalGroup(child.pid!, "SIGTERM")).toBe("gone");
  });

  it("a detached child leads its own group (pgid == pid); the daemon's group is not its group", async () => {
    const child = spawnGroup("sleep 60 & echo ready; wait");
    await firstLine(child);

    // /proc/<pid>/stat: pid (comm) state ppid pgrp …  — count from the last ')'.
    const pgrp = (pid: number): number =>
      Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[2]);

    expect(pgrp(child.pid!)).toBe(child.pid);
    expect(pgrp(process.pid)).not.toBe(child.pid);
    // …so signalling the child's group cannot reach the process that spawned it.
    signalGroup(child.pid!, "SIGKILL");
    await exited(child);
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("terminateGroup: a cooperative tree exits on SIGTERM without a SIGKILL", async () => {
    const leader = spawnNodeGroup(COOPERATIVE_TREE);
    expect(await firstLine(leader)).toBe("ready");

    const how = await terminateGroup(leader.pid!, { graceMs: 5_000, pollMs: 20 });

    // The whole tree drained on SIGTERM alone — leader *and* grandchild.
    expect(how).toBe("terminated");
    expect(groupAlive(leader.pid!)).toBe(false);
  });

  it("terminateGroup: escalates to SIGKILL when the tree ignores SIGTERM", async () => {
    const leader = spawnNodeGroup(STUBBORN_TREE);
    expect(await firstLine(leader)).toBe("ready");

    const how = await terminateGroup(leader.pid!, { graceMs: 300, pollMs: 20 });

    expect(how).toBe("killed");
    expect(groupAlive(leader.pid!)).toBe(false);
  });

  it("terminateGroup: an already-empty group is reported as gone", async () => {
    const child = spawnGroup("true");
    await exited(child);
    await until(() => !groupAlive(child.pid!));

    expect(await terminateGroup(child.pid!, { graceMs: 200, pollMs: 20 })).toBe("gone");
  });

  it("the deploy-restart protocol survives detaching: exit codes still reach the parent", async () => {
    // The daemon reads the wrapper's exit code (100 = deploy restart, 0 = clean
    // stop, anything else = crash). Detaching changes the process group, not
    // that contract.
    for (const code of [0, 1, 100]) {
      const child = spawnGroup(`exit ${code}`);
      const result = await exited(child);
      expect(result.code).toBe(code);
    }
  });

  it("detached children still deliver stdout/stderr through the pipes", async () => {
    const child = spawnGroup("echo out; echo err 1>&2");
    const chunks: string[] = [];
    child.stdout?.on("data", (d: Buffer) => chunks.push(`out:${d.toString().trim()}`));
    child.stderr?.on("data", (d: Buffer) => chunks.push(`err:${d.toString().trim()}`));
    await exited(child);
    await until(() => chunks.length >= 2);

    expect(chunks.sort()).toEqual(["err:err", "out:out"]);
  });
});
