// ---------------------------------------------------------------------------
// Pilot mode — Claude Agent SDK sessions bound to a Discord channel
//
// One long-lived SDK session per pilot channel. The prompt is an async
// iterable (streaming input mode), which is what lets a new Discord message be
// injected while a turn is already running — the thing our own agent loop
// cannot do today.
//
// Boundaries: effectively none, by operator choice.
//   - cwd is data/pilot/workspace/, but nothing confines the session to it
//   - the child inherits the full process environment, secrets included
//     (see env.ts) — a pilot session can read DISCORD_BOT_TOKEN, GH_TOKEN and
//     every provider key straight out of its own env
//   - permissionMode is 'bypassPermissions' (allowDangerouslySkipPermissions):
//     tool calls are NOT gated by permission prompts or a canUseTool hook, so
//     a pilot session can reach the repo, git and credential files.
//   To restore guard rails: filter the child env in env.ts, and set
//   permissionMode 'default' with a canUseTool gate or a PreToolUse hook.
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
import { getChannelConfig, setChannelConfig, addMessage } from "../db/index.js";
import type { ChannelConfig } from "../db/index.js";
import { resolveModel } from "../shared/models.js";
import { broadcastLog } from "../gateway/server.js";
import { sendChunked } from "../shared/discord-utils.js";
import { fmtDuration, fmtTokens } from "../shared/format.js";
import { buildPilotEnv } from "./env.js";
import { createPilotMcpServer } from "./bridge.js";
import { PilotRelayQueue } from "./relay-queue.js";
import { getSkillService } from "../skills/service.js";
import { getSoul } from "../soul/soul.js";
import { recordSignal } from "../reflection/signals.js";
import {
  MEMORY_RECALL_INSTRUCTIONS,
  buildCavemanInstructions,
  getCavemanLevel,
} from "../shared/prompt-fragments.js";
import { EVOLUTION_INSTRUCTIONS } from "../evolution/instructions.js";
import { count } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

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

/**
 * How long a single turn may run before it is interrupted. A wedged turn used
 * to hang forever with the typing indicator on and no way back except /stop.
 * Interrupt, not kill: the child and its context survive, so "continue" works.
 */
const PILOT_TURN_TIMEOUT_MS = Number(
  process.env.PILOT_TURN_TIMEOUT_MS || 15 * 60 * 1000,
);

/**
 * Soft per-turn spend warning (USD). 0 disables. Purely advisory — pilot never
 * refuses to run because of cost, it just says so in the channel.
 */
const PILOT_TURN_MAX_COST_USD = Number(process.env.PILOT_TURN_MAX_COST_USD || 0);

/** Reaction dropped on a message that steered a turn already in flight. */
const STEER_EMOJI = "↩️";

/** Max characters of a failed tool result we echo into the channel. */
const TOOL_ERROR_CHARS = 200;

/** How many tool_use ids we keep around to label their results. */
const TOOL_NAME_CACHE_LIMIT = 64;

/**
 * How many user messages we keep for replay. Only used when a resume fails
 * before the session produced anything, so the queue is short by definition.
 */
const REPLAY_LIMIT = 20;

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

/**
 * Forget the stored SDK session id. Called when the CLI cannot resume it —
 * otherwise the stale id is passed forever and every turn in that thread dies
 * on the same error.
 */
function clearPilotSessionId(channelId: string): void {
  const config = getChannelConfig(channelId);
  const settings = { ...(config?.settings ?? {}) };
  delete settings.pilotSessionId;
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
  /**
   * Parent channel when this target is a thread. A session is keyed to the
   * thread, but every channel-level command (`/clear`, `/interrupt`, `/pilot
   * off`) and every channel-level setting lives on the parent — without this
   * link those commands could only find a session when typed inside the thread.
   */
  parentId?: string | null;
}

