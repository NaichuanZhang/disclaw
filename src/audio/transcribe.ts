/**
 * Audio transcription for Discord voice messages.
 *
 * Prefers fully local/offline transcription via NVIDIA's Parakeet model
 * (see ./local-transcribe.ts) — no external API, no key required, and
 * audio never leaves the machine. Falls back to OpenAI's Whisper API
 * only if the local path is unavailable/fails AND OPENAI_API_KEY is set.
 */

import OpenAI from "openai";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { transcribeAudioLocal } from "./local-transcribe.js";

// ---------------------------------------------------------------------------
// OpenAI client (lazy singleton) — fallback only
// ---------------------------------------------------------------------------

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
  if (openaiClient) return openaiClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  openaiClient = new OpenAI({ apiKey });
  return openaiClient;
}

/**
 * Check if the OpenAI Whisper fallback is configured (OPENAI_API_KEY set).
 */
export function isOpenAITranscriptionAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Check if any transcription path is potentially available — local Parakeet
 * (which is attempted by default whenever python3/ffmpeg are present) or
 * the OpenAI fallback. This is optimistic about local transcription since
 * readiness is only really known after attempting it (lazy install).
 */
export function isTranscriptionAvailable(): boolean {
  return true; // local transcription is always attempted first
}

// ---------------------------------------------------------------------------
// Download helper (used by the OpenAI fallback path)
// ---------------------------------------------------------------------------

async function downloadFile(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function transcribeAudioOpenAI(
  url: string,
  filename?: string,
): Promise<string | null> {
  const client = getOpenAIClient();
  if (!client) return null;

  const audioBuffer = await downloadFile(url);

  const ext = filename?.split(".").pop() || "ogg";
  const tempPath = join(
    tmpdir(),
    `discordclaw-voice-${randomBytes(8).toString("hex")}.${ext}`,
  );

  try {
    writeFileSync(tempPath, audioBuffer);

    console.log(
      `[audio] Transcribing ${filename || "voice message"} via OpenAI fallback (${audioBuffer.length} bytes)`,
    );

    const file = new File([readFileSync(tempPath)], filename || `voice.${ext}`, {
      type: ext === "ogg" ? "audio/ogg" : `audio/${ext}`,
    });

    const transcription = await client.audio.transcriptions.create({
      model: "whisper-1",
      file,
      response_format: "text",
    });

    const text =
      typeof transcription === "string"
        ? transcription.trim()
        : (transcription as unknown as { text: string }).text?.trim() || "";

    console.log(
      `[audio] OpenAI transcription result (${text.length} chars): "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
    );

    return text || null;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Transcribe — local-first, OpenAI fallback
// ---------------------------------------------------------------------------

/**
 * Download and transcribe an audio file from a URL.
 * Tries fully local transcription (NVIDIA Parakeet) first; falls back to
 * OpenAI's Whisper API if the local path is unavailable/fails and
 * OPENAI_API_KEY is set. Returns the transcribed text, or null if all
 * available paths fail.
 *
 * @param url - URL of the audio file (e.g., Discord attachment URL)
 * @param filename - Original filename (used to determine format)
 * @param onStatus - optional progress callback surfaced during local model
 *   first-time setup (e.g. to post a status message to Discord)
 */
export async function transcribeAudio(
  url: string,
  filename?: string,
  onStatus?: (msg: string) => void,
): Promise<string | null> {
  try {
    const localText = await transcribeAudioLocal(url, filename, onStatus);
    if (localText) return localText;
  } catch (err) {
    console.error("[audio] Local transcription attempt failed:", err);
  }

  if (isOpenAITranscriptionAvailable()) {
    try {
      return await transcribeAudioOpenAI(url, filename);
    } catch (err) {
      console.error("[audio] OpenAI fallback transcription failed:", err);
    }
  }

  return null;
}
