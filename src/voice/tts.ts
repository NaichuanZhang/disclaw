/**
 * Text-to-Speech client for the realtime voice assistant, using ElevenLabs.
 *
 * Supports two modes:
 * 1. synthesize() — full synthesis, returns a complete mp3 buffer
 * 2. synthesizeStream() — HTTP chunked streaming, forwards mp3 bytes as they arrive
 *
 * Both feed discord.js `createAudioResource(..., { inputType: StreamType.Arbitrary })`,
 * which pipes through ffmpeg — so mp3 needs no client-side decoding or WAV framing.
 *
 * Previously this used Boson Higgs Audio v2.5 via EigenAI, including reference-file
 * voice cloning. EigenAI retired its audio product line (the Higgs endpoint answers
 * `502` from Cloudflare), so both the model and the cloning bootstrap are gone.
 * Pick a voice with ELEVENLABS_VOICE_ID (or VOICE_TTS_VOICE_ID to give the assistant
 * a different voice from the coach); note that instant-cloned voices require a paid
 * tier and 401 with `ivc_not_permitted` on payg.
 *
 * This is the same backend src/voice-coach/elevenlabs-tts.ts uses; the two stay
 * separate because the coach only needs one-shot synthesis.
 */

import { PassThrough } from "node:stream";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const ELEVENLABS_MODEL = "eleven_turbo_v2_5";

/** "Sarah" — a premade voice, available on every tier including payg. */
const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";

const VOICE_SETTINGS = {
  stability: 0.4,
  similarity_boost: 0.75,
  style: 0.3,
  use_speaker_boost: true,
} as const;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error("ELEVENLABS_API_KEY environment variable is not set");
  }
  return key;
}

/**
 * Voice for the assistant. VOICE_TTS_VOICE_ID wins, so the assistant and the
 * coach can sound different; otherwise they share ELEVENLABS_VOICE_ID.
 */
function voiceId(): string {
  return process.env.VOICE_TTS_VOICE_ID || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
}

function requestBody(text: string): string {
  return JSON.stringify({
    text,
    model_id: ELEVENLABS_MODEL,
    voice_settings: VOICE_SETTINGS,
  });
}

function preview(text: string, max = 100): string {
  return `${text.slice(0, max)}${text.length > max ? "..." : ""}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TTSStreamResult {
  /** A readable stream emitting mp3 audio data as it arrives.
   *  Compatible with discord.js createAudioResource(stream, { inputType: StreamType.Arbitrary }). */
  stream: PassThrough;
  /** Resolves when streaming is complete. Rejects on error. */
  done: Promise<void>;
}

// ---------------------------------------------------------------------------
// TTS API — Full Synthesis
// ---------------------------------------------------------------------------

/**
 * Synthesize text to speech.
 * @param text The text to speak
 * @returns mp3 audio buffer
 */
export async function synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
  const key = apiKey();
  const voice = voiceId();

  console.log(`[tts] Synthesizing ${text.length} chars: "${preview(text)}"`);
  const startTime = Date.now();

  const response = await fetch(`${ELEVENLABS_TTS_URL}/${voice}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": key,
      Accept: "audio/mpeg",
    },
    body: requestBody(text),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown error");
    console.error(`[tts] ❌ API error ${response.status}: ${errText}`);
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${errText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const elapsed = Date.now() - startTime;

  console.log(`[tts] ✅ Synthesized in ${elapsed}ms: ${buffer.length} bytes audio for "${preview(text, 50)}"`);

  return buffer;
}

// ---------------------------------------------------------------------------
// TTS API — Streaming
// ---------------------------------------------------------------------------

/**
 * Synthesize text to speech with HTTP chunked streaming.
 *
 * Returns a PassThrough that emits mp3 bytes as ElevenLabs produces them, so
 * playback starts at first-byte instead of after full synthesis. The stream can
 * be fed directly to discord.js createAudioResource().
 *
 * @param text The text to speak
 * @param signal Optional abort signal
 * @returns TTSStreamResult with the stream and a done promise
 */
export function synthesizeStream(text: string, signal?: AbortSignal): TTSStreamResult {
  const key = apiKey();
  const voice = voiceId();

  console.log(`[tts:stream] Synthesizing ${text.length} chars: "${preview(text)}"`);

  const passthrough = new PassThrough();
  const startTime = Date.now();
  let totalBytes = 0;
  let chunkCount = 0;
  let ttfb = 0;

  const done = (async () => {
    const response = await fetch(`${ELEVENLABS_TTS_URL}/${voice}/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": key,
        Accept: "audio/mpeg",
      },
      body: requestBody(text),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown error");
      console.error(`[tts:stream] ❌ API error ${response.status}: ${errText}`);
      const err = new Error(`ElevenLabs TTS stream failed (${response.status}): ${errText}`);
      passthrough.destroy(err);
      throw err;
    }

    if (!response.body) {
      const err = new Error("No response body for TTS stream");
      passthrough.destroy(err);
      throw err;
    }

    const reader = response.body.getReader();

    try {
      while (true) {
        if (signal?.aborted) break;

        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;
        if (!value || value.length === 0) continue;

        if (chunkCount === 0) {
          ttfb = Date.now() - startTime;
          console.log(`[tts:stream] ⚡ TTFB: ${ttfb}ms — forwarding first mp3 chunk`);
        }

        chunkCount++;
        totalBytes += value.length;
        passthrough.write(Buffer.from(value));
      }

      const elapsed = Date.now() - startTime;
      console.log(
        `[tts:stream] ✅ Stream finished in ${elapsed}ms (TTFB=${ttfb}ms, chunks=${chunkCount}, ` +
        `${totalBytes} bytes) for "${preview(text, 50)}"`,
      );
    } catch (err) {
      if (signal?.aborted) {
        // Expected — abort is not an error
      } else {
        console.error(`[tts:stream] ❌ Stream error:`, err);
        passthrough.destroy(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    } finally {
      reader.releaseLock();
      passthrough.end();
    }
  })();

  return { stream: passthrough, done };
}
