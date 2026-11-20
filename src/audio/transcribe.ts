/**
 * Audio transcription for Discord voice messages.
 *
 * One backend, local only: whisper.cpp (native binary + GGML model, no Python,
 * no network). The NeMo Parakeet and OpenAI Whisper fallbacks were removed —
 * neither had ever produced a transcript on this host.
 *
 * If the backend is unavailable or fails, a diagnostic string is recorded (see
 * `getLastTranscriptionFailureSummary`) so callers can log the real reason
 * while still showing users a friendly message.
 */

import { count } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";
import {
  transcribeAudioWhisperCpp,
  getWhisperCppStatus,
} from "./whispercpp-transcribe.js";

/**
 * Human-readable summary of why the most recent `transcribeAudio()` call
 * returned null. Useful for diagnostics / logging from callers like
 * messages.ts without changing the friendly user-facing error message.
 */
let lastFailureSummary: string | null = null;

export function getLastTranscriptionFailureSummary(): string | null {
  return lastFailureSummary;
}

/**
 * Download and transcribe an audio file from a URL via whisper.cpp. Returns
 * the transcribed text, or null if it fails.
 *
 * @param url - URL of the audio file (e.g., Discord attachment URL)
 * @param filename - Original filename (used to determine format)
 * @param _onStatus - progress callback; kept for callers, currently unused
 */
export async function transcribeAudio(
  url: string,
  filename?: string,
  _onStatus?: (msg: string) => void,
): Promise<string | null> {
  count(P.audioTranscribeDispatch);

  let reason: string;
  try {
    const text = await transcribeAudioWhisperCpp(url, filename);
    if (text) {
      lastFailureSummary = null;
      return text;
    }
    reason = getWhisperCppStatus().reason || "no transcript produced (silent or non-speech audio?)";
  } catch (err) {
    console.error("[audio] whisper.cpp transcription attempt failed:", err);
    reason = err instanceof Error ? err.message : String(err);
  }

  lastFailureSummary = `whisper.cpp: ${reason}`;
  console.error(`[audio] Transcription failed. ${lastFailureSummary}`);
  return null;
}
