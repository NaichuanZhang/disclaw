// ---------------------------------------------------------------------------
// Daemon wiring
//
// The helpers (process-group.ts, health-monitor.ts) have unit tests, but the
// fix only works if the daemon *uses* them the right way, and `daemon/index.ts`
// starts a real bot the moment it is imported, so it cannot be imported here.
// These are source-level guards, the approach sdk-session-dirs.test.ts takes for
// session.ts: each pins one line whose removal would bring the incident back
// while every helper test stayed green.
//
//   - drop `detached: true`        -> the bot shares the daemon's process group,
//                                     and signalling "its group" would hit the daemon
//   - signal the wrapper only      -> a health-check SIGKILL orphans the real bot
//   - drop the reap on exit        -> a bot that outlives its wrapper is invisible,
//                                     holds :3000, and every respawn dies on EADDRINUSE
//   - bring back module-level
//     health timers                -> stale timers judge a bot they were not started for
//
// For behaviour rather than text, run the daemon against a stub bot: see the
// "Watchdog daemon" paragraph in CLAUDE.md.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("../../src/daemon/index.ts", import.meta.url), "utf8");

// Guards look at code, not at the comments explaining it (several of which name
// the very patterns being forbidden).
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** The text of one top-level function, up to the next top-level declaration. */
function fn(name: string): string {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\b`, "m"));
  expect(start, `function ${name} exists`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + 1);
  const next = rest.search(/^(?:async )?function \w+|^\/\/ -{20,}/m);
  return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
}

describe("daemon wiring", () => {
  it("spawns the bot in its own process group", () => {
    const spawnBot = fn("spawnBot");
    const options = spawnBot.slice(spawnBot.indexOf('spawn("npx"'));
    expect(options).toMatch(/detached:\s*true/);
  });

  it("signals the bot's whole group, never just the wrapper", () => {
    const killBot = fn("killBot");
    expect(killBot).toContain("signalGroup(pgid, signal)");
    // Whatever else happens, a bare wrapper kill may only be the fallback.
    expect(killBot.indexOf("signalGroup(")).toBeLessThan(killBot.indexOf("botProcess?.kill("));
  });

  it("uses `.kill(` on the child in exactly one place: killBot's fallback", () => {
    const direct = src.match(/botProcess\??\.kill\(/g) ?? [];
    expect(direct).toHaveLength(1);
  });

  it("reaps what the wrapper left behind before it decides what to do next", () => {
    const spawnBot = fn("spawnBot");
    const exitHandler = spawnBot.slice(spawnBot.indexOf('child.on("exit"'));
    const reap = exitHandler.indexOf("reapBotGroup(child.pid)");
    expect(reap).toBeGreaterThan(-1);
    expect(reap).toBeLessThan(exitHandler.indexOf("handleBotExit("));
    // …but not when the daemon itself is shutting down: shutdown() owns the group then.
    expect(exitHandler.indexOf("if (shuttingDown)")).toBeLessThan(reap);
  });

  it("shuts down by draining the group, and never trusts ChildProcess.killed", () => {
    const shutdown = fn("shutdown");
    expect(shutdown).toContain("terminateGroup(pgid");
    // `.killed` flips on the first signal sent, not when the process is dead; the
    // old force-kill timer tested it and so never fired.
    expect(src).not.toMatch(/\.killed\b/);
  });

  it("keeps health state per bot, in a monitor, not in module-level timers", () => {
    expect(src).not.toMatch(/\bhealthTimer\b|\bhealthFailures\b/);
    expect(src).toContain("createHealthMonitor(");
    // A probe may only ever speak for the bot the monitor was started for.
    expect(src).toMatch(/alive:\s*\(\)\s*=>\s*!shuttingDown\s*&&\s*botProcess\s*===\s*child/);
    expect(fn("startHealthMonitor")).toContain("stopHealthMonitor();");
  });

  it("stops the monitor whenever the bot exits", () => {
    const spawnBot = fn("spawnBot");
    const exitHandler = spawnBot.slice(spawnBot.indexOf('child.on("exit"'));
    expect(exitHandler.indexOf("stopHealthMonitor()")).toBeGreaterThan(-1);
    expect(exitHandler.indexOf("stopHealthMonitor()")).toBeLessThan(exitHandler.indexOf("if (shuttingDown)"));
  });

  it("the helpers it imports exist beside it, and import nothing from the bot", () => {
    for (const file of ["health-monitor.ts", "process-group.ts"]) {
      const text = readFileSync(new URL(`../../src/daemon/${file}`, import.meta.url), "utf8");
      const imports = [...text.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).toMatch(/^node:/);
      }
    }
  });
});
