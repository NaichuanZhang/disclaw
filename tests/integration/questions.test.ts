import { describe, it, expect, beforeAll } from "vitest";
import { initDb } from "../../src/db/index.js";
import {
  createQuestion,
  encodeQuestionCustomId,
  encodeQuestionSelectCustomId,
  parseQuestionCustomId,
  waitForAnswer,
  resolveQuestion,
  resolveQuestionByIndex,
  findLiveQuestionForMessage,
  getQuestion,
  expireStalePendingQuestions,
  liveQuestionCount,
} from "../../src/agent/questions.js";

beforeAll(() => {
  initDb();
});

describe("question customId encoding", () => {
  it("round-trips a button customId", () => {
    const id = encodeQuestionCustomId("abc123", 2);
    expect(id).toBe("q:abc123:2");
    expect(parseQuestionCustomId(id)).toEqual({
      questionId: "abc123",
      optionIndex: 2,
    });
  });

  it("round-trips a select customId", () => {
    const id = encodeQuestionSelectCustomId("abc123");
    expect(parseQuestionCustomId(id)).toEqual({
      questionId: "abc123",
      optionIndex: null,
    });
  });

  it("stays under Discord's 100-char customId limit", () => {
    expect(encodeQuestionCustomId("a".repeat(16), 4).length).toBeLessThan(100);
  });

  it("ignores unrelated customIds", () => {
    expect(parseQuestionCustomId("some-button")).toBeNull();
    expect(parseQuestionCustomId("q:abc")).toBeNull();
    expect(parseQuestionCustomId("x:abc:1")).toBeNull();
    expect(parseQuestionCustomId("q::1")).toBeNull();
  });
});

describe("answering questions", () => {
  it("resolves a waiting question by button index", async () => {
    const q = createQuestion({
      channelId: "chan-1",
      userId: "user-1",
      question: "Ship it?",
      options: ["Yes", "No"],
    });
    const pending = waitForAnswer(q, 10);
    // Waiter must be live before the answer arrives
    expect(liveQuestionCount()).toBeGreaterThan(0);
    expect(resolveQuestionByIndex(q.id, 1, "button")).toBe("No");
    await expect(pending).resolves.toEqual({ answer: "No", source: "button" });
    const row = getQuestion(q.id);
    expect(row?.status).toBe("answered");
    expect(row?.answer).toBe("No");
  });

  it("rejects an out-of-range option index", async () => {
    const q = createQuestion({
      channelId: "chan-2",
      question: "Pick",
      options: ["A"],
    });
    const pending = waitForAnswer(q, 10);
    expect(resolveQuestionByIndex(q.id, 5, "button")).toBeNull();
    expect(resolveQuestion(q.id, "A", "message")).toBe("A");
    await expect(pending).resolves.toEqual({ answer: "A", source: "message" });
  });

  it("finds a live question for a free-text reply from the same user", async () => {
    const q = createQuestion({
      channelId: "chan-3",
      userId: "user-3",
      question: "What name?",
    });
    const pending = waitForAnswer(q, 10);
    expect(findLiveQuestionForMessage("chan-3", "other-user")).toBeNull();
    expect(findLiveQuestionForMessage("other-chan", "user-3")).toBeNull();
    const found = findLiveQuestionForMessage("chan-3", "user-3");
    expect(found?.id).toBe(q.id);
    expect(found?.options).toEqual([]);
    resolveQuestion(q.id, "widget", "message");
    await expect(pending).resolves.toEqual({
      answer: "widget",
      source: "message",
    });
  });

  it("times out and refuses late answers", async () => {
    const q = createQuestion({
      channelId: "chan-4",
      question: "Still there?",
      options: ["Yep"],
    });
    await expect(waitForAnswer(q, 1)).resolves.toBeNull();
    expect(getQuestion(q.id)?.status).toBe("timeout");
    expect(resolveQuestion(q.id, "Yep", "button")).toBeNull();
    expect(findLiveQuestionForMessage("chan-4", "anyone")).toBeNull();
  });
});

describe("startup cleanup", () => {
  it("expires questions left pending by a previous process", () => {
    const q = createQuestion({ channelId: "chan-5", question: "orphan?" });
    expect(getQuestion(q.id)?.status).toBe("pending");
    expireStalePendingQuestions();
    expect(getQuestion(q.id)?.status).toBe("expired");
  });
});
