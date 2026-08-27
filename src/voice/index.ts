/**
 * Voice assistant orchestrator.
 *
 * Wires together: connection → receiver → VAD → STT → agent → TTS → playback.
 *
 * Flow:
 *   User speaks → opus decode → downsample → Silero VAD → utterance detection
 *   → local whisper.cpp STT → Claude → ElevenLabs TTS (streaming) → play audio
 *
 * TTS streaming: each sentence is streamed over HTTP chunked transfer — playback
 * starts as soon as the first mp3 chunk arrives instead of waiting for full synthesis.
 */

import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  type VoiceConnection,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import type { VoiceBasedChannel, Client } from "discord.js";
import { joinChannel, leaveChannel, isConnected, getConnection } from "./connection.js";
import { subscribeToUser, downsampleToMono16kInt16, type UserAudioStream } from "./receiver.js";
import { SileroVAD, FRAME_SIZE } from "./vad.js";
import { transcribe } from "./stt.js";
import { synthesize, synthesizeStream, type TTSStreamResult } from "./tts.js";
import { processVoiceUtteranceStreaming, clearVoiceHistory } from "./agent.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SILENCE_DURATION_MS = parseInt(process.env.VOICE_SILENCE_MS || "800", 10);
const MIN_UTTERANCE_MS = parseInt(process.env.VOICE_MIN_UTTERANCE_MS || "500", 10);
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Use streaming TTS (SSE) for lower TTFB. Set VOICE_TTS_STREAM=0 to disable. */
const TTS_STREAM = process.env.VOICE_TTS_STREAM !== "0";

/** At 16kHz, samples per ms */
const SAMPLES_PER_MS = 16;

// ---------------------------------------------------------------------------
// Debug logging
// ---------------------------------------------------------------------------

const VOICE_DEBUG = process.env.VOICE_DEBUG !== "0"; // On by default, set VOICE_DEBUG=0 to disable

