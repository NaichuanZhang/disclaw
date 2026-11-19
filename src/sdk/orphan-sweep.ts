// ---------------------------------------------------------------------------
// Boot-time orphan sweep: deciding who is an orphan
//
// If the bot is SIGKILLed, its SDK child processes can outlive it, so every
// boot looks for them and SIGTERMs them. The old rule was "a claude process
// whose cwd is under the SDK workspace". That is right for the leftovers of a
// dead bot and wrong for a bot that is alive: a second instance booting next to
// a running one killed the running bot's live sessions, which the running bot
// reported as `SDK session error: Claude Code process exited with code 143`.
//
// (It happened when the watchdog daemon orphaned a healthy bot and then
// respawned doomed replacements — each replacement swept the live bot's
// children before dying on EADDRINUSE.)
//
// An orphan is a process with no live bot above it, so the rule is: a workspace
// claude is swept only if no ancestor is a bot instance. That includes the
// Bash-tool shells and anything else beneath a session, which is why the whole
// parent chain is walked rather than just the immediate parent.
//
// This module is pure over a `ProcSource` so the decision can be tested without
// touching /proc, and it imports session-dirs.ts only (never session.ts — that
// pulls the database module graph into whatever imports it).
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { isInsideDir } from "./session-dirs.js";

/** What the sweep needs to know about one process. */
export interface ProcInfo {
  ppid: number;
  /** null when unreadable (another user's process, a kernel thread). */
  cwd: string | null;
  /** argv joined with spaces. */
  cmdline: string;
}

export interface ProcSource {
  pids(): number[];
  /** null when the process is gone or unreadable. */
  read(pid: number): ProcInfo | null;
}

export interface SweepTarget {
  pid: number;
  cmdline: string;
}

export interface KeptProcess {
  pid: number;
  cmdline: string;
  /** The live bot instance (or this process) that owns it. */
  ownerPid: number;
}

export interface SweepPlan {
  /** Orphans: SIGTERM these. */
  sweep: SweepTarget[];
  /** Workspace processes that belong to a live bot and must be left alone. */
  kept: KeptProcess[];
}

/** The processes the sweep is about: the SDK's claude binary, or its cli.js. */
const SDK_PROCESS = /claude|cli\.js/;

/**
 * A bot instance, recognised by the script it was started with — the *last*
 * argument, so a claude whose system prompt merely mentions `src/index.ts`
 * cannot pass for one. `src/daemon/index.ts` does not match: the daemon is not
 * a bot and shields nothing.
 */
const BOT_ENTRYPOINT = /(?:^|[\s/])(?:src\/index\.ts|dist\/index\.js)\s*$/;

/** Far deeper than any real session chain; bounds the walk against a cycle. */
const MAX_ANCESTOR_HOPS = 128;

export function findOrphans(
  source: ProcSource,
  opts: { workspaceDir: string; selfPid: number },
): SweepPlan {
  const cache = new Map<number, ProcInfo | null>();
  const read = (pid: number): ProcInfo | null => {
    if (!cache.has(pid)) cache.set(pid, source.read(pid));
    return cache.get(pid) ?? null;
  };

  /** The live bot (or ourselves) above `info`, or null if there is none. */
  const owner = (info: ProcInfo): number | null => {
    const seen = new Set<number>();
    let ppid = info.ppid;
    for (let hop = 0; hop < MAX_ANCESTOR_HOPS && ppid > 0 && !seen.has(ppid); hop++) {
      seen.add(ppid);
      // Ourselves — checked before the init test: in a container we may *be*
      // PID 1, and our own children are then reparented-looking `ppid 1`.
      if (ppid === opts.selfPid) return ppid;
      // init, or a container's PID 1 that is not us: nothing above it, so
      // whatever hangs from it is an orphan.
      if (ppid === 1) return null;
      const parent = read(ppid);
      if (!parent) return null;
      if (BOT_ENTRYPOINT.test(parent.cmdline)) return ppid;
      ppid = parent.ppid;
    }
    return null;
  };

  const plan: SweepPlan = { sweep: [], kept: [] };

  for (const pid of source.pids()) {
    if (pid === opts.selfPid) continue;
    const info = read(pid);
    if (!info?.cwd || !isInsideDir(opts.workspaceDir, info.cwd)) continue;
    if (!SDK_PROCESS.test(info.cmdline)) continue;

    const ownerPid = owner(info);
    if (ownerPid !== null) {
      plan.kept.push({ pid, cmdline: info.cmdline, ownerPid });
    } else {
      plan.sweep.push({ pid, cmdline: info.cmdline });
    }
  }

  return plan;
}

/**
 * ppid out of a /proc/<pid>/stat line. The command name is in parentheses and
 * may itself contain spaces and parentheses, so the fields are counted from the
 * *last* `)`.
 */
export function parseProcStat(raw: string): number | null {
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  // After the name: state ppid pgrp session …
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : null;
}

/** The real /proc. */
export const linuxProcSource: ProcSource = {
  pids() {
    try {
      return readdirSync("/proc")
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number);
    } catch {
      return [];
    }
  },

  read(pid) {
    try {
      const ppid = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (ppid === null) return null;

      let cwd: string | null = null;
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        // not ours, or a kernel thread
      }

      let cmdline = "";
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      } catch {
        // exited between the two reads
      }

      return { ppid, cwd, cmdline };
    } catch {
      return null; // gone
    }
  },
};
