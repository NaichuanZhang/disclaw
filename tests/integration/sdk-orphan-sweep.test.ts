// ---------------------------------------------------------------------------
// Boot-time orphan sweep
//
// What went wrong (journal, 2026-11-18 17:22:03):
//
//   [sdk] swept orphan SDK process 2038594: …/claude --output-format stream-json …
//   [sdk] swept orphan SDK process 2039074: /usr/bin/zsh -c source …/shell-snapshots/…
//   [sdk] session error for 1572761729149050953: Claude Code process exited with code 143
//
// The sweep looked at "claude processes whose cwd is under the workspace" and
// SIGTERMed all of them. That is right for the leftovers of a dead bot, and
// wrong for a bot that is *alive*: a second instance booting next to a running
// one (the daemon respawning while an unsupervised bot still held the port)
// killed the running bot's live sessions — which the running bot then reported,
// correctly, as a session error.
//
// An orphan is a process with no live bot above it. So the question the sweep
// must ask is not "is this a claude under the workspace" but "who is its
// parent chain".
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findOrphans,
  linuxProcSource,
  parseProcStat,
  type ProcInfo,
  type ProcSource,
} from "../../src/sdk/orphan-sweep.js";

const WORKSPACE = "/home/bot/repo/data/sdk/workspace";
const SESSION_CWD = `${WORKSPACE}/sessions/1572761729149050953`;
const SELF = 5000;

const CLAUDE_CMD =
  "/home/bot/repo/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude --output-format stream-json --verbose";
const BOT_CMD =
  "/usr/bin/node --require /home/bot/repo/node_modules/tsx/dist/preflight.cjs --import file:///home/bot/repo/node_modules/tsx/dist/loader.mjs src/index.ts";
const DAEMON_CMD =
  "/usr/bin/node --require /home/bot/repo/node_modules/tsx/dist/preflight.cjs --import file:///home/bot/repo/node_modules/tsx/dist/loader.mjs src/daemon/index.ts";
const SHELL_CMD = "/usr/bin/zsh -c source /home/bot/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'ls'";

function table(rows: Record<number, ProcInfo>): ProcSource {
  return {
    pids: () => Object.keys(rows).map(Number),
    read: (pid) => rows[pid] ?? null,
  };
}

const init: ProcInfo = { ppid: 0, cwd: "/", cmdline: "/sbin/init" };

function sweptPids(rows: Record<number, ProcInfo>): number[] {
  return findOrphans(table(rows), { workspaceDir: WORKSPACE, selfPid: SELF })
    .sweep.map((p) => p.pid)
    .sort((a, b) => a - b);
}