function dbg(stage: string, msg: string): void {
  if (VOICE_DEBUG) {
    console.log(`[voice:${stage}] ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let vad: SileroVAD | null = null;
let audioPlayer = createAudioPlayer();
let userStreams: Map<string, UserAudioStream> = new Map();
let processing = false;
let pipelineAbort: AbortController | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let discordClient: Client | null = null;

// Per-user utterance state
interface UserUtteranceState {
  /** Accumulated raw PCM chunks for the current utterance */
  rawChunks: Int16Array[];
  /** Total raw samples accumulated */
  totalRawSamples: number;
  /** VAD frame buffer — accumulates samples until we have FRAME_SIZE */
  vadFrameBuffer: Float32Array;
  vadFrameOffset: number;
  /** Whether we're currently in speech */
  isSpeaking: boolean;
  /** Timestamp of last speech detection */
  lastSpeechTime: number;
  /** Timer for silence detection */
  silenceTimer: ReturnType<typeof setTimeout> | null;
  /** Timestamp when speech started */
  speechStartTime: number;
  /** Count of VAD frames processed (for periodic logging) */
  vadFrameCount: number;
  /** Count of speech frames detected */
  vadSpeechFrames: number;
  /** Count of audio data callbacks received */
  audioCallbackCount: number;
}

const userStates = new Map<string, UserUtteranceState>();

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the voice assistant. Must be called at startup.
 */
export async function initVoice(): Promise<void> {
  vad = new SileroVAD();
  await vad.init();
  console.log("[voice] Voice assistant initialized");
  console.log(`[voice] Config: SILENCE_DURATION=${SILENCE_DURATION_MS}ms, MIN_UTTERANCE=${MIN_UTTERANCE_MS}ms, DEBUG=${VOICE_DEBUG}, TTS_STREAM=${TTS_STREAM}`);
}

/**
 * Set the Discord client reference (for resolving user display names).
 */
export function setVoiceDiscordClient(client: Client): void {
  discordClient = client;
}

// ---------------------------------------------------------------------------
// Join / Leave
// ---------------------------------------------------------------------------

/**
 * Join a voice channel and start listening.
 */
export async function startVoice(channel: VoiceBasedChannel): Promise<void> {
  if (!vad) {
    throw new Error("Voice not initialized. Call initVoice() first.");
  }

  const connection = await joinChannel(channel);

  // Set up the audio player on this connection
  connection.subscribe(audioPlayer);
  dbg("init", "Audio player subscribed to connection");

  // Listen for users speaking
  const receiver = connection.receiver;

  receiver.speaking.on("start", (userId: string) => {
    if (userStreams.has(userId)) {
      dbg("event", `User ${userId} speaking:start but already subscribed, skipping`);
      return;
    }

    console.log(`[voice] User ${userId} started speaking`);
    resetIdleTimer();

    // Initialize utterance state
    const state: UserUtteranceState = {
      rawChunks: [],
      totalRawSamples: 0,
      vadFrameBuffer: new Float32Array(FRAME_SIZE),
      vadFrameOffset: 0,
      isSpeaking: false,
      lastSpeechTime: 0,
      silenceTimer: null,
      speechStartTime: 0,
      vadFrameCount: 0,
      vadSpeechFrames: 0,
      audioCallbackCount: 0,
    };
    userStates.set(userId, state);

    // Subscribe to their audio
    dbg("recv", `Subscribing to audio stream for user ${userId}`);
    const stream = subscribeToUser(
      connection,
      userId,
      // onFrame: downsampled 16kHz mono Float32 for VAD
      (frame: Float32Array) => handleVadFrame(userId, frame),
      // onRawPcm: raw PCM for buffering
      (pcm: Int16Array) => handleRawPcm(userId, pcm),
      // onStreamEnd: clean up so re-subscription can happen
      () => handleStreamEnd(userId),
    );

    userStreams.set(userId, stream);
    dbg("recv", `Audio stream subscribed for user ${userId}`);
  });

  receiver.speaking.on("end", (userId: string) => {
    // Don't immediately clean up — wait for silence timer to fire
    // This handles brief pauses in speech
    const state = userStates.get(userId);
    const info = state
      ? `vadFrames=${state.vadFrameCount}, speechFrames=${state.vadSpeechFrames}, audioCallbacks=${state.audioCallbackCount}, isSpeaking=${state.isSpeaking}`
      : "no state";
    console.log(`[voice] User ${userId} stopped speaking (Discord event) [${info}]`);
  });

  resetIdleTimer();
  console.log(`[voice] Listening in ${channel.name}`);
}

/**
 * Leave the voice channel and clean up.
 */
export function stopVoice(): void {
  // Clean up all user streams
  for (const [userId, stream] of userStreams) {
    stream.destroy();
    const state = userStates.get(userId);
    if (state?.silenceTimer) clearTimeout(state.silenceTimer);
  }
  userStreams.clear();
  userStates.clear();

  // Stop audio player
  audioPlayer.stop();

  // Clear idle timer
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  // Clear voice history
  clearVoiceHistory();

  // Disconnect
  leaveChannel();

  console.log("[voice] Voice assistant stopped");
}

// ---------------------------------------------------------------------------
// Audio processing pipeline
// ---------------------------------------------------------------------------

/**
 * Handle the opus stream ending for a user.
 * Cleans up userStreams so re-subscription can happen on the next speaking:start.
 */
function handleStreamEnd(userId: string): void {
  console.log(`[voice] 🔌 Audio stream ended for ${userId}, cleaning up for re-subscription`);

  // Remove the stream entry so next speaking:start will re-subscribe
  userStreams.delete(userId);

  // If user was mid-speech, fire the utterance completion
  const state = userStates.get(userId);
  if (state?.isSpeaking) {
    dbg("stream", `User ${userId} was mid-speech when stream ended, completing utterance`);
    if (state.silenceTimer) {
      clearTimeout(state.silenceTimer);
      state.silenceTimer = null;
    }
    onUtteranceComplete(userId);
  }

  // Clean up utterance state too — will be re-created on next speaking:start
  userStates.delete(userId);
}

/**
 * Handle raw PCM data from a user (buffer for STT).
 */
function handleRawPcm(userId: string, pcm: Int16Array): void {
  const state = userStates.get(userId);
  if (!state) return;

  state.audioCallbackCount++;

  // Log first callback and then every 100th
  if (state.audioCallbackCount === 1) {
    dbg("pcm", `First raw PCM callback for ${userId}: ${pcm.length} samples`);
  } else if (state.audioCallbackCount % 100 === 0) {
    dbg("pcm", `Raw PCM callback #${state.audioCallbackCount} for ${userId}, isSpeaking=${state.isSpeaking}, buffered chunks=${state.rawChunks.length}`);
  }

  if (state.isSpeaking) {
    state.rawChunks.push(new Int16Array(pcm)); // Copy
    state.totalRawSamples += pcm.length;
  }
}

/**
 * Handle a downsampled audio frame for VAD processing.
 */
async function handleVadFrame(userId: string, frame: Float32Array): Promise<void> {
  const state = userStates.get(userId);
  if (!state || !vad) {
    if (!state) dbg("vad", `No state for user ${userId}`);
    if (!vad) dbg("vad", "VAD not initialized!");
    return;
  }

  // Accumulate samples into the VAD frame buffer
  let offset = 0;
  while (offset < frame.length) {
    const remaining = FRAME_SIZE - state.vadFrameOffset;
    const toCopy = Math.min(remaining, frame.length - offset);
    state.vadFrameBuffer.set(frame.subarray(offset, offset + toCopy), state.vadFrameOffset);
    state.vadFrameOffset += toCopy;
    offset += toCopy;

    // When we have a full frame, process it
    if (state.vadFrameOffset >= FRAME_SIZE) {
      try {
        const prob = await vad.process(state.vadFrameBuffer);
        const isSpeech = prob > 0.5;
        state.vadFrameCount++;

        if (isSpeech) {
          state.vadSpeechFrames++;
        }

        // Log VAD probability periodically (every 10 frames = ~300ms)
        if (state.vadFrameCount % 10 === 0) {
          dbg("vad", `user=${userId} frame#${state.vadFrameCount} prob=${prob.toFixed(3)} isSpeech=${isSpeech} speaking=${state.isSpeaking} speechFrames=${state.vadSpeechFrames}`);
        }

        if (isSpeech) {
          if (!state.isSpeaking) {
            // Speech started
            state.isSpeaking = true;
            state.speechStartTime = Date.now();
            state.rawChunks = [];
            state.totalRawSamples = 0;
            console.log(`[voice] 🎤 Speech STARTED from ${userId} (prob=${prob.toFixed(3)})`);

            // If bot is speaking or processing, interrupt it
            if (audioPlayer.state.status === AudioPlayerStatus.Playing || pipelineAbort) {
              console.log("[voice] ⚡ Interrupting bot playback/pipeline");
              audioPlayer.stop();
              pipelineAbort?.abort();
            }
          }

          state.lastSpeechTime = Date.now();

          // Reset silence timer
          if (state.silenceTimer) {
            clearTimeout(state.silenceTimer);
            state.silenceTimer = null;
          }
        } else if (state.isSpeaking) {
          // In speech but VAD says silence — start silence timer
          if (!state.silenceTimer) {
            dbg("vad", `Silence detected for ${userId}, starting ${SILENCE_DURATION_MS}ms timer (prob=${prob.toFixed(3)})`);
            state.silenceTimer = setTimeout(() => {
              onUtteranceComplete(userId);
            }, SILENCE_DURATION_MS);
          }
        }
      } catch (err) {
        dbg("vad", `VAD processing error for ${userId}: ${err}`);
      }

      // Reset frame buffer
      state.vadFrameOffset = 0;
    }
  }
}

/**
 * Called when an utterance is considered complete (silence after speech).
 */
async function onUtteranceComplete(userId: string): Promise<void> {
  const state = userStates.get(userId);
  if (!state || !state.isSpeaking) return;

  const utteranceDuration = Date.now() - state.speechStartTime;
  console.log(`[voice] 🔇 Speech ENDED from ${userId} (duration=${utteranceDuration}ms, chunks=${state.rawChunks.length}, vadFrames=${state.vadFrameCount}, speechFrames=${state.vadSpeechFrames})`);

  // Mark as no longer speaking
  state.isSpeaking = false;
  if (state.silenceTimer) {
    clearTimeout(state.silenceTimer);
    state.silenceTimer = null;
  }

  // Check minimum utterance length
  if (utteranceDuration < MIN_UTTERANCE_MS) {
    console.log(`[voice] ⏭️ Utterance too short (${utteranceDuration}ms < ${MIN_UTTERANCE_MS}ms), discarding`);
    state.rawChunks = [];
    state.totalRawSamples = 0;
    return;
  }

  // If already processing another utterance, skip (queue could be added later)
  if (processing) {
    console.log("[voice] ⏭️ Already processing another utterance, skipping");
    state.rawChunks = [];
    state.totalRawSamples = 0;
    return;
  }

  // Grab the raw chunks and clear state
  const rawChunks = state.rawChunks;
  state.rawChunks = [];
  state.totalRawSamples = 0;

  if (rawChunks.length === 0) {
    console.log("[voice] ⏭️ No audio chunks buffered, skipping");
    return;
  }

  // Get the detected channel count from the user's audio stream
  const stream = userStreams.get(userId);
  const channels: 1 | 2 = stream?.channels ?? 2;

  // Reset VAD state for fresh detection
  vad?.reset();

  processing = true;
  const abortController = new AbortController();
  pipelineAbort = abortController;
  const pipelineStart = Date.now();

  try {
    // 1. Concatenate raw PCM chunks
    const totalSamples = rawChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const rawPcm = new Int16Array(totalSamples);
    let writeOffset = 0;
    for (const chunk of rawChunks) {
      rawPcm.set(chunk, writeOffset);
      writeOffset += chunk.length;
    }

    // 2. Downsample to 16kHz mono Int16 for STT (using detected channel count)
    const mono16k = downsampleToMono16kInt16(rawPcm, channels);

    const durationSec = mono16k.length / 16000;
    console.log(`[voice] 📝 Step 1: Audio ready — ${durationSec.toFixed(1)}s, ${totalSamples} raw samples → ${mono16k.length} mono16k samples (${channels}ch)`);

    // 3. STT
    console.log(`[voice] 📝 Step 2: Transcribing (STT)...`);
    const sttStart = Date.now();
    const text = await transcribe(mono16k);
    const sttElapsed = Date.now() - sttStart;

    if (!text || text.trim().length === 0) {
      console.log(`[voice] ⏭️ Empty transcription after ${sttElapsed}ms, skipping`);
      return;
    }
    if (abortController.signal.aborted) return;

    console.log(`[voice] 🗣️ STT result (${sttElapsed}ms): "${text}"`);

    // 4. Get user display name
    const userName = await getUserDisplayName(userId);
    dbg("pipeline", `User display name: ${userName}`);

    // 5. Streaming pipeline: Agent → sentence-level TTS → sequential playback
    console.log(`[voice] 📝 Step 3: Streaming response + TTS pipelining (streaming=${TTS_STREAM})...`);
    const agentStart = Date.now();
    let sentenceCount = 0;

    if (TTS_STREAM) {
      // ---------------------------------------------------------------
      // STREAMING TTS PATH
      // Each sentence → SSE streaming TTS → play as chunks arrive
      // Playback starts ~500ms after TTS request (vs ~1.4s non-streaming)
      // ---------------------------------------------------------------
      const ttsQueue: TTSStreamResult[] = [];
      let generationDone = false;

      // Task 1: Stream sentences from Agent and fire streaming TTS for each
      const generateTask = processVoiceUtteranceStreaming(
        text,
        userName,
        (sentence: string) => {
          sentenceCount++;
          console.log(`[voice] 📝 Sentence ${sentenceCount}: "${sentence}"`);
          const ttsResult = synthesizeStream(sentence, abortController.signal);
          ttsQueue.push(ttsResult);
        },
        abortController.signal,
      ).then((fullResponse) => {
        generationDone = true;
        return fullResponse;
      });

      // Task 2: Play streaming audio as it becomes available, in order
      const playTask = (async () => {
        let playIndex = 0;
        while (true) {
          if (abortController.signal.aborted) break;

          if (playIndex < ttsQueue.length) {
            const ttsResult = ttsQueue[playIndex];
            try {
              // Play the streaming audio — the stream emits WAV header + PCM chunks
              // as they arrive from the SSE endpoint
              await playStreamingAudio(ttsResult);
              // Wait for the TTS stream to fully finish before moving on
              await ttsResult.done;
            } catch (err) {
              if ((err as Error).name === "AbortError") break;
              console.error(`[voice] TTS/play error for sentence ${playIndex + 1}:`, err);
            }
            playIndex++;
          } else if (generationDone) {
            break;
          } else {
            // Wait briefly for next sentence to arrive
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      })();

      const [fullResponse] = await Promise.all([generateTask, playTask]);

      // Drain any un-awaited TTS done promises so errors don't become unhandled
      await Promise.allSettled(ttsQueue.map((t) => t.done));

      const agentElapsed = Date.now() - agentStart;
      const totalElapsed = Date.now() - pipelineStart;
      console.log(`[voice] ✅ Pipeline complete in ${totalElapsed}ms (STT=${sttElapsed}ms, Agent+TTS+Play=${agentElapsed}ms, sentences=${sentenceCount}, streaming=true)`);
      console.log(`[voice] ✅ "${text}" → "${fullResponse}"`);
    } else {
      // ---------------------------------------------------------------
      // NON-STREAMING TTS PATH (legacy)
      // Each sentence → full synthesis → play complete WAV
      // ---------------------------------------------------------------
      const audioQueue: Promise<Buffer>[] = [];
      let generationDone = false;

      // Task 1: Stream sentences from Agent and fire TTS for each
      const generateTask = processVoiceUtteranceStreaming(
        text,
        userName,
        (sentence: string) => {
          sentenceCount++;
          console.log(`[voice] 📝 Sentence ${sentenceCount}: "${sentence}"`);
          audioQueue.push(synthesize(sentence, abortController.signal));
        },
        abortController.signal,
      ).then((fullResponse) => {
        generationDone = true;
        return fullResponse;
      });

      // Task 2: Play audio as it becomes available, in order
      const playTask = (async () => {
        let playIndex = 0;
        while (true) {
          if (abortController.signal.aborted) break;

          if (playIndex < audioQueue.length) {
            try {
              const audio = await audioQueue[playIndex];
              if (!abortController.signal.aborted) {
                await playAudio(audio);
              }
            } catch (err) {
              if ((err as Error).name === "AbortError") break;
              console.error(`[voice] TTS/play error for sentence ${playIndex + 1}:`, err);
            }
            playIndex++;
          } else if (generationDone) {
            break;
          } else {
            // Wait briefly for next sentence to arrive
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      })();

      const [fullResponse] = await Promise.all([generateTask, playTask]);

      // Drain any un-awaited TTS promises
      await Promise.allSettled(audioQueue);

      const agentElapsed = Date.now() - agentStart;
      const totalElapsed = Date.now() - pipelineStart;
      console.log(`[voice] ✅ Pipeline complete in ${totalElapsed}ms (STT=${sttElapsed}ms, Agent+TTS+Play=${agentElapsed}ms, sentences=${sentenceCount}, streaming=false)`);
      console.log(`[voice] ✅ "${text}" → "${fullResponse}"`);
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      console.log(`[voice] ⚡ Pipeline aborted (interrupted by user)`);
    } else {
      const totalElapsed = Date.now() - pipelineStart;
      console.error(`[voice] ❌ Pipeline error after ${totalElapsed}ms:`, err);
    }
  } finally {
    processing = false;
    pipelineAbort = null;
  }
}

// ---------------------------------------------------------------------------
// Audio playback
// ---------------------------------------------------------------------------

/**
 * Play a WAV audio buffer through the voice connection (non-streaming).
 */
async function playAudio(wavBuffer: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      dbg("play", `Creating audio resource from ${wavBuffer.length} byte buffer`);
      const stream = Readable.from(wavBuffer);
      const resource = createAudioResource(stream, {
        inputType: StreamType.Arbitrary,
      });

      audioPlayer.play(resource);
      dbg("play", `Audio player started, status: ${audioPlayer.state.status}`);

      const onIdle = () => {
        audioPlayer.removeListener("error", onError);
        dbg("play", "Audio playback finished (idle)");
        resolve();
      };

      const onError = (err: Error) => {
        audioPlayer.removeListener(AudioPlayerStatus.Idle, onIdle);
        console.error("[voice] ❌ Audio player error:", err);
        reject(err);
      };

      audioPlayer.once(AudioPlayerStatus.Idle, onIdle);
      audioPlayer.once("error", onError);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Play a streaming TTS result through the voice connection.
 * Starts playback as soon as the PassThrough stream has data (after WAV header + first chunk).
 */
async function playStreamingAudio(ttsResult: TTSStreamResult): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      dbg("play", "Creating audio resource from streaming TTS PassThrough");

      const resource = createAudioResource(ttsResult.stream, {
        inputType: StreamType.Arbitrary,
      });

      audioPlayer.play(resource);
      dbg("play", `Streaming audio player started, status: ${audioPlayer.state.status}`);

      const onIdle = () => {
        audioPlayer.removeListener("error", onError);
        dbg("play", "Streaming audio playback finished (idle)");
        resolve();
      };

      const onError = (err: Error) => {
        audioPlayer.removeListener(AudioPlayerStatus.Idle, onIdle);
        console.error("[voice] ❌ Streaming audio player error:", err);
        reject(err);
      };

      audioPlayer.once(AudioPlayerStatus.Idle, onIdle);
      audioPlayer.once("error", onError);
    } catch (err) {
      reject(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get a user's display name from Discord.
 */
async function getUserDisplayName(userId: string): Promise<string> {
  if (!discordClient) return `User ${userId}`;

  try {
    const user = await discordClient.users.fetch(userId);
    return user.displayName || user.username || `User ${userId}`;
  } catch {
    return `User ${userId}`;
  }
}

/**
 * Reset the idle timer. Auto-leaves after IDLE_TIMEOUT_MS of no activity.
 */
function resetIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }

  idleTimer = setTimeout(() => {
    console.log("[voice] Idle timeout reached, leaving voice channel");
    stopVoice();
  }, IDLE_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Clean up on destroy
// ---------------------------------------------------------------------------

/**
 * Destroy VAD and clean up all resources.
 */
export async function destroyVoice(): Promise<void> {
  stopVoice();
  if (vad) {
    await vad.destroy();
    vad = null;
  }
}

// ---------------------------------------------------------------------------
// Re-export for external use
// ---------------------------------------------------------------------------

export { isConnected } from "./connection.js";
