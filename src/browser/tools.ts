// ---------------------------------------------------------------------------
// Browser — agent tools
//
// Same shape as the other tool arrays (name / description / input_schema) so
// tool-paths.ts can declare them; bridged into SDK sessions by sdk/bridge.ts.
// The snapshot (numbered refs) is the agent's primary observation; a
// screenshot is there for when layout or images matter.
// ---------------------------------------------------------------------------

import type { EditableHandle } from "../sdk/relay-queue.js";
import { attachBrowserBoard } from "./board.js";
import { closeBrowserFor, getBrowserFor, openBrowser } from "./manager.js";
import { DEFAULT_HUMAN_TIMEOUT_MS, takeoverIdleMs, type HumanWaitOutcome } from "./browser-session.js";
import { describeHandBackForAgent } from "./handback.js";
import { normalizeBrowserUrl } from "./page-scripts.js";
import { assertBrowserUrlAllowed } from "./url-gate.js";
import { count, countTool } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

export const browserTools = [
  {
    name: "browser_open",
    description:
      "Open a headless Chromium (1280x800, throwaway profile) for this conversation and load a URL. Posts a live board in the channel the user can watch and take over from. Reuses this conversation's browser if one is already open.",
    input_schema: {
      type: "object" as const,
      properties: { url: { type: "string", description: "URL to load (https:// assumed)" } },
      required: ["url"],
    },
  },
  {
    name: "browser_navigate",
    description: "Load a URL in this conversation's browser and wait for the page to finish loading.",
    input_schema: {
      type: "object" as const,
      properties: { url: { type: "string", description: "URL to load" } },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Text outline of the current page: title, URL, visible text and every interactive element with a numbered ref for browser_click / browser_type. Take a fresh one after anything changes the page.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "browser_click",
    description: "Click an element by snapshot ref, or at viewport coordinates (x,y in CSS px of the 1280x800 viewport).",
    input_schema: {
      type: "object" as const,
      properties: {
        ref: { type: "number", description: "Element ref from browser_snapshot" },
        x: { type: "number", description: "Viewport x (when no ref)" },
        y: { type: "number", description: "Viewport y (when no ref)" },
      },
    },
  },
  {
    name: "browser_type",
    description:
      "Type text. With a ref, clicks that field and replaces its content first; without one, types into whatever has focus. submit=true presses Enter afterwards.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Text to type" },
        ref: { type: "number", description: "Field ref from browser_snapshot" },
        submit: { type: "boolean", description: "Press Enter after typing" },
        clear: { type: "boolean", description: "Replace existing content when a ref is given (default true)" },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_screenshot",
    description:
      "JPEG screenshot of the viewport, saved into this session's folder (browser/). Use when the snapshot is not enough (layout, images, canvas).",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "browser_request_human",
    description:
      "Hand the browser to a human (login, CAPTCHA, payment, anything you must not do yourself) and wait until they hand it back from the live viewer or the board, optionally with a choice and a note. Blocks up to 10 minutes.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: { type: "string", description: "What the human needs to do, in one line" },
        handback_options: {
          type: "array",
          items: { type: "string" },
          description: "Up to 4 short choices (max 40 chars each) the user can pick when handing back",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "browser_close",
    description: "Close this conversation's browser and delete its profile.",
    input_schema: { type: "object" as const, properties: {} },
  },
];

export interface BrowserToolContext {
  /** SDK session key (the channel/thread id). */
  ownerKey: string;
  /** Session folder; screenshots land in `<dir>/browser/`. */
  sessionDir?: string;
  /** Posts the board through the session's relay queue. */
  openEditable?: (payload: unknown) => EditableHandle;
  /** Pings the user when a human is needed. */
  notify?: (text: string) => Promise<unknown> | void;
  getUserId?: () => string | undefined;
  /** Delivers a hand-back note to this conversation when no tool call is waiting for it. */
  deliverChat?: (text: string, userId: string) => void;
}

export interface BrowserToolResult {
  text: string;
  /** Base64 JPEG for browser_screenshot. */
  image?: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function requireBrowser(ownerKey: string) {
  const session = getBrowserFor(ownerKey);
  if (!session) throw new Error("No browser is open in this conversation. Call browser_open first.");
  return session;
}

function where(session: { title: string; url: string }): string {
  return `${session.title || "(untitled)"} — ${session.url}`;
}

/** Run one browser tool. Throws on failure; the bridge turns that into an error result. */
export async function handleBrowserTool(
  name: string,
  input: Record<string, unknown>,
  ctx: BrowserToolContext,
): Promise<BrowserToolResult> {
  countTool(name);
  switch (name) {
    case "browser_open": {
      // Before launching, so a refused URL never costs a Chromium.
      try {
        assertBrowserUrlAllowed(normalizeBrowserUrl(str(input.url)));
      } catch (err) {
        count(P.browserUrlRefused);
        throw err;
      }
      const { session, created } = await openBrowser(ctx.ownerKey);
      if (ctx.deliverChat) session.onHandBackChat = ctx.deliverChat;
      if (created && ctx.openEditable) attachBrowserBoard(session, ctx.openEditable);
      await session.navigate(str(input.url));
      return {
        text: `${created ? "Browser opened" : "Reused the open browser"} (id ${session.id}). Now at: ${where(session)}\nCall browser_snapshot to see the page.`,
      };
    }
    case "browser_navigate": {
      const session = requireBrowser(ctx.ownerKey);
      await session.navigate(str(input.url));
      return { text: `Now at: ${where(session)}` };
    }
    case "browser_snapshot":
      return { text: await requireBrowser(ctx.ownerKey).snapshot() };
    case "browser_click": {
      const session = requireBrowser(ctx.ownerKey);
      const ref = optNum(input.ref);
      const x = optNum(input.x);
      const y = optNum(input.y);
      if (ref === undefined && (x === undefined || y === undefined)) {
        throw new Error("Pass a ref, or both x and y.");
      }
      const label = await session.click(ref !== undefined ? { ref } : { x: x!, y: y! });
      return { text: `Clicked ${label}. Now at: ${where(session)}` };
    }
    case "browser_type": {
      const session = requireBrowser(ctx.ownerKey);
      const label = await session.type({
        text: str(input.text),
        ref: optNum(input.ref),
        submit: input.submit === true,
        clear: input.clear === false ? false : undefined,
      });
      return { text: `Typed ${label}. Now at: ${where(session)}` };
    }
    case "browser_screenshot": {
      const session = requireBrowser(ctx.ownerKey);
      const shot = await session.screenshot(ctx.sessionDir);
      return {
        text: `Screenshot of ${where(session)}${shot.path ? `\nSaved to ${shot.path}` : ""}`,
        image: shot.base64,
      };
    }
    case "browser_request_human": {
      const session = requireBrowser(ctx.ownerKey);
      const reason = str(input.reason) || "The agent needs a human to take over.";
      const wait = session.requestHuman(reason, DEFAULT_HUMAN_TIMEOUT_MS, input.handback_options);
      const userId = ctx.getUserId?.();
      try {
        await ctx.notify?.(
          `${userId ? `<@${userId}> ` : ""}🙋 The browser needs you: ${reason}\nUse **Live view** on the browser board to take control, then press **Hand back**.`,
        );
      } catch {
        // the board still shows it
      }
      const outcome = await wait;
      return { text: requestHumanResultText(outcome, session) };
    }
    case "browser_close": {
      const closed = await closeBrowserFor(ctx.ownerKey, "closed by the agent");
      return { text: closed ? "Browser closed." : "No browser was open." };
    }
    default:
      throw new Error(`Unknown browser tool: ${name}`);
  }
}

/** The browser_request_human tool result for a settled wait. */
export function requestHumanResultText(
  outcome: HumanWaitOutcome,
  session: { title: string; url: string },
): string {
  if (outcome.result === "done") {
    const said = outcome.auto
      ? `The user's control was released automatically after ${Math.round(takeoverIdleMs() / 60000)} minutes without input; they may not have finished.`
      : describeHandBackForAgent(outcome);
    return `${said}\nNow at: ${where(session)}\nTake a fresh browser_snapshot.`;
  }
  if (outcome.result === "closed") return "The browser was closed while waiting for the human.";
  return `No human responded within ${Math.round(DEFAULT_HUMAN_TIMEOUT_MS / 60000)} minutes. The browser is back under your control; ask the user in the channel before trying again.`;
}