export interface PilotIncomingMessage {
  text: string;
  userId: string;
  userName: string;
  /**
   * Conversation-row id (from `resolveSession`) this turn belongs to. When set,
   * the session writes one assistant row per turn so pilot conversations land in
   * the same archive/history as every other channel. Absent = no logging.
   */
  logSessionId?: string;
  /** Channel name, for the log-viewer broadcast only. */
  channelName?: string;
  /**
   * Best-effort reaction hook on the Discord message this came from. Used to
   * mark a message that landed mid-turn; absent when the caller has no message
   * to react to.
   */
  react?: (emoji: string) => Promise<unknown>;
  /**
   * Model for this session, used only when the session is created (the child's
   * model is fixed once it spawns). Cron jobs carry a per-job override; without
   * this the override was logged and thrown away.
   */
  modelOverride?: string;
}

/** Outcome of interrupting a pilot session's current turn. */
export interface PilotInterruptResult {
  /** True when the SDK accepted the interrupt. */
  ok: boolean;
  /** How many of our own queued messages were discarded. */
  dropped: number;
  /** Short name of the tool that was in flight, when there was one. */
  lastTool: string | null;
  /**
   * Uuids the CLI says will still run despite the interrupt. Always empty when
   * the CLI does not advertise the `interrupt_receipt_v1` capability.
   */
  stillQueued: string[];
}

// ---------------------------------------------------------------------------
// Small relay helpers
// ---------------------------------------------------------------------------

/** Coerce an unknown JSON number to a finite number, defaulting to 0. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The model that did most of the talking in a turn, from the SDK's per-model
 * usage map. Subagents can add entries, so pick the busiest rather than the
 * first.
 */
function primaryModel(modelUsage: unknown): string | null {
  if (!modelUsage || typeof modelUsage !== "object") return null;
  let best: string | null = null;
  let bestTokens = -1;
  for (const [model, usage] of Object.entries(modelUsage as Record<string, unknown>)) {
    const tokens = num((usage as Record<string, unknown> | null)?.outputTokens);
    if (tokens > bestTokens) {
      bestTokens = tokens;
      best = model;
    }
  }
  return best;
}

