// ---------------------------------------------------------------------------
// Pilot mode — Claude Agent SDK sessions bound to a Discord channel
//
// One long-lived SDK session per pilot channel. The prompt is an async
// iterable (streaming input mode), which is what lets a new Discord message be
// injected while a turn is already running — the thing our own agent loop
// cannot do today.
//
// Boundaries:
//   - cwd is data/pilot/workspace/, never the repo root
//   - the child env is an explicit allowlist (see env.ts)
//   - permissionMode is 'bypassPermissions' (allowDangerouslySkipPermissions):
//     tool calls are NOT gated by our own policy or by permission prompts, so
//     a pilot session can reach the repo, git and credential files. This is a
//     deliberate operator choice; revert to permissionMode 'default' plus a
//     canUseTool gate (see policy.ts) to restore the guard rails.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readlinkSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { DATA_DIR } from "../shared/paths.js";
import { getChannelConfig, setChannelConfig } from "../db/index.js";
import { sendChunked } from "../shared/discord-utils.js";
import { buildPilotEnv } from "./env.js";
import { createPilotMcpServer } from "./bridge.js";
import { getSkillService } from "../skills/service.js";

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

/** Root for pilot mode state. */
export const PILOT_DIR = path.join(DATA_DIR, "pilot");

/** Sandboxed working directory handed to SDK sessions. */
export const PILOT_WORKSPACE_DIR = path.join(PILOT_DIR, "workspace");

/** Idle timeout — a session with no traffic for this long is torn down. */
const PILOT_IDLE_MS = Number(process.env.PILOT_IDLE_MS || 30 * 60 * 1000);

/** How often to check for idle sessions. */
const IDLE_SWEEP_INTERVAL_MS = 60_000;

/** Max characters of a tool input we echo into the channel. */
const TOOL_PREVIEW_CHARS = 160;

// ---------------------------------------------------------------------------
// Channel config helpers — pilot mode is data, not code
// ---------------------------------------------------------------------------

/** True when the given channel is flagged as a pilot channel. */
export function isPilotChannelId(channelId: string): boolean {
  const config = getChannelConfig(channelId);
  return config?.settings?.pilot === true;
}

/**
 * Which channel id decides pilot mode for a message, or null if pilot can
 * never apply. Threads inherit the flag from their parent channel; DMs never
 * run in pilot mode. Pure so the routing rule is testable without Discord.
 */
export function pilotConfigChannelId(input: {
  channelId: string;
  isDM: boolean;
  isThread: boolean;
  parentId?: string | null;
}): string | null {
  if (input.isDM) return null;
  if (input.isThread) return input.parentId ?? null;
  return input.channelId;
}

/** Persist the SDK session id so we can `resume` after a restart. */
function savePilotSessionId(channelId: string, sdkSessionId: string): void {
  const config = getChannelConfig(channelId);
  const settings = { ...(config?.settings ?? {}), pilotSessionId: sdkSessionId };
  setChannelConfig(channelId, { settings });
}

