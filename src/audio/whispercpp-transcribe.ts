/**
 * Fully local/offline audio transcription via whisper.cpp.
 *
 * This is the primary local backend because it has essentially no runtime
 * dependencies: a single self-contained native binary plus a GGML model
 * file. It needs *no* Python, no pip, and no virtualenv — which matters a
 * lot on hosts where the Python packaging stack is unusable (e.g. this
 * Jetson Orin: no `pip3`, no `ensurepip`, no passwordless sudo, so the
 * NeMo/Parakeet `pip install` path can never succeed).
 *
 * Audio never leaves the machine.
 *
 * Setup (one-time, no root required — see scripts/setup-whispercpp.sh):
 *   git clone --depth 1 https://github.com/ggml-org/whisper.cpp data/asr/whisper.cpp
 *   cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j
 *   ./models/download-ggml-model.sh base.en
 *
 * Overrides:
 *   WHISPER_CPP_BIN    — path to the whisper-cli binary
 *   WHISPER_CPP_MODEL  — path to the .bin GGML model
 *   WHISPER_CPP_THREADS — thread count (default: 4)
 */

import { spawn } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo root — this file lives at <root>/src/audio/. */
const REPO_ROOT = join(__dirname, "..", "..");
const ASR_DIR = join(REPO_ROOT, "data", "asr", "whisper.cpp");

const DEFAULT_BIN = join(ASR_DIR, "build", "bin", "whisper-cli");
const DEFAULT_MODEL = join(ASR_DIR, "models", "ggml-base.en.bin");

function binPath(): string {
  return process.env.WHISPER_CPP_BIN || DEFAULT_BIN;
}

function modelPath(): string {
  return process.env.WHISPER_CPP_MODEL || DEFAULT_MODEL;
}

function threadCount(): string {
  const raw = parseInt(process.env.WHISPER_CPP_THREADS || "", 10);
  return String(Number.isFinite(raw) && raw > 0 ? raw : 4);
}

// ---------------------------------------------------------------------------
// Small process-spawning helper
// ---------------------------------------------------------------------------

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: 1, stdout: "", stderr: String(err) });
      return;
    }

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // ignore
          }
        }, opts.timeoutMs)
      : null;

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + `\n${String(err)}` });
    });
  });
}

/** Trim a command's stderr/stdout down to a short, log-friendly snippet. */
function shortDetail(res: CommandResult, maxLen = 300): string {
  const raw = (res.stderr || res.stdout || "").trim();
  if (!raw) return `exit code ${res.code}, no output captured`;
  const lastLine = raw.split("\n").filter(Boolean).pop() || raw;
  return lastLine.length > maxLen ? lastLine.slice(-maxLen) : lastLine;
}

// ---------------------------------------------------------------------------
// Readiness check (cached)
// ---------------------------------------------------------------------------

let setupChecked = false;
let setupAvailable = false;
let setupPromise: Promise<boolean> | null = null;
let setupFailureReason: string | null = null;

/**
 * Check whether the whisper.cpp backend is usable: ffmpeg on PATH, the
 * native binary present and executable, and the model file present.
 * Result is cached for the process lifetime.
 */
export async function ensureWhisperCppReady(): Promise<boolean> {
  if (setupChecked) return setupAvailable;
  if (setupPromise) return setupPromise;

  setupPromise = (async () => {
    const finish = (ok: boolean, reason: string | null) => {
      setupChecked = true;
      setupAvailable = ok;
      setupFailureReason = reason;
      if (!ok) console.error(`[whispercpp] unavailable: ${reason}`);
      return ok;
    };

    const ffmpegCheck = await runCommand("ffmpeg", ["-version"], {
      timeoutMs: 5_000,
    });
    if (ffmpegCheck.code !== 0) {
      return finish(
        false,
        `ffmpeg not found on PATH (${shortDetail(ffmpegCheck)}). Install it, e.g. 'apt-get install -y ffmpeg'.`,
      );
    }

    const bin = binPath();
    if (!existsSync(bin)) {
      return finish(
        false,
        `whisper.cpp binary missing at ${bin}. Run scripts/setup-whispercpp.sh (needs cmake + g++, no root) or set WHISPER_CPP_BIN.`,
      );
    }

    const model = modelPath();
    if (!existsSync(model)) {
      return finish(
        false,
        `whisper.cpp model missing at ${model}. Run scripts/setup-whispercpp.sh or set WHISPER_CPP_MODEL.`,
      );
    }

    // Confirm the binary actually executes on this arch (catches a bad
    // build, missing shared libs, wrong architecture, etc).
    const help = await runCommand(bin, ["--help"], { timeoutMs: 10_000 });
    if (help.code !== 0) {
      return finish(
        false,
        `whisper.cpp binary at ${bin} is present but failed to execute (${shortDetail(help)}). Try rebuilding it.`,
      );
    }

    console.log(
      `[whispercpp] ready — bin=${bin} model=${model} threads=${threadCount()}`,
    );
    return finish(true, null);
  })();

  return setupPromise;
}

