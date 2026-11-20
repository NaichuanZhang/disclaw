import { Client, GatewayIntentBits, Partials } from "discord.js";
import { setDiscordClient } from "../agent/tools.js";
import { handleMessage, setMessageClient } from "./messages.js";
import { handleInteraction, slashCommands } from "./commands.js";

// ---------------------------------------------------------------------------
// DM deduplication — raw fallback may fire alongside messageCreate
// ---------------------------------------------------------------------------

const _processedDMIds = new Set<string>();

function markProcessed(id: string): boolean {
  if (_processedDMIds.has(id)) return false;
  _processedDMIds.add(id);
  setTimeout(() => _processedDMIds.delete(id), 60_000);
  return true;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
  });
}

// ---------------------------------------------------------------------------
// Register slash commands
// ---------------------------------------------------------------------------

export async function registerCommands(client: Client): Promise<void> {
  if (!client.application) {
    console.error("[bot] Cannot register commands — client.application is null");
    return;
  }

  try {
    await client.application.commands.set(slashCommands);
    console.log(`[bot] Registered ${slashCommands.length} slash command(s)`);
  } catch (err) {
    console.error("[bot] Failed to register slash commands:", err);
  }
}

// ---------------------------------------------------------------------------
// Start bot
// ---------------------------------------------------------------------------

export async function startBot(client: Client): Promise<void> {
  // Wire up event handlers
  client.on("messageCreate", async (message) => {
    // Fetch partial channel/message if needed (required for DMs in discord.js v14)
    if (message.partial) {
      try {
        await message.fetch();
      } catch (err) {
        console.error("[bot] Failed to fetch partial message:", err);
        return;
      }
    }
    if (message.channel.partial) {
      try {
        await message.channel.fetch();
      } catch (err) {
        console.error("[bot] Failed to fetch partial channel:", err);
        return;
      }
    }

    // Dedup DMs: skip if the raw fallback already claimed this message
    if (message.channel.isDMBased()) {
      if (!markProcessed(message.id)) {
        console.log(`[bot] DM ${message.id} already handled by raw fallback, skipping`);
        return;
      }
    }

    try {
      await handleMessage(message);
    } catch (err) {
      console.error("[bot] Unhandled error in messageCreate:", err);
    }
  });

  // Fallback: handle DMs via raw gateway events.
  // discord.js v14 sometimes fails to emit messageCreate for uncached DM channels.
  client.on("raw", async (packet: any) => {
    if (packet.t !== "MESSAGE_CREATE") return;
    if (packet.d.guild_id) return; // Only DMs (no guild)
    if (packet.d.author?.bot) return;
    if (!markProcessed(packet.d.id)) return; // Already handled by messageCreate

    console.log(`[bot] DM via raw fallback from ${packet.d.author?.username}`);

    try {
      const channel = await client.channels.fetch(packet.d.channel_id);
      if (!channel || !("messages" in channel)) return;

      const msg = await (channel as any).messages.fetch(packet.d.id);
      await handleMessage(msg);
    } catch (err) {
      console.error("[bot] Raw DM fallback error:", err);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      await handleInteraction(interaction);
    } catch (err) {
      console.error("[bot] Unhandled error in interactionCreate:", err);
    }
  });

  // Provide the client reference to modules that need it
  setDiscordClient(client);
  setMessageClient(client);

  // Wait for the client to be ready, then register commands and log status
  return new Promise<void>((resolve, reject) => {
    client.once("ready", async () => {
      console.log(`[bot] Connected as ${client.user?.tag}`);

      const guilds = client.guilds.cache;
      console.log(`[bot] Serving ${guilds.size} guild(s):`);
      for (const [id, guild] of guilds) {
        console.log(`[bot]   - ${guild.name} (${id})`);
      }

      await registerCommands(client);
      resolve();
    });

    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      reject(new Error("DISCORD_BOT_TOKEN is not set"));
      return;
    }

    client.login(token).catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Stop bot
// ---------------------------------------------------------------------------

export async function stopBot(client: Client): Promise<void> {
  console.log("[bot] Shutting down client");
  client.destroy();
}
