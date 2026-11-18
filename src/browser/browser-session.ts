// ---------------------------------------------------------------------------
// Browser — one controlled Chromium page
//
// Owns the state machine (state.ts), the bounded action log, the latest
// thumbnail for the Discord board, the screencast fan-out to viewers and the
// browser_request_human waiter. Agent actions run only in `running`; while a
// human holds control they wait (BROWSER_HOLD_MS) for the hand-back instead of
// failing. Observation (snapshot, screenshot) is allowed while a human drives,
// so the agent can watch what they did. Every URL the agent opens, and every
// URL a page commits to after an agent action, passes url-gate.ts.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CdpPage, LaunchedBrowser } from "./launch.js";
import { VIEWPORT } from "./launch.js";
import {
  META_SCRIPT,
  SELECT_FOCUSED_SCRIPT,
  SNAPSHOT_SCRIPT,
  formatSnapshot,
  normalizeBrowserUrl,
  refCenterScript,
  sensitiveFieldScript,
  type HumanInput,
  type SnapshotData,
} from "./page-scripts.js";
import {
  agentBlockedReason,
  nextBrowserState,
  type BrowserControlEvent,
  type BrowserState,
} from "./state.js";
import {
  formatHandBackChat,
  parseHandBack,
  sanitizeHandBackOptions,
  type HandBack,
  type HandBackInput,
} from "./handback.js";
import { assertBrowserUrlAllowed, checkCommittedUrl } from "./url-gate.js";
import { count } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

export const MAX_ACTION_LOG = 50;
export const DEFAULT_HUMAN_TIMEOUT_MS = 10 * 60 * 1000;

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** How long an agent action waits for a human to hand control back. */
export function browserHoldMs(): number {
  return envMs("BROWSER_HOLD_MS", 10 * 60 * 1000);
}

/** A takeover with no viewer input for this long is released automatically. */
export function takeoverIdleMs(): number {
  return envMs("BROWSER_TAKEOVER_IDLE_MS", 5 * 60 * 1000);
}

export const PASSWORD_FIELD_ERROR =
  "browser_type refuses password and one-time-code fields, so the agent never types credentials. Call browser_request_human and let the user type it during takeover.";
const NAVIGATION_TIMEOUT_MS = 15_000;
const FRAME_ACK_FALLBACK_MS = 3_000;

export interface BrowserAction {
  at: number;
  actor: "agent" | "human";
  kind: string;
  detail: string;
}

export interface ScreencastFrame {
  /** Base64 JPEG. */
  data: string;
  metadata: Record<string, unknown>;
}

/** Called per frame; call `done` once the frame has been sent on. */
export type FrameListener = (frame: ScreencastFrame, done: () => void) => void;

export type HumanWaitResult = "done" | "timeout" | "closed";

export interface HumanWaitOutcome extends HandBack {
  result: HumanWaitResult;
  userId?: string;
  /** Set when control was released for the human, not by them. */
  auto?: "idle";
}

export type HandBackResult =
  | { ok: true; delivered: "waiter" | "chat" | "none" }
  | { ok: false; error: string };

/** Delivers a hand-back note to the owning conversation when no tool call is waiting. */
export type HandBackChat = (text: string, userId: string) => void;

type Events = {
  state: BrowserState;
  action: BrowserAction;
  meta: void;
  closed: string;
};

export type ClickTarget = { ref: number } | { x: number; y: number };

export class BrowserSession {
  readonly id: string;
  readonly ownerKey: string;
  readonly createdAt: number;

  state: BrowserState = "running";
  url = "about:blank";
  title = "";
  actions: BrowserAction[] = [];
  actionCount = 0;
  lastShot: Buffer | null = null;
  controllerUserId: string | null = null;
  humanReason: string | null = null;
  /** Agent-supplied hand-back choices for the current request (viewer + modal). */
  handBackOptions: string[] = [];
  onHandBackChat: HandBackChat | null = null;
  lastActivityAt: number;

