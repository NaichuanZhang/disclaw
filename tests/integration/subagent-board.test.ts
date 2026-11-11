// ---------------------------------------------------------------------------
// Subagent board — pure reducer + renderers
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  MAX_BOARD_ROWS,
  MAX_SELECT_OPTIONS,
  MAX_TRACKED_TASKS,
  SUB_SELECT_ID,
  applyTaskEvent,
  boardView,
  buildSubCustomId,
  countWord,
  emptyBoard,
  parseSubCustomId,
  renderBoard,
  renderCompletionReport,
  renderDetail,
  renderSteerModal,
  steerMessageText,
  summaryLine,
  taskEventFromSdk,
  type BoardState,
  type TaskEvent,
} from "../../src/sdk/subagent-board.js";

const T0 = 1_000_000;

function sdk(subtype: string, fields: Record<string, unknown>) {
  return { type: "system", subtype, uuid: "u", session_id: "s", ...fields };
}

function feed(messages: unknown[], state: BoardState = emptyBoard(), now = T0): BoardState {
  for (const m of messages) {
    const e = taskEventFromSdk(m);
    if (e) state = applyTaskEvent(state, e, now);
  }
  return state;
}

const start = (id: string, extra: Record<string, unknown> = {}) =>
  sdk("task_started", {
    task_id: id,
    tool_use_id: `tu-${id}`,
    description: `Task ${id}`,
    subagent_type: "Explore",
    task_type: "local_agent",
    ...extra,
  });

const done = (id: string, status = "completed", extra: Record<string, unknown> = {}) =>
  sdk("task_notification", { task_id: id, status, output_file: "", summary: "", ...extra });

describe("taskEventFromSdk", () => {
  it("ignores non-task and ambient messages", () => {
    expect(taskEventFromSdk({ type: "system", subtype: "init" })).toBeNull();
    expect(taskEventFromSdk({ type: "assistant" })).toBeNull();
    expect(taskEventFromSdk(null)).toBeNull();
    expect(taskEventFromSdk(start("a", { skip_transcript: true }))).toBeNull();
    expect(taskEventFromSdk(start("b", { task_type: "local_bash", subagent_type: undefined }))).toBeNull();
    expect(taskEventFromSdk(done("c", "weird"))).toBeNull();
  });
});

describe("applyTaskEvent", () => {
  it("walks started -> progress -> completed", () => {
    let s = feed([start("a")]);
    expect(s.tasks[0]).toMatchObject({ status: "running", spawnDepth: 1, toolUseId: "tu-a" });
    s = feed(
      [
        sdk("task_progress", {
          task_id: "a",
          description: "Task a",
          usage: { total_tokens: 500, tool_uses: 3, duration_ms: 9000 },
          last_tool_name: "Grep",
          summary: "reading auth middleware",
        }),
      ],
      s,
    );
    expect(s.tasks[0]).toMatchObject({ toolUses: 3, lastToolName: "Grep", summary: "reading auth middleware" });
    s = feed([done("a", "completed", { usage: { total_tokens: 34_000, tool_uses: 12, duration_ms: 41_000 } })], s);
    expect(s.tasks[0]).toMatchObject({ status: "done", totalTokens: 34_000, toolUses: 12 });
  });

  it("maps failed and stopped notifications, and task_updated patches", () => {
    let s = feed([start("a"), start("b"), start("c"), done("a", "failed"), done("b", "stopped")]);
    expect(s.tasks.map((t) => t.status)).toEqual(["failed", "stopped", "running"]);
    s = feed([sdk("task_updated", { task_id: "c", patch: { status: "killed", is_backgrounded: true } })], s);
    expect(s.tasks[2]).toMatchObject({ status: "stopped", isBackgrounded: true });
  });

  it("ignores events for tasks it never saw start (ambient ones included)", () => {
    const s = feed([
      start("amb", { skip_transcript: true }),
      sdk("task_progress", { task_id: "amb", description: "x", usage: {} }),
      done("amb"),
    ]);
    expect(s.tasks).toEqual([]);
  });

  it("does not duplicate a re-sent task_started", () => {
    const s = feed([start("a"), start("a")]);
    expect(s.tasks.length).toBe(1);
  });

  it("needs_you follows ask_user calls by tool_use id", () => {
    let s = feed([start("a")]);
    s = applyTaskEvent(s, { kind: "ask_started", parentToolUseId: "tu-a", askToolUseId: "q1" });
    expect(s.tasks[0].status).toBe("needs_you");
    s = applyTaskEvent(s, { kind: "ask_answered", askToolUseId: "q1" });
    expect(s.tasks[0].status).toBe("running");
    const unchanged = applyTaskEvent(s, { kind: "ask_answered", askToolUseId: "other" });
    expect(unchanged).toBe(s);
  });

  it("stays bounded, evicting finished tasks before live ones", () => {
    const msgs: unknown[] = [start("live")];
    for (let i = 0; i < MAX_TRACKED_TASKS + 10; i++) msgs.push(start(`t${i}`), done(`t${i}`));
    const s = feed(msgs);
    expect(s.tasks.length).toBe(MAX_TRACKED_TASKS);
    expect(s.tasks.some((t) => t.taskId === "live")).toBe(true);
  });
});

