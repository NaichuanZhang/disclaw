// ---------------------------------------------------------------------------
// Per-session folders
//
// Every session owns a folder under the workspace, and the layout mirrors
// Discord's own channel -> thread hierarchy. The parts worth pinning down are
// the ones that would fail quietly:
//
//   - a thread nests under its parent, so a channel's work and its threads'
//     work stay grouped rather than sitting as unrelated numeric siblings;
//   - ids that are not snowflakes (cron ids, test ids, blank strings) still
//     produce a safe, *distinct* segment — a digits-only sanitiser would
//     collapse `chan-1` and `dm-1` onto the same folder;
//   - a `..` in an id cannot escape the workspace;
//   - scaffolding never overwrites an existing CLAUDE.md, because that file is
//     the durable record of the conversation and holds notes we must not lose.
//
// The scaffolding tests write into the real sessions/ root (there is no
// injection seam), so they use marked ids and remove them afterwards.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readFileSync as read } from "node:fs";
// session-dirs.ts only, never session.ts: session.ts reaches the database, and
// importing it here adds another worker racing initDb(). The agreement between
// SDK_SESSIONS_DIR and SDK_WORKSPACE_DIR is pinned in sdk-attachments.test.ts,
// which already imports both.
import {
  SDK_SESSIONS_DIR,
  sdkSessionDir,
  ensureSdkSessionDir,
} from "../../src/sdk/session-dirs.js";

/** Ids used by the scaffolding tests, cleaned up after each one. */
const created: string[] = [];

function markedId(name: string): string {
  const id = `test-session-dirs-${name}`;
  created.push(id);
  return id;
}

