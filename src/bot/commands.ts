import {
  type Interaction,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ApplicationCommandData,
  type AutocompleteInteraction,
  ApplicationCommandOptionType,
  EmbedBuilder,
  ChannelType,
} from "discord.js";
import { clearSession, resolveSession } from "../agent/sessions.js";
import { clearThreadHistoryCache } from "./thread-history.js";
import { buildSkillListEmbedDescriptions } from "./skills-list.js";
import { getChannelConfig, setChannelConfig, getDb } from "../db/index.js";
import { getSoul } from "../soul/soul.js";
import { triggerRestart } from "../restart.js";
import { startVoice, stopVoice, isConnected } from "../voice/index.js";
import {
  activePilotChannelIds,
  interruptPilotSession,
  isPilotChannelId,
  cronAgentRuntime,
  pilotConfigChannelId,
  activePilotSessionCount,
  interruptPilotSessionsUnder,
  resetPilotSessionScope,
  stopPilotSessionsUnder,
  stopAllPilotSessions,
} from "../pilot/index.js";
import { abortAllSessions, getActiveSessionInfo } from "../agent/session-lock.js";
import { CAVEMAN_LEVELS, getCavemanLevel } from "../agent/agent.js";
import {
  parseQuestionCustomId,
  resolveQuestionByIndex,
  getLiveQuestionOptions,
} from "../agent/questions.js";
import {
  AUTOCOMPLETE_LIMIT,
  FALLBACK_MODEL_IDS,
  cleanModelName,
  clearSelectedModel,
  describeModelResolution,
  getCachedSelectableModelIds,
  invalidateModelCache,
  listModels,
  rankModelIds,
  resolveModel,
  selectableModelIds,
  setSelectedModel,
  warmModelCache,
} from "../shared/models.js";
import type { SkillService } from "../skills/service.js";
import type { CronService } from "../cron/service.js";
import type { CronJob, CronSchedule, CronPayload, CronDelivery } from "../cron/types.js";

// ---------------------------------------------------------------------------
// Service references (set from index.ts after init)
// ---------------------------------------------------------------------------

let skillService: SkillService | null = null;
let cronService: CronService | null = null;

export function setCommandsSkillService(service: SkillService): void {
  skillService = service;
}

export function setCommandsCronService(service: CronService): void {
  cronService = service;
}

// ---------------------------------------------------------------------------
// Boot timestamp for uptime calculation
// ---------------------------------------------------------------------------

const bootTime = Date.now();

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------

export const slashCommands: ApplicationCommandData[] = [
  {
    name: "ping",
    description: "Show bot health status, latency, and uptime",
  },
  {
    name: "help",
    description: "Show bot capabilities and usage info",
  },
  {
    name: "config",
    description: "Show or edit channel configuration",
    options: [
      {
        name: "show",
        description: "Display current channel configuration",
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: "set-prompt",
        description: "Set the system prompt for this channel",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "prompt",
            description: "The system prompt text",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: "toggle",
        description: "Enable or disable the bot in this channel",
        type: ApplicationCommandOptionType.Subcommand,
      },
    ],
  },
  {
    name: "clear",
    description: "Clear the current session context",
  },
  {
    name: "stop",
    description: "Stop all active processing sessions",
  },
  {
    name: "interrupt",
    description: "Stop the pilot session's current turn, keep its context",
  },
  {
    name: "pilot",
    description: "Turn pilot mode (Claude Agent SDK sessions) on or off here",
    options: [
      {
        name: "state",
        description: "on, off, or status (default: status)",
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: "on", value: "on" },
          { name: "off", value: "off" },
          { name: "status", value: "status" },
        ],
      },
    ],
  },
  {
    name: "soul",
    description: "Show the current soul (personality) content",
  },
  {
    name: "model",
    description: "Show or set the model used for all conversations and cron jobs",
    options: [
      {
        name: "name",
        description: "Model to use (leave empty to show the current selection)",
        type: ApplicationCommandOptionType.String,
        required: false,
        autocomplete: true,
      },
      {
        name: "reset",
        description: "Clear the saved selection and fall back to the default",
        type: ApplicationCommandOptionType.Boolean,
        required: false,
      },
      {
        name: "refresh",
        description: "Re-fetch the model list from the proxy",
        type: ApplicationCommandOptionType.Boolean,
        required: false,
      },
    ],
  },
  {
    name: "restart",
    description: "Restart the bot process",
  },
  {
    name: "caveman",
    description: "Toggle caveman-speak mode (terse replies) for this channel",
    options: [
      {
        name: "level",
        description: "Intensity level, or 'off' to disable (omit to show current status)",
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: [
          { name: "lite", value: "lite" },
          { name: "full", value: "full" },
          { name: "ultra", value: "ultra" },
          { name: "off", value: "off" },
        ],
      },
    ],
  },
  {
    name: "join",
    description: "Join a voice channel to act as a voice assistant",
  },
  {
    name: "leave",
    description: "Leave the current voice channel",
  },
  {
    name: "skills",
    description: "Manage bot skills",
    options: [
      {
        name: "list",
        description: "List installed skills",
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: "add-github",
        description: "Install a skill from a GitHub repository",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "url",
            description: "GitHub repository URL",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: "name",
            description: "Override skill name",
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ],
      },
      {
        name: "add-file",
        description: "Install a skill from an uploaded SKILL.md file",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "file",
            description: "SKILL.md file to upload",
            type: ApplicationCommandOptionType.Attachment,
            required: true,
          },
          {
            name: "name",
            description: "Override skill name",
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ],
      },
      {
        name: "remove",
        description: "Remove an installed skill",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "name",
            description: "Name of the skill to remove",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
    ],
  },
  {
    name: "cron",
    description: "View and manage scheduled cron jobs",
    options: [
      {
        name: "list",
        description: "List all cron jobs",
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: "show",
        description: "Show details for a specific cron job",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "id",
            description: "Job ID",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: "add",
        description: "Add a new cron job",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "name",
            description: "Job name",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: "schedule",
            description: "Cron expression (e.g. '0 9 * * *') or interval (e.g. 'every 30m')",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: "message",
            description: "Agent prompt message to execute on each run",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: "channel",
            description: "Channel to deliver results to (defaults to current)",
            type: ApplicationCommandOptionType.Channel,
            required: false,
          },
          {
            name: "timezone",
            description: "Timezone for cron expression (e.g. America/Los_Angeles)",
            type: ApplicationCommandOptionType.String,
            required: false,
          },
          {
            name: "model",
            description: "Model for this job only (defaults to the global selection)",
            type: ApplicationCommandOptionType.String,
            required: false,
            autocomplete: true,
          },
        ],
      },
      {
        name: "set-model",
        description: "Set or clear the model override for an existing job",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "id",
            description: "Job ID",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: "model",
            description: "Model to use, or 'default' to inherit the global selection",
            type: ApplicationCommandOptionType.String,
            required: true,
            autocomplete: true,
          },
        ],
      },
      {
        name: "remove",
        description: "Remove a cron job",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "id",
            description: "Job ID to remove",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: "enable",
        description: "Enable a disabled cron job",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "id",
            description: "Job ID to enable",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: "disable",
        description: "Disable a cron job",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "id",
            description: "Job ID to disable",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: "run",
        description: "Force-run a cron job immediately",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "id",
            description: "Job ID to run",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
      {
        name: "history",
        description: "Show recent run history for a cron job",
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: "id",
            description: "Job ID",
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: "limit",
            description: "Number of entries to show (default 10)",
            type: ApplicationCommandOptionType.Integer,
            required: false,
          },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Interaction handler
// ---------------------------------------------------------------------------

export async function handleInteraction(interaction: Interaction): Promise<void> {
  // Autocomplete first — it is the only latency-bound interaction type
  // (Discord allows a single response within ~3s and has no defer equivalent).
  if (interaction.isAutocomplete()) {
    await handleAutocomplete(interaction);
    return;
  }

  // Handle button / select menu interactions
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    // ask_user answers: customId is `q:<questionId>:<optionIndex|select>`
    const parsed = parseQuestionCustomId(interaction.customId);
    if (parsed) {
      await handleQuestionAnswer(interaction, parsed.questionId, parsed.optionIndex);
      return;
    }
    await interaction.reply({ content: "Interaction received.", ephemeral: true });
    return;
  }

  // Only handle slash commands from here
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    switch (commandName) {
      case "ping":
        await handlePing(interaction);
        break;
      case "help":
        await handleHelp(interaction);
        break;
      case "config":
        await handleConfig(interaction);
        break;
      case "clear":
        await handleClear(interaction);
        break;
      case "stop":
        await handleStop(interaction);
        break;
      case "interrupt":
        await handleInterrupt(interaction);
        break;
      case "pilot":
        await handlePilot(interaction);
        break;
      case "soul":
        await handleSoul(interaction);
        break;
      case "model":
        await handleModel(interaction);
        break;
      case "skills":
        await handleSkills(interaction);
        break;
      case "cron":
        await handleCron(interaction);
        break;
      case "join":
        await handleJoin(interaction);
        break;
      case "leave":
        await handleLeave(interaction);
        break;
      case "restart": {
        const livePilots = activePilotSessionCount();
        await interaction.reply({
          content:
            livePilots > 0
              ? `Restarting... (stopping ${livePilots} pilot session(s) first — their context is resumed after the restart)`
              : "Restarting...",
          ephemeral: true,
        });
        triggerRestart();
        break;
      }
      case "caveman":
        await handleCaveman(interaction);
        break;
      default:
        await interaction.reply({
          content: `Unknown command: \`/${commandName}\``,
          ephemeral: true,
        });
    }
  } catch (err) {
    console.error(`[bot] Error handling /${commandName}:`, err);
    const content = "Sorry, something went wrong processing that command.";
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

/**
 * Route autocomplete requests. Always responds — Discord leaves the dropdown
 * stuck on "loading options" if a request goes unanswered.
 */
async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  try {
    const focused = interaction.options.getFocused(true);
    const wantsModel =
      (interaction.commandName === "model" && focused.name === "name") ||
      (interaction.commandName === "cron" && focused.name === "model");

    if (wantsModel) {
      await respondWithModelChoices(interaction, focused.value);
      return;
    }

    await interaction.respond([]);
  } catch (err) {
    console.error("[bot] Autocomplete failed:", err);
    if (!interaction.responded) {
      await interaction.respond([]).catch(() => {});
    }
  }
}

