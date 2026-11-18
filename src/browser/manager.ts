// ---------------------------------------------------------------------------
// Browser — registry
//
// At most one browser per SDK session (keyed by the session's channel id) and
// BROWSER_MAX (default 2) in total. Idle browsers are reaped after
// BROWSER_IDLE_MS (default 10 min; a connected viewer counts as activity),
// and every browser is killed — profile deleted — on close, reap, session
// end, shutdown and process exit.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { BrowserSession } from "./browser-session.js";
import { launchChromium, sweepOrphanBrowsers, type BrowserLauncher } from "./launch.js";
import { revokeViewerTokens } from "./tokens.js";
import { count } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

const REAP_INTERVAL_MS = 60_000;

const browsers = new Map<string, BrowserSession>();
const byOwner = new Map<string, string>();
const opening = new Map<string, Promise<BrowserSession>>();
const openListeners = new Set<(session: BrowserSession) => void>();

let launcher: BrowserLauncher = launchChromium;
let reaper: ReturnType<typeof setInterval> | null = null;
let exitHookInstalled = false;

export function browserMax(): number {
  const n = Number(process.env.BROWSER_MAX);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

export function browserIdleMs(): number {
  const n = Number(process.env.BROWSER_IDLE_MS);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000;
}

/** Swap the launcher (tests). Pass nothing to restore Chromium. */
export function setBrowserLauncher(next?: BrowserLauncher): void {
  launcher = next ?? launchChromium;
}

/** Hook called for every newly opened browser (the Discord board attaches here). */
export function onBrowserOpened(fn: (session: BrowserSession) => void): () => void {
  openListeners.add(fn);
  return () => {
    openListeners.delete(fn);
  };
}

export function getBrowser(id: string): BrowserSession | null {
  const session = browsers.get(id);
  return session && !session.closed ? session : null;
}

export function getBrowserFor(ownerKey: string): BrowserSession | null {
  const id = byOwner.get(ownerKey);
  return id ? getBrowser(id) : null;
}

export function listBrowsers(): BrowserSession[] {
  return [...browsers.values()].filter((b) => !b.closed);
}

function newBrowserId(): string {
  return randomBytes(9).toString("base64url");
}

function forget(session: BrowserSession): void {
  browsers.delete(session.id);
  if (byOwner.get(session.ownerKey) === session.id) byOwner.delete(session.ownerKey);
  revokeViewerTokens(session.id);
}

function ensureBackground(): void {
  if (!reaper) {
    reaper = setInterval(() => void reapIdleBrowsers(), REAP_INTERVAL_MS);
    reaper.unref?.();
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const session of browsers.values()) session.killSync();
    });
  }
}

/**
 * The owner's browser, launching one if it has none. `created` says which.
 * Throws when the global limit is reached or Chromium will not start.
 */
export async function openBrowser(
  ownerKey: string,
): Promise<{ session: BrowserSession; created: boolean }> {
  const existing = getBrowserFor(ownerKey);
  if (existing) return { session: existing, created: false };
  const inFlight = opening.get(ownerKey);
  if (inFlight) return { session: await inFlight, created: false };

  const max = browserMax();
  if (listBrowsers().length + opening.size >= max) {
    throw new Error(
      `Browser limit reached (${max} running, BROWSER_MAX). Close one with browser_close or wait for an idle one to be reaped.`,
    );
  }

  const promise = (async () => {
    const id = newBrowserId();
    const launched = await launcher(id);
    const session = new BrowserSession(id, ownerKey, launched);
    try {
      await session.init();
    } catch (err) {
      await session.close("init failed");
      throw err;
    }
    session.on("closed", () => forget(session));
    browsers.set(id, session);
    byOwner.set(ownerKey, id);
    return session;
  })();
  opening.set(ownerKey, promise);
  try {
    const session = await promise;
    ensureBackground();
    count(P.browserOpen);
    console.log(`[browser] opened ${session.id} for ${ownerKey}`);
    for (const fn of [...openListeners]) {
      try {
        fn(session);
      } catch (err) {
        console.error("[browser] open listener threw:", err);
      }
    }
    return { session, created: true };
  } finally {
    opening.delete(ownerKey);
  }
}

export async function closeBrowser(id: string, reason = "closed"): Promise<boolean> {
  const session = browsers.get(id);
  if (!session) return false;
  forget(session);
  await session.close(reason);
  console.log(`[browser] closed ${id}: ${reason}`);
  return true;
}

export async function closeBrowserFor(ownerKey: string, reason = "closed"): Promise<boolean> {
  const id = byOwner.get(ownerKey);
  return id ? closeBrowser(id, reason) : false;
}

export async function reapIdleBrowsers(idleMs = browserIdleMs()): Promise<number> {
  const stale = listBrowsers().filter((b) => b.idleMs >= idleMs && !b.awaitingHuman);
  await Promise.all(stale.map((b) => closeBrowser(b.id, `idle for ${Math.round(b.idleMs / 60000)} min`)));
  return stale.length;
}

/** Close every browser (shutdown / restart). Returns how many were open. */
export async function stopAllBrowsers(): Promise<number> {
  const all = [...browsers.values()];
  await Promise.all(all.map((b) => closeBrowser(b.id, "shutdown")));
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
  return all.length;
}

/** Boot-time cleanup of browsers orphaned by a SIGKILL'd predecessor. */
export function sweepOrphanBrowserProcesses(): number {
  return sweepOrphanBrowsers(new Set(browsers.keys()));
}