afterEach(() => {
  for (const id of created.splice(0)) {
    rmSync(path.join(SDK_SESSIONS_DIR, id), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Path shape
// ---------------------------------------------------------------------------

describe("sdkSessionDir", () => {
  it("keeps every session under the one root, so a cwd prefix check works", () => {
    expect(sdkSessionDir("123").startsWith(SDK_SESSIONS_DIR)).toBe(true);
    expect(sdkSessionDir("456", "123").startsWith(SDK_SESSIONS_DIR)).toBe(true);
  });

  it("nests a thread under its parent channel", () => {
    expect(sdkSessionDir("456", "123")).toBe(
      path.join(SDK_SESSIONS_DIR, "123", "threads", "456"),
    );
  });

  it("keys a thread by its own id, not the parent's", () => {
    // The session key is the thread's own snowflake, so two threads under one
    // channel must not share a folder.
    const a = sdkSessionDir("456", "123");
    const b = sdkSessionDir("789", "123");
    expect(a).not.toBe(b);
    expect(path.basename(a)).toBe("456");
    expect(path.basename(b)).toBe("789");
  });

  it("leaves a session with no parent flat at the top level", () => {
    // DMs, group DMs and a channel that never spawned a thread.
    expect(sdkSessionDir("dm-1")).toBe(path.join(SDK_SESSIONS_DIR, "dm-1"));
    expect(sdkSessionDir("dm-1", null)).toBe(path.join(SDK_SESSIONS_DIR, "dm-1"));
    expect(sdkSessionDir("dm-1", undefined)).toBe(
      path.join(SDK_SESSIONS_DIR, "dm-1"),
    );
  });

  it("treats a blank parent as no parent rather than nesting under nothing", () => {
    expect(sdkSessionDir("chan-1", "   ")).toBe(
      path.join(SDK_SESSIONS_DIR, "chan-1"),
    );
  });

  it("keeps non-snowflake ids distinct", () => {
    // Cron and test ids are not numeric. Stripping to digits would map both of
    // these onto "1".
    expect(sdkSessionDir("chan-1")).not.toBe(sdkSessionDir("dm-1"));
  });

  it("trims surrounding whitespace instead of creating a padded twin", () => {
    expect(sdkSessionDir(" chan-1 ")).toBe(sdkSessionDir("chan-1"));
  });

  it("falls back to a placeholder for an id with nothing usable in it", () => {
    expect(sdkSessionDir("   ")).toBe(path.join(SDK_SESSIONS_DIR, "unknown"));
  });

  it("cannot be walked out of the sessions root", () => {
    for (const id of ["..", "../..", "../../etc", "a/../../b"]) {
      const dir = sdkSessionDir(id);
      expect(dir.startsWith(SDK_SESSIONS_DIR)).toBe(true);
      expect(path.relative(SDK_SESSIONS_DIR, dir)).not.toContain("..");
    }
    const nested = sdkSessionDir("..", "..");
    expect(nested.startsWith(SDK_SESSIONS_DIR)).toBe(true);
    expect(path.relative(SDK_SESSIONS_DIR, nested)).not.toContain("..");
  });
});

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

describe("ensureSdkSessionDir", () => {
  it("creates the folder and seeds a CLAUDE.md", () => {
    const id = markedId("seed");
    const dir = ensureSdkSessionDir(id);

    expect(dir).toBe(path.join(SDK_SESSIONS_DIR, id));
    expect(existsSync(dir)).toBe(true);

    const seed = readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    expect(seed).toContain(`**Session id:** ${id}`);
    expect(seed).toContain("**Parent:** none");
    expect(seed).toContain("**Status:** active");
  });

  it("records the parent id and the human channel name", () => {
    const parent = markedId("parent");
    const dir = ensureSdkSessionDir("thread-9", parent, "  #design-review  ");

    expect(dir).toBe(path.join(SDK_SESSIONS_DIR, parent, "threads", "thread-9"));

    const seed = readFileSync(path.join(dir, "CLAUDE.md"), "utf8");
    // The name is the one renameable thing, so it belongs in the heading —
    // never in the directory name.
    expect(seed).toContain("# #design-review");
    expect(seed).toContain(`**Parent:** ${parent}`);
    expect(seed).toContain("**Session id:** thread-9");
  });

  it("falls back to the id when there is no channel name", () => {
    const id = markedId("noname");
    const dir = ensureSdkSessionDir(id, null, "   ");
    expect(readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toContain(`# ${id}`);
  });

  it("never overwrites notes already in the CLAUDE.md", () => {
    const id = markedId("noclobber");
    const dir = path.join(SDK_SESSIONS_DIR, id);
    mkdirSync(dir, { recursive: true });
    const existing = "# hand-written\n\n- **Status:** blocked\n\nnotes worth keeping\n";
    writeFileSync(path.join(dir, "CLAUDE.md"), existing);

    ensureSdkSessionDir(id);

    expect(readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toBe(existing);
  });

  it("is safe to call on every session start", () => {
    const id = markedId("idempotent");
    const first = ensureSdkSessionDir(id);
    const seed = readFileSync(path.join(first, "CLAUDE.md"), "utf8");

    expect(ensureSdkSessionDir(id)).toBe(first);
    expect(readFileSync(path.join(first, "CLAUDE.md"), "utf8")).toBe(seed);
  });
});

// ---------------------------------------------------------------------------
// Wiring
//
// buildOptions() is private and constructing a real session would spawn the
// CLI, so these are source-level guards — the same approach sdk-guards.test.ts
// uses for the bridge and evolution wiring.
// ---------------------------------------------------------------------------

describe("session wiring", () => {
  const sessionSrc = read(
    new URL("../../src/sdk/session.ts", import.meta.url),
    "utf8",
  );

  it("loads project settings, which is what makes the workspace CLAUDE.md apply", () => {
    expect(sessionSrc).toContain('settingSources: ["project"]');
  });

  it("still withholds the operator's own user settings", () => {
    // Scoped to the option's own value: `"user"` occurs all over this file
    // (message roles, prompt copy), so a bare substring search proves nothing.
    const match = sessionSrc.match(/settingSources:\s*\[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const sources = match![1];
    expect(sources).toContain('"project"');
    expect(sources).not.toContain('"user"');
    expect(sources).not.toContain('"local"');
  });

  it("scaffolds the session folder when a session starts", () => {
    expect(sessionSrc).toContain(
      "ensureSdkSessionDir(this.channelId, this.parentId, this.logChannelName)",
    );
  });

  it("tells the session where its artifacts belong", () => {
    expect(sessionSrc).toContain("this.sessionDirRelative()");
  });
});
