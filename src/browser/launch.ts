// ---------------------------------------------------------------------------
// Browser — Chromium launcher
//
// Binary order: BROWSER_BIN, then a Playwright/Puppeteer-cached Chromium, then
// chromium-browser / chromium / google-chrome on PATH. The cached builds come
// first because /usr/bin/chromium-browser on this board is a snap shim, and
// snap-confine refuses to start under the bot's RLIMIT_MEMLOCK.
//
// Each browser gets a throwaway profile under data/browser/profiles/<id> (not
// os.tmpdir(): a snap build sees a private /tmp) and its own process group,
// so kill() takes the renderer/zygote children with it.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DATA_DIR } from "../shared/paths.js";
import { CdpClient, findOrCreatePage } from "./cdp.js";

export const VIEWPORT = { width: 1280, height: 800 } as const;

export const BROWSER_PROFILES_DIR = path.join(DATA_DIR, "browser", "profiles");

const STARTUP_TIMEOUT_MS = 20_000;
const STDERR_TAIL_CHARS = 1_500;

/** The CDP surface the session needs — CdpClient, or a fake in tests. */
export interface CdpPage {
  readonly closed: boolean;
  send<T = any>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  on(method: string, handler: (params: any) => void): () => void;
  onClose(handler: (reason: string) => void): () => void;
  close(): void;
}

export interface LaunchedBrowser {
  page: CdpPage;
  /** Graceful-then-forced kill plus profile removal. Never throws. */
  kill(): Promise<void>;
  /** Synchronous last-resort kill for process `exit`. Never throws. */
  killSync(): void;
  /** Fires once if the browser process exits on its own. */
  onExit(handler: (detail: string) => void): void;
}

export type BrowserLauncher = (id: string) => Promise<LaunchedBrowser>;

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function newestCached(root: string, prefix: string, rels: string[]): string | null {
  try {
    const dirs = readdirSync(root)
      .filter((d) => d.startsWith(prefix))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const dir of dirs) {
      for (const rel of rels) {
        const file = path.join(root, dir, rel);
        if (isExecutable(file)) return file;
      }
    }
  } catch {
    // cache dir absent
  }
  return null;
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    if (isExecutable(file)) return file;
  }
  return null;
}

let resolvedBinary: string | null | undefined;

/** Path to a Chromium binary, or null. Cached for the life of the process. */
export function resolveBrowserBinary(): string | null {
  if (resolvedBinary !== undefined) return resolvedBinary;
  const override = process.env.BROWSER_BIN;
  if (override) {
    resolvedBinary = isExecutable(override) ? override : null;
    return resolvedBinary;
  }
  const home = homedir();
  resolvedBinary =
    newestCached(path.join(home, ".cache", "ms-playwright"), "chromium-", [
      "chrome-linux/chrome",
      "chrome-linux64/chrome",
    ]) ??
    newestCached(path.join(home, ".cache", "puppeteer", "chrome"), "linux", [
      "chrome-linux64/chrome",
      "chrome-linux/chrome",
    ]) ??
    onPath("chromium-browser") ??
    onPath("chromium") ??
    onPath("google-chrome") ??
    onPath("google-chrome-stable");
  return resolvedBinary;
}

/** BROWSER_ENABLED is not "0" and a binary exists. */
export function browserFeatureEnabled(): boolean {
  return process.env.BROWSER_ENABLED !== "0" && resolveBrowserBinary() !== null;
}

function chromiumArgs(profileDir: string): string[] {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-dev-shm-usage",
    "--mute-audio",
    "--password-store=basic",
  ];
  // Chromium's sandbox refuses to run as root; elsewhere keep it on.
  if (process.getuid?.() === 0 || process.env.BROWSER_NO_SANDBOX === "1") args.push("--no-sandbox");
  args.push("about:blank");
  return args;
}

