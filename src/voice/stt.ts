/**
 * Speech-to-Text for the realtime voice pipelines.
 *
 * Takes PCM audio (16kHz mono Int16) and transcribes it **locally** via
 * whisper.cpp — the same backend the Discord voice-message path uses, so
 * audio never leaves the machine and there is no per-utterance API cost.
 *
 * Previously this called EigenAI Whisper V3 Turbo. EigenAI dropped its audio
 * models (the endpoint now answers `500 {"detail":"Unsupported category"}`),
 * so that path is gone. Measured on a 2.3s utterance, local whisper.cpp is
 * also *faster* than the remote services it replaced (~1.65s vs ~2.45s).
 *
 * An optional remote fallback (ElevenLabs Scribe) can be enabled with
 * VOICE_STT_REMOTE_FALLBACK=1 for hosts where whisper.cpp cannot be built, or
 * when non-English input matters — `base.en` is English-only.
 */

import { VAD_SAMPLE_RATE } from "./receiver.js";
import { transcribePcm16kWhisperCpp } from "../audio/whispercpp-transcribe.js";
import { count } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

// ---------------------------------------------------------------------------
// Remote fallback (opt-in)
// ---------------------------------------------------------------------------

const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const SCRIBE_MODEL = "scribe_v1";

/** True when the operator opted into the remote fallback. */
function remoteFallbackEnabled(): boolean {
  return process.env.VOICE_STT_REMOTE_FALLBACK === "1";
}

/**
 * Wrap raw PCM Int16 samples in a WAV header, for the multipart upload the
 * remote fallback needs.
 */
function encodeWav(samples: Int16Array, sampleRate: number, channels = 1): Buffer {
  const bytesPerSample = 2; // Int16
  const dataSize = samples.length * bytesPerSample;
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  // fmt chunk
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(channels * bytesPerSample, 32); // block align
  buffer.writeUInt16LE(bytesPerSample * 8, 34); // bits per sample

  // data chunk
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(buffer, headerSize);

  return buffer;
}

/**
 * Transcribe via ElevenLabs Scribe. Only called when the local backend is
 * unavailable *and* VOICE_STT_REMOTE_FALLBACK=1.
 */
async function transcribeRemote(pcm16kMono: Int16Array): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.warn("[stt] remote fallback enabled but ELEVENLABS_API_KEY is not set");
    return "";
  }

  const wavBuffer = encodeWav(pcm16kMono, VAD_SAMPLE_RATE);
  const durationSec = pcm16kMono.length / VAD_SAMPLE_RATE;

  const formData = new FormData();
  formData.append("model_id", SCRIBE_MODEL);
  formData.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "utterance.wav");

  const startTime = Date.now();
  const response = await fetch(SCRIBE_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: formData,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown error");
    console.error(`[stt] ❌ Scribe error ${response.status}: ${errText}`);
    return "";
  }

  const data = (await response.json()) as { text?: string };
  const text = (data.text ?? "").trim();
  console.log(
    `[stt] ✅ Scribe transcribed in ${Date.now() - startTime}ms (${durationSec.toFixed(1)}s audio): "${text}"`,
  );
  return text;
}

// ---------------------------------------------------------------------------
// STT API
// ---------------------------------------------------------------------------

/**
 * Transcribe PCM audio to text.
 *
 * @param pcm16kMono Int16Array of 16kHz mono audio samples
 * @returns Transcribed text, or an empty string if nothing was detected
 */
export async function transcribe(pcm16kMono: Int16Array): Promise<string> {
  count(P.voiceSttTranscribe);
  const durationSec = pcm16kMono.length / VAD_SAMPLE_RATE;
  console.log(`[stt] Transcribing ${durationSec.toFixed(1)}s audio locally (whisper.cpp)`);

  try {
    const text = await transcribePcm16kWhisperCpp(pcm16kMono, VAD_SAMPLE_RATE);
    if (text) return text;
    // null means the backend was unavailable or the audio held no speech.
    // Fall through to the remote fallback only if one is configured.
  } catch (err) {
    console.error("[stt] local whisper.cpp failed:", err);
  }

  if (remoteFallbackEnabled()) {
    try {
      return await transcribeRemote(pcm16kMono);
    } catch (err) {
      console.error("[stt] remote fallback failed:", err);
    }
  }

  return "";
}
