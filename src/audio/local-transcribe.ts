/**
 * Fully local/offline audio transcription using NVIDIA's Parakeet ASR
 * model, served through NVIDIA's NeMo toolkit. No audio leaves the machine.
 *
 * On first use, lazily installs the required Python packages
 * (`nemo_toolkit[asr]`, `soundfile`, `librosa`) — this can take a few
 * minutes and a few GB of disk the very first time. After that, the model
 * itself is cached locally (~/.cache/huggingface) and everything runs
 * offline.
 *
 * This is the preferred transcription backend (privacy-friendly, no
 * external API key required). `transcribe.ts` falls back to OpenAI's
 * Whisper API only if this local path is unavailable or fails and
 * OPENAI_API_KEY is set.
 */

import { spawn } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { count } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARAKEET_SCRIPT = join(__dirname, "parakeet_transcribe.py");
const DEFAULT_MODEL = "nvidia/parakeet-tdt-0.6b-v2";

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
  return lastLine.length > maxLen ? `${lastLine.slice(-maxLen)}` : lastLine;
}

// ---------------------------------------------------------------------------
// Setup / readiness check (cached, lazy install on first use)
// ---------------------------------------------------------------------------

let setupChecked = false;
let setupAvailable = false;
let setupPromise: Promise<boolean> | null = null;
/** Human-readable reason the local stack is unavailable, if applicable. */
let setupFailureReason: string | null = null;

async function checkNemoInstalled(): Promise<CommandResult> {
  return runCommand(
    "python3",
    ["-c", "import nemo.collections.asr"],
    { timeoutMs: 15_000 },
  );
}

/**
 * Figure out which pip invocation actually works on this host. Some
 * environments (notably minimal/embedded Python installs) don't have a
 * `pip3` binary on PATH even though `python3 -m pip` works, or vice versa.
 * Tries `pip3` first, then falls back to `python3 -m pip`.
 */
async function resolvePipCommand(): Promise<
  { cmd: string; baseArgs: string[] } | null
> {
  const pip3Check = await runCommand("pip3", ["--version"], {
    timeoutMs: 5_000,
  });
  if (pip3Check.code === 0) {
    return { cmd: "pip3", baseArgs: [] };
  }
  console.log(
    `[local-audio] 'pip3' unavailable (${shortDetail(pip3Check)}) — trying 'python3 -m pip' instead...`,
  );

  const pyPipCheck = await runCommand("python3", ["-m", "pip", "--version"], {
    timeoutMs: 5_000,
  });
  if (pyPipCheck.code === 0) {
    return { cmd: "python3", baseArgs: ["-m", "pip"] };
  }

  console.error(
    `[local-audio] No usable pip found. 'pip3 --version' -> ${shortDetail(pip3Check)}; 'python3 -m pip --version' -> ${shortDetail(pyPipCheck)}`,
  );
  return null;
}

/**
 * Ensure the local Parakeet/NeMo transcription stack is installed and ready.
 * Result is cached for the process lifetime. If NeMo isn't installed yet,
 * this triggers a one-time `pip install` (can take several minutes).
 *
 * @param onStatus - optional callback invoked with a human-readable status
 *   update (e.g. to post a "setting up, please wait" message to Discord).
 */
export async function ensureLocalTranscriptionReady(
  onStatus?: (msg: string) => void,
): Promise<boolean> {
  if (setupChecked) return setupAvailable;
  if (setupPromise) return setupPromise;

  setupPromise = (async () => {
    const ffmpegCheck = await runCommand("ffmpeg", ["-version"], {
      timeoutMs: 5_000,
    });
    if (ffmpegCheck.code !== 0) {
      setupFailureReason = `ffmpeg not found on PATH (${shortDetail(ffmpegCheck)}). Install it, e.g. 'apt-get install -y ffmpeg'.`;
      console.error(`[local-audio] ${setupFailureReason}`);
      setupChecked = true;
      setupAvailable = false;
      return false;
    }

    const alreadyInstalled = await checkNemoInstalled();
    if (alreadyInstalled.code === 0) {
      console.log(
        "[local-audio] NeMo/Parakeet already installed — local transcription ready.",
      );
      setupFailureReason = null;
      setupChecked = true;
      setupAvailable = true;
      return true;
    }

    console.log(
      `[local-audio] NeMo/Parakeet not installed yet (${shortDetail(alreadyInstalled)}) — attempting one-time setup...`,
    );

    const pip = await resolvePipCommand();
    if (!pip) {
      setupFailureReason =
        "No usable pip installation found (checked 'pip3' and 'python3 -m pip'). Install pip to enable local voice transcription, e.g. 'apt-get install -y python3-pip', then it will retry automatically after a restart.";
      console.error(`[local-audio] ${setupFailureReason}`);
      setupChecked = true;
      setupAvailable = false;
      return false;
    }

    console.log(
      `[local-audio] Installing nemo_toolkit via '${[pip.cmd, ...pip.baseArgs, "install"].join(" ")} ...' (one-time, can take several minutes)...`,
    );
    onStatus?.(
      "🔧 Setting up local voice transcription (NVIDIA Parakeet) for the first time — this can take a few minutes, hang tight...",
    );

    const install = await runCommand(
      pip.cmd,
      [...pip.baseArgs, "install", "-U", "nemo_toolkit[asr]", "soundfile", "librosa"],
      { timeoutMs: 20 * 60 * 1000 }, // up to 20 minutes for first install
    );

    if (install.code !== 0) {
      setupFailureReason = `pip install of nemo_toolkit failed (exit code ${install.code}): ${shortDetail(install, 1500)}`;
      console.error(
        `[local-audio] ${setupFailureReason}\nFull stderr tail:\n${install.stderr.slice(-2000)}`,
      );
      setupChecked = true;
      setupAvailable = false;
      return false;
    }

    const nowInstalled = await checkNemoInstalled();
    setupChecked = true;
    setupAvailable = nowInstalled.code === 0;

    if (setupAvailable) {
      setupFailureReason = null;
      console.log(
        "[local-audio] NeMo/Parakeet installed successfully — local transcription ready.",
      );
    } else {
      setupFailureReason = `pip install reported success, but 'import nemo.collections.asr' still fails afterward (${shortDetail(nowInstalled)}). Possible partial/broken install.`;
      console.error(`[local-audio] ${setupFailureReason}`);
    }

    return setupAvailable;
  })();

  return setupPromise;
}