/** One-line summary of a failed tool_result's content, for the channel. */
function summariseToolResult(content: unknown): string {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        const p = part as Record<string, unknown>;
        return p && p.type === "text" && typeof p.text === "string" ? p.text : "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return text.replace(/\s+/g, " ").trim().slice(0, TOOL_ERROR_CHARS);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class PilotSession {
  readonly channelId: string;
  /** Parent channel when this session is keyed to a thread. */
  parentId: string | null;
  /** Model for the child, captured from the first message (see submit()). */
  private modelOverride: string | undefined;

  private target: PilotChannelTarget;
  private abortController = new AbortController();

  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private started = false;

  private turnActive = false;
  /** Watchdog for the turn in flight — see PILOT_TURN_TIMEOUT_MS. */
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = Date.now();
  private lastUserId: string | undefined;
  private sdkSessionId: string | undefined;
  private loop: Promise<void> | null = null;

  /** Short name of the most recent tool call, for steer/interrupt markers. */
  private lastToolName: string | null = null;
  /** True once the running turn has relayed anything to the channel. */
  private sawTurnOutput = false;
  /** How many times the running turn has been steered mid-flight. */
  private steerCount = 0;

  /** Live SDK query handle — needed for native interrupt(). */
  private stream: Query | null = null;
  /** Capabilities advertised by the CLI in the system/init message. */
  private capabilities: string[] = [];

  /** True once the CLI has handshaked — tells a resume failure from a real one. */
  private sawInit = false;
  /** Messages handed to the CLI but not yet answered, for resume replay. */
  private pendingReplay: SDKUserMessage[] = [];
  /** Conversation row + channel name for logging, from the latest message. */
  private logSessionId?: string;
  private logChannelName?: string;
  /** Assistant text relayed so far this turn, joined into one row at `result`. */
  private turnText: string[] = [];
  /** tool_use id -> short tool name, so we can label failed results. */
  private toolNames = new Map<string, string>();
  /** Cost the last result reported — the SDK's total is cumulative. */
  private lastCostUsd = 0;

  /** Order-preserving, rate-limited outbound relay to the channel. */
  private outbound: PilotRelayQueue;

  constructor(target: PilotChannelTarget) {
    this.channelId = target.id;
    this.parentId = target.parentId ?? null;
    this.target = target;
    // Reads this.target on every send, so a re-fetched channel object is picked
    // up without rebuilding the queue.
    this.outbound = new PilotRelayQueue({
      send: (text) => sendChunked(this.target, text),
      onError: (err) =>
        console.error(
          `[pilot] failed to send to ${this.channelId}:`,
          err instanceof Error ? err.message : err,
        ),
    });
  }

  /**
   * Who the session is talking to right now. Handed to the MCP bridge as a
   * function so `ask_user` mentions and `evolve_*` attribution track the
   * current speaker instead of freezing on whoever opened the session.
   */
  private currentUserId = (): string | undefined => this.lastUserId;

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
    if (target.parentId !== undefined) this.parentId = target.parentId;
  }

  /**
   * Enqueue a Discord message for the session. Safe to call while a turn is
   * already running — that's the mid-conversation injection path.
   */
  submit(message: PilotIncomingMessage): void {
    if (this.closed) return;
    this.lastActivityAt = Date.now();
    this.lastUserId = message.userId;
    // Only meaningful before the child spawns — its model is fixed after that.
    if (!this.started && message.modelOverride) {
      this.modelOverride = message.modelOverride;
    }
    if (message.logSessionId) this.logSessionId = message.logSessionId;
    if (message.channelName) this.logChannelName = message.channelName;

    // A steer is a message that lands after the turn already started talking.
    // Messages fired back-to-back before any output are just batched input, so
    // they are deliberately not marked.
    const steered = this.turnActive && this.sawTurnOutput;

    const prefixed = `[${message.userName}]: ${message.text}`;
    this.queue.push({
      type: "user",
      message: { role: "user", content: prefixed },
      parent_tool_use_id: null,
      session_id: this.sdkSessionId ?? "",
    } as SDKUserMessage);

    this.beginTurn();

    const wake = this.wake;
    this.wake = null;
    wake?.();

    if (steered) {
      this.steerCount += 1;
      void this.markSteer(message);
    }

    if (!this.started) {
      this.started = true;
      this.loop = this.run().catch((err) => {
        console.error("[pilot] session loop crashed:", err);
      });
    }
  }

  /**
   * Visualise a mid-turn steer: react on the message that cut in, then drop a
   * subtle marker line so the transcript shows where the course changed and
   * what was in flight at the time.
   */
  private async markSteer(message: PilotIncomingMessage): Promise<void> {
    try {
      await message.react?.(STEER_EMOJI);
    } catch {
      // Reactions are cosmetic — a missing permission must not break the turn.
    }
    const nth = this.steerCount > 1 ? ` ${this.steerCount}×` : "";
    const was = this.lastToolName ? ` · was **${this.lastToolName}**` : "";
    this.say(`-# ${STEER_EMOJI} **steered mid-run**${nth}${was}`);
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
    count(P.pilotSessionInterrupt);
    const dropped = this.queue.length;
    const lastTool = this.lastToolName;
    this.queue = [];
    this.lastActivityAt = Date.now();

    const stream = this.stream;
    if (this.closed || !stream) {
      this.endTurn();
      return { ok: false, dropped, stillQueued: [], lastTool };
    }

    try {
      const receipt = await stream.interrupt();
      const stillQueued =
        this.capabilities.includes("interrupt_receipt_v1") &&
        Array.isArray(receipt?.still_queued)
          ? receipt.still_queued
          : [];
      this.endTurn();
      return { ok: true, dropped, stillQueued, lastTool };
    } catch (err) {
      console.error(
        `[pilot] interrupt failed for ${this.channelId}:`,
        err instanceof Error ? err.message : err,
      );
      return { ok: false, dropped, stillQueued: [], lastTool };
    }
  }

  /** Turn is over: flush output, stop typing, reset per-turn markers. */
  /** Mark a turn as running: typing indicator on, watchdog armed. */
  private beginTurn(): void {
    this.turnActive = true;
    this.startTyping();
    this.armTurnWatchdog();
  }

  /**
   * Arm (or re-arm) the turn watchdog. Idempotent: a second message inside the
   * same turn extends the deadline, which is what a user steering a long task
   * expects.
   */
  private armTurnWatchdog(): void {
    this.clearTurnWatchdog();
    if (!(PILOT_TURN_TIMEOUT_MS > 0)) return;
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      if (this.closed || !this.turnActive) return;
      const minutes = Math.round(PILOT_TURN_TIMEOUT_MS / 60_000);
      console.warn(
        `[pilot] turn in ${this.channelId} exceeded ${minutes}m — interrupting`,
      );
      this.say(
        `-# ⏱️ turn ran past ${minutes}m — interrupting it. The session keeps its context, so say "continue" to resume.`,
      );
      void this.interrupt();
    }, PILOT_TURN_TIMEOUT_MS);
    // Never hold the process open for a watchdog.
    this.turnTimer.unref?.();
  }

  private clearTurnWatchdog(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }

  private endTurn(): void {
    // Before the flags reset: an interrupted or errored turn still said things,
    // and logTurn() clears its own buffer, so this is safe to call on every path.
    this.logTurn();
    this.clearTurnWatchdog();
    this.turnActive = false;
    this.sawTurnOutput = false;
    this.steerCount = 0;
    this.stopTyping();
    // The debounce must never outlive the turn, or the tail of a transcript
    // sits in the buffer until the next message arrives.
    void this.outbound.flush();
  }

  /**
   * Stop the session and kill its child process. `notice` is relayed to the
   * channel first, so a teardown the user did not ask for (an idle reap) can
   * explain itself.
   */
  async stop(reason = "stopped", notice?: string): Promise<void> {
    if (this.closed) return;
    count(P.pilotSessionStop);
    this.closed = true;
    this.stopTyping();
    this.clearTurnWatchdog();

    if (notice) this.say(notice);

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
    await this.outbound.close();
  }

  // -------------------------------------------------------------------------
  // Streaming input generator
  // -------------------------------------------------------------------------

  private async *prompt(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        this.pendingReplay.push(next);
        if (this.pendingReplay.length > REPLAY_LIMIT) this.pendingReplay.shift();
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
   * Model for the child process.
   *
   * The child used to take whatever `ANTHROPIC_MODEL` the bot happened to have,
   * so `/model` (and a cron job's per-job model) applied to every runtime
   * except this one. `PILOT_ANTHROPIC_MODEL` still wins — it is the explicit
   * "pin pilot to its own model" escape hatch — so we only override when it is
   * unset.
   */
  private modelEnvOverrides(): Record<string, string> {
    if (process.env.PILOT_ANTHROPIC_MODEL) return {};
    const model = resolveModel(this.modelOverride);
    return model ? { ANTHROPIC_MODEL: model } : {};
  }

  /**
   * SOUL.md and the memory-recall rules — the bot's identity and habits, shared
   * verbatim with the main agent. Without them a pilot channel answered as a
   * generic Claude Code session and never searched memory unasked.
   */
  private buildIdentityPrompt(): string {
    const parts: string[] = [];
    const soul = getSoul();
    if (soul) parts.push(`## Soul\n\n${soul}`);
    parts.push(MEMORY_RECALL_INSTRUCTIONS);
    return `\n\n${parts.join("\n\n")}`;
  }

  /**
   * Channel settings for this session, thread row first and then the parent.
   *
   * A session is keyed to a thread, but `/caveman` and `/config set-prompt` are
   * usually typed in the parent channel — and that is also the row the main
   * agent reads. Checking the thread first keeps a per-thread override working
   * while making the channel-level setting actually land.
   */
  private channelSettings<T>(read: (config: ChannelConfig | undefined) => T): T {
    const own = read(getChannelConfig(this.channelId));
    if (own !== undefined && own !== null && own !== "") return own;
    if (!this.parentId) return own;
    return read(getChannelConfig(this.parentId));
  }

  /**
   * Caveman mode, if /caveman is on for this channel. Read when the session
   * starts: the system prompt is fixed for the life of the SDK child, so a
   * level changed mid-session applies from the next session (idle reap, /stop).
   */
  private buildCavemanPrompt(): string {
    const level = this.channelSettings((config) => getCavemanLevel(config));
    if (!level) return "";
    return `\n\n${buildCavemanInstructions(level)}`;
  }

  /**
   * The channel's own system prompt from `/config set-prompt`. The main agent
   * has always injected this; pilot ignored it, so the command replied
   * "updated" and changed nothing in a pilot channel.
   */
  private buildChannelPrompt(): string {
    const prompt = this.channelSettings((config) => config?.systemPrompt);
    if (!prompt || !prompt.trim()) return "";
    return `\n\n## Channel Instructions\n\n${prompt.trim()}`;
  }

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

  /**
   * Self-evolution rules, shared verbatim with the main agent, plus the pilot
   * tool-name mapping. The plan-approval gate applies identically here.
   */
  private buildEvolutionPrompt(): string {
    return [
      "",
      "",
      EVOLUTION_INSTRUCTIONS,
      "",
      "In pilot mode these tools are named `mcp__discordclaw__evolve_start`,",
      "`mcp__discordclaw__evolve_read`, `mcp__discordclaw__evolve_write`,",
      "`mcp__discordclaw__evolve_bash`, `mcp__discordclaw__evolve_propose`,",
      "`mcp__discordclaw__evolve_suggest`, `mcp__discordclaw__evolve_cancel`,",
      "`mcp__discordclaw__evolve_review` and `mcp__discordclaw__evolve_merge`.",
      "The plan-approval gate applies exactly the same way: post the build plan to",
      "the channel, end your turn, and wait for the user to explicitly approve",
      "before calling evolve_start.",
      "",
      "Your native Bash/Read/Write tools can reach the bot's source checkout, but",
      "you must NOT edit `src/`, TypeScript files, `start.sh` or `migrations/`",
      "with them. All source changes go through the evolve_* worktree tools so",
      "they are validated and shipped as a PR.",
    ].join("\n");
  }

  private buildOptions(): Options {
    const resume = loadPilotSessionId(this.channelId);
    return {
      cwd: PILOT_WORKSPACE_DIR,
      env: buildPilotEnv({ overrides: this.modelEnvOverrides() }),
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
          // A getter, not a value: the server is built once but the person
          // talking changes, and ask_user / evolve_* must follow them.
          getUserId: this.currentUserId,
        }),
        ...(process.env.NOTION_API_KEY
          ? {
              notion: {
                type: "stdio",
                command: "npx",
                args: ["-y", "@notionhq/notion-mcp-server"],
                env: { NOTION_TOKEN: process.env.NOTION_API_KEY },
              },
            }
          : {}),
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
        ].join("\n") +
          this.buildIdentityPrompt() +
          this.buildChannelPrompt() +
          this.buildSkillsPrompt() +
          this.buildEvolutionPrompt() +
          this.buildCavemanPrompt(),
      },
      ...(resume ? { resume } : {}),
      stderr: (data: string) => {
        const trimmed = data.trim();
        if (trimmed) console.error(`[pilot:cli] ${trimmed.slice(0, 500)}`);
      },
    };
  }

  /**
   * Run the SDK session until it ends.
   *
   * A stored session id can go stale (the CLI prunes its own transcripts, or a
   * restart lands on a different machine). Resuming it then fails immediately —
   * before the `system/init` handshake — and every later turn in that thread
   * hits the same wall. So a failure with no handshake is treated as a bad
   * resume exactly once: forget the id, replay whatever the CLI never answered,
   * and start fresh.
   */
  private async run(): Promise<void> {
    ensurePilotDirs();

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const options = this.buildOptions();
        const resumed = Boolean(options.resume);
        this.sawInit = false;

        // A retry inherits a queue that the previous attempt's endTurn() just
        // marked idle, so re-arm the turn state before handing it over.
        if (this.queue.length > 0) {
          this.beginTurn();
        }

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
          return;
        } catch (err) {
          if (this.closed) return;
          const detail = err instanceof Error ? err.message : String(err);
          console.error(`[pilot] session error for ${this.channelId}: ${detail}`);
          // Feed the reflection daemon the same way agent errors do, so pilot
          // failures are visible to self-improvement instead of console-only.
          recordSignal({
            type: "error",
            source: "pilot",
            detail: `Pilot session error: ${detail.slice(0, 300)}`,
            metadata: { channelId: this.channelId, resumed, attempt },
            sessionId: this.sdkSessionId,
            userId: this.lastUserId,
          });

          if (resumed && !this.sawInit && attempt === 0) {
            console.log(
              `[pilot] resume failed for ${this.channelId} — clearing stored session id and starting fresh`,
            );
            clearPilotSessionId(this.channelId);
            this.sdkSessionId = undefined;
            // Drop the abandoned generator's waker so a message arriving during
            // the retry can't be yielded into the dead stream.
            this.wake = null;
            this.requeueForReplay();
            this.say(
              "-# ⚠️ couldn't resume the previous pilot session — starting a fresh one (earlier context is gone)",
            );
            continue;
          }

          this.say(`⚠️ Pilot session error: ${detail.slice(0, 500)}`);
          return;
        } finally {
          this.stream = null;
          this.endTurn();
        }
      }
    } finally {
      removeSession(this.channelId, this);
    }
  }

  /**
   * Put messages the CLI never answered back at the front of the queue, so a
   * fresh session after a failed resume still does the work that was asked for.
   * The stored session_id is dropped — the new session assigns its own.
   */
  private requeueForReplay(): void {
    if (this.pendingReplay.length === 0) return;
    const replay = this.pendingReplay.map(
      (message) => ({ ...message, session_id: "" }) as SDKUserMessage,
    );
    this.pendingReplay = [];
    this.queue = [...replay, ...this.queue];
  }

  // -------------------------------------------------------------------------
  // Relay SDK messages to Discord
  // -------------------------------------------------------------------------

  private async relay(message: SDKMessage): Promise<void> {
    if (message.type === "system") {
      const subtype = (message as { subtype?: string }).subtype;
      const sessionId = (message as { session_id?: string }).session_id;
      if (subtype === "init") {
        this.sawInit = true;
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
          if (text) {
            this.sawTurnOutput = true;
            this.turnText.push(text);
            this.say(text);
          }
        } else if (b.type === "tool_use") {
          this.sawTurnOutput = true;
          this.lastToolName =
            typeof b.name === "string"
              ? b.name.replace(/^mcp__discordclaw__/, "")
              : "tool";
          if (typeof b.id === "string") this.rememberToolName(b.id, this.lastToolName);
          this.sayProgress(this.formatToolUse(b));
        }
      }
      return;
    }

    // A tool that fails mid-turn is otherwise invisible: the model sees the
    // error and may quietly work around it, leaving the channel with a gap.
    if (message.type === "user") {
      const blocks = (message as { message?: { content?: unknown } }).message
        ?.content;
      if (!Array.isArray(blocks)) return;
      for (const block of blocks) {
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_result" || b.is_error !== true) continue;
        const name =
          (typeof b.tool_use_id === "string" && this.toolNames.get(b.tool_use_id)) ||
          "tool";
        const detail = summariseToolResult(b.content);
        this.sawTurnOutput = true;
        this.sayProgress(
          detail
            ? `-# ⚠️ **${name}** failed · ${detail}`
            : `-# ⚠️ **${name}** failed`,
        );
      }
      return;
    }

    if (message.type === "result") {
      this.endTurn();
      // The CLI answered, so nothing is left to replay.
      this.pendingReplay = [];
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
        this.say(`⚠️ Pilot turn ended with an error: ${detail.slice(0, 500)}`);
      }
      const usageLine = this.formatUsage(message as Record<string, unknown>);
      if (usageLine) this.say(usageLine);
      void this.outbound.flush();
      return;
    }
  }

  /**
   * Persist this turn's assistant text as one conversation row, so pilot output
   * is visible to /history, the archive and `get_conversation_history` like any
   * other channel. Best-effort: logging must never break a turn.
   *
   * What is stored is what the channel saw — relayed text, not tool detail.
   */
  private logTurn(): void {
    const text = this.turnText.join("\n\n").trim();
    this.turnText = [];
    if (!this.logSessionId || !text) return;

    try {
      addMessage({
        sessionId: this.logSessionId,
        role: "assistant",
        content: text,
      });
      broadcastLog({
        type: "message",
        sessionId: this.logSessionId,
        role: "assistant",
        content: text,
        channel: this.logChannelName ?? this.channelId,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error(
        `[pilot] failed to log turn for ${this.channelId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Remember a tool_use id so its result can be labelled. Bounded. */
  private rememberToolName(id: string, name: string): void {
    this.toolNames.set(id, name);
    if (this.toolNames.size > TOOL_NAME_CACHE_LIMIT) {
      const oldest = this.toolNames.keys().next().value;
      if (oldest !== undefined) this.toolNames.delete(oldest);
    }
  }

  /**
   * Per-turn usage footer, matching the main path's `-# 📊` line.
   *
   * `usage` is per-turn for the main loop, but `total_cost_usd` is cumulative
   * across a streaming-input session, so the cost shown is the delta since the
   * previous result.
   */
  private formatUsage(result: Record<string, unknown>): string | null {
    const usage = result.usage as Record<string, unknown> | undefined;
    if (!usage) return null;

    const inTokens = num(usage.input_tokens);
    const outTokens = num(usage.output_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    const cacheCreate = num(usage.cache_creation_input_tokens);
    if (inTokens + outTokens + cacheRead + cacheCreate === 0) return null;

    const totalCost = num(result.total_cost_usd);
    const turnCost = Math.max(0, totalCost - this.lastCostUsd);
    if (totalCost > 0) this.lastCostUsd = totalCost;

    const model = primaryModel(result.modelUsage) ?? "pilot";
    const durationMs = num(result.duration_ms);
    const cached = cacheRead > 0 ? ` (${fmtTokens(cacheRead)} cached)` : "";
    const durationPart = durationMs > 0 ? ` · ${fmtDuration(durationMs)}` : "";

    const footer = `-# 📊 ${model} · ${fmtTokens(inTokens + cacheRead + cacheCreate)} in${cached} / ${fmtTokens(outTokens)} out · $${turnCost.toFixed(4)}${durationPart}`;
    if (PILOT_TURN_MAX_COST_USD > 0 && turnCost > PILOT_TURN_MAX_COST_USD) {
      return `${footer}\n-# 💸 that turn cost $${turnCost.toFixed(4)}, over the $${PILOT_TURN_MAX_COST_USD.toFixed(2)} soft cap`;
    }
    return footer;
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

  /** Relay a line to the channel promptly, behind the shared send queue. */
  private say(text: string): void {
    this.outbound.push(text);
  }

  /** Relay a tool-progress line — merged with its neighbours, then sent. */
  private sayProgress(text: string): void {
    this.outbound.pushCoalescing(text);
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
  count(P.pilotTurnSubmit);
  session.submit(message);
  return session;
}

/**
 * True when a live (non-closed) pilot session is keyed to this exact channel id.
 *
 * Message routing needs this because a session can now exist in a channel that
 * was never pilot-flagged: cron runs every agent turn on the SDK, so a reply to
 * a cron report inside its own thread has to reach the session that wrote it
 * rather than the main agent loop, which has none of its context.
 */
export function hasLivePilotSession(channelId: string): boolean {
  const session = sessions.get(channelId);
  return session !== undefined && !session.isClosed;
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
 * Live session ids a channel owns: itself, plus every thread under it.
 *
 * Sessions are keyed to threads while `/clear`, `/interrupt` and `/pilot off`
 * are usually typed in the parent channel. Without this lookup those commands
 * reported "no active session here" while a turn was streaming one level down.
 */
export function pilotSessionChannelIdsUnder(channelId: string): string[] {
  const ids: string[] = [];
  for (const [id, session] of sessions) {
    if (session.isClosed) continue;
    if (id === channelId || session.parentId === channelId) ids.push(id);
  }
  return ids;
}

/**
 * Interrupt every live session a channel owns (see
 * `pilotSessionChannelIdsUnder`). Returns one entry per session interrupted.
 */
export async function interruptPilotSessionsUnder(
  channelId: string,
): Promise<Array<{ channelId: string; result: PilotInterruptResult }>> {
  const out: Array<{ channelId: string; result: PilotInterruptResult }> = [];
  for (const id of pilotSessionChannelIdsUnder(channelId)) {
    const result = await interruptPilotSession(id);
    if (result) out.push({ channelId: id, result });
  }
  return out;
}

/** Stop every live session a channel owns. Returns how many were stopped. */
export async function stopPilotSessionsUnder(channelId: string): Promise<number> {
  let stopped = 0;
  for (const id of pilotSessionChannelIdsUnder(channelId)) {
    if (await stopPilotSession(id)) stopped += 1;
  }
  return stopped;
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

/**
 * Forget everything pilot remembers about a channel: stop the live session and
 * drop the stored SDK session id, so the next message starts a genuinely fresh
 * session instead of resuming. This is what `/clear` means in a pilot channel —
 * clearing our own conversation rows does nothing, because a pilot session
 * keeps its context inside the CLI, not in our DB.
 *
 * Returns whether a live session was stopped.
 */
export async function resetPilotSession(channelId: string): Promise<boolean> {
  const stopped = await stopPilotSession(channelId);
  clearPilotSessionId(channelId);
  return stopped;
}

/**
 * `/clear` semantics for a whole channel: reset the sessions it owns (itself and
 * its threads) and drop their stored resume ids, plus the channel's own stored
 * id even when nothing is running there. Returns how many live sessions were
 * stopped and how many stored ids were dropped.
 */
export async function resetPilotSessionScope(
  channelId: string,
): Promise<{ stopped: number; cleared: number }> {
  const ids = pilotSessionChannelIdsUnder(channelId);
  let stopped = 0;
  for (const id of ids) {
    if (await stopPilotSession(id)) stopped += 1;
    clearPilotSessionId(id);
  }
  if (!ids.includes(channelId)) clearPilotSessionId(channelId);
  return { stopped, cleared: ids.includes(channelId) ? ids.length : ids.length + 1 };
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
        const idleMinutes = Math.round(session.idleMs / 60_000);
        sessions.delete(channelId);
        void session.stop(
          `reaped after ${Math.round(session.idleMs / 1000)}s idle`,
          `-# 💤 pilot session closed after ${idleMinutes}m idle — the next message resumes it`,
        );
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