/**
 * Offer model choices from the cached catalog only.
 *
 * This path never awaits the network: autocomplete must answer within ~3s and
 * the catalog fetch timeout alone is 5s. A cold cache falls back to the
 * built-in list and triggers a background warm so the next keystroke is live.
 */
async function respondWithModelChoices(
  interaction: AutocompleteInteraction,
  query: string,
): Promise<void> {
  const cached = getCachedSelectableModelIds();
  if (!cached) warmModelCache();

  const current = resolveModel();
  const choices = rankModelIds(cached ?? FALLBACK_MODEL_IDS, query);

  await interaction.respond(
    choices.map((id) => ({
      name: id === current ? `● ${id}` : id,
      value: id,
    })),
  );
}

// ---------------------------------------------------------------------------
// /model
// ---------------------------------------------------------------------------

/** Option values meaning "no explicit model — inherit whatever is configured". */
const INHERIT_MODEL_VALUES = new Set([
  "default",
  "auto",
  "inherit",
  "global",
  "none",
  "clear",
  "reset",
]);

type ModelOptionResult =
  | { ok: true; model?: string; warning?: string }
  | { ok: false; error: string };

/**
 * Validate a user-supplied model id against the proxy catalog.
 *
 * `model: undefined` means the sentinel was used and the caller should clear
 * whatever override it manages. Awaits the catalog, so callers must already
 * have deferred the interaction.
 */
async function validateModelOption(raw: string): Promise<ModelOptionResult> {
  const cleaned = cleanModelName(raw);
  if (!cleaned || INHERIT_MODEL_VALUES.has(cleaned.toLowerCase())) {
    return { ok: true, model: undefined };
  }

  const list = await listModels();
  if (list.models.some((m) => m.id === cleaned)) {
    return { ok: true, model: cleaned };
  }

  // Proxy unreachable — accept rather than block a legitimate id, but say so.
  if (list.source === "fallback") {
    return {
      ok: true,
      model: cleaned,
      warning: "the proxy was unreachable so this could not be verified",
    };
  }

  const suggestions = rankModelIds(selectableModelIds(list), cleaned).slice(0, 8);
  const hint = suggestions.length
    ? `\n\nClosest matches:\n${suggestions.map((s) => `• \`${s}\``).join("\n")}`
    : "\n\nRun `/model` to see what is available.";
  return { ok: false, error: `❌ \`${cleaned}\` is not a model this proxy offers.${hint}` };
}

function describeSource(source: string): string {
  switch (source) {
    case "override":
      return "Per-job override";
    case "config":
      return "Saved selection";
    case "env":
      return "`ANTHROPIC_MODEL` env";
    default:
      return "Built-in default";
  }
}