/** Synchronous check of whether setup has already succeeded (no side effects). */
export function isLocalTranscriptionKnownReady(): boolean {
  return setupChecked && setupAvailable;
}

/**
 * Diagnostic snapshot of local transcription readiness, useful for logging
 * *why* the local path is unavailable (e.g. surfaced by transcribe.ts /
 * messages.ts when both local and OpenAI fallback fail).
 */
export function getLocalTranscriptionStatus(): {
  checked: boolean;
  ready: boolean;
  reason: string | null;
} {
  return { checked: setupChecked, ready: setupAvailable, reason: setupFailureReason };
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

// ---------------------------------------------------------------------------
// Transcribe (local)
// ---------------------------------------------------------------------------

/**
 * Download and transcribe an audio file fully locally using NVIDIA Parakeet.
 * Returns the transcribed text, or null if the local stack is unavailable
 * or transcription otherwise fails.
 *
 * @param url - URL of the audio file (e.g. Discord attachment URL)
 * @param filename - Original filename (used to determine format)
 * @param onStatus - optional progress callback (see ensureLocalTranscriptionReady)
 */
export async function transcribeAudioLocal(
  url: string,
  filename?: string,
  onStatus?: (msg: string) => void,
): Promise<string | null> {
  count(P.audioTranscribeLocalNemo);
  const ready = await ensureLocalTranscriptionReady(onStatus);
  if (!ready) {
    const status = getLocalTranscriptionStatus();
    console.log(
      `[local-audio] Local transcription stack unavailable — skipping. Reason: ${status.reason || "unknown"}`,
    );
    return null;
  }

  const audioBuffer = await downloadFile(url);
  const ext = filename?.split(".").pop() || "ogg";
  const rawPath = join(
    tmpdir(),
    `discordclaw-voice-${randomBytes(8).toString("hex")}.${ext}`,
  );
  const wavPath = rawPath.replace(new RegExp(`\\.${ext}$`), ".wav");

  try {
    writeFileSync(rawPath, audioBuffer);

    // Parakeet requires 16kHz mono WAV input
    const convert = await runCommand(
      "ffmpeg",
      ["-y", "-i", rawPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      { timeoutMs: 60_000 },
    );

    if (convert.code !== 0) {
      console.error(
        `[local-audio] ffmpeg conversion failed (exit code ${convert.code}):`,
        convert.stderr.slice(-1000),
      );
      return null;
    }

    console.log(
      `[local-audio] Transcribing ${filename || "voice message"} locally via Parakeet (${audioBuffer.length} bytes)...`,
    );

    const result = await runCommand(
      "python3",
      [PARAKEET_SCRIPT, wavPath, "--model", DEFAULT_MODEL],
      { timeoutMs: 5 * 60 * 1000 }, // model load + inference, generous for CPU fallback
    );

    if (result.code !== 0) {
      console.error(
        `[local-audio] Parakeet transcription failed (exit code ${result.code}):`,
        result.stderr.slice(-1000),
      );
      return null;
    }

    const lines = result.stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1] || "";
    try {
      const parsed = JSON.parse(lastLine) as { text?: string; error?: string };
      if (parsed.error) {
        console.error("[local-audio] Parakeet reported error:", parsed.error);
        return null;
      }
      const text = (parsed.text || "").trim();
      console.log(
        `[local-audio] Transcription result (${text.length} chars): "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
      );
      return text || null;
    } catch (parseErr) {
      console.error(
        `[local-audio] Could not parse Parakeet output (${String(parseErr)}):`,
        lastLine.slice(0, 200),
      );
      return null;
    }
  } catch (err) {
    console.error(
      `[local-audio] Unexpected error during local transcription of ${filename || "voice message"}:`,
      err,
    );
    return null;
  } finally {
    try {
      unlinkSync(rawPath);
    } catch {
      // ignore cleanup errors
    }
    try {
      if (existsSync(wavPath)) unlinkSync(wavPath);
    } catch {
      // ignore cleanup errors
    }
  }
}
