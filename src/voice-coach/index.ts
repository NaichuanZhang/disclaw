/**
 * Voice Coach Orchestrator
 *
 * Wires together: mock cycling data → coach brain → ElevenLabs TTS → Discord playback.
 * Also wires: rider audio → VAD → STT → message queue → coach brain context.
 *
 * Polling loop runs every POLL_INTERVAL_MS:
 *   1. Get current cycling telemetry
 *   2. Flush any rider messages from the listener queue
 *   3. Ask the coach brain what to say (LLM) — includes rider speech context
 *   4. If coach has something to say → synthesize via ElevenLabs → play in voice channel
 *
 * Designed to run independently of the main voice assistant pipeline.
 */

import type { VoiceBasedChannel, Client, VoiceState } from "discord.js";
import { startRide, stopRide, getCyclingData } from "./mock-server.js";
import { getCoachResponse, resetCoachBrain } from "./coach-brain.js";
import { initElevenLabs, synthesizeElevenLabs } from "./elevenlabs-tts.js";
import {
  joinCoachChannel,
  leaveCoachChannel,
  playCoachAudio,
  isCoachConnected,
  getCoachConnection,
} from "./player.js";
import { startListening, stopListening, flushRiderMessages } from "./listener.js";
import { count } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 7_000; // 7 seconds

// ---------------------------------------------------------------------------
// Intro variations — randomly picked each session
// ---------------------------------------------------------------------------

const INTRO_VARIATIONS = [
  "Okay, I am here viz you now. I see eferyzing — ze vatts, ze heart rate, efery pedal stroke. Vun zing ve vill always do, is fight for it efery day. Zat is vat ve do. So, let's go. Los!",
  "Gut, ve are connected. I have ze numbers in front of me, I see eferyzing from ze car. Today ve vork togezzer, ve push togezzer, ve get stronger togezzer. Surrender is not part of our DNA. Los, let's ride!",
  "Okay, I'm here. I can see your vatts, your heart rate, eferyzing. Today is about building somesing special. Ve came here viz a big objective and ve vill fight for it efery single day. Are you ready? Komm, let's go!",
  "Alright, Grischa here in ze car behind you. I see all ze data, I see eferyzing. Remember — ve are always motivated by victory, simply because zat's who ve are. Now let's make zis session count. Los los los!",
  "Gut, I am viz you now. Ze numbers are coming in, eferyzing looks gut. Listen, I believe in you. I vouldn't be here if I didn't. Efery pedal stroke today matters. Ve fight togezzer, ya? Komm, let's go!",
  "Okay, radio check. I have you on ze screen, vatts and heart rate coming srough. Today ve don't chust train, ve prepare for somesing bigger. Ze Tour doesn't end until Paris, and our vork doesn't end until ve give eferyzing. Los!",
];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let coachChannelId: string | null = null;
let trackedUserId: string | null = null;
let discordClient: Client | null = null;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pollTimer: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the voice coach system.
 *
 * @param config.channelId - The voice channel ID dedicated to coaching
 * @param config.userId - The user ID to track (auto-join when they join this channel)
 * @param config.elevenLabsApiKey - ElevenLabs API key
 * @param config.elevenLabsVoiceId - ElevenLabs voice ID
 */
export function initVoiceCoach(config: {
  channelId: string;
  userId: string;
  elevenLabsApiKey: string;
  elevenLabsVoiceId: string;
}): void {
  count(P.voiceCoachInit);
  coachChannelId = config.channelId;
  trackedUserId = config.userId;

  initElevenLabs({
    apiKey: config.elevenLabsApiKey,
    voiceId: config.elevenLabsVoiceId,
  });

  console.log(`[voice-coach] Initialized — channel: ${coachChannelId}, tracking user: ${trackedUserId}`);
}

/**
 * Set the Discord client reference and register the voiceStateUpdate listener.
 */
export function setVoiceCoachClient(client: Client): void {
  discordClient = client;
  client.on("voiceStateUpdate", handleVoiceStateUpdate);
  console.log("[voice-coach] Registered voiceStateUpdate listener");
}

/**
 * Stop the voice coach and clean up.
 */
export function destroyVoiceCoach(): void {
  count(P.voiceCoachDestroy);
  stopCoachSession();

  if (discordClient) {
    discordClient.removeListener("voiceStateUpdate", handleVoiceStateUpdate);
    discordClient = null;
  }

  console.log("[voice-coach] Destroyed");
}