describe("summaryLine", () => {
  it("uses word numbers up to ten, digits beyond", () => {
    expect(countWord(3)).toBe("Three");
    expect(countWord(10)).toBe("Ten");
    expect(countWord(11)).toBe("11");
  });

  it("reads as a sentence", () => {
    let s = feed([start("a"), start("b"), start("c")]);
    s = applyTaskEvent(s, { kind: "ask_started", parentToolUseId: "tu-c", askToolUseId: "q" });
    expect(summaryLine(s)).toBe("Three subagents, 1 needs you, 2 moving");
    expect(summaryLine(feed([start("a"), start("b"), done("a"), done("b")]))).toBe("Two subagents, all done");
    expect(summaryLine(feed([start("a")]))).toBe("One subagent, moving");
    const many = feed(Array.from({ length: 12 }, (_, i) => start(`x${i}`)));
    expect(summaryLine(many)).toBe("12 subagents, all moving");
  });
});

describe("renderBoard", () => {
  it("puts needs-you rows first and words rows plainly", () => {
    let s = feed([
      start("a"),
      sdk("task_progress", { task_id: "a", description: "Task a", usage: { duration_ms: 41_000 }, last_tool_name: "Read" }),
      start("b"),
      start("c", { spawn_depth: 2 }),
      done("c", "completed", { usage: { total_tokens: 34_000, tool_uses: 12, duration_ms: 3000 } }),
    ]);
    s = applyTaskEvent(s, { kind: "ask_started", parentToolUseId: "tu-b", askToolUseId: "q" });
    const { embeds } = renderBoard(s, T0);
    const rows = String(embeds[0].description).split("\n");
    expect(rows[0]).toMatch(/^🙋 .*Task b: needs you/);
    expect(rows[1]).toMatch(/^⏳ \*\*Explore\*\* Task a: reading files · 41s$/);
    expect(rows[2]).toMatch(/^　✅ .*done · 34k tok · 12 tools · 3s$/);
  });

  it("caps rows with +N more and respects embed limits", () => {
    const long = "x".repeat(5000);
    const msgs = Array.from({ length: 40 }, (_, i) => start(`t${i}`, { description: long }));
    const { embeds, components } = renderBoard(feed(msgs), T0);
    const desc = String(embeds[0].description);
    expect(desc.split("\n").length).toBe(MAX_BOARD_ROWS + 1);
    expect(desc).toContain(`+${40 - MAX_BOARD_ROWS} more`);
    expect(desc.length).toBeLessThanOrEqual(4096);
    expect(String(embeds[0].title).length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(embeds[0]).length).toBeLessThan(6000);

    const select = (components[0] as { components: Array<{ custom_id: string; options: Array<{ label: string; value: string }> }> }).components[0];
    expect(select.custom_id).toBe(SUB_SELECT_ID);
    expect(select.options.length).toBe(MAX_SELECT_OPTIONS);
    for (const o of select.options) expect(o.label.length).toBeLessThanOrEqual(100);
  });

  it("has no components with no tasks, and escapes markdown in model text", () => {
    expect(renderBoard(emptyBoard()).components).toEqual([]);
    const { embeds } = renderBoard(feed([start("a", { description: "**bold** `x`" })]), T0);
    expect(String(embeds[0].description)).toContain("\\*\\*bold\\*\\* \\`x\\`");
  });

  it("boardView restricts to one message's tasks", () => {
    const s = feed([start("a"), start("b")]);
    expect(boardView(s, ["b"]).tasks.map((t) => t.taskId)).toEqual(["b"]);
  });
});

