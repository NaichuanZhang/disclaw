import "dotenv/config";

import { initDb } from "./db/index.js";
import { expireStalePendingQuestions } from "./agent/questions.js";
import { initSoul, stopSoulWatcher } from "./soul/soul.js";
import { initMemory, stopMemoryWatcher } from "./memory/memory.js";
import { isMem9Enabled } from "./memory/mem9.js";
import { CronService } from "./cron/service.js";
import { SkillService } from "./skills/service.js";
import { processAgentTurn } from "./agent/agent.js";
import { createClient, startBot, stopBot } from "./bot/client.js";
import { setCommandsSkillService, setCommandsCronService } from "./bot/commands.js";
import { startGateway } from "./gateway/server.js";
import { cleanExpiredSessions } from "./agent/sessions.js";
import { setRestartHandler } from "./restart.js";
import { syncDeployedEvolutions, setEvolutionSendToDiscord, setEvolutionCreateThread, checkGhCli } from "./evolution/engine.js";
import { setHealthDiscordClient, setServicesReady } from "./evolution/health.js";
import {
  startReflectionDaemon,
  stopReflectionDaemon,
  setReflectionSendToDiscord,
  setReflectionChannelId,
} from "./reflection/daemon.js";
import { snapshotAllResources } from "./registry/index.js";
import { initVoice, setVoiceDiscordClient, destroyVoice } from "./voice/index.js";
import { enableAutoJoin, disableAutoJoin, excludeFromAutoJoin } from "./voice/autoJoin.js";
import { initVoiceCoach, setVoiceCoachClient, destroyVoiceCoach } from "./voice-coach/index.js";
import { registerBotThread } from "./bot/messages.js";
import { ensureThread, sendChunked } from "./shared/discord-utils.js";
import { SKILLS_DIR, DATA_DIR } from "./shared/paths.js";
import { warmModelCache } from "./shared/models.js";
import { join } from "node:path";

// Admin user ID for DM fallback delivery
const ADMIN_USER_ID = "152801068663832576";