function readActivePort(profileDir: string): number | null {
  try {
    const first = readFileSync(path.join(profileDir, "DevToolsActivePort"), "utf8").split("\n")[0];
    const port = Number(first);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function removeProfile(profileDir: string): void {
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // best effort; the boot sweep retries
  }
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** Spawn headless Chromium and attach to its page target. */
export const launchChromium: BrowserLauncher = async (id) => {
  const bin = resolveBrowserBinary();
  if (!bin) throw new Error("No Chromium binary found (set BROWSER_BIN).");
  const profileDir = path.join(BROWSER_PROFILES_DIR, id);
  mkdirSync(profileDir, { recursive: true });

  const child = spawn(bin, chromiumArgs(profileDir), {
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let stderr = "";
  let exited: string | null = null;
  const exitHandlers: Array<(detail: string) => void> = [];
  let portFromStderr: number | null = null;

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS * 4);
    const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(chunk);
    if (m) portFromStderr = Number(m[1]);
  });
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exited = `exit code ${code ?? "?"}${signal ? ` (${signal})` : ""}`;
      for (const h of exitHandlers.splice(0)) {
        try {
          h(exited);
        } catch {
          // ignore
        }
      }
      resolve();
    });
  });
  child.once("error", (err) => {
    exited = `spawn failed: ${err.message}`;
  });

  const tail = () => stderr.slice(-STDERR_TAIL_CHARS).trim();
  const fail = async (message: string): Promise<never> => {
    signalGroup(child.pid, "SIGKILL");
    await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 2_000))]);
    removeProfile(profileDir);
    throw new Error(`${message}${tail() ? `\n${tail()}` : ""}`);
  };

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let port: number | null = null;
  while (port === null) {
    if (exited) return fail(`Chromium (${bin}) exited during startup: ${exited}`);
    if (Date.now() > deadline) return fail(`Chromium did not open a debugging port within ${STARTUP_TIMEOUT_MS}ms`);
    port = portFromStderr ?? readActivePort(profileDir);
    if (port === null) await new Promise((r) => setTimeout(r, 100));
  }

  let page: CdpClient;
  try {
    const target = await findOrCreatePage(port);
    if (!target.webSocketDebuggerUrl) throw new Error("page target has no debugger URL");
    page = await CdpClient.connect(target.webSocketDebuggerUrl);
  } catch (err) {
    return fail(`Could not attach to Chromium: ${(err as Error).message}`);
  }

  let killed = false;
  return {
    page,
    onExit(handler) {
      if (exited) handler(exited);
      else exitHandlers.push(handler);
    },
    async kill() {
      if (killed) return;
      killed = true;
      page.close();
      if (!exited) {
        signalGroup(child.pid, "SIGTERM");
        const done = await Promise.race([
          exitPromise.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 3_000)),
        ]);
        if (!done) {
          signalGroup(child.pid, "SIGKILL");
          await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 2_000))]);
        }
      }
      removeProfile(profileDir);
    },
    killSync() {
      if (killed) return;
      killed = true;
      signalGroup(child.pid, "SIGKILL");
      removeProfile(profileDir);
    },
  };
};

/**
 * Kill Chromium processes left over from a previous bot process (SIGKILL'd
 * before it could clean up) and delete their profiles. Matches on our own
 * profile root in the command line, so an unrelated browser is never touched.
 * Never throws.
 */
export function sweepOrphanBrowsers(keepIds: ReadonlySet<string> = new Set()): number {
  let killed = 0;
  const marker = `--user-data-dir=${BROWSER_PROFILES_DIR}${path.sep}`;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid) continue;
      let cmdline: string;
      try {
        cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      } catch {
        continue;
      }
      const idx = cmdline.indexOf(marker);
      if (idx < 0) continue;
      const id = cmdline.slice(idx + marker.length).split(/[\0/]/)[0];
      if (keepIds.has(id)) continue;
      try {
        process.kill(pid, "SIGKILL");
        killed++;
      } catch {
        // gone or not ours
      }
    }
  } catch {
    // no /proc (not Linux)
  }
  try {
    if (existsSync(BROWSER_PROFILES_DIR)) {
      for (const dir of readdirSync(BROWSER_PROFILES_DIR)) {
        if (!keepIds.has(dir)) removeProfile(path.join(BROWSER_PROFILES_DIR, dir));
      }
    }
  } catch {
    // best effort
  }
  return killed;
}