describe("sdk orphan sweep: who gets killed", () => {
  it("sweeps the leftovers of a dead bot (reparented to init)", () => {
    const swept = sweptPids({
      1: init,
      200: { ppid: 1, cwd: SESSION_CWD, cmdline: CLAUDE_CMD },
      201: { ppid: 200, cwd: SESSION_CWD, cmdline: SHELL_CMD },
      [SELF]: { ppid: 1, cwd: "/home/bot/repo", cmdline: BOT_CMD },
    });
    expect(swept).toEqual([200, 201]);
  });

  it("REGRESSION: leaves a live bot's sessions alone (the exit-143 incident)", () => {
    const plan = findOrphans(
      table({
        1: init,
        // The unsupervised-but-running bot and its live session + that
        // session's Bash tool shell:
        100: { ppid: 1, cwd: "/home/bot/repo", cmdline: "sh -c tsx src/index.ts" },
        101: { ppid: 100, cwd: "/home/bot/repo", cmdline: "node /home/bot/repo/node_modules/.bin/tsx src/index.ts" },
        102: { ppid: 101, cwd: "/home/bot/repo", cmdline: BOT_CMD },
        200: { ppid: 102, cwd: SESSION_CWD, cmdline: CLAUDE_CMD },
        201: { ppid: 200, cwd: SESSION_CWD, cmdline: SHELL_CMD },
        // …and this is the doomed second instance doing the sweeping:
        [SELF]: { ppid: 1, cwd: "/home/bot/repo", cmdline: BOT_CMD },
      }),
      { workspaceDir: WORKSPACE, selfPid: SELF },
    );

    expect(plan.sweep).toEqual([]);
    // It says whose they are, so the log can explain why nothing was swept.
    expect(plan.kept.map((k) => [k.pid, k.ownerPid]).sort()).toEqual([
      [200, 102],
      [201, 102],
    ]);
  });

  it("a process only counts as protected through a *bot* ancestor, not just any live parent", () => {
    // A claude whose parent is some unrelated live process (not a bot) is
    // still an orphan of ours: nothing is going to supervise it.
    const swept = sweptPids({
      1: init,
      300: { ppid: 1, cwd: "/home/bot", cmdline: "/lib/systemd/systemd --user" },
      301: { ppid: 300, cwd: SESSION_CWD, cmdline: CLAUDE_CMD }, // subreaper-adopted
    });
    expect(swept).toEqual([301]);
  });

  it("when the bot is PID 1 (a container), its own children are still its own", () => {
    // In a sandbox container the bot can be PID 1, so "reparented to init" and
    // "child of the bot" look identical. Our own children must never be swept.
    const plan = findOrphans(
      table({
        1: { ppid: 0, cwd: "/home/bot/repo", cmdline: BOT_CMD },
        200: { ppid: 1, cwd: SESSION_CWD, cmdline: CLAUDE_CMD },
      }),
      { workspaceDir: WORKSPACE, selfPid: 1 },
    );
    expect(plan.sweep).toEqual([]);
    expect(plan.kept.map((k) => [k.pid, k.ownerPid])).toEqual([[200, 1]]);
  });

  it("never sweeps its own descendants or itself", () => {
    const swept = sweptPids({
      1: init,
      [SELF]: { ppid: 1, cwd: SESSION_CWD, cmdline: CLAUDE_CMD }, // even if its own cmdline looked like claude
      400: { ppid: SELF, cwd: SESSION_CWD, cmdline: CLAUDE_CMD },
      401: { ppid: 400, cwd: SESSION_CWD, cmdline: SHELL_CMD },
    });
    expect(swept).toEqual([]);
  });

  it("ignores processes outside the workspace, including a lookalike sibling directory", () => {
    const swept = sweptPids({
      1: init,
      500: { ppid: 1, cwd: "/home/bot/repo", cmdline: CLAUDE_CMD }, // a developer's own claude in the repo root
      501: { ppid: 1, cwd: `${WORKSPACE}-old/sessions/1`, cmdline: CLAUDE_CMD }, // prefix, not a child
      502: { ppid: 1, cwd: "/tmp", cmdline: CLAUDE_CMD },
      503: { ppid: 1, cwd: null, cmdline: CLAUDE_CMD }, // cwd unreadable
    });
    expect(swept).toEqual([]);
  });

  it("ignores workspace processes that are not Claude", () => {
    const swept = sweptPids({
      1: init,
      600: { ppid: 1, cwd: SESSION_CWD, cmdline: "/usr/bin/python3 script.py" },
      601: { ppid: 1, cwd: SESSION_CWD, cmdline: "/usr/bin/vim notes.md" },
    });
    expect(swept).toEqual([]);
  });

  it("the daemon is not a bot: its cmdline must not shield orphans from the sweep", () => {
    // src/daemon/index.ts shares the `index.ts` name; only src/index.ts and
    // dist/index.js are bot entry points.
    const swept = sweptPids({
      1: init,
      700: { ppid: 1, cwd: "/home/bot/repo", cmdline: DAEMON_CMD },
      701: { ppid: 700, cwd: SESSION_CWD, cmdline: CLAUDE_CMD },
    });
    expect(swept).toEqual([701]);
  });

  it("a claude whose arguments merely mention src/index.ts is not mistaken for a bot", () => {
    // The entry point is recognised by the script the process was started with
    // (its last argument), not by the text appearing anywhere in its argv — a
    // system prompt passed on the command line can say anything.
    const swept = sweptPids({
      1: init,
      1100: {
        ppid: 1,
        cwd: SESSION_CWD,
        cmdline: `${CLAUDE_CMD} --append-system-prompt edit src/index.ts carefully --model x`,
      },
      1101: { ppid: 1100, cwd: SESSION_CWD, cmdline: SHELL_CMD },
    });
    expect(swept).toEqual([1100, 1101]);
  });

  it("recognises both bot entry-point spellings, relative or absolute", () => {
    for (const botCmd of [
      "node src/index.ts",
      "node /home/bot/repo/src/index.ts",
      "node dist/index.js",
      "node /home/bot/repo/dist/index.js",
    ]) {
      const swept = sweptPids({
        1: init,
        800: { ppid: 1, cwd: "/home/bot/repo", cmdline: botCmd },
        801: { ppid: 800, cwd: SESSION_CWD, cmdline: CLAUDE_CMD },
      });
      expect(swept, botCmd).toEqual([]);
    }
  });

  it("survives a parent-chain cycle or a missing ancestor without looping or throwing", () => {
    const swept = sweptPids({
      1: init,
      900: { ppid: 901, cwd: SESSION_CWD, cmdline: CLAUDE_CMD },
      901: { ppid: 900, cwd: "/tmp", cmdline: "weird" }, // cycle
      902: { ppid: 99999, cwd: SESSION_CWD, cmdline: CLAUDE_CMD }, // parent vanished mid-scan
    });
    expect(swept).toEqual([900, 902]);
  });

  it("is not fooled by a very deep process chain", () => {
    const rows: Record<number, ProcInfo> = { 1: init };
    // bot at the top of a 100-deep chain: further than the walk is willing to go,
    // which must resolve to a decision rather than a hang.
    rows[1000] = { ppid: 1, cwd: "/home/bot/repo", cmdline: BOT_CMD };
    for (let i = 1; i <= 100; i++) {
      rows[1000 + i] = { ppid: 1000 + i - 1, cwd: "/home/bot/repo", cmdline: "sh" };
    }
    rows[2000] = { ppid: 1100, cwd: SESSION_CWD, cmdline: CLAUDE_CMD };
    expect(() => findOrphans(table(rows), { workspaceDir: WORKSPACE, selfPid: SELF })).not.toThrow();
  });
});