  private readonly page: CdpPage;
  private readonly launched: LaunchedBrowser;
  private readonly now: () => number;
  private listeners: { [K in keyof Events]?: Set<(v: Events[K]) => void> } = {};
  private frameListeners = new Set<FrameListener>();
  private screencasting = false;
  private humanWaiter: {
    resolve: (r: HumanWaitOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private takeovers = 0;
  private closing: Promise<void> | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(id: string, ownerKey: string, launched: LaunchedBrowser, now: () => number = Date.now) {
    this.id = id;
    this.ownerKey = ownerKey;
    this.launched = launched;
    this.page = launched.page;
    this.now = now;
    this.createdAt = now();
    this.lastActivityAt = this.createdAt;
  }

  /** Enable domains, fix the viewport and wire page events. */
  async init(): Promise<void> {
    await this.page.send("Page.enable");
    await this.page.send("Runtime.enable");
    await this.page.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    this.unsubscribers.push(
      this.page.on("Page.screencastFrame", (p) => this.handleFrame(p)),
      this.page.on("Page.frameNavigated", (p) => {
        if (p?.frame && !p.frame.parentId && typeof p.frame.url === "string") {
          this.url = p.frame.url;
          this.emit("meta", undefined);
        }
      }),
      this.page.on("Page.loadEventFired", () => {
        void this.refreshMeta().then(() => this.emit("meta", undefined));
      }),
      this.page.onClose((reason) => void this.close(`browser connection lost (${reason})`)),
    );
    this.launched.onExit((detail) => void this.close(`browser process exited (${detail})`));
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  on<K extends keyof Events>(event: K, fn: (v: Events[K]) => void): () => void {
    let set = this.listeners[event] as Set<(v: Events[K]) => void> | undefined;
    if (!set) {
      set = new Set();
      (this.listeners as Record<string, unknown>)[event] = set;
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
    };
  }

  private emit<K extends keyof Events>(event: K, value: Events[K]): void {
    const set = this.listeners[event] as Set<(v: Events[K]) => void> | undefined;
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(value);
      } catch (err) {
        console.error(`[browser] ${event} listener threw:`, err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  get closed(): boolean {
    return this.state === "closed";
  }

  get awaitingHuman(): boolean {
    return this.humanWaiter !== null;
  }

  get viewerCount(): number {
    return this.frameListeners.size;
  }

  get idleMs(): number {
    return this.viewerCount > 0 ? 0 : this.now() - this.lastActivityAt;
  }

  private touch(): void {
    this.lastActivityAt = this.now();
  }

  private transition(event: BrowserControlEvent): boolean {
    const next = nextBrowserState(this.state, event, { awaitingHuman: this.awaitingHuman });
    if (!next) return false;
    this.state = next;
    this.touch();
    if (next === "human-control") this.armIdleRelease();
    else this.clearIdleRelease();
    this.emit("state", next);
    return true;
  }

  private armIdleRelease(): void {
    this.clearIdleRelease();
    const ms = takeoverIdleMs();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.state !== "human-control") return;
      count(P.browserIdleRelease);
      this.handBack(this.controllerUserId ?? "unknown", {}, { auto: "idle", idleMs: ms });
    }, ms);
    this.idleTimer.unref?.();
  }

  private clearIdleRelease(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Any viewer message (input, heartbeat) keeps a takeover from idling out. */
  noteHumanActivity(): void {
    if (this.state !== "human-control") return;
    this.touch();
    this.armIdleRelease();
  }

  private record(actor: BrowserAction["actor"], kind: string, detail: string): void {
    const action: BrowserAction = { at: this.now(), actor, kind, detail: detail.slice(0, 200) };
    this.actions.push(action);
    if (this.actions.length > MAX_ACTION_LOG) this.actions.splice(0, this.actions.length - MAX_ACTION_LOG);
    this.actionCount++;
    this.emit("action", action);
  }

  get lastAction(): BrowserAction | null {
    return this.actions[this.actions.length - 1] ?? null;
  }

  setPaused(paused: boolean, by?: string): boolean {
    const ok = this.transition(paused ? "pause" : "resume");
    if (ok) this.record("human", paused ? "pause" : "resume", by ? `by ${by}` : "");
    return ok;
  }

  takeControl(userId: string): boolean {
    if (!this.transition("takeover")) return false;
    this.controllerUserId = userId;
    this.takeovers++;
    count(P.browserTakeover);
    this.record("human", "takeover", `<@${userId}> took control`);
    return true;
  }

  releaseControl(): boolean {
    if (!this.transition("release")) return false;
    this.controllerUserId = null;
    this.record("human", "release", "control handed back");
    return true;
  }

  /** Human finished: resolves a pending browser_request_human, returns control to the agent. */
  humanDone(userId?: string): boolean {
    if (!this.transition("done")) return false;
    this.controllerUserId = null;
    this.humanReason = null;
    this.handBackOptions = [];
    this.record("human", "done", userId ? `<@${userId}> pressed Done` : "Done");
    this.settleHuman({ result: "done", userId });
    return true;
  }

  /**
   * The human hands control back, optionally saying something. Valid only in
   * human-control; a refusal leaves them in control. What they said goes to a
   * waiting browser_request_human if there is one, otherwise to the owning
   * conversation as a chat message — delivered exactly once either way.
   */
  handBack(userId: string, input: HandBackInput, opts: { auto?: "idle"; idleMs?: number } = {}): HandBackResult {
    if (this.state !== "human-control") {
      return { ok: false, error: "Nobody has control of the browser right now, so there is nothing to hand back." };
    }
    const parsed = parseHandBack(input);
    if (!parsed.ok) return parsed;
    const said = parsed.value;
    const logDetail = opts.auto
      ? `released automatically after ${Math.round((opts.idleMs ?? 0) / 60000)} min without input`
      : `<@${userId}> handed back${formatHandBackChat(said) ? `: ${formatHandBackChat(said)}` : ""}`;

    if (this.humanWaiter) {
      if (!this.transition("done")) return { ok: false, error: "Could not hand the browser back." };
      this.afterHandBack(opts.auto ? "idle_release" : "handback", logDetail);
      this.settleHuman({ result: "done", userId, ...said, ...(opts.auto ? { auto: opts.auto } : {}) });
      return { ok: true, delivered: "waiter" };
    }

    const text = formatHandBackChat(said);
    if (text) {
      if (!this.onHandBackChat) {
        return { ok: false, error: "This browser has no conversation to deliver the note to. Hand back without a note, or close the browser." };
      }
      try {
        this.onHandBackChat(text, userId);
      } catch (err) {
        console.error("[browser] hand-back delivery failed:", err);
        return { ok: false, error: "Could not deliver the note to the conversation; you still have control." };
      }
    }
    this.transition("release");
    this.afterHandBack(opts.auto ? "idle_release" : "handback", logDetail);
    return { ok: true, delivered: text ? "chat" : "none" };
  }

  private afterHandBack(kind: string, detail: string): void {
    this.controllerUserId = null;
    this.humanReason = null;
    this.handBackOptions = [];
    count(P.browserHandBack);
    this.record("human", kind, detail);
  }

  /** Block until a human hands back (or timeout / close). */
  requestHuman(
    reason: string,
    timeoutMs = DEFAULT_HUMAN_TIMEOUT_MS,
    handBackOptions?: unknown,
  ): Promise<HumanWaitOutcome> {
    const blocked = agentBlockedReason(this.state);
    if (blocked) return Promise.reject(new Error(blocked));
    // Set before the transition so the state broadcast already carries them.
    this.handBackOptions = sanitizeHandBackOptions(handBackOptions);
    if (!this.transition("request_human")) {
      this.handBackOptions = [];
      return Promise.reject(new Error("Could not hand over to a human."));
    }
    count(P.browserRequestHuman);
    this.humanReason = reason.slice(0, 300);
    this.record("agent", "request_human", this.humanReason);
    return new Promise<HumanWaitOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.humanWaiter = null;
        this.humanReason = null;
        this.handBackOptions = [];
        if (this.state === "needs-human") this.transition("done");
        resolve({ result: "timeout" });
      }, timeoutMs);
      timer.unref?.();
      this.humanWaiter = { resolve, timer };
    });
  }

  private settleHuman(outcome: HumanWaitOutcome): void {
    const waiter = this.humanWaiter;
    if (!waiter) return;
    this.humanWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(outcome);
  }

  /** Resolves true once the state leaves human-control, false after `timeoutMs`. */
  waitForAgentTurn(timeoutMs: number): Promise<boolean> {
    if (this.state !== "human-control") return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const off = this.on("state", (s) => {
        if (s === "human-control") return;
        clearTimeout(timer);
        off();
        resolve(true);
      });
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  // -------------------------------------------------------------------------
  // Agent actions
  // -------------------------------------------------------------------------

  private assertAgentCanAct(): void {
    const blocked = agentBlockedReason(this.state);
    if (blocked) throw new Error(blocked);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(agentBlockedReason("closed")!);
  }

  private async eval<T = unknown>(expression: string): Promise<T> {
    const res = await this.page.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error(
        `page script failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "error"}`,
      );
    }
    return res.result?.value as T;
  }

  private waitForEvent(method: string, timeoutMs: number): { promise: Promise<boolean>; cancel: () => void } {
    let off: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveFn: (v: boolean) => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
      resolveFn = resolve;
      off = this.page.on(method, () => {
        if (timer) clearTimeout(timer);
        off();
        resolve(true);
      });
      timer = setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
    });
    return {
      promise,
      cancel: () => {
        if (timer) clearTimeout(timer);
        off();
        resolveFn(false);
      },
    };
  }

  /** After a click/keypress: if it started a navigation, wait for the load. */
  private async settle(): Promise<void> {
    const started = this.waitForEvent("Page.frameStartedLoading", 400);
    const load = this.waitForEvent("Page.loadEventFired", 10_000);
    if (await started.promise) await load.promise;
    else load.cancel();
  }

  private async refreshMeta(): Promise<void> {
    try {
      const raw = await this.eval<string>(META_SCRIPT);
      const [url, title] = JSON.parse(raw) as [string, string];
      this.url = url;
      this.title = title;
    } catch {
      // mid-navigation; the next load event fills it in
    }
  }

  private async captureThumb(): Promise<void> {
    try {
      const { data } = await this.page.send<{ data: string }>("Page.captureScreenshot", {
        format: "jpeg",
        quality: 50,
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 0.5 },
      });
      this.lastShot = Buffer.from(data, "base64");
    } catch {
      // keep the previous thumbnail
    }
  }

  private interrupted(kind: string): Error {
    return new Error(
      `A human took control of the browser while this ${kind} was running, so it may have been interrupted. Wait for them to hand it back, then take a fresh browser_snapshot before retrying.`,
    );
  }

  /**
   * If the page ended up somewhere the gate refuses, blank it (only when the
   * agent is driving — never yank a page from a human) and throw.
   */
  private async enforceCommittedUrl(url: string): Promise<void> {
    const verdict = checkCommittedUrl(url);
    if (verdict.ok) return;
    count(P.browserUrlRefused);
    if (this.state === "running") {
      try {
        await this.page.send("Page.navigate", { url: "about:blank" });
      } catch {
        // the error below still stops the agent
      }
      this.url = "about:blank";
      this.title = "";
      this.record("agent", "redirect_refused", url);
      this.emit("meta", undefined);
    }
    throw new Error(
      `redirect_refused: the page went to ${url}, which ${verdict.reason}.${this.state === "running" ? " The browser was sent to about:blank." : ""} Only public http(s) sites are allowed.`,
    );
  }

  private async agentAct<T>(kind: string, detail: string, fn: () => Promise<T>): Promise<T> {
    if (this.state === "human-control") {
      const holdMs = browserHoldMs();
      if (!(await this.waitForAgentTurn(holdMs))) {
        throw new Error(
          `The user is still in control of the browser (waited ${Math.round(holdMs / 60000)} min). Tell them you are waiting for them to hand it back, and end your turn.`,
        );
      }
    }
    this.assertAgentCanAct();
    this.touch();
    const epoch = this.takeovers;
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      if (this.takeovers !== epoch) throw this.interrupted(kind);
      throw err;
    }
    if (this.takeovers !== epoch) throw this.interrupted(kind);
    await this.refreshMeta();
    await this.enforceCommittedUrl(this.url);
    await this.captureThumb();
    count(P.browserAction);
    this.record("agent", kind, detail);
    return result;
  }

  async navigate(rawUrl: string): Promise<string> {
    const url = normalizeBrowserUrl(rawUrl);
    try {
      assertBrowserUrlAllowed(url);
    } catch (err) {
      count(P.browserUrlRefused);
      throw err;
    }
    return this.agentAct("navigate", url, async () => {
      const load = this.waitForEvent("Page.loadEventFired", NAVIGATION_TIMEOUT_MS);
      const res = await this.page.send<{ errorText?: string; loaderId?: string }>("Page.navigate", { url });
      if (res.errorText) {
        load.cancel();
        throw new Error(`Navigation to ${url} failed: ${res.errorText}`);
      }
      if (res.loaderId) await load.promise;
      else load.cancel();
      return url;
    });
  }

  async snapshot(): Promise<string> {
    this.assertOpen();
    this.touch();
    const raw = await this.eval<string>(SNAPSHOT_SCRIPT);
    const data = JSON.parse(raw) as SnapshotData;
    this.url = data.url;
    this.title = data.title;
    await this.enforceCommittedUrl(data.url);
    return formatSnapshot(data);
  }

  private async refPoint(ref: number): Promise<{ x: number; y: number }> {
    if (!Number.isInteger(ref) || ref < 1) throw new Error(`Invalid ref: ${ref}`);
    const raw = await this.eval<string | null>(refCenterScript(ref));
    if (!raw) throw new Error(`Ref ${ref} is not on the page any more — take a fresh browser_snapshot.`);
    return JSON.parse(raw) as { x: number; y: number };
  }

  private async mouseClick(x: number, y: number): Promise<void> {
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async click(target: ClickTarget): Promise<string> {
    const label = "ref" in target ? `ref ${target.ref}` : `(${Math.round(target.x)}, ${Math.round(target.y)})`;
    return this.agentAct("click", label, async () => {
      const point =
        "ref" in target
          ? await this.refPoint(target.ref)
          : {
              x: Math.min(VIEWPORT.width, Math.max(0, target.x)),
              y: Math.min(VIEWPORT.height, Math.max(0, target.y)),
            };
      const settled = this.settle();
      await this.mouseClick(point.x, point.y);
      await settled;
      return label;
    });
  }

  async type(opts: { ref?: number; text: string; submit?: boolean; clear?: boolean }): Promise<string> {
    const label = `${opts.text.length} chars${opts.ref ? ` into ref ${opts.ref}` : ""}${opts.submit ? " + Enter" : ""}`;
    return this.agentAct("type", label, async () => {
      if (opts.ref !== undefined) {
        if (await this.isSensitiveField(opts.ref)) throw new Error(PASSWORD_FIELD_ERROR);
        const point = await this.refPoint(opts.ref);
        await this.mouseClick(point.x, point.y);
        if (opts.clear !== false) await this.eval(SELECT_FOCUSED_SCRIPT);
      }
      // Also checks the focused element: clicking a label can focus a password field.
      if (opts.text && (await this.isSensitiveField())) throw new Error(PASSWORD_FIELD_ERROR);
      if (opts.text) await this.page.send("Input.insertText", { text: opts.text });
      if (opts.submit) {
        const settled = this.settle();
        const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        await this.page.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key });
        await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
        await settled;
      }
      return label;
    });
  }

  private async isSensitiveField(ref?: number): Promise<boolean> {
    if (ref !== undefined && (!Number.isInteger(ref) || ref < 1)) throw new Error(`Invalid ref: ${ref}`);
    return (await this.eval<unknown>(sensitiveFieldScript(ref))) === true;
  }

  /** Full-size JPEG; also written under `<dir>/browser/` when a dir is given. */
  async screenshot(dir?: string): Promise<{ base64: string; path: string | null }> {
    this.assertOpen();
    this.touch();
    await this.refreshMeta();
    await this.enforceCommittedUrl(this.url);
    const { data } = await this.page.send<{ data: string }>("Page.captureScreenshot", {
      format: "jpeg",
      quality: 80,
    });
    let file: string | null = null;
    if (dir) {
      try {
        const outDir = path.join(dir, "browser");
        mkdirSync(outDir, { recursive: true });
        file = path.join(outDir, `shot-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}.jpg`);
        writeFileSync(file, Buffer.from(data, "base64"));
      } catch (err) {
        console.error("[browser] could not save screenshot:", err);
        file = null;
      }
    }
    this.lastShot = null;
    await this.captureThumb();
    return { base64: data, path: file };
  }

  // -------------------------------------------------------------------------
  // Human input + screencast (gateway viewer)
  // -------------------------------------------------------------------------

  /** Forward one validated viewer input. False unless a human has control. */
  async dispatchHumanInput(input: HumanInput): Promise<boolean> {
    if (this.state !== "human-control") return false;
    this.noteHumanActivity();
    try {
      if (input.t === "mouse") {
        await this.page.send("Input.dispatchMouseEvent", {
          type: input.type,
          x: input.x,
          y: input.y,
          button: input.button,
          buttons: input.buttons,
          clickCount: input.clickCount,
          modifiers: input.modifiers,
          ...(input.type === "mouseWheel" ? { deltaX: input.deltaX, deltaY: input.deltaY } : {}),
        });
        if (input.type === "mousePressed") {
          this.record("human", "click", `(${Math.round(input.x)}, ${Math.round(input.y)})`);
        }
      } else if (input.t === "key") {
        const type = input.type === "keyUp" ? "keyUp" : input.text ? "keyDown" : "rawKeyDown";
        await this.page.send("Input.dispatchKeyEvent", {
          type,
          key: input.key,
          code: input.code,
          windowsVirtualKeyCode: input.keyCode,
          nativeVirtualKeyCode: input.keyCode,
          modifiers: input.modifiers,
          ...(input.text && input.type === "keyDown" ? { text: input.text } : {}),
        });
        if (input.type === "keyDown" && input.key === "Enter") this.record("human", "key", "Enter");
      } else {
        await this.page.send("Input.insertText", { text: input.text });
        this.record("human", "type", `${input.text.length} chars`);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Subscribe to screencast frames; the screencast runs while anyone listens. */
  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    this.touch();
    if (!this.screencasting && !this.closed) {
      this.screencasting = true;
      this.page
        .send("Page.startScreencast", {
          format: "jpeg",
          quality: 60,
          maxWidth: VIEWPORT.width,
          maxHeight: VIEWPORT.height,
          everyNthFrame: 1,
        })
        .catch(() => {
          this.screencasting = false;
        });
    }
    return () => {
      if (!this.frameListeners.delete(listener)) return;
      this.touch();
      if (this.frameListeners.size === 0 && this.screencasting) {
        this.screencasting = false;
        if (!this.closed) this.page.send("Page.stopScreencast").catch(() => {});
      }
    };
  }

  /** Fan a frame out; ack to Chrome only once every viewer has sent it on. */
  private handleFrame(params: { data?: string; metadata?: Record<string, unknown>; sessionId?: number }): void {
    let acked = false;
    const ack = () => {
      if (acked) return;
      acked = true;
      clearTimeout(fallback);
      this.page.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    };
    // A wedged socket must not freeze the screencast for everyone else.
    const fallback = setTimeout(ack, FRAME_ACK_FALLBACK_MS);
    fallback.unref?.();
    const listeners = [...this.frameListeners];
    if (listeners.length === 0 || typeof params.data !== "string") {
      ack();
      return;
    }
    let remaining = listeners.length;
    const frame: ScreencastFrame = { data: params.data, metadata: params.metadata ?? {} };
    for (const listener of listeners) {
      let called = false;
      const done = () => {
        if (called) return;
        called = true;
        if (--remaining === 0) ack();
      };
      try {
        listener(frame, done);
      } catch {
        done();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Kill the browser and remove its profile. Idempotent; never throws. */
  close(reason = "closed"): Promise<void> {
    if (this.closing) return this.closing;
    this.transition("close");
    this.clearIdleRelease();
    this.settleHuman({ result: "closed" });
    this.frameListeners.clear();
    for (const off of this.unsubscribers.splice(0)) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    this.closing = (async () => {
      try {
        await this.launched.kill();
      } catch (err) {
        console.error(`[browser] kill failed for ${this.id}:`, err);
      }
      this.emit("closed", reason);
    })();
    return this.closing;
  }

  /** Synchronous kill for process exit. */
  killSync(): void {
    try {
      this.launched.killSync();
    } catch {
      // ignore
    }
  }
}