// Voice coach channel ID
const VOICE_COACH_CHANNEL_ID = "1495515183463006431";

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[discordclaw] Starting...");

  // 1. Initialize database
  console.log("[discordclaw] Initializing database...");
  initDb();

  // Any question left pending by the previous process can never be answered
  // into a live agent turn — retire them so stale clicks report cleanly.
  const expiredQuestions = expireStalePendingQuestions();
  if (expiredQuestions > 0) {
    console.log(
      `[discordclaw] Expired ${expiredQuestions} pending ask_user question(s) from previous run`,
    );
  }

  // Warm the model catalog in the background so the first /model autocomplete
  // has real data. Never awaited — must not delay or fail boot.
  console.log("[discordclaw] Warming model catalog...");
  warmModelCache();

  // 2. Load soul + start file watcher
  console.log("[discordclaw] Loading soul...");
  await initSoul();

  // 3. Index memory files
  console.log("[discordclaw] Indexing memory...");
  await initMemory();

  // 3.5 Initialize skills
  console.log("[discordclaw] Loading skills...");
  const skillService = new SkillService();
  await skillService.init();
  setCommandsSkillService(skillService);

  // 3.6 Snapshot evolvable resources (resource registry)
  console.log("[discordclaw] Snapshotting resource registry...");
  snapshotAllResources({
    skillsDir: SKILLS_DIR,
    soulPath: join(DATA_DIR, "SOUL.md"),
  });

  // 3.7 Check gh CLI availability
  const ghAvailable = await checkGhCli();
  if (!ghAvailable) {
    console.warn("[discordclaw] WARNING: gh CLI not authenticated — evolution PRs will fail");
  }

  // 3.8 Initialize voice assistant
  console.log("[discordclaw] Initializing voice assistant...");
  let voiceReady = false;
  try {
    await initVoice();
    voiceReady = true;
  } catch (err) {
    console.warn("[discordclaw] Voice assistant init failed (non-fatal):", err);
  }

  // 3.9 Initialize voice coach
  console.log("[discordclaw] Initializing voice coach...");
  let voiceCoachReady = false;
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
  const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID;
  if (elevenLabsKey && elevenLabsVoiceId) {
    try {
      initVoiceCoach({
        channelId: VOICE_COACH_CHANNEL_ID,
        userId: ADMIN_USER_ID,
        elevenLabsApiKey: elevenLabsKey,
        elevenLabsVoiceId: elevenLabsVoiceId,
      });
      voiceCoachReady = true;
    } catch (err) {
      console.warn("[discordclaw] Voice coach init failed (non-fatal):", err);
    }
  } else {
    console.warn("[discordclaw] Voice coach disabled — ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID not set");
  }

  // 4. Start cron service
  console.log("[discordclaw] Starting cron service...");
  const cronService = new CronService();
  cronService.setExecuteAgentTurn(
    (message, model) => processAgentTurn({ message, model }),
  );
  cronService.start();
  setCommandsCronService(cronService);

  // 5. Start Discord bot
  console.log("[discordclaw] Connecting to Discord...");
  const client = createClient();
  await startBot(client);

  // Wire voice → Discord client (for user display name resolution)
  if (voiceReady) {
    setVoiceDiscordClient(client);

    // Enable auto-join/leave: bot follows the admin user in/out of voice channels
    enableAutoJoin(client, ADMIN_USER_ID);

    // Exclude the voice coach channel from the regular voice auto-join
    if (voiceCoachReady) {
      excludeFromAutoJoin(VOICE_COACH_CHANNEL_ID);
    }
  }

  // Wire voice coach → Discord client
  if (voiceCoachReady) {
    setVoiceCoachClient(client);
  }

  // Wire cron → Discord delivery now that the client is ready
  cronService.setSendToDiscord(async (channelId, text, mentionUser) => {
    const channel: any = await client.channels.fetch(channelId);
    if (!channel?.send) {
      console.error(`[cron] Cannot send to channel ${channelId}`);
      return;
    }
    const prefix = mentionUser ? `<@${mentionUser}> ` : "";
    const fullText = prefix + text;
    const target = await ensureThread(
      channel,
      fullText.split("\n")[0].slice(0, 100) || "Cron notification",
      "cron",
    );
    await sendChunked(target, fullText);
  });

  // Wire cron → admin DM fallback
  try {
    const adminUser = await client.users.fetch(ADMIN_USER_ID);
    const dmChannel = await adminUser.createDM();
    cronService.setAdminDmChannelId(dmChannel.id);
    console.log(`[discordclaw] Admin DM fallback channel: ${dmChannel.id}`);
  } catch (err) {
    console.warn("[discordclaw] Could not set up admin DM fallback for cron:", err);
  }

  // Wire evolution → Discord delivery
  setEvolutionSendToDiscord(async (channelId, text) => {
    const channel: any = await client.channels.fetch(channelId);
    if (!channel?.send) {
      console.error(`[evolution] Cannot send to channel ${channelId}`);
      return;
    }
    const target = await ensureThread(
      channel,
      text.split("\n")[0].slice(0, 100) || "Evolution update",
      "evolution",
    );
    await sendChunked(target, text);
  });

  // Wire evolution → Discord thread creation (for deployment notifications)
  setEvolutionCreateThread(async (channelId, name, message) => {
    const channel: any = await client.channels.fetch(channelId);
    if (!channel?.threads) {
      console.error(`[evolution] Channel ${channelId} does not support threads`);
      return;
    }
    const thread = await channel.threads.create({
      name: name.slice(0, 100),
      // ChannelType.PublicThread = 11
      type: 11,
    });
    registerBotThread(thread.id);
    if (message) {
      await sendChunked(thread, message);
    }
  });

  // Wire reflection daemon → Discord delivery
  const reflectionChannelId = process.env.REFLECTION_CHANNEL_ID;
  if (reflectionChannelId) {
    setReflectionChannelId(reflectionChannelId);
    setReflectionSendToDiscord(async (channelId, text) => {
      const channel: any = await client.channels.fetch(channelId);
      if (!channel?.send) {
        console.error(`[reflection] Cannot send to channel ${channelId}`);
        return;
      }
      const target = await ensureThread(
        channel,
        text.split("\n")[0].slice(0, 100) || "Reflection",
        "reflection",
      );
      await sendChunked(target, text);
    });
  }

  // Set health check references
  setHealthDiscordClient(client);

  // 6. Start gateway server
  const port = parseInt(process.env.GATEWAY_PORT || "3000", 10);
  const token = process.env.GATEWAY_TOKEN || "discordclaw";
  const gateway = startGateway({
    port,
    token,
    cronService,
    skillService,
    discordClient: client,
  });

  // Mark services as ready for health check
  setServicesReady(true);

  // Sync deployed evolutions (check if any PRs were merged since last run)
  try {
    const deployed = await syncDeployedEvolutions();
    if (deployed > 0) {
      console.log(`[discordclaw] ${deployed} evolution(s) marked as deployed`);
    }
  } catch (err) {
    console.error("[discordclaw] Failed to sync evolutions:", err);
  }

  // 7. Schedule periodic session cleanup (every hour)
  const SESSION_CLEANUP_INTERVAL = 60 * 60 * 1000;
  const cleanupInterval = setInterval(() => {
    try {
      cleanExpiredSessions();
    } catch (err) {
      console.error("[discordclaw] Session cleanup error:", err);
    }
  }, SESSION_CLEANUP_INTERVAL);

  // 8. Start reflection daemon (self-evolution feedback loop)
  console.log("[discordclaw] Starting reflection daemon...");
  startReflectionDaemon();

  // 9. Log startup summary
  const guilds = client.guilds.cache;
  const cronJobs = cronService.list();
  const mem9Ready = isMem9Enabled();
  console.log("[discordclaw] ========================================");
  console.log(`[discordclaw] Bot online as ${client.user?.tag}`);
  console.log(`[discordclaw] Guilds: ${guilds.size}`);
  console.log(`[discordclaw] Cron jobs: ${cronJobs.length}`);
  console.log(`[discordclaw] Skills: ${skillService.list().length}`);
  console.log(`[discordclaw] gh CLI: ${ghAvailable ? "ready" : "NOT AVAILABLE"}`);
  console.log(`[discordclaw] Voice: ${voiceReady ? "ready (auto-join enabled)" : "NOT AVAILABLE"}`);
  console.log(`[discordclaw] Voice Coach: ${voiceCoachReady ? `ready (channel: ${VOICE_COACH_CHANNEL_ID})` : "NOT AVAILABLE"}`);
  console.log(`[discordclaw] mem9: ${mem9Ready ? "enabled (cloud memory)" : "disabled (local only)"}`);
  console.log(`[discordclaw] Reflection: ${reflectionChannelId ? `→ #${reflectionChannelId}` : "no channel (ideas only)"}`);
  console.log(`[discordclaw] Gateway: http://localhost:${port}`);
  console.log("[discordclaw] ========================================");

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  async function shutdown(signal: string): Promise<void> {
    console.log(`\n[discordclaw] Received ${signal}, shutting down...`);

    // Stop periodic cleanup
    clearInterval(cleanupInterval);

    // Stop reflection daemon
    stopReflectionDaemon();

    // Disable auto-join before destroying voice
    disableAutoJoin();

    // Stop voice coach
    destroyVoiceCoach();

    // Stop voice assistant
    await destroyVoice();

    // Stop cron first (prevents new jobs from firing)
    cronService.stop();

    // Stop file watchers
    stopSoulWatcher();
    stopMemoryWatcher();
    skillService.stop();

    // Close gateway
    gateway.close();

    // Disconnect Discord
    await stopBot(client);

    console.log("[discordclaw] Shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Wire restart: graceful shutdown → exit 100 (daemon handles deploy + restart)
  setRestartHandler(() => {
    console.log("[discordclaw] Restart requested — signaling daemon (exit 100)...");
    (async () => {
      clearInterval(cleanupInterval);
      stopReflectionDaemon();
      disableAutoJoin();
      destroyVoiceCoach();
      await destroyVoice();
      cronService.stop();
      stopSoulWatcher();
      stopMemoryWatcher();
      skillService.stop();
      gateway.close();
      await stopBot(client);

      process.exit(100);
    })();
  });
}

// ---------------------------------------------------------------------------
// Crash handlers — ensure unhandled errors produce a clean exit for the daemon
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  console.error("[discordclaw] Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[discordclaw] Unhandled rejection:", reason);
  process.exit(1);
});

main().catch((err) => {
  console.error("[discordclaw] Fatal error:", err);
  process.exit(1);
});
