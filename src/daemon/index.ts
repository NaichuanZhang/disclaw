#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// Discordclaw Watchdog Daemon
//
// Manages the bot process lifecycle: spawning, health monitoring, crash
// recovery (with backoff), and Discord crash notifications.
//
// ZERO imports from the main bot codebase — a broken evolution can't break
// the daemon. (The helpers beside this file are the daemon's own.)
//
// The bot is spawned as `npx tsx src/index.ts`: a chain of processes, not one.
// It runs in its own process group and every signal goes to the group — see
// process-group.ts for why signalling only the pid we spawned orphans the bot.
// ---------------------------------------------------------------------------

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startHealthMonitor as createHealthMonitor,
  type HealthMonitor,
} from "./health-monitor.js";
import { reapGroup, signalGroup, terminateGroup } from "./process-group.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

const EXIT_GRACEFUL = 0;
const EXIT_DEPLOY_RESTART = 100;

const HEALTH_GRACE_MS = 30_000; // Wait before first health check
const HEALTH_INTERVAL_MS = 60_000; // Check every 60s
const HEALTH_MAX_FAILURES = 3; // Kill after 3 consecutive failures
const HEALTH_TIMEOUT_MS = 5_000; // Per-request timeout
const SHUTDOWN_GRACE_MS = 10_000; // Time the bot gets to exit on SIGTERM before SIGKILL

const LOG_BUFFER_SIZE = 100; // Rolling buffer line count
const CRASH_WINDOW_MS = 5 * 60_000; // 5 min sliding window for backoff
const BACKOFF_DELAYS = [0, 10_000, 30_000, 60_000]; // Escalating delays (ms)
const MAX_RAPID_CRASHES = 5; // Enter cooldown after this many
const COOLDOWN_MS = 5 * 60_000; // 5 min cooldown
const STABLE_RESET_MS = 5 * 60_000; // Reset crash counter after 5 min stable

const PID_FILE = resolve(ROOT, "data/daemon.pid");

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function loadEnv(): void {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    let val = trimmed.slice(eq + 1);
    // Strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

loadEnv();

const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || "3000", 10);
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let botProcess: ChildProcess | null = null;
let logBuffer: string[] = [];
// One monitor per bot process; it owns its timers and its failure count.
let healthMonitor: HealthMonitor | null = null;
let botHealthy = false;
let botStartedAt = 0;
let stableTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

// Crash tracking for backoff
const crashTimestamps: number[] = [];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`[daemon] ${msg}`);
}

function logError(msg: string): void {
  console.error(`[daemon] ${msg}`);
}

// ---------------------------------------------------------------------------
// Discord Webhook
// ---------------------------------------------------------------------------

function notifyDiscord(message: string): void {
  if (!WEBHOOK_URL) return;

  try {
    const url = new URL(WEBHOOK_URL);
    const payload = JSON.stringify({ content: message });

    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      () => {},
    );
    req.on("error", () => {}); // Best-effort, never crash
    req.write(payload);
    req.end();
  } catch {
    // Silently ignore webhook errors
  }
}

// ---------------------------------------------------------------------------
// Log Buffer
// ---------------------------------------------------------------------------

function appendToBuffer(line: string): void {
  logBuffer.push(line);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer = logBuffer.slice(-LOG_BUFFER_SIZE);
  }
}

function getBufferTail(n: number): string {
  return logBuffer.slice(-n).join("\n");
}

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

function checkHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), HEALTH_TIMEOUT_MS);

    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: GATEWAY_PORT,
        path: "/api/health",
        method: "GET",
        timeout: HEALTH_TIMEOUT_MS,
      },
      (res) => {
        clearTimeout(timeout);
        resolve(res.statusCode === 200);
        res.resume(); // Drain response
      },
    );

    req.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    req.on("timeout", () => {
      req.destroy();
      clearTimeout(timeout);
      resolve(false);
    });
    req.end();
  });
}

/**
 * Watch `child` for health. The monitor is tied to this one process: stopping it
 * removes every timer it owns, and `alive` makes a probe that outlives its bot
 * stand down instead of judging whichever bot is running by then.
 */
