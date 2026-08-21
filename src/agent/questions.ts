// ---------------------------------------------------------------------------
// Pending agent → user questions (ask_user tool)
//
// The agent can ask the user a question with a real Discord UI (embed +
// buttons / select menu) and block its turn until the user answers, the
// question times out, or the user replies with free text in the channel.
//
// Live waiters are kept in memory (a blocked agent turn cannot survive a
// restart anyway). The DB table is the audit trail: every question, its
// options, and the final answer/status.
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";
import { getDb } from "../db/index.js";

export const QUESTION_CUSTOM_ID_PREFIX = "q";

/** Hard cap on how long an agent turn may block waiting for an answer. */
export const MAX_WAIT_SECONDS = 300;
export const DEFAULT_WAIT_SECONDS = 120;

/** Discord allows max 5 buttons per action row. Above that we use a select menu. */
export const MAX_BUTTON_OPTIONS = 5;
/** Discord allows max 25 options in a select menu. */
export const MAX_SELECT_OPTIONS = 25;

export type QuestionStatus =
  | "pending"
  | "answered"
  | "timeout"
  | "expired"
  | "cancelled";

export interface QuestionRow {
  id: string;
  channel_id: string;
  message_id: string | null;
  user_id: string | null;
  question: string;
  options_json: string | null;
  answer: string | null;
  answer_source: string | null;
  status: QuestionStatus;
  created_at: number;
  answered_at: number | null;
}

export interface CreateQuestionOptions {
  channelId: string;
  userId?: string | null;
  question: string;
  options?: string[];
}

interface Waiter {
  id: string;
  channelId: string;
  userId: string | null;
  options: string[];
  resolve: (answer: AnswerResult | null) => void;
  timer: NodeJS.Timeout | null;
}

export interface AnswerResult {
  answer: string;
  /** "button" | "select" | "message" */
  source: string;
}

/** Live waiters, keyed by question id. */
const waiters = new Map<string, Waiter>();

// ---------------------------------------------------------------------------
// customId encoding
// ---------------------------------------------------------------------------

/** Encode a component customId: `q:<questionId>:<optionIndex>`. */
export function encodeQuestionCustomId(
  questionId: string,
  optionIndex: number,
): string {
  return `${QUESTION_CUSTOM_ID_PREFIX}:${questionId}:${optionIndex}`;
}

/** Encode the select-menu customId (index comes from the chosen value). */
export function encodeQuestionSelectCustomId(questionId: string): string {
  return `${QUESTION_CUSTOM_ID_PREFIX}:${questionId}:select`;
}

export interface ParsedQuestionCustomId {
  questionId: string;
  /** Numeric option index for buttons, null for select menus. */
  optionIndex: number | null;
}

/** Parse a component customId produced by ask_user. Returns null if unrelated. */
export function parseQuestionCustomId(
  customId: string,
): ParsedQuestionCustomId | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== QUESTION_CUSTOM_ID_PREFIX) return null;
  const questionId = parts[1];
  if (!questionId) return null;
  if (parts[2] === "select") return { questionId, optionIndex: null };
  const idx = Number.parseInt(parts[2] as string, 10);
  if (!Number.isInteger(idx) || idx < 0) return null;
  return { questionId, optionIndex: idx };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export function createQuestion(opts: CreateQuestionOptions): QuestionRow {
  const id = randomUUID().replace(/-/g, "").slice(0, 16);
  const now = Date.now();
  const optionsJson = opts.options?.length ? JSON.stringify(opts.options) : null;
  getDb()
    .prepare(
      `INSERT INTO agent_questions
         (id, channel_id, message_id, user_id, question, options_json, answer, answer_source, status, created_at, answered_at)
       VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, 'pending', ?, NULL)`,
    )
    .run(
      id,
      opts.channelId,
      opts.userId ?? null,
      opts.question,
      optionsJson,
      now,
    );
  return {
    id,
    channel_id: opts.channelId,
    message_id: null,
    user_id: opts.userId ?? null,
    question: opts.question,
    options_json: optionsJson,
    answer: null,
    answer_source: null,
    status: "pending",
    created_at: now,
    answered_at: null,
  };
}

