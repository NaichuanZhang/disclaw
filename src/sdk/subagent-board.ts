// ---------------------------------------------------------------------------
// SDK sessions — subagent board
//
// Pure state + rendering for the one live-edited "board" message a turn gets
// when the session spawns subagents. Summary line first, one plain-words row
// per subagent, needs-you rows set apart at the top, detail on demand through
// a select menu. No Discord side effects: everything returns plain API JSON
// that `channel.send()` / `message.edit()` / `interaction.reply()` accept.
// ---------------------------------------------------------------------------

import { ButtonStyle, ComponentType, TextInputStyle } from "discord.js";

export type SubagentStatus = "running" | "done" | "failed" | "stopped" | "needs_you";

export interface SubagentTask {
  taskId: string;
  description: string;
  subagentType: string | null;
  prompt: string | null;
  status: SubagentStatus;
  totalTokens: number;
  toolUses: number;
  durationMs: number;
  lastToolName: string | null;
  summary: string | null;
  spawnDepth: number;
  isBackgrounded: boolean;
  toolUseId: string | null;
  startedAt: number;
  endedAt: number | null;
  /** ask_user tool_use ids the subagent is blocked on. */
  pendingAsks: string[];
}

export interface BoardState {
  /** Insertion order is display order before sorting. */
  tasks: SubagentTask[];
}

export type TaskEvent =
  | {
      kind: "started";
      taskId: string;
      description: string;
      subagentType?: string;
      prompt?: string;
      spawnDepth?: number;
      isBackgrounded?: boolean;
      toolUseId?: string;
    }
  | {
      kind: "progress";
      taskId: string;
      description?: string;
      totalTokens?: number;
      toolUses?: number;
      durationMs?: number;
      lastToolName?: string;
      summary?: string;
    }
  | {
      kind: "updated";
      taskId: string;
      status?: string;
      description?: string;
      error?: string;
      isBackgrounded?: boolean;
    }
  | {
      kind: "notification";
      taskId: string;
      status: "completed" | "failed" | "stopped";
      summary?: string;
      totalTokens?: number;
      toolUses?: number;
      durationMs?: number;
    }
  /** A subagent (identified by its spawning tool_use id) called ask_user. */
  | { kind: "ask_started"; parentToolUseId: string; askToolUseId: string }
  /** That ask_user call returned. */
  | { kind: "ask_answered"; askToolUseId: string };

export const MAX_TRACKED_TASKS = 50;
export const MAX_BOARD_ROWS = 12;
export const MAX_SELECT_OPTIONS = 25;
const MAX_ROW_CHARS = 220;
const MAX_DESCRIPTION_CHARS = 4096;
const MAX_TITLE_CHARS = 256;
const MAX_CUSTOM_ID_CHARS = 100;

/** Task types that are subagents. local_bash (background shells) is not. */
const SUBAGENT_TASK_TYPES = new Set(["local_agent", "remote_agent", "local_workflow"]);

export function emptyBoard(): BoardState {
  return { tasks: [] };
}