function startHealthMonitor(child: ChildProcess): void {
  stopHealthMonitor();

  healthMonitor = createHealthMonitor({
    graceMs: HEALTH_GRACE_MS,
    intervalMs: HEALTH_INTERVAL_MS,
    maxFailures: HEALTH_MAX_FAILURES,
    check: checkHealth,
    alive: () => !shuttingDown && botProcess === child,
    onHealthy: (failuresBefore) => {
      if (failuresBefore > 0) {
        log(`Health restored (was failing for ${failuresBefore} checks)`);
      }
      if (!botHealthy) {
        botHealthy = true;
        log("Bot is healthy");
      }
    },
    onFailure: (failures, max) => {
      log(`Health check failed (${failures}/${max})`);
    },
    onUnhealthy: () => {
      logError("Health check failed too many times — killing bot for restart");
      botHealthy = false;
      killBot("SIGKILL");
      // The exit handler will trigger restart
    },
    onError: (err) => logError(`Health monitor error: ${err}`),
  });
}

function stopHealthMonitor(): void {
  healthMonitor?.stop();
  healthMonitor = null;
}

// ---------------------------------------------------------------------------
// Deploy Pipeline
// ---------------------------------------------------------------------------

function runDeploy(): boolean {
  try {
    log("Running deployment pipeline...");
    execSync("bash deploy.sh", {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 300_000, // 5 min timeout
      stdio: "inherit",
    });
    log("Deployment complete");
    return true;
  } catch (err) {
    logError(`Deployment failed: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Crash Backoff
// ---------------------------------------------------------------------------

function getBackoffDelay(): number {
  const now = Date.now();
  // Prune old timestamps
  while (crashTimestamps.length > 0 && now - crashTimestamps[0] > CRASH_WINDOW_MS) {
    crashTimestamps.shift();
  }

  const count = crashTimestamps.length;

  if (count >= MAX_RAPID_CRASHES) {
    return COOLDOWN_MS;
  }

  return BACKOFF_DELAYS[Math.min(count, BACKOFF_DELAYS.length - 1)];
}

function recordCrash(): void {
  crashTimestamps.push(Date.now());
}

function resetCrashCounter(): void {
  crashTimestamps.length = 0;
}

function startStableTimer(): void {
  clearStableTimer();
  stableTimer = setTimeout(() => {
    if (crashTimestamps.length > 0) {
      log("Bot stable for 5 minutes — resetting crash counter");
      resetCrashCounter();
    }
  }, STABLE_RESET_MS);
}

function clearStableTimer(): void {
  if (stableTimer) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Uptime Formatting
// ---------------------------------------------------------------------------

function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hrs = Math.floor(min / 60);

  if (hrs > 0) return `${hrs}h ${min % 60}m`;
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}

// ---------------------------------------------------------------------------
// Bot Process Management
// ---------------------------------------------------------------------------

function spawnBot(): void {
  if (botProcess) {
    logError("Attempted to spawn bot while one is already running");
    return;
  }

  log("Spawning bot...");
  logBuffer = [];
  botHealthy = false;
  botStartedAt = Date.now();

  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    // Its own process group (pgid == child.pid), so signals reach the bot at the
    // end of the npx -> sh -> tsx -> node chain and not just the wrapper we hold.
    detached: true,
  });

  botProcess = child;

  child.stdout?.on("data", (data: Buffer) => {
    const text = data.toString();
    process.stdout.write(text); // Forward to daemon stdout
    for (const line of text.split("\n").filter(Boolean)) {
      appendToBuffer(line);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    process.stderr.write(text); // Forward to daemon stderr
    for (const line of text.split("\n").filter(Boolean)) {
      appendToBuffer(`[stderr] ${line}`);
    }
  });

  child.on("exit", (code, signal) => {
    const uptime = Date.now() - botStartedAt;
    botProcess = null;
    stopHealthMonitor();
    clearStableTimer();

    if (shuttingDown) {
      log(`Bot exited (code=${code}, signal=${signal}) — daemon shutting down`);
      return;
    }

    log(
      `Bot exited (code=${code}, signal=${signal}, uptime=${formatUptime(uptime)})`,
    );

    // The wrapper is gone; nothing it started may outlive it. A bot left running
    // here is invisible to us yet still holds the gateway port and the Discord
    // session, so every replacement we spawn would die on EADDRINUSE.
    reapBotGroup(child.pid);

    handleBotExit(code, signal, uptime);
  });

  startHealthMonitor(child);
  startStableTimer();
}

function reapBotGroup(pgid: number | undefined): void {
  if (!pgid) return;
  try {
    if (reapGroup(pgid)) {
      logError(
        `Bot wrapper exited but its process group (${pgid}) was still occupied — killed the leftovers`,
      );
    }
  } catch (err) {
    logError(`Could not reap bot process group ${pgid}: ${err}`);
  }
}

async function handleBotExit(
  code: number | null,
  signal: string | null,
  uptime: number,
): Promise<void> {
  const exitCode = code ?? (signal ? 128 : 1);

  // Graceful shutdown
  if (exitCode === EXIT_GRACEFUL) {
    log("Bot shut down gracefully — daemon exiting");
    cleanup();
    process.exit(0);
  }

  // Deploy restart
  if (exitCode === EXIT_DEPLOY_RESTART) {
    log("Bot requested deploy restart (exit 100)");
    notifyDiscord(
      `🔄 discordclaw: Deploy restart requested. Running deployment pipeline...`,
    );

    const success = runDeploy();
    if (!success) {
      notifyDiscord(
        `❌ discordclaw: Deployment pipeline failed! Restarting with current code...`,
      );
    }

    spawnBot();
    return;
  }

  // Crash — analyze and recover
  recordCrash();
  const backoff = getBackoffDelay();

  // Regular crash
  const uptimeStr = formatUptime(uptime);
  const recentCrashes = crashTimestamps.length;
  const isEscalation = recentCrashes >= MAX_RAPID_CRASHES;

  const lines = [
    `🔴 **discordclaw crashed**`,
    `Exit code: ${exitCode}${signal ? ` (${signal})` : ""}`,
    `Uptime: ${uptimeStr}`,
    `Recent crashes: ${recentCrashes} in last 5m`,
  ];

  if (isEscalation) {
    lines.push(
      `🚨 **ESCALATION**: ${recentCrashes} rapid crashes — entering ${COOLDOWN_MS / 60_000}min cooldown`,
    );
  } else if (backoff > 0) {
    lines.push(`Restarting in ${backoff / 1000}s...`);
  } else {
    lines.push(`Restarting immediately...`);
  }

  lines.push("", "```", getBufferTail(50), "```");

  notifyDiscord(lines.join("\n"));

  if (backoff > 0) {
    log(`Waiting ${backoff / 1000}s before restart (backoff)...`);
    await sleep(backoff);
  }

  // Check if we got a shutdown signal during backoff
  if (!shuttingDown) {
    spawnBot();
  }
}

function killBot(signal: NodeJS.Signals = "SIGTERM"): void {
  const pgid = botProcess?.pid;
  if (!pgid) return;

  log(`Sending ${signal} to bot process group (PID ${pgid})`);
  try {
    signalGroup(pgid, signal);
  } catch (err) {
    // Better the wrapper alone than leaving a sick bot running.
    logError(`Could not signal process group ${pgid}: ${err}`);
    botProcess?.kill(signal);
  }
}

// ---------------------------------------------------------------------------
// PID File
// ---------------------------------------------------------------------------

function writePidFile(): void {
  try {
    writeFileSync(PID_FILE, String(process.pid), "utf-8");
  } catch {
    logError("Could not write PID file");
  }
}

function removePidFile(): void {
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

function cleanup(): void {
  stopHealthMonitor();
  clearStableTimer();
  removePidFile();
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  log(`Received ${signal} — shutting down`);

  const pgid = botProcess?.pid;
  if (!pgid) {
    cleanup();
    process.exit(0);
  }

  log("Forwarding SIGTERM to bot...");
  // SIGTERM the whole group, then wait for the whole group: the npx wrapper can
  // exit while the bot behind it is still shutting down. (The old force-kill
  // timer tested `botProcess.killed`, which becomes true the moment *any*
  // signal is sent, so it never fired.)
  terminateGroup(pgid, { graceMs: SHUTDOWN_GRACE_MS })
    .then((outcome) => {
      if (outcome === "killed") {
        logError(`Bot did not exit in ${SHUTDOWN_GRACE_MS / 1000}s — force killed`);
      }
    })
    .catch((err) => logError(`Bot shutdown failed: ${err}`))
    .finally(() => {
      cleanup();
      process.exit(0);
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  log("Discordclaw watchdog daemon starting");
  log(`Root: ${ROOT}`);
  log(`Gateway port: ${GATEWAY_PORT}`);
  log(`Webhook configured: ${WEBHOOK_URL ? "yes" : "no"}`);

  writePidFile();

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  spawnBot();
}

main();