export function setQuestionMessageId(id: string, messageId: string): void {
  getDb()
    .prepare("UPDATE agent_questions SET message_id = ? WHERE id = ?")
    .run(messageId, id);
}

export function getQuestion(id: string): QuestionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM agent_questions WHERE id = ?")
    .get(id) as QuestionRow | undefined;
}

function setQuestionStatus(
  id: string,
  status: QuestionStatus,
  answer?: string,
  source?: string,
): void {
  getDb()
    .prepare(
      `UPDATE agent_questions
          SET status = ?, answer = ?, answer_source = ?, answered_at = ?
        WHERE id = ?`,
    )
    .run(status, answer ?? null, source ?? null, Date.now(), id);
}

/**
 * Mark any still-pending questions as expired. Called at startup: their
 * in-memory waiters died with the previous process, so they can never be
 * answered into a live agent turn.
 */
export function expireStalePendingQuestions(): number {
  const result = getDb()
    .prepare(
      `UPDATE agent_questions
          SET status = 'expired', answered_at = ?
        WHERE status = 'pending'`,
    )
    .run(Date.now());
  return result.changes ?? 0;
}

// ---------------------------------------------------------------------------
// Waiting / resolving
// ---------------------------------------------------------------------------

/**
 * Block until the question is answered or the timeout elapses.
 * Resolves with the answer, or null on timeout.
 */
export function waitForAnswer(
  question: QuestionRow,
  waitSeconds: number,
): Promise<AnswerResult | null> {
  const clamped = Math.max(
    1,
    Math.min(Math.round(waitSeconds), MAX_WAIT_SECONDS),
  );
  const options: string[] = question.options_json
    ? (JSON.parse(question.options_json) as string[])
    : [];

  return new Promise<AnswerResult | null>((resolve) => {
    const waiter: Waiter = {
      id: question.id,
      channelId: question.channel_id,
      userId: question.user_id,
      options,
      resolve,
      timer: null,
    };
    waiter.timer = setTimeout(() => {
      waiters.delete(question.id);
      setQuestionStatus(question.id, "timeout");
      resolve(null);
    }, clamped * 1000);
    // Don't hold the event loop open purely for a pending question.
    waiter.timer.unref?.();
    waiters.set(question.id, waiter);
  });
}

/**
 * Resolve a question with an answer. Returns the settled answer text, or null
 * if there was no live waiter (already answered, timed out, or lost to a
 * restart).
 */
export function resolveQuestion(
  id: string,
  answer: string,
  source: string,
): string | null {
  const waiter = waiters.get(id);
  if (!waiter) return null;
  waiters.delete(id);
  if (waiter.timer) clearTimeout(waiter.timer);
  setQuestionStatus(id, "answered", answer, source);
  waiter.resolve({ answer, source });
  return answer;
}

/** Resolve a button/select interaction by option index. */
export function resolveQuestionByIndex(
  id: string,
  optionIndex: number,
  source: string,
): string | null {
  const waiter = waiters.get(id);
  if (!waiter) return null;
  const answer = waiter.options[optionIndex];
  if (answer === undefined) return null;
  return resolveQuestion(id, answer, source);
}

/** Options for a live question (empty array = free-text question). */
export function getLiveQuestionOptions(id: string): string[] | null {
  const waiter = waiters.get(id);
  return waiter ? waiter.options : null;
}

/**
 * Find a live (still-waiting) question in this channel that a plain user
 * message should answer. Only matches the user the question was addressed to
 * (or any user if the question had no target).
 */
export function findLiveQuestionForMessage(
  channelId: string,
  userId: string,
): { id: string; options: string[] } | null {
  for (const waiter of waiters.values()) {
    if (waiter.channelId !== channelId) continue;
    if (waiter.userId && waiter.userId !== userId) continue;
    return { id: waiter.id, options: waiter.options };
  }
  return null;
}

/** Number of live waiters — used by tests and diagnostics. */
export function liveQuestionCount(): number {
  return waiters.size;
}
