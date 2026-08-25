// ---------------------------------------------------------------------------
// Pilot mode smoke test (manual, not part of CI)
//
//   npx tsx scripts/pilot-smoke.ts
//
// Boots a real Claude Agent SDK session with the exact options pilot mode uses
// (sandboxed cwd, env allowlist, bypassPermissions) and asks it one question,
// then asks it to run a shell command. Nothing is gated: pilot mode runs with
// allowDangerouslySkipPermissions, so this only proves the session works.
//
// Requires working credentials in ~/.claude (or PILOT_ANTHROPIC_API_KEY).
// ---------------------------------------------------------------------------

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildPilotEnv } from "../src/pilot/env.js";
import { PILOT_WORKSPACE_DIR, ensurePilotDirs } from "../src/pilot/session.js";

const prompts = [
  "Reply with exactly: pilot-ok",
  "Run this shell command with Bash and tell me what happened: echo pilot-bash-ok",
];

// Mirror the real session: an open-ended generator, fed one prompt per
// completed turn.
let queue: string[] = [...prompts];
let wake: (() => void) | null = null;
let closed = false;

function pump(): void {
  const w = wake;
  wake = null;
  w?.();
}

function close(): void {
  closed = true;
  pump();
}

async function* promptStream(): AsyncGenerator<SDKUserMessage> {
  while (!closed) {
    while (queue.length > 0) {
      const text = queue.shift()!;
      yield {
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: "",
      } as SDKUserMessage;
    }
    if (closed) return;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
}

async function main(): Promise<void> {
  ensurePilotDirs();
  let turns = 0;

  const stream = query({
    prompt: promptStream(),
    options: {
      cwd: PILOT_WORKSPACE_DIR,
      env: buildPilotEnv(),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      includePartialMessages: false,
      stderr: (data) => {
        const t = data.trim();
        if (t) console.error(`[smoke:cli] ${t.slice(0, 300)}`);
      },
    },
  });

  for await (const message of stream) {
    if (message.type === "system") {
      const m = message as { subtype?: string; session_id?: string };
      if (m.subtype === "init") console.log(`[smoke] session ${m.session_id}`);
      continue;
    }
    if (message.type === "assistant") {
      const blocks = (message as { message?: { content?: unknown } }).message
        ?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          console.log(`[smoke] assistant: ${b.text.trim().slice(0, 400)}`);
        } else if (b.type === "tool_use") {
          console.log(`[smoke] tool_use: ${String(b.name)}`);
        }
      }
      continue;
    }
    if (message.type === "result") {
      const r = message as { subtype?: string; is_error?: boolean };
      console.log(`[smoke] result: ${r.subtype} is_error=${r.is_error}`);
      turns += 1;
      if (turns >= prompts.length) close();
      else pump();
    }
  }

  console.log(`[smoke] done — ${turns} turn(s), no permission gating`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] failed:", err);
  process.exit(1);
});
