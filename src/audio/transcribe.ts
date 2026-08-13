/**
 * Audio transcription for Discord voice messages.
 *
 * Backends are tried in order, and audio only leaves the machine as a last
 * resort:
 *
 *   1. whisper.cpp   — local, native binary + GGML model. No Python at all,
 *                      so it works on hosts with a broken/absent pip.
 *   2. NeMo Parakeet — local, but requires a working Python packaging stack.
 *   3. OpenAI Whisper API — remote fallback, only if OPENAI_API_KEY is set.
 *
 * If every backend is unavailable or fails, a combined diagnostic string is
 * recorded (see `getLastTranscriptionFailureSummary`) so callers can log the
 * real reason while still showing users a friendly message.
 */

import OpenAI from "openai";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { transcribeAudioLocal, getLocalTranscriptionStatus } from "./local-transcribe.js";
import {
  transcribeAudioWhisperCpp,
  getWhisperCppStatus,
} from "./whispercpp-transcribe.js";

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
 * Check if any transcription path is potentially available. Optimistic: the
 * local backends' true readiness is only known after attempting them.
 */
export function isTranscriptionAvailable(): boolean {
  return true; // local backends are always attempted first
}

/**
 * Human-readable summary of why the most recent `transcribeAudio()` call
 * returned null (every backend failed or was unavailable). Useful for
 * diagnostics / logging from callers like messages.ts without changing the
 * friendly user-facing error message.
 */
let lastFailureSummary: string | null = null;

export function getLastTranscriptionFailureSummary(): string | null {
  return lastFailureSummary;
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
// Transcribe — local-first backend chain
// ---------------------------------------------------------------------------

interface BackendAttempt {
  name: string;
  reason: string;
}

/**
 * Download and transcribe an audio file from a URL, trying whisper.cpp, then
 * NeMo Parakeet, then the OpenAI Whisper API (if configured). Returns the
 * transcribed text, or null if every available path fails.
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
  const attempts: BackendAttempt[] = [];

  // --- 1. whisper.cpp (local, no Python required) -------------------------
  try {
    const text = await transcribeAudioWhisperCpp(url, filename);
    if (text) {
      lastFailureSummary = null;
      return text;
    }
    const status = getWhisperCppStatus();
    attempts.push({
      name: "whisper.cpp",
      reason: status.reason || "no transcript produced (silent or non-speech audio?)",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[audio] whisper.cpp transcription attempt failed:", err);
    attempts.push({ name: "whisper.cpp", reason: detail });
  }

  // --- 2. NeMo Parakeet (local, needs a working pip) ----------------------
  try {
    const text = await transcribeAudioLocal(url, filename, onStatus);
    if (text) {
      lastFailureSummary = null;
      return text;
    }
    const status = getLocalTranscriptionStatus();
    attempts.push({
      name: "parakeet",
      reason: status.reason || "no transcript produced",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[audio] Local Parakeet transcription attempt failed:", err);
    attempts.push({ name: "parakeet", reason: detail });
  }

  // --- 3. OpenAI Whisper API (remote fallback) ----------------------------
  if (isOpenAITranscriptionAvailable()) {
    try {
      const text = await transcribeAudioOpenAI(url, filename);
      if (text) {
        lastFailureSummary = null;
        return text;
      }
      attempts.push({ name: "openai", reason: "no transcript produced" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[audio] OpenAI fallback transcription failed:", err);
      attempts.push({ name: "openai", reason: detail });
    }
  } else {
    attempts.push({
      name: "openai",
      reason: "not configured (OPENAI_API_KEY unset)",
    });
  }

  lastFailureSummary = attempts.map((a) => `${a.name}: ${a.reason}`).join("; ");
  console.error(`[audio] All transcription paths failed. ${lastFailureSummary}`);
  return null;
}