/**
 * Diagnostic snapshot of whisper.cpp readiness, so callers can log *why*
 * the backend was skipped rather than just "transcription failed".
 */
export function getWhisperCppStatus(): {
  checked: boolean;
  ready: boolean;
  reason: string | null;
  bin: string;
  model: string;
} {
  return {
    checked: setupChecked,
    ready: setupAvailable,
    reason: setupFailureReason,
    bin: binPath(),
    model: modelPath(),
  };
}

// ---------------------------------------------------------------------------
// Download helper
// ---------------------------------------------------------------------------

async function downloadFile(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download file: ${response.status} ${response.statusText}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * whisper.cpp emits bracketed non-speech annotations like `[BLANK_AUDIO]`,
 * `[MUSIC]`, `(wind blowing)` for silence/noise. Strip those so a silent
 * clip yields an empty transcript rather than junk text.
 */
function cleanTranscript(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?:blank_audio|music|silence|inaudible)\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Transcribe
// ---------------------------------------------------------------------------

/**
 * Download and transcribe an audio file fully locally via whisper.cpp.
 * Returns the transcribed text, or null if the backend is unavailable or
 * transcription produced nothing usable.
 *
 * @param url - URL of the audio file (e.g. Discord attachment URL)
 * @param filename - Original filename (used to determine format)
 */
export async function transcribeAudioWhisperCpp(
  url: string,
  filename?: string,
): Promise<string | null> {
  const ready = await ensureWhisperCppReady();
  if (!ready) {
    console.log(
      `[whispercpp] backend unavailable — skipping. Reason: ${setupFailureReason || "unknown"}`,
    );
    return null;
  }

  const audioBuffer = await downloadFile(url);
  const ext = filename?.split(".").pop() || "ogg";
  const rawPath = join(
    tmpdir(),
    `discordclaw-voice-${randomBytes(8).toString("hex")}.${ext}`,
  );
  const wavPath = `${rawPath}.16k.wav`;

  try {
    writeFileSync(rawPath, audioBuffer);

    // whisper.cpp requires 16kHz mono 16-bit PCM WAV input.
    const convert = await runCommand(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        rawPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ],
      { timeoutMs: 60_000 },
    );

    if (convert.code !== 0) {
      throw new Error(
        `ffmpeg conversion failed (exit ${convert.code}): ${shortDetail(convert, 500)}`,
      );
    }

    console.log(
      `[whispercpp] Transcribing ${filename || "voice message"} locally (${audioBuffer.length} bytes)...`,
    );
    const startedAt = Date.now();

    const result = await runCommand(
      binPath(),
      [
        "-m",
        modelPath(),
        "-f",
        wavPath,
        "-t",
        threadCount(),
        "-nt", // no timestamps — plain text only
        "-np", // no progress/system prints, keeps stdout clean
      ],
      { timeoutMs: 5 * 60 * 1000 },
    );

    if (result.code !== 0) {
      throw new Error(
        `whisper-cli failed (exit ${result.code}): ${shortDetail(result, 500)}`,
      );
    }

    const text = cleanTranscript(result.stdout);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    if (!text) {
      console.log(
        `[whispercpp] Completed in ${elapsed}s but produced no speech text (silent or non-speech audio).`,
      );
      return null;
    }

    console.log(
      `[whispercpp] Transcribed in ${elapsed}s (${text.length} chars): "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
    );
    return text;
  } finally {
    for (const p of [rawPath, wavPath]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
