// ---------------------------------------------------------------------------
// Subagent board interactions (`sub:` custom ids)
//
// select   -> ephemeral detail panel
// :stop    -> Query.stopTask() on the owning live session
// :steer   -> modal; on submit the text is injected into the session
//
// Authorization mirrors the ask_user components and plain thread replies:
// anyone who can see the thread can already message (and so steer) the
// session, so the board grants nothing a reply wouldn't.
// ---------------------------------------------------------------------------

import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import { findSdkSubagent, steerSdkSubagent, stopSdkSubagent } from "../sdk/session.js";
import {
  parseSubCustomId,
  renderDetail,
  renderSteerModal,
} from "../sdk/subagent-board.js";
import { count } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

type SubInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

const NOT_TRACKED =
  "That subagent is no longer tracked — its session ended or the bot restarted, so this board is read-only now.";

export function isSubagentCustomId(customId: string): boolean {
  return customId.startsWith("sub:");
}

async function replyEphemeral(interaction: SubInteraction, content: string): Promise<void> {
  const payload = { content, ephemeral: true };
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

/** Route one `sub:` interaction. Never throws. */
export async function handleSubagentInteraction(interaction: SubInteraction): Promise<void> {
  try {
    await route(interaction);
  } catch (err) {
    console.error("[bot] subagent interaction failed:", err);
    await replyEphemeral(interaction, "Something went wrong handling that subagent control.").catch(
      () => {},
    );
  }
}

async function route(interaction: SubInteraction): Promise<void> {
  const parsed = parseSubCustomId(interaction.customId);
  if (!parsed) {
    await replyEphemeral(interaction, "That control is not recognised.");
    return;
  }
  const channelId = interaction.channelId;
  if (!channelId) {
    await replyEphemeral(interaction, NOT_TRACKED);
    return;
  }

  if (parsed.kind === "select") {
    const taskId = interaction.isStringSelectMenu() ? interaction.values[0] ?? "" : "";
    const found = taskId ? findSdkSubagent(channelId, taskId) : null;
    if (!found) {
      await replyEphemeral(interaction, NOT_TRACKED);
      return;
    }
    count(P.sdkSubagentDetail);
    const detail = renderDetail(found.task);
    await interaction.reply({ ...detail, ephemeral: true } as never);
    return;
  }

  const { taskId, action } = parsed;
  if (action === "stop") {
    const result = await stopSdkSubagent(channelId, taskId);
    await replyEphemeral(
      interaction,
      result === "stopped"
        ? "⏹️ Asked the subagent to stop. The board updates when it confirms."
        : result === "failed"
          ? "Couldn't stop that subagent — the session refused the request."
          : "That subagent is no longer running.",
    );
    return;
  }

  if (action === "steer") {
    const found = findSdkSubagent(channelId, taskId);
    const modal = found ? renderSteerModal(found.task) : null;
    if (!modal || !interaction.isButton()) {
      await replyEphemeral(interaction, NOT_TRACKED);
      return;
    }
    await interaction.showModal(modal as never);
    return;
  }

  if (!interaction.isModalSubmit()) {
    await replyEphemeral(interaction, "That control is not recognised.");
    return;
  }
  const text = interaction.fields.getTextInputValue("text").trim();
  if (!text) {
    await replyEphemeral(interaction, "Nothing to send — the steer was empty.");
    return;
  }
  const user = interaction.user;
  const ok = steerSdkSubagent(
    channelId,
    taskId,
    text,
    user.id,
    (user as { displayName?: string }).displayName ?? user.username,
  );
  await replyEphemeral(
    interaction,
    ok
      ? "↩️ Steer sent to the session — it will pass it to that subagent."
      : NOT_TRACKED,
  );
}