async function handleModel(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  // The set/show paths await the catalog, which can exceed the 3s ack deadline.
  await interaction.deferReply({ ephemeral: true });

  const name = interaction.options.getString("name");
  const reset = interaction.options.getBoolean("reset") ?? false;
  const refresh = interaction.options.getBoolean("refresh") ?? false;

  if (reset) {
    clearSelectedModel();
    const after = describeModelResolution();
    await interaction.editReply({
      content:
        `✅ Cleared the saved selection. Now using \`${after.model}\` ` +
        `(${describeSource(after.source).toLowerCase()}).`,
    });
    return;
  }

  if (refresh) invalidateModelCache();

  const list = await listModels({ force: refresh });

  if (name) {
    const result = await validateModelOption(name);
    if (!result.ok) {
      await interaction.editReply({ content: result.error });
      return;
    }

    // Sentinel value (`default`, `auto`, …) — same effect as reset:true.
    if (!result.model) {
      clearSelectedModel();
      const after = describeModelResolution();
      await interaction.editReply({
        content:
          `✅ Cleared the saved selection. Now using \`${after.model}\` ` +
          `(${describeSource(after.source).toLowerCase()}).`,
      });
      return;
    }

    setSelectedModel(result.model);
    await interaction.editReply({
      content:
        `${result.warning ? "⚠️" : "✅"} Model set to \`${result.model}\` for all channels, ` +
        `threads, and DMs${result.warning ? ` — ${result.warning}` : ""}.\n` +
        `-# Takes effect on the next message — replies already in flight keep the previous model. ` +
        `A running pilot session keeps its model until it restarts (\`/clear\` in the channel forces that). ` +
        `Voice and the cycling coach are configured separately.`,
    });
    return;
  }

  // No arguments — report the current resolution.
  const resolution = describeModelResolution();
  const selectable = selectableModelIds(list);
  const active = list.models.find((m) => m.id === resolution.model);
  const envUnknown =
    resolution.env && list.source !== "fallback" && !list.models.some((m) => m.id === resolution.env);

  const availability =
    list.source === "fallback"
      ? `⚠️ Proxy unreachable — showing ${selectable.length} built-in fallback models`
      : `${selectable.length} selectable · ${list.models.length} total from proxy`;

  const embed = new EmbedBuilder()
    .setTitle("🧠 Model")
    .addFields(
      { name: "Active", value: `\`${resolution.model}\``, inline: true },
      { name: "Source", value: describeSource(resolution.source), inline: true },
      {
        name: "Saved selection",
        value: resolution.saved ? `\`${resolution.saved}\`` : "_Not set_",
        inline: false,
      },
      {
        name: "Env `ANTHROPIC_MODEL`",
        value: resolution.env
          ? `${envUnknown ? "⚠️ " : ""}\`${resolution.env}\`${envUnknown ? " — not offered by the proxy" : ""}`
          : "_Not set_",
        inline: false,
      },
      { name: "Available", value: availability, inline: false },
    )
    .setColor(resolution.healed || envUnknown ? 0xfee75c : 0x5865f2)
    .setFooter({
      text: "/model name:<model> to change · applies to every channel, thread, and DM",
    });

  if (active?.maxInputTokens) {
    embed.addFields({
      name: "Context window",
      value: `${active.maxInputTokens.toLocaleString()} in / ${
        active.maxOutputTokens?.toLocaleString() ?? "?"
      } out`,
      inline: false,
    });
  }

  if (resolution.healed) {
    embed.setDescription(
      `⚠️ The configured model is not offered by the proxy — falling back to \`${resolution.model}\`.`,
    );
  }

  await interaction.editReply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// /join
// ---------------------------------------------------------------------------

async function handleJoin(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  // Must be in a guild
  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  // Check if already connected
  if (isConnected()) {
    await interaction.reply({
      content: "I'm already in a voice channel. Use `/leave` first.",
      ephemeral: true,
    });
    return;
  }

  // Find the user's voice channel
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    await interaction.reply({
      content: "You need to be in a voice channel first!",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    await startVoice(voiceChannel);
    await interaction.editReply({
      content: `🎙️ Joined **${voiceChannel.name}**! I'm listening.`,
    });
  } catch (err) {
    await interaction.editReply({
      content: `Failed to join voice channel: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// /leave
// ---------------------------------------------------------------------------

async function handleLeave(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  if (!isConnected()) {
    await interaction.reply({
      content: "I'm not in a voice channel.",
      ephemeral: true,
    });
    return;
  }

  stopVoice();

  await interaction.reply({
    content: "👋 Left the voice channel.",
    ephemeral: true,
  });
}

// ---------------------------------------------------------------------------
// /ping
// ---------------------------------------------------------------------------

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

async function handlePing(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  const client = interaction.client;

  // WebSocket heartbeat latency
  const wsLatency = client.ws.ping;

  // Uptime
  const uptime = Date.now() - bootTime;

  // Health checks
  const dbOk = (() => {
    try {
      getDb().prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  })();

  const discordOk = client.ws.status === 0;
  const allHealthy = dbOk && discordOk;

  const statusEmoji = allHealthy ? "🟢" : "🔴";
  const statusText = allHealthy ? "All systems operational" : "Degraded";

  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji} Bot Status`)
    .addFields(
      {
        name: "Latency",
        value: `🏓 **${wsLatency}ms** (WebSocket)`,
        inline: true,
      },
      {
        name: "Uptime",
        value: `⏱️ ${formatUptime(uptime)}`,
        inline: true,
      },
      {
        name: "Health",
        value: [
          `${dbOk ? "✅" : "❌"} Database`,
          `${discordOk ? "✅" : "❌"} Discord Gateway`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "Status",
        value: statusText,
        inline: false,
      },
      ...(activePilotSessionCount() > 0
        ? [
            {
              name: "Pilot",
              value: `🧪 ${activePilotSessionCount()} live session(s)`,
              inline: false,
            },
          ]
        : []),
    )
    .setColor(allHealthy ? 0x57f287 : 0xed4245)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

async function handleHelp(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("Discordclaw Bot")
    .setDescription("An AI-powered Discord assistant built with Claude.")
    .addFields(
      {
        name: "Talking to the bot",
        value:
          "Mention me in a channel or send me a DM. I will respond using conversation context and memory.",
      },
      {
        name: "Commands",
        value: [
          "`/ping` — Show bot health status",
          "`/help` — Show this message",
          "`/config show` — View channel configuration",
          "`/config set-prompt <prompt>` — Set a channel system prompt",
          "`/config toggle` — Enable/disable bot in this channel",
          "`/clear` — Clear the current session (in a pilot channel: reset the pilot session)",
          "`/stop` — Stop all active processing sessions",
          "`/interrupt` — Interrupt this channel's pilot turn (keeps context)",
          "`/pilot on|off|status` — Toggle pilot mode (Claude Agent SDK) here",
          "`/soul` — Show the bot personality",
          "`/model` — Show the active model",
          "`/model name:<model>` — Switch models (persists across restarts; pilot sessions pick it up on their next session)",
          "`/join` — Join your voice channel as a voice assistant",
          "`/leave` — Leave the voice channel",
          "`/skills list` — List installed skills",
          "`/skills add-github <url>` — Install skill from GitHub",
          "`/skills add-file <file>` — Install skill from upload",
          "`/skills remove <name>` — Remove a skill",
          "`/cron list` — List cron jobs",
          "`/cron show <id>` — Show job details",
          "`/cron add` — Create a new cron job",
          "`/cron remove <id>` — Delete a cron job",
          "`/cron enable/disable <id>` — Toggle a job",
          "`/cron run <id>` — Force-run a job now",
          "`/cron history <id>` — View run history",
          "`/cron set-model <id> <model>` — Override the model for one job",
          "`/caveman` — Show caveman-speak status for this channel",
          "`/caveman level:<lite|full|ultra|off>` — Toggle terse caveman-speak mode",
          "`/restart` — Restart the bot process",
        ].join("\n"),
      },
      {
        name: "Features",
        value:
          "Persistent memory, per-channel configuration, conversation sessions, tool use, scheduled tasks, and voice assistant.",
      },
    )
    .setColor(0x5865f2);

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ---------------------------------------------------------------------------
// /config
// ---------------------------------------------------------------------------

async function handleConfig(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const channelId = interaction.channelId;

  switch (subcommand) {
    case "show": {
      const config = getChannelConfig(channelId);

      const embed = new EmbedBuilder()
        .setTitle("Channel Configuration")
        .addFields(
          {
            name: "Channel",
            value: `<#${channelId}>`,
            inline: true,
          },
          {
            name: "Enabled",
            value: config ? (config.enabled ? "Yes" : "No") : "Yes (default)",
            inline: true,
          },
          {
            name: "System Prompt",
            value: config?.systemPrompt || "_Not set_",
          },
          {
            name: "Runtime",
            value: isPilotChannelId(channelId)
              ? "🧪 Pilot (Claude Agent SDK) — the system prompt above is applied when a session starts"
              : "Main agent",
            inline: true,
          },
        )
        .setColor(0x5865f2);

      await interaction.reply({ embeds: [embed], ephemeral: true });
      break;
    }

    case "set-prompt": {
      const prompt = interaction.options.getString("prompt", true);

      setChannelConfig(channelId, {
        guildId: interaction.guildId ?? undefined,
        systemPrompt: prompt,
      });

      await interaction.reply({
        content: "Channel system prompt updated." + pilotPromptNote(channelId),
        ephemeral: true,
      });
      console.log(`[bot] System prompt set for channel ${channelId}`);
      break;
    }

    case "toggle": {
      const existing = getChannelConfig(channelId);
      const newEnabled = existing ? !existing.enabled : false;

      setChannelConfig(channelId, {
        guildId: interaction.guildId ?? undefined,
        enabled: newEnabled,
      });

      await interaction.reply({
        content: `Bot is now **${newEnabled ? "enabled" : "disabled"}** in this channel.`,
        ephemeral: true,
      });
      console.log(`[bot] Channel ${channelId} toggled to enabled=${newEnabled}`);
      break;
    }

    default:
      await interaction.reply({
        content: "Unknown config subcommand.",
        ephemeral: true,
      });
  }
}

// ---------------------------------------------------------------------------
// /clear
// ---------------------------------------------------------------------------

async function handleClear(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  const isDM = !interaction.guildId;
  const isThread =
    interaction.channel &&
    "isThread" in interaction.channel &&
    typeof interaction.channel.isThread === "function"
      ? interaction.channel.isThread()
      : false;

  // In a pilot channel, our own conversation rows are not the context the model
  // reads — the SDK session holds it inside the CLI. Clearing rows there looked
  // like it worked and changed nothing, so /clear resets the pilot session
  // instead: stop it and forget the stored resume id.
  const pilotConfigId = pilotConfigChannelId({
    channelId: interaction.channelId,
    isDM,
    isThread,
    parentId:
      interaction.channel && "parentId" in interaction.channel
        ? interaction.channel.parentId
        : null,
  });
  if (pilotConfigId && isPilotChannelId(pilotConfigId)) {
    // Scope, not one channel: sessions are keyed to threads, so /clear in the
    // parent channel used to report success while every thread session kept
    // its context. This resets the channel and the threads under it.
    const { stopped } = await resetPilotSessionScope(interaction.channelId);
    await interaction.reply({
      content:
        stopped > 0
          ? `Stopped ${stopped} pilot session(s) and dropped their context. The next message starts fresh.`
          : "No live pilot session here — cleared the stored session id, so the next message starts fresh.",
      ephemeral: true,
    });
    console.log(
      `[bot] Pilot session ${interaction.channelId} reset by ${interaction.user.tag}`,
    );
    return;
  }

  const session = resolveSession({
    threadId: isThread && interaction.channel ? interaction.channel.id : undefined,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    guildId: interaction.guildId ?? undefined,
    isDM,
  });

  clearSession(session.id);
  if (isThread && interaction.channel) {
    // Also forget the thread history cache, otherwise the cached/stored
    // messages would be replayed on the next turn in this thread.
    clearThreadHistoryCache(interaction.channel.id);
  }

  await interaction.reply({
    content: "Session cleared. I have forgotten our conversation context.",
    ephemeral: true,
  });
  console.log(`[bot] Session ${session.id} cleared by ${interaction.user.tag}`);
}

// ---------------------------------------------------------------------------
// /stop
// ---------------------------------------------------------------------------

async function handleStop(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  const activeSessions = getActiveSessionInfo();
  const pilotChannels = activePilotChannelIds();

  if (activeSessions.length === 0 && pilotChannels.length === 0) {
    await interaction.reply({
      content: "No active sessions to stop.",
      ephemeral: true,
    });
    return;
  }

  const count = abortAllSessions();
  // Pilot sessions are SDK child processes — aborting kills the child and,
  // with it, any shell commands it spawned.
  const pilotCount = await stopAllPilotSessions();

  const lines = activeSessions.map(
    (s) => `\`${s.sessionId}\`${s.queueLength > 0 ? ` (+${s.queueLength} queued)` : ""}`,
  );
  for (const channelId of pilotChannels) {
    lines.push(`\`pilot:${channelId}\``);
  }

  await interaction.reply({
    content: `🛑 Stopped **${count + pilotCount}** active session(s):\n${lines.join("\n")}`,
    ephemeral: true,
  });
  console.log(`[bot] ${count} session(s) stopped by ${interaction.user.tag}`);
}

// ---------------------------------------------------------------------------
// /interrupt
//
// Unlike /stop (global, kills sessions) this is scoped to the channel or
// thread it is used in, and keeps the pilot session and its context alive.
// ---------------------------------------------------------------------------

async function handleInterrupt(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  const channelId = interaction.channelId;
  let result = await interruptPilotSession(channelId);

  if (!result) {
    // Sessions are keyed to threads. Used in the parent pilot channel this
    // command used to answer "no active session" while a turn was streaming one
    // level down, so fall back to the sessions this channel owns.
    const under = await interruptPilotSessionsUnder(channelId);
    if (under.length > 1) {
      const ok = under.filter((entry) => entry.result.ok).length;
      const dropped = under.reduce((sum, e) => sum + e.result.dropped, 0);
      await interaction.reply({
        content: `⏹️ Interrupted **${ok}/${under.length}** pilot session(s) in this channel's threads. Dropped **${dropped}** queued message(s).`,
      });
      console.log(
        `[bot] ${under.length} pilot turn(s) under ${channelId} interrupted by ${interaction.user.tag}`,
      );
      return;
    }
    result = under[0]?.result ?? null;
  }

  if (!result) {
    await interaction.reply({
      content: "No active pilot session here.",
      ephemeral: true,
    });
    return;
  }

  const was = result.lastTool ? ` (was **${result.lastTool}**)` : "";

  if (!result.ok) {
    await interaction.reply({
      content: `⚠️ Interrupt failed${was}. Dropped **${result.dropped}** queued message(s).`,
      ephemeral: true,
    });
    return;
  }

  const extra =
    result.stillQueued.length > 0
      ? ` **${result.stillQueued.length}** message(s) already handed to the CLI will still run.`
      : "";
  await interaction.reply({
    content: `⏹️ Interrupted mid-run${was}. Dropped **${result.dropped}** queued message(s).${extra}`,
  });
  console.log(
    `[bot] pilot turn in ${channelId} interrupted by ${interaction.user.tag}`,
  );
}

// ---------------------------------------------------------------------------
// /pilot
//
// Pilot mode is data (`channel_configs.settings.pilot`), so this command only
// flips a flag — but it was previously a manual DB edit, which made an
// experimental runtime awkward to turn off in a hurry.
// ---------------------------------------------------------------------------

/**
 * Suffix for settings that a pilot session only reads when it starts.
 *
 * A pilot child's system prompt is fixed for its lifetime, so a caveman level or
 * channel prompt changed mid-session applies from the next one. Empty for
 * non-pilot channels, so ordinary replies are unchanged.
 */
/**
 * Suffix for skill changes, which a pilot session only sees in its start-up prompt.
 *
 * Skills are global, so this is keyed on live sessions rather than the invoking
 * channel — and stays empty when none are running.
 */
function pilotSkillsNote(): string {
  const live = activePilotSessionCount();
  return live > 0
    ? `\n-# 🧪 ${live} running pilot session(s) keep the skill list they started with — \`/clear\` in the pilot channel to reload.`
    : "";
}

function pilotPromptNote(channelId: string): string {
  return isPilotChannelId(channelId)
    ? "\n-# 🧪 Pilot channel: a running session keeps the prompt it started with — `/clear` here to apply it now."
    : "";
}

async function handlePilot(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  const state = interaction.options.getString("state") ?? "status";

  if (!interaction.guildId) {
    await interaction.reply({
      content: "Pilot mode is per guild channel — DMs always use the main agent.",
      ephemeral: true,
    });
    return;
  }

  const isThread =
    interaction.channel &&
    "isThread" in interaction.channel &&
    typeof interaction.channel.isThread === "function"
      ? interaction.channel.isThread()
      : false;

  // Threads inherit the flag from their parent, so that is the row to write.
  const configId = pilotConfigChannelId({
    channelId: interaction.channelId,
    isDM: false,
    isThread,
    parentId:
      interaction.channel && "parentId" in interaction.channel
        ? interaction.channel.parentId
        : null,
  });

  if (!configId) {
    await interaction.reply({
      content: "Can't work out which channel owns pilot mode here.",
      ephemeral: true,
    });
    return;
  }

  const enabled = isPilotChannelId(configId);
  const scope = configId === interaction.channelId ? "this channel" : `<#${configId}>`;

  if (state === "status") {
    await interaction.reply({
      content: enabled
        ? `🧪 Pilot mode is **on** for ${scope} (${activePilotChannelIds().length} live session(s) bot-wide).`
        : `Pilot mode is **off** for ${scope} — messages go to the main agent.`,
      ephemeral: true,
    });
    return;
  }

  const turnOn = state === "on";
  const existing = getChannelConfig(configId);
  setChannelConfig(configId, {
    settings: { ...(existing?.settings ?? {}), pilot: turnOn },
  });

  // Turning it off should also end whatever is running, or the old runtime
  // keeps answering in this thread until it idles out.
  // Sessions are keyed to threads, so stopping only `interaction.channelId`
  // left every thread session of a parent channel running until the idle reaper.
  let stopped = 0;
  if (!turnOn) {
    stopped = await stopPilotSessionsUnder(interaction.channelId);
    if (interaction.channelId !== configId) {
      stopped += await stopPilotSessionsUnder(configId);
    }
  }

  await interaction.reply({
    content: turnOn
      ? `🧪 Pilot mode **on** for ${scope}. New messages open a Claude Agent SDK session per thread.`
      : `Pilot mode **off** for ${scope}.${stopped ? ` Stopped ${stopped} live session(s).` : ""} Messages go back to the main agent.`,
    ephemeral: true,
  });
  console.log(
    `[bot] Pilot mode ${turnOn ? "enabled" : "disabled"} for ${configId} by ${interaction.user.tag}`,
  );
}

// ---------------------------------------------------------------------------
// /skills
// ---------------------------------------------------------------------------

async function handleSkills(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  if (!skillService) {
    await interaction.reply({
      content: "Skills service is not available.",
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "list": {
      const skills = skillService.list();

      if (skills.length === 0) {
        await interaction.reply({
          content: "No skills installed.",
          ephemeral: true,
        });
        return;
      }

      // Descriptions are truncated and chunked so we never exceed Discord's
      // 4096-char embed description limit (see src/bot/skills-list.ts).
      const descriptions = buildSkillListEmbedDescriptions(skills);
      const embeds = descriptions.map((description, i) =>
        new EmbedBuilder()
          .setTitle(
            descriptions.length > 1
              ? `Installed Skills (${i + 1}/${descriptions.length})`
              : "Installed Skills",
          )
          .setDescription(description)
          .setColor(0x5865f2),
      );
      embeds[embeds.length - 1]!.setFooter({
        text: `${skills.length} skill(s)`,
      });

      await interaction.reply({ embeds, ephemeral: true });
      break;
    }

    case "add-github": {
      const url = interaction.options.getString("url", true);
      const name = interaction.options.getString("name") ?? undefined;

      await interaction.deferReply({ ephemeral: true });

      try {
        const skill = await skillService.installFromGitHub({ url, name });
        await interaction.editReply({
          content: `Skill **${skill.name}** installed from GitHub.` + pilotSkillsNote(),
        });
        console.log(`[bot] Skill installed via /skills add-github: ${skill.name}`);
      } catch (err) {
        await interaction.editReply({
          content: `Failed to install skill: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      break;
    }

    case "add-file": {
      const attachment = interaction.options.getAttachment("file", true);
      const name = interaction.options.getString("name") ?? undefined;

      await interaction.deferReply({ ephemeral: true });

      try {
        // Fetch the attachment content
        const response = await fetch(attachment.url);
        if (!response.ok) {
          await interaction.editReply({
            content: `Failed to download attachment: ${response.statusText}`,
          });
          return;
        }
        const content = await response.text();

        const skill = await skillService.installFromUpload({ content, name });
        await interaction.editReply({
          content: `Skill **${skill.name}** installed from upload.` + pilotSkillsNote(),
        });
        console.log(`[bot] Skill installed via /skills add-file: ${skill.name}`);
      } catch (err) {
        await interaction.editReply({
          content: `Failed to install skill: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      break;
    }

    case "remove": {
      const name = interaction.options.getString("name", true);
      const skill = skillService.getByName(name);

      if (!skill) {
        await interaction.reply({
          content: `Skill **${name}** not found.`,
          ephemeral: true,
        });
        return;
      }

      const removed = skillService.remove(skill.id);
      if (!removed) {
        await interaction.reply({
          content: `Failed to remove skill **${name}**.`,
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: `Skill **${name}** removed.` + pilotSkillsNote(),
        ephemeral: true,
      });
      console.log(`[bot] Skill removed via /skills remove: ${name}`);
      break;
    }

    default:
      await interaction.reply({
        content: "Unknown skills subcommand.",
        ephemeral: true,
      });
  }
}

// ---------------------------------------------------------------------------
// /cron
// ---------------------------------------------------------------------------

function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.type) {
    case "at":
      return `Once at <t:${Math.floor(schedule.timestamp / 1000)}:F>`;
    case "every": {
      const ms = schedule.intervalMs;
      if (ms < 60_000) return `Every ${Math.round(ms / 1000)}s`;
      if (ms < 3_600_000) return `Every ${Math.round(ms / 60_000)}m`;
      if (ms < 86_400_000) return `Every ${Math.round(ms / 3_600_000)}h`;
      return `Every ${Math.round(ms / 86_400_000)}d`;
    }
    case "cron":
      return `\`${schedule.expression}\`${schedule.tz ? ` (${schedule.tz})` : ""}`;
    default:
      return "Unknown";
  }
}

function formatPayload(payload: CronPayload): string {
  if (payload.kind === "systemEvent") {
    return `System event: ${payload.text}`;
  }
  if (payload.kind === "agentTurn") {
    const msg = payload.message.length > 100
      ? payload.message.slice(0, 100) + "…"
      : payload.message;
    const model = payload.model ? ` · model: \`${payload.model}\`` : "";
    return `Agent turn: ${msg}${model}`;
  }
  return "Unknown";
}

/** Model a job will run on, distinguishing a per-job override from the global one. */
function formatJobModel(job: CronJob): string {
  if (job.payload.kind !== "agentTurn") return "—";
  return job.payload.model
    ? `\`${job.payload.model}\` (job override)`
    : `\`${resolveModel()}\` (global)`;
}

/**
 * True when this job's run is handed to a Claude Agent SDK session (in a per-run
 * thread) rather than the main agent loop. Every `agentTurn` job is, whatever
 * the delivery channel's pilot flag says, unless the `CRON_RUNTIME=main` escape
 * hatch is set. `systemEvent` jobs never run an agent at all.
 */
function isPilotRoutedJob(job: CronJob): boolean {
  if (job.payload.kind !== "agentTurn") return false;
  return cronAgentRuntime() === "sdk";
}

/**
 * Parse a schedule string from the user into a CronSchedule.
 */
function parseScheduleInput(input: string, tz?: string): CronSchedule {
  const everyMatch = input.match(/^every\s+(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days)$/i);
  if (everyMatch) {
    const value = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2].toLowerCase();
    let ms: number;
    if (unit.startsWith("s")) ms = value * 1000;
    else if (unit.startsWith("m")) ms = value * 60_000;
    else if (unit.startsWith("h")) ms = value * 3_600_000;
    else ms = value * 86_400_000;
    return { type: "every", intervalMs: ms };
  }

  // Otherwise treat as cron expression
  return { type: "cron", expression: input.trim(), tz };
}

async function handleCron(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  if (!cronService) {
    await interaction.reply({
      content: "Cron service is not available.",
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "list": {
      const jobs = cronService.list();

      if (jobs.length === 0) {
        await interaction.reply({
          content: "No cron jobs configured.",
          ephemeral: true,
        });
        return;
      }

      const lines = jobs.map((job) => {
        const status = job.enabled ? "🟢" : "🔴";
        const schedule = formatSchedule(job.schedule);
        const nextRun = job.state.nextRunAtMs
          ? `<t:${Math.floor(job.state.nextRunAtMs / 1000)}:R>`
          : "—";
        // Only annotate overrides, so jobs on the global model render unchanged.
        const model =
          job.payload.kind === "agentTurn" && job.payload.model
            ? ` · Model: \`${job.payload.model}\``
            : "";
        const pilot = isPilotRoutedJob(job) ? " · 🧪 pilot" : "";
        return `${status} **${job.name}** (\`${job.id}\`)\n  Schedule: ${schedule} · Next: ${nextRun}${model}${pilot}`;
      });

      const embed = new EmbedBuilder()
        .setTitle("⏰ Cron Jobs")
        .setDescription(lines.join("\n\n"))
        .setFooter({ text: `${jobs.length} job(s)` })
        .setColor(0x5865f2);

      await interaction.reply({ embeds: [embed], ephemeral: true });
      break;
    }

    case "show": {
      const id = interaction.options.getString("id", true);
      const job = cronService.get(id);

      if (!job) {
        await interaction.reply({
          content: `Job \`${id}\` not found.`,
          ephemeral: true,
        });
        return;
      }

      const embed = buildJobDetailEmbed(job);
      await interaction.reply({ embeds: [embed], ephemeral: true });
      break;
    }

    case "add": {
      const name = interaction.options.getString("name", true);
      const scheduleInput = interaction.options.getString("schedule", true);
      const message = interaction.options.getString("message", true);
      const channel = interaction.options.getChannel("channel");
      const timezone = interaction.options.getString("timezone") ?? undefined;
      const modelInput = interaction.options.getString("model");

      const deliveryChannelId = channel?.id ?? interaction.channelId;

      // Validating the model awaits the catalog, which can outlast the 3s
      // ack deadline, so defer before doing any of it.
      await interaction.deferReply({ ephemeral: true });

      let schedule: CronSchedule;
      try {
        schedule = parseScheduleInput(scheduleInput, timezone);
      } catch {
        await interaction.editReply({
          content: `Invalid schedule: \`${scheduleInput}\`. Use a cron expression or \`every <N>m/h/d\`.`,
        });
        return;
      }

      let model: string | undefined;
      let modelWarning: string | undefined;
      if (modelInput) {
        const result = await validateModelOption(modelInput);
        if (!result.ok) {
          await interaction.editReply({ content: result.error });
          return;
        }
        model = result.model;
        modelWarning = result.warning;
      }

      const payload: CronPayload = { kind: "agentTurn", message, model };
      const delivery: CronDelivery = {
        channelId: deliveryChannelId,
        mentionUser: interaction.user.id,
      };

      const job = cronService.add({
        name,
        enabled: true,
        schedule,
        payload,
        delivery,
      });

      const nextRun = job.state.nextRunAtMs
        ? `<t:${Math.floor(job.state.nextRunAtMs / 1000)}:R>`
        : "not scheduled";

      const modelNote = model
        ? `\nModel: \`${model}\`${modelWarning ? ` (⚠️ ${modelWarning})` : ""}`
        : "";

      const pilotNote = isPilotRoutedJob(job)
        ? "\n-# 🧪 Runs on a Claude Agent SDK session — each run gets its own thread and session."
        : "";

      await interaction.editReply({
        content: `✅ Cron job **${name}** created (\`${job.id}\`). Next run: ${nextRun}${modelNote}${pilotNote}`,
      });
      console.log(`[bot] Cron job created via /cron add: "${name}" (${job.id})`);
      break;
    }

    case "set-model": {
      const id = interaction.options.getString("id", true);
      const modelInput = interaction.options.getString("model", true);
      const job = cronService.get(id);

      if (!job) {
        await interaction.reply({ content: `Job \`${id}\` not found.`, ephemeral: true });
        return;
      }

      if (job.payload.kind !== "agentTurn") {
        await interaction.reply({
          content: `Job **${job.name}** is a \`${job.payload.kind}\` job — only agent-turn jobs run a model.`,
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const result = await validateModelOption(modelInput);
      if (!result.ok) {
        await interaction.editReply({ content: result.error });
        return;
      }

      // The store shallow-merges patches at the top level, so the whole
      // payload has to be spread — patching `payload` replaces it outright.
      const updated = cronService.update(id, {
        payload: { ...job.payload, model: result.model },
      });

      if (!updated) {
        await interaction.editReply({ content: `Failed to update job \`${id}\`.` });
        return;
      }

      const setModelPilotNote = isPilotRoutedJob(job)
        ? "\n-# 🧪 This job routes to a pilot session, which starts on this model."
        : "";

      await interaction.editReply({
        content:
          (result.model
            ? `${result.warning ? "⚠️" : "✅"} Job **${job.name}** will now run on \`${result.model}\`` +
              `${result.warning ? ` — ${result.warning}` : ""}.`
            : `✅ Job **${job.name}** now inherits the global model (\`${resolveModel()}\`).`) +
          setModelPilotNote,
      });
      console.log(
        `[bot] Cron job model set via /cron set-model: "${job.name}" (${id}) → ${result.model ?? "inherit"}`,
      );
      break;
    }

    case "remove": {
      const id = interaction.options.getString("id", true);
      const job = cronService.get(id);

      if (!job) {
        await interaction.reply({
          content: `Job \`${id}\` not found.`,
          ephemeral: true,
        });
        return;
      }

      const removed = cronService.remove(id);
      await interaction.reply({
        content: removed
          ? `🗑️ Job **${job.name}** (\`${id}\`) removed.`
          : `Failed to remove job \`${id}\`.`,
        ephemeral: true,
      });
      if (removed) {
        console.log(`[bot] Cron job removed via /cron remove: "${job.name}" (${id})`);
      }
      break;
    }

    case "enable": {
      const id = interaction.options.getString("id", true);
      const job = cronService.update(id, { enabled: true });

      if (!job) {
        await interaction.reply({
          content: `Job \`${id}\` not found.`,
          ephemeral: true,
        });
        return;
      }

      const nextRun = job.state.nextRunAtMs
        ? `<t:${Math.floor(job.state.nextRunAtMs / 1000)}:R>`
        : "not scheduled";

      await interaction.reply({
        content: `🟢 Job **${job.name}** enabled. Next run: ${nextRun}`,
        ephemeral: true,
      });
      console.log(`[bot] Cron job enabled via /cron enable: "${job.name}" (${id})`);
      break;
    }

    case "disable": {
      const id = interaction.options.getString("id", true);
      const job = cronService.update(id, { enabled: false });

      if (!job) {
        await interaction.reply({
          content: `Job \`${id}\` not found.`,
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: `🔴 Job **${job.name}** disabled.`,
        ephemeral: true,
      });
      console.log(`[bot] Cron job disabled via /cron disable: "${job.name}" (${id})`);
      break;
    }

    case "run": {
      const id = interaction.options.getString("id", true);
      const job = cronService.get(id);

      if (!job) {
        await interaction.reply({
          content: `Job \`${id}\` not found.`,
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      try {
        await cronService.forceRun(id);
        await interaction.editReply({
          content: `▶️ Job **${job.name}** executed successfully.`,
        });
      } catch (err) {
        await interaction.editReply({
          content: `❌ Job **${job.name}** failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      console.log(`[bot] Cron job force-run via /cron run: "${job.name}" (${id})`);
      break;
    }

    case "history": {
      const id = interaction.options.getString("id", true);
      const limit = interaction.options.getInteger("limit") ?? 10;
      const job = cronService.get(id);

      if (!job) {
        await interaction.reply({
          content: `Job \`${id}\` not found.`,
          ephemeral: true,
        });
        return;
      }

      const runs = cronService.getRunHistory(id, limit);

      if (runs.length === 0) {
        await interaction.reply({
          content: `No run history for job **${job.name}**.`,
          ephemeral: true,
        });
        return;
      }

      const lines = runs.map((run) => {
        const status = run.status === "ok" ? "✅" : run.status === "error" ? "❌" : "⏭️";
        const time = `<t:${Math.floor(run.startedAt / 1000)}:R>`;
        const duration = `${Math.round((run.completedAt - run.startedAt) / 1000)}s`;
        const detail = run.error ? ` — \`${run.error.slice(0, 80)}\`` : "";
        return `${status} ${time} (${duration})${detail}`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`📜 Run History — ${job.name}`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: `Showing ${runs.length} most recent run(s)` })
        .setColor(0x5865f2);

      await interaction.reply({ embeds: [embed], ephemeral: true });
      break;
    }

    default:
      await interaction.reply({
        content: "Unknown cron subcommand.",
        ephemeral: true,
      });
  }
}

function buildJobDetailEmbed(job: CronJob): EmbedBuilder {
  const status = job.enabled ? "🟢 Enabled" : "🔴 Disabled";
  const schedule = formatSchedule(job.schedule);
  const payload = formatPayload(job.payload);
  const nextRun = job.state.nextRunAtMs
    ? `<t:${Math.floor(job.state.nextRunAtMs / 1000)}:F> (<t:${Math.floor(job.state.nextRunAtMs / 1000)}:R>)`
    : "—";
  const lastRun = job.state.lastRunAtMs
    ? `<t:${Math.floor(job.state.lastRunAtMs / 1000)}:R> — ${job.state.lastRunStatus ?? "unknown"}`
    : "Never";
  const delivery = job.delivery
    ? `<#${job.delivery.channelId}>${job.delivery.mentionUser ? ` (mention <@${job.delivery.mentionUser}>)` : ""}`
    : "None";

  const fields = [
    { name: "Status", value: status, inline: true },
    { name: "Schedule", value: schedule, inline: true },
    { name: "Next Run", value: nextRun, inline: false },
    { name: "Last Run", value: lastRun, inline: false },
    { name: "Payload", value: payload, inline: false },
    {
      name: "Model",
      value:
        formatJobModel(job) +
        (isPilotRoutedJob(job) ? " · applies to the pilot session this job runs on" : ""),
      inline: false,
    },
    { name: "Delivery", value: delivery, inline: false },
  ];

  if (job.state.lastError) {
    fields.push({
      name: "Last Error",
      value: `\`\`\`${job.state.lastError.slice(0, 200)}\`\`\``,
      inline: false,
    });
  }

  if (job.state.consecutiveErrors && job.state.consecutiveErrors > 0) {
    fields.push({
      name: "Consecutive Errors",
      value: `${job.state.consecutiveErrors}`,
      inline: true,
    });
  }

  return new EmbedBuilder()
    .setTitle(`⏰ ${job.name}`)
    .setDescription(`ID: \`${job.id}\`${job.description ? `\n${job.description}` : ""}`)
    .addFields(fields)
    .setColor(job.enabled ? 0x57f287 : 0xed4245)
    .setFooter({ text: `Created ${new Date(job.createdAt).toISOString()}` });
}

// ---------------------------------------------------------------------------
// /caveman
// ---------------------------------------------------------------------------

async function handleCaveman(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  const channelId = interaction.channelId;
  const level = interaction.options.getString("level");

  if (!level) {
    const config = getChannelConfig(channelId);
    const active = getCavemanLevel(config);
    await interaction.reply({
      content: active
        ? `🪨 Caveman mode **on** in this channel — level \`${active}\`. Use \`/caveman level:off\` to disable.`
        : "Caveman mode is **off** in this channel. Use `/caveman level:<lite|full|ultra>` to enable.",
      ephemeral: true,
    });
    return;
  }

  const existing = getChannelConfig(channelId);
  const settings = { ...(existing?.settings ?? {}) };

  if (level === "off") {
    delete settings.cavemanLevel;
    setChannelConfig(channelId, {
      guildId: interaction.guildId ?? undefined,
      settings,
    });
    await interaction.reply({
      content:
        "🪨 Caveman mode **off** for this channel." + pilotPromptNote(channelId),
      ephemeral: true,
    });
    console.log(`[bot] Caveman mode disabled for channel ${channelId} by ${interaction.user.tag}`);
    return;
  }

  if (!(CAVEMAN_LEVELS as readonly string[]).includes(level)) {
    await interaction.reply({
      content: `Unknown level \`${level}\`. Use lite, full, ultra, or off.`,
      ephemeral: true,
    });
    return;
  }

  settings.cavemanLevel = level;
  setChannelConfig(channelId, {
    guildId: interaction.guildId ?? undefined,
    settings,
  });

  await interaction.reply({
    content:
      `🪨 Caveman mode **on** for this channel — level \`${level}\`. Say "stop caveman" or run \`/caveman level:off\` to disable.` +
      pilotPromptNote(channelId),
    ephemeral: true,
  });
  console.log(`[bot] Caveman mode set to "${level}" for channel ${channelId} by ${interaction.user.tag}`);
}

// ---------------------------------------------------------------------------
// /soul
// ---------------------------------------------------------------------------

async function handleSoul(
  interaction: import("discord.js").ChatInputCommandInteraction,
): Promise<void> {
  const soul = getSoul();

  if (!soul) {
    await interaction.reply({
      content: "No soul content is currently loaded.",
      ephemeral: true,
    });
    return;
  }

  // Truncate if necessary (embed description limit is 4096)
  const display = soul.length > 4000
    ? soul.slice(0, 4000) + "\n\n_...truncated_"
    : soul;

  const embed = new EmbedBuilder()
    .setTitle("Soul")
    .setDescription(display)
    .setColor(0x5865f2);

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ---------------------------------------------------------------------------
// ask_user answers (button / select menu)
// ---------------------------------------------------------------------------

/**
 * Resolve a pending ask_user question from a component interaction.
 * Must ack within 3s, so we update the message in a single call.
 */
async function handleQuestionAnswer(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  questionId: string,
  buttonIndex: number | null,
): Promise<void> {
  const options = getLiveQuestionOptions(questionId);
  if (!options) {
    // No live waiter: answered already, timed out, or lost to a restart.
    await interaction.reply({
      content:
        "That question is no longer waiting for an answer (already answered, timed out, or the bot restarted).",
      ephemeral: true,
    });
    return;
  }

  const index =
    buttonIndex !== null
      ? buttonIndex
      : Number.parseInt(interaction.isStringSelectMenu() ? interaction.values[0] ?? "" : "", 10);

  const answer = Number.isInteger(index)
    ? resolveQuestionByIndex(questionId, index, interaction.isButton() ? "button" : "select")
    : null;

  if (answer === null) {
    await interaction.reply({
      content: "Could not record that answer — please reply with text instead.",
      ephemeral: true,
    });
    return;
  }

  const baseEmbed = interaction.message.embeds[0];
  const updated = baseEmbed
    ? EmbedBuilder.from(baseEmbed).setFooter({
        text: `✅ Answered: ${answer}`.slice(0, 2048),
      })
    : new EmbedBuilder().setDescription(`✅ Answered: ${answer}`);

  await interaction.update({ embeds: [updated], components: [] });
}
