// ---------------------------------------------------------------------------
// Browser — Discord board
//
// One live-edited message per browser: state, page, last action and the latest
// thumbnail, plus `br:<browserId>:<action>` buttons. The renderers are pure
// and return plain API JSON; `attachBrowserBoard` wires a session's events to
// an editable relay handle (edits coalesced to one per 5s by the relay queue).
// ---------------------------------------------------------------------------

import { ButtonStyle, ComponentType, TextInputStyle } from "discord.js";
import type { EditableHandle } from "../sdk/relay-queue.js";
import type { BrowserSession } from "./browser-session.js";
import { DEFAULT_HANDBACK_OPTIONS, HANDBACK_CHOICE_MAX, HANDBACK_NOTE_MAX } from "./handback.js";
import { STATE_LABEL, type BrowserState } from "./state.js";

export const BROWSER_ACTIONS = [
  "live",
  "pause",
  "resume",
  "takeover",
  "done",
  "handback",
  "handback-submit",
  "stop",
] as const;
export type BrowserBoardAction = (typeof BROWSER_ACTIONS)[number];

export const BOARD_SHOT_NAME = "browser.jpg";

const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const CUSTOM_ID_RE = new RegExp(`^br:([A-Za-z0-9_-]{1,40}):(${BROWSER_ACTIONS.join("|")})$`);

export function buildBrowserCustomId(browserId: string, action: BrowserBoardAction): string | null {
  return SAFE_ID.test(browserId) ? `br:${browserId}:${action}` : null;
}

export function parseBrowserCustomId(
  customId: string,
): { browserId: string; action: BrowserBoardAction } | null {
  const m = CUSTOM_ID_RE.exec(customId);
  return m ? { browserId: m[1], action: m[2] as BrowserBoardAction } : null;
}

export function isBrowserCustomId(customId: string): boolean {
  return customId.startsWith("br:");
}

export interface BrowserBoardView {
  browserId: string;
  url: string;
  title: string;
  state: BrowserState;
  lastAction: string | null;
  actionCount: number;
  humanReason?: string | null;
  controllerUserId?: string | null;
  hasShot?: boolean;
}

const STATE_COLOR: Record<BrowserState, number> = {
  running: 0x5865f2,
  paused: 0x99aab5,
  "needs-human": 0xfee75c,
  "human-control": 0xeb459e,
  closed: 0x2f3136,
};

const STATE_ICON: Record<BrowserState, string> = {
  running: "🤖",
  paused: "⏸️",
  "needs-human": "🙋",
  "human-control": "🧑",
  closed: "⏹️",
};

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Which buttons are enabled in each state (closed has no buttons at all). */
export function enabledActions(state: BrowserState): Set<BrowserBoardAction> {
  switch (state) {
    case "running":
      return new Set(["live", "pause", "takeover", "stop"]);
    case "paused":
      return new Set(["live", "resume", "takeover", "stop"]);
    case "needs-human":
      return new Set(["live", "takeover", "done", "stop"]);
    case "human-control":
      return new Set(["live", "handback", "stop"]);
    case "closed":
      return new Set();
  }
}

export interface BrowserBoardPayload {
  embeds: Array<Record<string, unknown>>;
  components: Array<Record<string, unknown>>;
  files?: Array<{ attachment: Buffer; name: string }>;
  attachments?: unknown[];
}

