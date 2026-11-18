// ---------------------------------------------------------------------------
// Browser — control state machine (pure)
//
//   running ⇄ paused                 pause / resume (Discord board)
//   running → needs-human            agent called browser_request_human
//   any live → human-control         someone pressed Take control
//   human-control → needs-human      release while the agent is still waiting
//   human-control → running          release, or Done
//   needs-human → running            Done
//   any → closed                     stop / reap / session end (terminal)
//
// The agent may act only in `running`.
// ---------------------------------------------------------------------------

export type BrowserState = "running" | "paused" | "needs-human" | "human-control" | "closed";

export type BrowserControlEvent =
  | "pause"
  | "resume"
  | "request_human"
  | "takeover"
  | "release"
  | "done"
  | "close";

/** Next state, or null when the event does not apply in `state`. */
export function nextBrowserState(
  state: BrowserState,
  event: BrowserControlEvent,
  ctx: { awaitingHuman?: boolean } = {},
): BrowserState | null {
  if (state === "closed") return null;
  switch (event) {
    case "close":
      return "closed";
    case "pause":
      return state === "running" ? "paused" : null;
    case "resume":
      return state === "paused" ? "running" : null;
    case "request_human":
      return state === "running" ? "needs-human" : null;
    case "takeover":
      return state === "human-control" ? null : "human-control";
    case "release":
      if (state !== "human-control") return null;
      return ctx.awaitingHuman ? "needs-human" : "running";
    case "done":
      return state === "needs-human" || state === "human-control" ? "running" : null;
  }
}

/** Why the agent may not act right now, or null when it may. */
export function agentBlockedReason(state: BrowserState): string | null {
  switch (state) {
    case "running":
      return null;
    case "human-control":
      return "A human has control of the browser right now. Wait for them to hand it back (they press Done or Release), then try again.";
    case "paused":
      return "The browser is paused from Discord. Ask the user to press Resume, or wait.";
    case "needs-human":
      return "The browser is waiting for a human (browser_request_human). Wait for them to press Done.";
    case "closed":
      return "The browser is closed. Call browser_open to start a new one.";
  }
}

export const STATE_LABEL: Record<BrowserState, string> = {
  running: "Agent driving",
  paused: "Paused",
  "needs-human": "Needs you",
  "human-control": "Human in control",
  closed: "Closed",
};