describe("custom ids", () => {
  it("round-trips build/parse", () => {
    for (const action of ["stop", "steer", "steer-submit"] as const) {
      const id = buildSubCustomId("task_AB-12", action)!;
      expect(parseSubCustomId(id)).toEqual({ kind: "action", taskId: "task_AB-12", action });
    }
    expect(parseSubCustomId("sub:select")).toEqual({ kind: "select" });
  });

  it("refuses hostile or oversized ids", () => {
    for (const bad of ["", "a:b", "../x", "x y", "a".repeat(81), "id\n", "q:1:stop"]) {
      expect(buildSubCustomId(bad, "stop")).toBeNull();
    }
    for (const bad of ["sub:", "sub:a", "sub:a:rm", "sub:a:b:stop", "sub:a:stop ", "q:a:stop", "sub:../x:stop"]) {
      expect(parseSubCustomId(bad)).toBeNull();
    }
  });

  it("leaves unsafe task ids out of the select menu and detail buttons", () => {
    const s = feed([start("bad id"), start("ok")]);
    const select = (renderBoard(s).components[0] as { components: Array<{ options: Array<{ value: string }> }> }).components[0];
    expect(select.options.map((o) => o.value)).toEqual(["ok"]);
    expect(renderDetail(s.tasks[0]).components).toEqual([]);
    expect(renderSteerModal(s.tasks[0])).toBeNull();
  });
});

describe("renderDetail / steer", () => {
  it("enables stop only while live", () => {
    let s = feed([start("a", { prompt: "look at auth" })]);
    const live = renderDetail(s.tasks[0], T0);
    const liveButtons = (live.components[0] as { components: Array<{ custom_id: string; disabled?: boolean }> }).components;
    expect(liveButtons.map((b) => b.custom_id)).toEqual(["sub:a:stop", "sub:a:steer"]);
    expect(liveButtons[0].disabled).toBe(false);
    expect(String(live.embeds[0].description)).toContain("look at auth");
    s = feed([done("a")], s);
    const after = (renderDetail(s.tasks[0]).components[0] as { components: Array<{ disabled?: boolean }> }).components;
    expect(after[0].disabled).toBe(true);
  });

  it("prefixes steer text with the subagent and task", () => {
    expect(steerMessageText({ taskId: "a", description: "Audit auth" }, " use the v2 API ")).toBe(
      "[steer subagent Audit auth / task a] use the v2 API",
    );
  });
});

describe("renderCompletionReport", () => {
  it("groups by outcome and is null without tasks", () => {
    expect(renderCompletionReport(emptyBoard())).toBeNull();
    const s = feed([start("a"), start("b"), start("c"), done("a"), done("b"), done("c", "failed")]);
    expect(renderCompletionReport(s)).toBe("subagents: 3 (2 ✅ 1 ❌)");
    const events: TaskEvent[] = [{ kind: "ask_started", parentToolUseId: "tu-d", askToolUseId: "q" }];
    let t = feed([start("d"), start("e")]);
    for (const e of events) t = applyTaskEvent(t, e);
    expect(renderCompletionReport(t)).toBe("subagents: 2 (1 🙋 1 ⏳)");
  });
});