export function renderBrowserBoard(view: BrowserBoardView): BrowserBoardPayload {
  const lines = [
    `**${oneLine(view.title || "(untitled)", 200)}**`,
    oneLine(view.url, 500),
  ];
  if (view.state === "needs-human" && view.humanReason) {
    lines.push("", `🙋 **Needs you:** ${oneLine(view.humanReason, 500)}`);
    lines.push("Open **Live view**, take control, then **Hand back** (or press **Done** here).");
  }
  if (view.state === "human-control" && view.controllerUserId) {
    lines.push("", `🧑 <@${view.controllerUserId}> is driving. Press **Hand back…** to return control, with an optional note.`);
  }
  const description = lines.join("\n").slice(0, 4096);

  const fields = [
    { name: "State", value: `${STATE_ICON[view.state]} ${STATE_LABEL[view.state]}`, inline: true },
    { name: "Actions", value: String(view.actionCount), inline: true },
  ];
  if (view.lastAction) fields.push({ name: "Last action", value: oneLine(view.lastAction, 1024), inline: false });

  const embed: Record<string, unknown> = {
    title: oneLine(`🌐 Browser · ${STATE_LABEL[view.state]}`, 256),
    description,
    color: STATE_COLOR[view.state],
    fields,
    footer: {
      text:
        view.state === "closed"
          ? `browser ${view.browserId} · closed`
          : `browser ${view.browserId} · Live view gives you a private 15-minute link`,
    },
  };
  if (view.hasShot && view.state !== "closed") embed.image = { url: `attachment://${BOARD_SHOT_NAME}` };

  const enabled = enabledActions(view.state);
  const button = (action: BrowserBoardAction, label: string, style: ButtonStyle) => ({
    type: ComponentType.Button,
    style,
    label,
    custom_id: buildBrowserCustomId(view.browserId, action),
    disabled: !enabled.has(action),
  });
  const components =
    view.state === "closed" || !SAFE_ID.test(view.browserId)
      ? []
      : [
          {
            type: ComponentType.ActionRow,
            components: [
              button("live", "Live view", ButtonStyle.Primary),
              view.state === "paused"
                ? button("resume", "Resume", ButtonStyle.Secondary)
                : button("pause", "Pause", ButtonStyle.Secondary),
              button("takeover", "Take control", ButtonStyle.Secondary),
              view.state === "human-control"
                ? button("handback", "Hand back…", ButtonStyle.Success)
                : button("done", "Done", ButtonStyle.Success),
              button("stop", "Close", ButtonStyle.Danger),
            ],
          },
        ];

  return {
    embeds: [embed],
    components,
  };
}

/** Modal opened by the board's Hand back… button. */
export function renderHandBackModal(browserId: string, options: string[] = []): Record<string, unknown> | null {
  const customId = buildBrowserCustomId(browserId, "handback-submit");
  if (!customId) return null;
  const choices = (options.length ? options : DEFAULT_HANDBACK_OPTIONS).join(", ");
  return {
    custom_id: customId,
    title: "Hand the browser back",
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            custom_id: "choice",
            label: "Outcome (optional)",
            style: TextInputStyle.Short,
            required: false,
            max_length: HANDBACK_CHOICE_MAX,
            placeholder: oneLine(`e.g. ${choices}`, 100),
          },
        ],
      },
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            custom_id: "note",
            label: "Note for the agent (optional)",
            style: TextInputStyle.Paragraph,
            required: false,
            max_length: HANDBACK_NOTE_MAX,
          },
        ],
      },
    ],
  };
}

export function boardViewOf(session: BrowserSession): BrowserBoardView {
  const last = session.lastAction;
  return {
    browserId: session.id,
    url: session.url,
    title: session.title,
    state: session.state,
    lastAction: last ? `${last.actor === "agent" ? "🤖" : "🧑"} ${last.kind}${last.detail ? `: ${last.detail}` : ""}` : null,
    actionCount: session.actionCount,
    humanReason: session.humanReason,
    controllerUserId: session.controllerUserId,
    hasShot: session.lastShot !== null,
  };
}

/** Board payload for a live session, with the thumbnail attached. */
export function renderSessionBoard(session: BrowserSession): BrowserBoardPayload {
  const payload = renderBrowserBoard(boardViewOf(session));
  if (session.lastShot && session.state !== "closed") {
    payload.files = [{ attachment: session.lastShot, name: BOARD_SHOT_NAME }];
  }
  // Replace, not accumulate, attachments on every edit.
  payload.attachments = [];
  return payload;
}

/**
 * Post the board through `open` and keep it in sync with the session until it
 * closes. Returns a detach function. Never throws.
 */
export function attachBrowserBoard(
  session: BrowserSession,
  open: (payload: unknown) => EditableHandle,
): () => void {
  let handle: EditableHandle;
  try {
    handle = open(renderSessionBoard(session));
  } catch (err) {
    console.error("[browser] could not post board:", err);
    return () => {};
  }
  const refresh = () => {
    try {
      handle.update(renderSessionBoard(session));
    } catch (err) {
      console.error("[browser] board update failed:", err);
    }
  };
  const offs = [session.on("state", refresh), session.on("action", refresh), session.on("meta", refresh)];
  const detach = () => {
    for (const off of offs.splice(0)) off();
  };
  offs.push(
    session.on("closed", () => {
      detach();
      void handle.finalize(renderSessionBoard(session)).catch(() => {});
    }),
  );
  return detach;
}