// ---------------------------------------------------------------------------
// Voice state handler — auto-join/leave the coach channel
// ---------------------------------------------------------------------------

async function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
): Promise<void> {
  // Only care about the tracked user
  if (newState.member?.id !== trackedUserId) return;

  const oldChannel = oldState.channelId;
  const newChannel = newState.channelId;

  // No change
  if (oldChannel === newChannel) return;

  // User joined the coach channel
  if (newChannel && newChannel === coachChannelId) {
    console.log(`[voice-coach] Tracked user joined coach channel — starting session`);

    try {
      const channel = await newState.guild.channels.fetch(newChannel);
      if (!channel || !channel.isVoiceBased()) {
        console.error("[voice-coach] Channel is not voice-based");
        return;
      }
      await startCoachSession(channel);
    } catch (err) {
      console.error("[voice-coach] Failed to start session:", err);
    }
  }
  // User left the coach channel
  else if (oldChannel === coachChannelId) {
    console.log("[voice-coach] Tracked user left coach channel — stopping session");
    stopCoachSession();
  }
}

// ---------------------------------------------------------------------------
// Coach session lifecycle
// ---------------------------------------------------------------------------

async function startCoachSession(channel: VoiceBasedChannel): Promise<void> {
  // Join the voice channel
  await joinCoachChannel(channel);

  // Reset state
  resetCoachBrain();
  startRide();

  // Start listening to the rider's speech
  const connection = getCoachConnection();
  if (connection && trackedUserId) {
    try {
      await startListening(connection, trackedUserId);
      console.log("[voice-coach] Listener started — rider speech will be captured");
    } catch (err) {
      console.error("[voice-coach] Failed to start listener:", err);
    }
  }

  // Start the polling loop
  pollTimer = setInterval(pollCycle, POLL_INTERVAL_MS);
  console.log(`[voice-coach] Session started — polling every ${POLL_INTERVAL_MS}ms`);

  // Play a random intro message after a short delay
  setTimeout(async () => {
    try {
      const introText = INTRO_VARIATIONS[Math.floor(Math.random() * INTRO_VARIATIONS.length)];
      console.log(`[voice-coach] Playing intro: "${introText}"`);
      const audio = await synthesizeElevenLabs(introText);
      await playCoachAudio(audio);
    } catch (err) {
      console.error("[voice-coach] Failed to play intro:", err);
    }
  }, 2000);
}

function stopCoachSession(): void {
  // Stop listening
  stopListening();

  // Stop polling
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // Stop the mock ride
  stopRide();

  // Leave voice
  leaveCoachChannel();

  console.log("[voice-coach] Session stopped");
}

// ---------------------------------------------------------------------------
// Core polling loop
// ---------------------------------------------------------------------------

async function pollCycle(): Promise<void> {
  // Don't stack polls if processing is slow
  if (isProcessing) {
    console.log("[voice-coach] Still processing previous cycle, skipping");
    return;
  }

  if (!isCoachConnected()) {
    console.log("[voice-coach] Not connected, skipping poll");
    return;
  }

  isProcessing = true;
  const cycleStart = Date.now();

  try {
    // 1. Get cycling data
    const data = getCyclingData();
    if (!data) {
      console.log("[voice-coach] No cycling data available");
      return;
    }

    console.log(
      `[voice-coach] 📊 ${data.phase} | HR:${data.hr} W:${data.watts} CAD:${data.cadence} Z${data.zone} | ${data.pct_ftp}%FTP | ${data.elapsed_min}min`,
    );

    // 2. Flush any rider messages from the listener
    const riderMessages = flushRiderMessages();
    if (riderMessages.length > 0) {
      console.log(`[voice-coach] 🎤 Rider said ${riderMessages.length} thing(s): ${riderMessages.map(m => `"${m.text}"`).join(", ")}`);
    }

    // 3. Ask the coach brain (includes rider messages)
    const coachText = await getCoachResponse(data, riderMessages.length > 0 ? riderMessages : undefined);

    if (!coachText) {
      // Coach chose silence
      return;
    }

    // 4. Synthesize via ElevenLabs
    const audio = await synthesizeElevenLabs(coachText);

    // 5. Play in voice channel
    await playCoachAudio(audio);

    const elapsed = Date.now() - cycleStart;
    console.log(`[voice-coach] ✅ Cycle complete in ${elapsed}ms`);
  } catch (err) {
    console.error("[voice-coach] ❌ Poll cycle error:", err);
  } finally {
    isProcessing = false;
  }
}
