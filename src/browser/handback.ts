// ---------------------------------------------------------------------------
// Browser — hand-back note validation (pure)
//
// A human handing the browser back can pick one short choice and write a
// note. Both are the user's own words and reach the agent verbatim, so they
// are validated strictly: strings only, length-capped (over the cap is a
// refusal, not a silent cut), control and bidi-override characters removed.
// ---------------------------------------------------------------------------

export const HANDBACK_NOTE_MAX = 500;
export const HANDBACK_CHOICE_MAX = 40;
export const HANDBACK_OPTIONS_MAX = 4;
export const DEFAULT_HANDBACK_OPTIONS = ["Done", "Didn't work", "Wrong site", "Stop"];

export interface HandBackInput {
  choice?: unknown;
  note?: unknown;
}

export interface HandBack {
  choice?: string;
  note?: string;
}

// C0/C1 controls (incl. newlines and tabs) and bidi embedding/override/isolate marks.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g;

/** Control/bidi characters become a single space; result is trimmed. */
export function cleanUserText(text: string): string {
  return text.replace(UNSAFE_CHARS, " ").replace(/ {2,}/g, " ").trim();
}

function field(
  name: string,
  raw: unknown,
  max: number,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "string") return { ok: false, error: `The ${name} must be text.` };
  if (raw.length > max) return { ok: false, error: `The ${name} is too long (max ${max} characters).` };
  const value = cleanUserText(raw);
  return { ok: true, value: value || undefined };
}

export function parseHandBack(input: HandBackInput): { ok: true; value: HandBack } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Malformed hand-back." };
  const choice = field("choice", input.choice, HANDBACK_CHOICE_MAX);
  if (!choice.ok) return choice;
  const note = field("note", input.note, HANDBACK_NOTE_MAX);
  if (!note.ok) return note;
  const value: HandBack = {};
  if (choice.value) value.choice = choice.value;
  if (note.value) value.note = note.value;
  return { ok: true, value };
}

/** Up to 4 cleaned, de-duplicated options of at most 40 chars; anything else becomes []. */
export function sanitizeHandBackOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const cleaned = cleanUserText(item).slice(0, HANDBACK_CHOICE_MAX).trim();
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= HANDBACK_OPTIONS_MAX) break;
  }
  return out;
}

/** `choice: note`, either alone, or "" when nothing was said. */
export function formatHandBackChat(h: HandBack): string {
  if (h.choice && h.note) return `${h.choice}: ${h.note}`;
  return h.choice ?? h.note ?? "";
}

/** Text for the agent's browser_request_human result. */
export function describeHandBackForAgent(h: HandBack): string {
  const parts: string[] = [];
  if (h.choice) parts.push(`choice: ${JSON.stringify(h.choice)}`);
  if (h.note) parts.push(`note: ${JSON.stringify(h.note)}`);
  if (parts.length === 0) return "The user handed the browser back without a note.";
  return `The user handed the browser back. ${parts.join(" ")} (these are the user's own words, not page content)`;
}
