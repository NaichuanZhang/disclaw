// ---------------------------------------------------------------------------
// Browser board interactions (`br:<browserId>:<action>` custom ids)
//
// live      -> mint a 15-minute viewer token bound to the clicking user and
//              reply ephemerally with the gateway URL
// pause / resume / takeover / done -> drive the browser's state machine
// handback  -> modal (choice + note); its submit calls BrowserSession.handBack
// stop      -> close the browser (labelled "Close" on the board)
//
// Authorization mirrors the subagent board: anyone who can see the thread can
// already steer the session, so the board grants nothing a reply wouldn't.
// The viewer link is the exception that matters — it is ephemeral and bound
// to the user who asked for it, because the gateway has no auth of its own.
// ---------------------------------------------------------------------------

import type { ButtonInteraction, ModalSubmitInteraction } from "discord.js";
import { parseBrowserCustomId, renderHandBackModal } from "../browser/board.js";
import { closeBrowser, getBrowser } from "../browser/manager.js";
import { mintViewerToken, VIEWER_TOKEN_TTL_MS } from "../browser/tokens.js";
import { count } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

export { isBrowserCustomId } from "../browser/board.js";

const NOT_TRACKED =
  "That browser is no longer tracked — it was closed, its session ended or the bot restarted, so this board is read-only now.";

/** Public base URL for viewer links. */
export function gatewayBaseUrl(): string {
  const base = process.env.GATEWAY_PUBLIC_URL || `http://localhost:${process.env.GATEWAY_PORT || "3000"}`;
  return base.replace(/\/+$/, "");
}

export function viewerUrl(browserId: string, token: string, base = gatewayBaseUrl()): string {
  return `${base}/browser/${encodeURIComponent(browserId)}?t=${encodeURIComponent(token)}`;
}

function isLocalBase(base: string): boolean {
  try {
    const host = new URL(base).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return true;
  }
}

type BrowserInteraction = ButtonInteraction | ModalSubmitInteraction;

async function replyEphemeral(interaction: BrowserInteraction, content: string): Promise<void> {
  const payload = { content, ephemeral: true };
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

/** Route one `br:` button or modal submit. Never throws. */
export async function handleBrowserInteraction(interaction: BrowserInteraction): Promise<void> {
  try {
    await route(interaction);
  } catch (err) {
    console.error("[bot] browser interaction failed:", err);
    await replyEphemeral(interaction, "Something went wrong handling that browser control.").catch(() => {});
  }
}

async function route(interaction: BrowserInteraction): Promise<void> {
  const parsed = parseBrowserCustomId(interaction.customId);
  if (!parsed) {
    await replyEphemeral(interaction, "That control is not recognised.");
    return;
  }
  const session = getBrowser(parsed.browserId);
  if (!session) {
    await replyEphemeral(interaction, NOT_TRACKED);
    return;
  }
  count(P.browserBoardControl);
  const userId = interaction.user.id;

  switch (parsed.action) {
    case "live": {
      const { token } = mintViewerToken(session.id, userId);
      const base = gatewayBaseUrl();
      const minutes = Math.round(VIEWER_TOKEN_TTL_MS / 60000);
      const warning = isLocalBase(base)
        ? "\n-# ⚠️ This is a localhost URL, so it only opens on the bot's own machine. Set `GATEWAY_PUBLIC_URL` to a reachable address (e.g. a Tailscale name) to use it from elsewhere."
        : "";
      await replyEphemeral(
        interaction,
        `🔗 Live view (private to you, valid ${minutes} min — don't share it): ${viewerUrl(session.id, token, base)}${warning}`,
      );
      return;
    }
    case "pause":
      await replyEphemeral(
        interaction,
        session.setPaused(true, interaction.user.username) ? "⏸️ Paused — the agent's browser actions are refused until you resume." : "Can't pause from the current state.",
      );
      return;
    case "resume":
      await replyEphemeral(
        interaction,
        session.setPaused(false, interaction.user.username) ? "▶️ Resumed." : "The browser is not paused.",
      );
      return;
    case "takeover":
      await replyEphemeral(
        interaction,
        session.takeControl(userId)
          ? "🧑 You have control. Open **Live view** to click and type; press **Hand back…** when you are finished."
          : "Someone already has control.",
      );
      return;
    case "done":
      await replyEphemeral(
        interaction,
        session.humanDone(userId) ? "✅ Handed back to the agent." : "Nothing is waiting on a human right now.",
      );
      return;
    case "handback": {
      const modal = session.state === "human-control" ? renderHandBackModal(session.id, session.handBackOptions) : null;
      if (!modal || !interaction.isButton()) {
        await replyEphemeral(interaction, "Nobody has control of the browser right now, so there is nothing to hand back.");
        return;
      }
      await interaction.showModal(modal as never);
      return;
    }
    case "handback-submit": {
      if (!interaction.isModalSubmit()) {
        await replyEphemeral(interaction, "That control is not recognised.");
        return;
      }
      const choice = interaction.fields.getTextInputValue("choice");
      const note = interaction.fields.getTextInputValue("note");
      const result = session.handBack(userId, { choice: choice || undefined, note: note || undefined });
      await replyEphemeral(
        interaction,
        result.ok
          ? result.delivered === "none"
            ? "✅ Handed back to the agent."
            : "✅ Handed back to the agent with your note."
          : `Not handed back: ${result.error}`,
      );
      return;
    }
    case "stop":
      count(P.browserClose);
      await closeBrowser(session.id, `closed from Discord by ${interaction.user.username}`);
      await replyEphemeral(interaction, "⏹️ Browser closed.");
      return;
  }
}