describe("parseProcStat", () => {
  it("reads the ppid", () => {
    expect(parseProcStat("2038438 (node) S 2038422 1397000 1397000 0 -1 4194304 165049")).toBe(2038422);
  });

  it("copes with a comm that contains spaces and parentheses", () => {
    expect(parseProcStat("77 (my (weird) name) R 4242 77 77 0 -1 0")).toBe(4242);
    expect(parseProcStat("78 (a b c) S 9 78 78 0")).toBe(9);
  });

  it("returns null for garbage rather than a bogus ppid", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("no parens here")).toBeNull();
    expect(parseProcStat("1 (x) S notanumber 1 1")).toBeNull();
  });
});

describe.skipIf(process.platform !== "linux")("linuxProcSource (real /proc)", () => {
  it("reads this process the way the kernel reports it", () => {
    const me = linuxProcSource.read(process.pid);
    expect(me).not.toBeNull();
    expect(me!.ppid).toBe(process.ppid);
    expect(me!.cwd).toBe(readlinkSync(`/proc/${process.pid}/cwd`));
    expect(me!.cmdline).toContain(path.basename(process.execPath));
    expect(me!.cmdline.length).toBe(
      readFileSync(`/proc/${process.pid}/cmdline`, "utf8").replace(/\0/g, " ").length,
    );
  });

  it("lists pids including its own, and returns null for a pid that does not exist", () => {
    expect(linuxProcSource.pids()).toContain(process.pid);
    expect(linuxProcSource.read(2 ** 22 + 12345)).toBeNull();
  });

  it("finds nothing to sweep in a workspace nobody is using", () => {
    const plan = findOrphans(linuxProcSource, {
      workspaceDir: "/nonexistent/workspace/for/test",
      selfPid: process.pid,
    });
    expect(plan.sweep).toEqual([]);
    expect(plan.kept).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Real processes
//
// The tests above feed findOrphans() a table. This one asks the kernel: a
// stand-in bot (argv ends in `src/index.ts`, like the real one) owns a
// claude-looking child whose cwd is inside a workspace. While the bot lives the
// child must be left alone; once the bot is SIGKILLed the child is reparented
// away from it and must become sweepable. That reparenting is what makes the
// "no live bot above it" rule equal "orphan", so it is worth seeing happen.
// ---------------------------------------------------------------------------

// `exec -a` (rename argv[0]) is a bash feature; a busybox/dash-only image has
// no bash and this test has nothing to stand in for the SDK's claude with.
const HAS_BASH =
  process.platform === "linux" && spawnSync("bash", ["-c", "exec -a x true"]).status === 0;

describe.skipIf(!HAS_BASH)("findOrphans against real processes", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    while (cleanup.length) {
      try {
        cleanup.pop()!();
      } catch {
        /* best effort */
      }
    }
  });

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

  async function until(cond: () => boolean, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for condition");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("keeps a live bot's claude, then sweeps it once the bot is gone", async () => {
    const workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dc-sweep-")));
    cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
    const sessionDir = path.join(workspace, "sessions", "1");
    mkdirSync(sessionDir, { recursive: true });

    // The stand-in bot spawns the claude-looking child in the session dir and
    // reports its pid. `exec -a` renames argv[0], so the child's cmdline has
    // "claude" in it exactly as the SDK's binary does.
    // Both stand-ins end themselves after a minute: if the test run is killed
    // mid-test (a CI timeout) afterEach never runs, and nothing should outlive it.
    const botScript = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn('bash', ['-c', 'exec -a claude-fake sleep 60'], { cwd: process.argv[1], stdio: 'ignore' });",
      "console.log(c.pid);",
      "setTimeout(() => process.exit(0), 60000);",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const bot = spawn(process.execPath, ["-e", botScript, sessionDir, "src/index.ts"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const botPid = bot.pid!;
    let childPid = 0;
    cleanup.push(() => {
      for (const pid of [childPid, botPid]) {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    });

    childPid = Number(await firstLine(bot));
    await until(() => {
      const info = linuxProcSource.read(childPid);
      return !!info && info.cwd === sessionDir && /claude-fake/.test(info.cmdline);
    });
    const opts = { workspaceDir: workspace, selfPid: process.pid };

    // 1. The bot is alive: its child is owned, not an orphan.
    const live = findOrphans(linuxProcSource, opts);
    expect(live.sweep.map((p) => p.pid)).not.toContain(childPid);
    expect(live.kept.map((k) => [k.pid, k.ownerPid])).toContainEqual([childPid, botPid]);

    // 2. SIGKILL the bot — the case the sweep exists for. The child survives it
    //    and is adopted by init (or a subreaper): no bot above it any more.
    bot.kill("SIGKILL");
    await new Promise<void>((resolve) => bot.once("exit", () => resolve()));
    await until(() => {
      const info = linuxProcSource.read(childPid);
      return !!info && info.ppid !== botPid;
    });

    const orphaned = findOrphans(linuxProcSource, opts);
    expect(orphaned.sweep.map((p) => p.pid)).toContain(childPid);
    expect(orphaned.kept.map((k) => k.pid)).not.toContain(childPid);
  });
});