// ---------------------------------------------------------------------------
// SDK message -> event
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function n(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Turn an SDK `system` message into a board event, or null when it is not a
 * task message or is one the board should not show (ambient/housekeeping
 * tasks, background shells).
 */
export function taskEventFromSdk(message: unknown): TaskEvent | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.type !== "system") return null;
  const taskId = str(m.task_id);
  if (!taskId) return null;
  const usage = (m.usage ?? {}) as Record<string, unknown>;

  switch (m.subtype) {
    case "task_started": {
      if (m.skip_transcript === true) return null;
      const taskType = str(m.task_type);
      if (taskType && !SUBAGENT_TASK_TYPES.has(taskType) && !str(m.subagent_type)) return null;
      return {
        kind: "started",
        taskId,
        description: str(m.description) ?? str(m.workflow_name) ?? "subagent",
        subagentType: str(m.subagent_type),
        prompt: str(m.prompt),
        spawnDepth: n(m.spawn_depth),
        isBackgrounded: typeof m.is_backgrounded === "boolean" ? m.is_backgrounded : undefined,
        toolUseId: str(m.tool_use_id),
      };
    }
    case "task_progress":
      return {
        kind: "progress",
        taskId,
        description: str(m.description),
        totalTokens: n(usage.total_tokens),
        toolUses: n(usage.tool_uses),
        durationMs: n(usage.duration_ms),
        lastToolName: str(m.last_tool_name),
        summary: str(m.summary),
      };
    case "task_updated": {
      const patch = (m.patch ?? {}) as Record<string, unknown>;
      return {
        kind: "updated",
        taskId,
        status: str(patch.status),
        description: str(patch.description),
        error: str(patch.error),
        isBackgrounded: typeof patch.is_backgrounded === "boolean" ? patch.is_backgrounded : undefined,
      };
    }
    case "task_notification": {
      const status = m.status;
      if (status !== "completed" && status !== "failed" && status !== "stopped") return null;
      return {
        kind: "notification",
        taskId,
        status,
        summary: str(m.summary),
        totalTokens: n(usage.total_tokens),
        toolUses: n(usage.tool_uses),
        durationMs: n(usage.duration_ms),
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function isLive(status: SubagentStatus): boolean {
  return status === "running" || status === "needs_you";
}

function liveStatus(task: SubagentTask): SubagentStatus {
  return task.pendingAsks.length > 0 ? "needs_you" : "running";
}

/** Drop the oldest finished tasks once over the cap; live ones are kept. */
function bound(tasks: SubagentTask[]): SubagentTask[] {
  if (tasks.length <= MAX_TRACKED_TASKS) return tasks;
  const out = [...tasks];
  for (let i = 0; i < out.length && out.length > MAX_TRACKED_TASKS; ) {
    if (!isLive(out[i].status)) out.splice(i, 1);
    else i++;
  }
  return out.length > MAX_TRACKED_TASKS ? out.slice(out.length - MAX_TRACKED_TASKS) : out;
}

function patchTask(
  state: BoardState,
  taskId: string,
  patch: (task: SubagentTask) => SubagentTask,
): BoardState {
  const index = state.tasks.findIndex((t) => t.taskId === taskId);
  if (index < 0) return state;
  const tasks = [...state.tasks];
  tasks[index] = patch(tasks[index]);
  return { tasks };
}

/**
 * Fold one event into the board. Events for tasks the board never saw start
 * (ambient tasks, or ones from before a restart) are ignored, so a filtered
 * task can never sneak in through its progress messages.
 */
export function applyTaskEvent(
  state: BoardState,
  event: TaskEvent,
  now: number = Date.now(),
): BoardState {
  switch (event.kind) {
    case "started": {
      if (state.tasks.some((t) => t.taskId === event.taskId)) return state;
      const task: SubagentTask = {
        taskId: event.taskId,
        description: event.description,
        subagentType: event.subagentType ?? null,
        prompt: event.prompt ?? null,
        status: "running",
        totalTokens: 0,
        toolUses: 0,
        durationMs: 0,
        lastToolName: null,
        summary: null,
        spawnDepth: event.spawnDepth ?? 1,
        isBackgrounded: event.isBackgrounded ?? false,
        toolUseId: event.toolUseId ?? null,
        startedAt: now,
        endedAt: null,
        pendingAsks: [],
      };
      return { tasks: bound([...state.tasks, task]) };
    }
    case "progress":
      return patchTask(state, event.taskId, (t) => ({
        ...t,
        description: event.description ?? t.description,
        totalTokens: event.totalTokens ?? t.totalTokens,
        toolUses: event.toolUses ?? t.toolUses,
        durationMs: event.durationMs ?? t.durationMs,
        lastToolName: event.lastToolName ?? t.lastToolName,
        summary: event.summary ?? t.summary,
      }));
    case "updated":
      return patchTask(state, event.taskId, (t) => {
        let status = t.status;
        let endedAt = t.endedAt;
        if (event.status === "completed") status = "done";
        else if (event.status === "failed") status = "failed";
        else if (event.status === "killed") status = "stopped";
        else if (event.status === "running" || event.status === "pending") status = liveStatus(t);
        if (!isLive(status) && endedAt === null) endedAt = now;
        return {
          ...t,
          status,
          endedAt,
          description: event.description ?? t.description,
          summary: event.error ?? t.summary,
          isBackgrounded: event.isBackgrounded ?? t.isBackgrounded,
        };
      });
    case "notification":
      return patchTask(state, event.taskId, (t) => ({
        ...t,
        status:
          event.status === "completed" ? "done" : event.status === "failed" ? "failed" : "stopped",
        summary: event.summary ?? t.summary,
        totalTokens: event.totalTokens ?? t.totalTokens,
        toolUses: event.toolUses ?? t.toolUses,
        durationMs: event.durationMs ?? t.durationMs,
        endedAt: t.endedAt ?? now,
        pendingAsks: [],
      }));
    case "ask_started": {
      const task = state.tasks.find((t) => t.toolUseId === event.parentToolUseId);
      if (!task || !isLive(task.status)) return state;
      return patchTask(state, task.taskId, (t) => ({
        ...t,
        status: "needs_you",
        pendingAsks: t.pendingAsks.includes(event.askToolUseId)
          ? t.pendingAsks
          : [...t.pendingAsks, event.askToolUseId],
      }));
    }
    case "ask_answered": {
      const task = state.tasks.find((t) => t.pendingAsks.includes(event.askToolUseId));
      if (!task) return state;
      return patchTask(state, task.taskId, (t) => {
        const pendingAsks = t.pendingAsks.filter((id) => id !== event.askToolUseId);
        const next = { ...t, pendingAsks };
        return isLive(t.status) ? { ...next, status: liveStatus(next) } : next;
      });
    }
  }
}

/** The board restricted to a set of task ids (one Discord message's view). */
export function boardView(state: BoardState, taskIds: Iterable<string>): BoardState {
  const ids = new Set(taskIds);
  return { tasks: state.tasks.filter((t) => ids.has(t.taskId)) };
}

export function findTask(state: BoardState, taskId: string): SubagentTask | undefined {
  return state.tasks.find((t) => t.taskId === taskId);
}

export function liveTaskIds(state: BoardState): string[] {
  return state.tasks.filter((t) => isLive(t.status)).map((t) => t.taskId);
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/** "Three" for 1–10, digits beyond. */
export function countWord(count: number): string {
  return count >= 0 && count <= 10 ? WORDS[count] : String(count);
}

const STATUS_ICON: Record<SubagentStatus, string> = {
  running: "⏳",
  done: "✅",
  failed: "❌",
  stopped: "⏹️",
  needs_you: "🙋",
};

const STATUS_ORDER: SubagentStatus[] = ["needs_you", "running", "failed", "stopped", "done"];

function statusPhrase(status: SubagentStatus, count: number): string {
  switch (status) {
    case "running":
      return "moving";
    case "needs_you":
      return count === 1 ? "needs you" : "need you";
    default:
      return status;
  }
}

/** "Three subagents, 2 moving, 1 needs you" / "Two subagents, all done". */
export function summaryLine(state: BoardState): string {
  const total = state.tasks.length;
  const noun = total === 1 ? "subagent" : "subagents";
  const counts = new Map<SubagentStatus, number>();
  for (const t of state.tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const present = STATUS_ORDER.filter((s) => counts.get(s));
  let tail: string;
  if (total === 0) tail = "none yet";
  else if (present.length === 1) {
    const phrase = statusPhrase(present[0], total);
    tail = total === 1 ? phrase : `all ${present[0] === "needs_you" ? "need you" : phrase}`;
  } else {
    tail = present.map((s) => `${counts.get(s)} ${statusPhrase(s, counts.get(s)!)}`).join(", ");
  }
  return `${countWord(total)} ${noun}, ${tail}`;
}

const TOOL_VERBS: Record<string, string> = {
  Read: "reading files",
  Grep: "searching code",
  Glob: "finding files",
  Bash: "running a command",
  Edit: "editing files",
  MultiEdit: "editing files",
  Write: "writing a file",
  NotebookEdit: "editing a notebook",
  WebFetch: "reading the web",
  WebSearch: "searching the web",
  Task: "delegating",
  Agent: "delegating",
  TodoWrite: "planning",
  ask_user: "waiting on you",
};

/** Plain words for what a tool call is doing. */
export function toolPhrase(tool: string | null): string | null {
  if (!tool) return null;
  const short = tool.replace(/^mcp__[^_]+__/, "");
  return TOOL_VERBS[short] ?? `using ${short}`;
}

export function fmtShortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtShortTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** Escape the characters that would turn a model-written string into markup. */
function plain(text: string): string {
  return text.replace(/([*_`~|>\\])/g, "\\$1");
}

function elapsed(task: SubagentTask, now: number): number {
  if (task.durationMs > 0) return task.durationMs;
  return (task.endedAt ?? now) - task.startedAt;
}

function label(task: SubagentTask): string {
  return task.subagentType ?? "Agent";
}

/** What the row says the task is doing, in words. */
function activity(task: SubagentTask): string {
  switch (task.status) {
    case "needs_you":
      return "needs you — answer the question above";
    case "running":
      return task.summary ?? toolPhrase(task.lastToolName) ?? "starting";
    case "done":
      return "done";
    case "failed":
      return task.summary ? `failed: ${task.summary}` : "failed";
    case "stopped":
      return "stopped";
  }
}

export function renderRow(task: SubagentTask, now: number = Date.now()): string {
  const indent = "　".repeat(Math.max(0, Math.min(task.spawnDepth - 1, 4)));
  const stats: string[] = [];
  if (task.status === "done") {
    if (task.totalTokens > 0) stats.push(`${fmtShortTokens(task.totalTokens)} tok`);
    if (task.toolUses > 0) stats.push(`${task.toolUses} tool${task.toolUses === 1 ? "" : "s"}`);
  }
  stats.push(fmtShortDuration(elapsed(task, now)));
  const head = `${STATUS_ICON[task.status]} **${plain(oneLine(label(task), 40))}** ${plain(oneLine(task.description, 60))}`;
  const body = plain(oneLine(activity(task), 100));
  const bg = task.isBackgrounded && isLive(task.status) ? " · bg" : "";
  // Indent after trimming: \s matches the ideographic space.
  return indent + oneLine(`${head}: ${body} · ${stats.join(" · ")}${bg}`, MAX_ROW_CHARS);
}

/** Needs-you first, then running, then the finished ones; stable otherwise. */
export function sortedTasks(state: BoardState): SubagentTask[] {
  return state.tasks
    .map((task, index) => ({ task, index }))
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.task.status) - STATUS_ORDER.indexOf(b.task.status) ||
        a.index - b.index,
    )
    .map((x) => x.task);
}

function boardColor(state: BoardState): number {
  if (state.tasks.some((t) => t.status === "needs_you")) return 0xfee75c;
  if (state.tasks.some((t) => t.status === "running")) return 0x5865f2;
  if (state.tasks.some((t) => t.status === "failed")) return 0xed4245;
  return 0x57f287;
}

// ---------------------------------------------------------------------------
// Custom ids
// ---------------------------------------------------------------------------

export const SUB_SELECT_ID = "sub:select";
export type SubAction = "stop" | "steer" | "steer-submit";
const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;

export type ParsedSubCustomId =
  | { kind: "select" }
  | { kind: "action"; taskId: string; action: SubAction };

/** `sub:<taskId>:<action>`, or null when the id cannot be encoded safely. */
export function buildSubCustomId(taskId: string, action: SubAction): string | null {
  if (!SAFE_TASK_ID.test(taskId)) return null;
  const id = `sub:${taskId}:${action}`;
  return id.length <= MAX_CUSTOM_ID_CHARS ? id : null;
}

export function parseSubCustomId(customId: string): ParsedSubCustomId | null {
  if (customId === SUB_SELECT_ID) return { kind: "select" };
  const match = /^sub:([A-Za-z0-9_-]{1,80}):(stop|steer|steer-submit)$/.exec(customId);
  if (!match) return null;
  return { kind: "action", taskId: match[1], action: match[2] as SubAction };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export interface BoardPayload {
  embeds: Array<Record<string, unknown>>;
  components: Array<Record<string, unknown>>;
}

export function renderBoard(state: BoardState, now: number = Date.now()): BoardPayload {
  const sorted = sortedTasks(state);
  const shown = sorted.slice(0, MAX_BOARD_ROWS);
  const rows = shown.map((t) => renderRow(t, now));
  const hidden = sorted.length - shown.length;
  if (hidden > 0) rows.push(`-# +${hidden} more`);
  let description = rows.join("\n");
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description = `${description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`;
  }

  const embed: Record<string, unknown> = {
    title: oneLine(summaryLine(state), MAX_TITLE_CHARS),
    color: boardColor(state),
    ...(description ? { description } : {}),
    footer: { text: "Open a subagent below for detail, stop or steer" },
  };

  const options = sorted
    .filter((t) => SAFE_TASK_ID.test(t.taskId))
    .slice(0, MAX_SELECT_OPTIONS)
    .map((t) => ({
      label: oneLine(`${label(t)}: ${t.description}`, 100) || t.taskId,
      value: t.taskId,
      description: oneLine(activity(t), 100) || undefined,
      emoji: { name: STATUS_ICON[t.status] },
    }));

  const components =
    options.length > 0
      ? [
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.StringSelect,
                custom_id: SUB_SELECT_ID,
                placeholder: "Open subagent…",
                min_values: 1,
                max_values: 1,
                options,
              },
            ],
          },
        ]
      : [];

  return { embeds: [embed], components };
}

/** The ephemeral detail panel for one subagent. */
export function renderDetail(task: SubagentTask, now: number = Date.now()): BoardPayload {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Status", value: `${STATUS_ICON[task.status]} ${activity(task)}`.slice(0, 1024), inline: true },
    { name: "Elapsed", value: fmtShortDuration(elapsed(task, now)), inline: true },
    {
      name: "Stats",
      value: `${fmtShortTokens(task.totalTokens)} tok · ${task.toolUses} tool${task.toolUses === 1 ? "" : "s"}`,
      inline: true,
    },
  ];
  const tool = toolPhrase(task.lastToolName);
  if (tool) fields.push({ name: "Last tool", value: `${task.lastToolName} (${tool})`.slice(0, 1024) });
  if (task.summary) fields.push({ name: "Summary", value: oneLine(task.summary, 1024) });

  const prompt = task.prompt ? `\n\n**Prompt**\n${task.prompt}` : "";
  const description = `${task.description}${prompt}`;

  const embed = {
    title: oneLine(`${label(task)}: ${task.description}`, MAX_TITLE_CHARS),
    description:
      description.length > 2000 ? `${description.slice(0, 1999)}…` : description,
    color: boardColor({ tasks: [task] }),
    fields,
    footer: { text: `task ${task.taskId}${task.isBackgrounded ? " · background" : ""}` },
  };

  const stopId = buildSubCustomId(task.taskId, "stop");
  const steerId = buildSubCustomId(task.taskId, "steer");
  const buttons = [
    stopId && {
      type: ComponentType.Button,
      style: ButtonStyle.Danger,
      label: "Stop",
      custom_id: stopId,
      disabled: !isLive(task.status),
    },
    steerId && {
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      label: "Steer",
      custom_id: steerId,
    },
  ].filter(Boolean) as Array<Record<string, unknown>>;

  return {
    embeds: [embed],
    components: buttons.length ? [{ type: ComponentType.ActionRow, components: buttons }] : [],
  };
}

/** The steer modal: one paragraph input. */
export function renderSteerModal(task: SubagentTask): Record<string, unknown> | null {
  const customId = buildSubCustomId(task.taskId, "steer-submit");
  if (!customId) return null;
  return {
    custom_id: customId,
    title: oneLine(`Steer ${label(task)}`, 45),
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.TextInput,
            custom_id: "text",
            label: oneLine(`Instruction for: ${task.description}`, 45),
            style: TextInputStyle.Paragraph,
            required: true,
            max_length: 1500,
          },
        ],
      },
    ],
  };
}

/** The message a steer injects into the session. */
export function steerMessageText(task: Pick<SubagentTask, "taskId" | "description">, text: string): string {
  return `[steer subagent ${oneLine(task.description, 80)} / task ${task.taskId}] ${text.trim()}`;
}

/** "subagents: 3 (2 ✅ 1 ❌)" for the usage footer, or null with no tasks. */
export function renderCompletionReport(state: BoardState): string | null {
  if (state.tasks.length === 0) return null;
  const counts = new Map<SubagentStatus, number>();
  for (const t of state.tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const order: SubagentStatus[] = ["done", "failed", "stopped", "needs_you", "running"];
  const parts = order
    .filter((s) => counts.get(s))
    .map((s) => `${counts.get(s)} ${STATUS_ICON[s]}`);
  return `subagents: ${state.tasks.length} (${parts.join(" ")})`;
}