/** Read a previously stored SDK session id for this channel. */
function loadPilotSessionId(channelId: string): string | undefined {
  const value = getChannelConfig(channelId)?.settings?.pilotSessionId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Minimal Discord channel surface we need
// ---------------------------------------------------------------------------

export interface PilotChannelTarget {
  id: string;
  send: (content: string) => Promise<unknown>;
  sendTyping?: () => Promise<void>;
}

export interface PilotIncomingMessage {
  text: string;
  userId: string;
  userName: string;
}

/** Outcome of interrupting a pilot session's current turn. */
export interface PilotInterruptResult {
  /** True when the SDK accepted the interrupt. */
  ok: boolean;
  /** How many of our own queued messages were discarded. */
  dropped: number;
  /**
   * Uuids the CLI says will still run despite the interrupt. Always empty when
   * the CLI does not advertise the `interrupt_receipt_v1` capability.
   */
  stillQueued: string[];
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class PilotSession {
  readonly channelId: string;

  private target: PilotChannelTarget;
  private abortController = new AbortController();

  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private started = false;

  private turnActive = false;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = Date.now();
  private lastUserId: string | undefined;
  private sdkSessionId: string | undefined;
  private loop: Promise<void> | null = null;

  /** Live SDK query handle — needed for native interrupt(). */
  private stream: Query | null = null;
  /** Capabilities advertised by the CLI in the system/init message. */
  private capabilities: string[] = [];

  constructor(target: PilotChannelTarget) {
    this.channelId = target.id;
    this.target = target;
  }

  /** Wall-clock ms since the last message in either direction. */
  get idleMs(): number {
    return Date.now() - this.lastActivityAt;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Refresh the channel object (it can be re-fetched between messages). */
  setTarget(target: PilotChannelTarget): void {
    this.target = target;
  }

  /**
   * Enqueue a Discord message for the session. Safe to call while a turn is
   * already running — that's the mid-conversation injection path.
   */
  submit(message: PilotIncomingMessage): void {
    if (this.closed) return;
    this.lastActivityAt = Date.now();
    this.lastUserId = message.userId;

    const prefixed = `[${message.userName}]: ${message.text}`;
    this.queue.push({
      type: "user",
      message: { role: "user", content: prefixed },
      parent_tool_use_id: null,
      session_id: this.sdkSessionId ?? "",
    } as SDKUserMessage);

    this.startTyping();
    this.turnActive = true;

    const wake = this.wake;
    this.wake = null;
    wake?.();

    if (!this.started) {
      this.started = true;
      this.loop = this.run().catch((err) => {
        console.error("[pilot] session loop crashed:", err);
      });
    }
  }

  /**
   * Interrupt the turn that is currently running, without killing the session.
   *
   * Uses the SDK's native `Query.interrupt()` (streaming-input mode only,
   * which is what we always use). The child process and its context survive —
   * the session simply returns control and waits for the next message.
   *
   * Our own pending queue is dropped here, on our side: the shipped CLI does
   * not implement `cancel_queued`, so anything we already handed over may
   * still run and is reported back via `stillQueued`.
   */
  async interrupt(): Promise<PilotInterruptResult> {
    const dropped = this.queue.length;
    this.queue = [];
    this.lastActivityAt = Date.now();

    const stream = this.stream;
    if (this.closed || !stream) {
      this.turnActive = false;
      this.stopTyping();
      return { ok: false, dropped, stillQueued: [] };
    }

    try {
      const receipt = await stream.interrupt();
      const stillQueued =
        this.capabilities.includes("interrupt_receipt_v1") &&
        Array.isArray(receipt?.still_queued)
          ? receipt.still_queued
          : [];
      this.turnActive = false;
      this.stopTyping();
      return { ok: true, dropped, stillQueued };
    } catch (err) {
      console.error(
        `[pilot] interrupt failed for ${this.channelId}:`,
        err instanceof Error ? err.message : err,
      );
      return { ok: false, dropped, stillQueued: [] };
    }
  }

  /** Stop the session and kill its child process. */
  async stop(reason = "stopped"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopTyping();

    const wake = this.wake;
    this.wake = null;
    wake?.();

    try {
      this.abortController.abort();
    } catch {
      // already aborted
    }

    console.log(`[pilot] session for channel ${this.channelId} ${reason}`);
    if (this.loop) {
      await this.loop.catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Streaming input generator
  // -------------------------------------------------------------------------

  private async *prompt(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        yield next;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  /**
   * Skills are shared with the main agent: the same metadata listing, loaded
   * on demand through the bridged read_skill / list_skill_files tools. The SDK
   * prefixes MCP tool names, so the prompt points at the prefixed forms.
   */
  private buildSkillsPrompt(): string {
    const section = getSkillService()?.buildSkillsPromptSection();
    if (!section) return "";
    return [
      "",
      "",
      section,
      "",
      "In pilot mode these skill tools are named `mcp__discordclaw__read_skill`",
      "and `mcp__discordclaw__list_skill_files`. Skill instructions may refer to",
      "the host bot's tool names (e.g. `bash`, `write_file`, `send_message`) —",
      "use the closest equivalent available to you: the native Bash/Read/Write",
      "tools for local work, and the mcp__discordclaw__ tools for Discord.",
    ].join("\n");
  }

  private buildOptions(): Options {
    const resume = loadPilotSessionId(this.channelId);
    return {
      cwd: PILOT_WORKSPACE_DIR,
      env: buildPilotEnv(),
      // Unguarded by operator choice: no permission prompts, no canUseTool.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      abortController: this.abortController,
      includePartialMessages: false,
      // Isolation: don't inherit the operator's own ~/.claude settings.
      settingSources: [],
      mcpServers: {
        discordclaw: createPilotMcpServer({
          channelId: this.channelId,
          userId: this.lastUserId,
        }),
      },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: [
          "You are running in DiscordClaw 'pilot mode': a Claude Agent SDK session",
          `wired directly to Discord channel ${this.channelId}. Your normal text output`,
          "is relayed to that channel, so answer conversationally and concisely, with",
          "Discord markdown. Keep replies short unless asked for depth.",
          "",
          `Your default working directory is ${PILOT_WORKSPACE_DIR}. Tool calls are not`,
          "gated: prefer the workspace, and be careful with anything outside it. Use the",
          "mcp__discordclaw__ tools for Discord actions (send_message, send_file,",
          "ask_user) and memory.",
          "",
          "New user messages can arrive while you are still working. Treat them as",
          "additional instructions from the same person and adapt mid-task.",
        ].join("\n") + this.buildSkillsPrompt(),
      },
      ...(resume ? { resume } : {}),
      stderr: (data: string) => {
        const trimmed = data.trim();
        if (trimmed) console.error(`[pilot:cli] ${trimmed.slice(0, 500)}`);
      },
    };
  }

  private async run(): Promise<void> {
    ensurePilotDirs();
    const options = this.buildOptions();

    console.log(
      `[pilot] starting SDK session for channel ${this.channelId} (cwd=${PILOT_WORKSPACE_DIR}${options.resume ? `, resume=${options.resume}` : ""})`,
    );

    try {
      const stream = query({ prompt: this.prompt(), options });
      this.stream = stream;
      for await (const message of stream) {
        this.lastActivityAt = Date.now();
        await this.relay(message);
      }
    } catch (err) {
      if (this.closed) return;
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[pilot] session error for ${this.channelId}: ${detail}`);
      await this.say(`⚠️ Pilot session error: ${detail.slice(0, 500)}`);
    } finally {
      this.stream = null;
      this.stopTyping();
      this.turnActive = false;
      removeSession(this.channelId, this);
    }
  }

  // -------------------------------------------------------------------------
  // Relay SDK messages to Discord
  // -------------------------------------------------------------------------

  private async relay(message: SDKMessage): Promise<void> {
    if (message.type === "system") {
      const subtype = (message as { subtype?: string }).subtype;
      const sessionId = (message as { session_id?: string }).session_id;
      if (subtype === "init") {
        // Feature-detect from the init handshake rather than sniffing versions.
        const caps = (message as { capabilities?: unknown }).capabilities;
        this.capabilities = Array.isArray(caps)
          ? caps.filter((c): c is string => typeof c === "string")
          : [];
        if (sessionId) {
          this.sdkSessionId = sessionId;
          savePilotSessionId(this.channelId, sessionId);
          console.log(`[pilot] session id ${sessionId} for ${this.channelId}`);
        }
      }
      return;
    }

    if (message.type === "assistant") {
      const blocks = (message as { message?: { content?: unknown } }).message
        ?.content;
      if (!Array.isArray(blocks)) return;

      for (const block of blocks) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          const text = b.text.trim();
          if (text) await this.say(text);
        } else if (b.type === "tool_use") {
          await this.say(this.formatToolUse(b));
        }
      }
      return;
    }

    if (message.type === "result") {
      this.turnActive = false;
      this.stopTyping();
      const result = message as {
        subtype?: string;
        is_error?: boolean;
        result?: string;
      };
      if (result.is_error) {
        const detail =
          typeof result.result === "string" && result.result
            ? result.result
            : (result.subtype ?? "unknown error");
        await this.say(`⚠️ Pilot turn ended with an error: ${detail.slice(0, 500)}`);
      }
      return;
    }
  }

  private formatToolUse(block: Record<string, unknown>): string {
    const name = typeof block.name === "string" ? block.name : "tool";
    const input = block.input as Record<string, unknown> | undefined;
    let preview = "";
    if (input) {
      const candidate =
        (typeof input.command === "string" && input.command) ||
        (typeof input.file_path === "string" && input.file_path) ||
        (typeof input.path === "string" && input.path) ||
        (typeof input.pattern === "string" && input.pattern) ||
        (typeof input.query === "string" && input.query) ||
        (typeof input.url === "string" && input.url) ||
        "";
      preview = candidate
        ? String(candidate).replace(/\s+/g, " ").slice(0, TOOL_PREVIEW_CHARS)
        : "";
    }
    const shortName = name.replace(/^mcp__discordclaw__/, "");
    return preview
      ? `-# ⚙️ **${shortName}** \`${preview}\``
      : `-# ⚙️ **${shortName}**`;
  }

  private async say(text: string): Promise<void> {
    try {
      await sendChunked(this.target, text);
    } catch (err) {
      console.error(
        `[pilot] failed to send to ${this.channelId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Typing indicator
  // -------------------------------------------------------------------------

  private startTyping(): void {
    if (!this.target.sendTyping) return;
    this.target.sendTyping().catch(() => {});
    if (this.typingTimer) return;
    this.typingTimer = setInterval(() => {
      if (!this.turnActive) {
        this.stopTyping();
        return;
      }
      this.target.sendTyping?.().catch(() => {});
    }, 8_000);
  }

  private stopTyping(): void {
    if (this.typingTimer) {
      clearInterval(this.typingTimer);
      this.typingTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const sessions = new Map<string, PilotSession>();

function removeSession(channelId: string, session: PilotSession): void {
  if (sessions.get(channelId) === session) {
    sessions.delete(channelId);
  }
}

/** Ensure the pilot data directories exist. */
export function ensurePilotDirs(): void {
  for (const dir of [PILOT_DIR, PILOT_WORKSPACE_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/** Get (or create) the pilot session for a channel and hand it a message. */
export function submitToPilotSession(
  target: PilotChannelTarget,
  message: PilotIncomingMessage,
): PilotSession {
  let session = sessions.get(target.id);
  if (!session || session.isClosed) {
    session = new PilotSession(target);
    sessions.set(target.id, session);
  } else {
    session.setTarget(target);
  }
  session.submit(message);
  return session;
}

/** Number of live pilot sessions. */
export function activePilotSessionCount(): number {
  return sessions.size;
}

/** Channel ids with a live pilot session. */
export function activePilotChannelIds(): string[] {
  return [...sessions.keys()];
}

/**
 * Interrupt the current turn of one channel's pilot session, keeping the
 * session (and its context) alive. Returns null when no session is running.
 */
export async function interruptPilotSession(
  channelId: string,
): Promise<PilotInterruptResult | null> {
  const session = sessions.get(channelId);
  if (!session || session.isClosed) return null;
  return session.interrupt();
}

/** Stop the pilot session for one channel. Returns true if one was running. */
export async function stopPilotSession(channelId: string): Promise<boolean> {
  const session = sessions.get(channelId);
  if (!session) return false;
  await session.stop("stopped by request");
  sessions.delete(channelId);
  return true;
}

/** Stop every pilot session. Returns how many were stopped. */
export async function stopAllPilotSessions(): Promise<number> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((s) => s.stop("stopped (shutdown/stop-all)")));
  return all.length;
}

// ---------------------------------------------------------------------------
// Idle reaping
// ---------------------------------------------------------------------------

let idleTimer: ReturnType<typeof setInterval> | null = null;

function startIdleReaper(): void {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    for (const [channelId, session] of [...sessions.entries()]) {
      if (session.idleMs > PILOT_IDLE_MS) {
        sessions.delete(channelId);
        void session.stop(`reaped after ${Math.round(session.idleMs / 1000)}s idle`);
      }
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  idleTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Orphan sweep
//
// If we were SIGKILLed, SDK child processes can outlive us. We identify them
// precisely — and safely — by looking for processes whose cwd is the pilot
// workspace directory. Nothing else on the machine uses that directory, so
// there is no risk of killing an unrelated `claude` session.
// ---------------------------------------------------------------------------

/** Kill leftover pilot child processes from a previous run. */
export function sweepOrphanPilotProcesses(): number {
  if (process.platform !== "linux" || !existsSync("/proc")) return 0;

  let killed = 0;
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;

    let cwd: string;
    try {
      cwd = readlinkSync(`/proc/${entry}/cwd`);
    } catch {
      continue; // not ours / no permission
    }
    if (path.resolve(cwd) !== path.resolve(PILOT_WORKSPACE_DIR)) continue;

    let cmdline = "";
    try {
      cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      continue;
    }
    if (!/claude|cli\.js/.test(cmdline)) continue;

    try {
      process.kill(pid, "SIGTERM");
      killed += 1;
      console.log(`[pilot] swept orphan pilot process ${pid}: ${cmdline.slice(0, 120)}`);
    } catch {
      // already gone
    }
  }

  return killed;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

let shutdownHooksInstalled = false;

/**
 * Initialise pilot mode: create directories, sweep orphaned children from a
 * previous run, start the idle reaper and install shutdown hooks.
 * Safe to call more than once.
 */
export function initPilot(): void {
  ensurePilotDirs();
  sweepOrphanPilotProcesses();
  startIdleReaper();

  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;

  const shutdown = () => {
    void stopAllPilotSessions();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("beforeExit", shutdown);
}
