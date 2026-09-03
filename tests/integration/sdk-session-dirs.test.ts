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
import os from "node:os";
// session-dirs.ts only, never session.ts: session.ts reaches the database, and
// importing it here adds another worker racing initDb(). The agreement between
// SDK_SESSIONS_DIR and SDK_WORKSPACE_DIR is pinned in sdk-attachments.test.ts,
// which already imports both.
import {
  SDK_SESSIONS_DIR,
  claudeProjectDir,
  claudeProjectKey,
  isInsideDir,
  migrateTranscript,
  sdkSessionDir,
  sdkSessionInboxDir,
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
    expect(sessionSrc).toContain("this.sessionDir()");
  });

  it("runs the session in its own folder, not the shared workspace root", () => {
    expect(sessionSrc).toContain("cwd: this.sessionDir()");
    expect(sessionSrc).not.toContain("cwd: SDK_WORKSPACE_DIR");
  });

  it("relocates a stored transcript before resuming", () => {
    expect(sessionSrc).toContain("if (options.resume) this.ensureTranscriptVisible(options.resume)");
  });

  it("cross-checks the derived project key against the init handshake", () => {
    expect(sessionSrc).toContain("checkTranscriptLocation");
    expect(sessionSrc).toContain("transcript_path");
  });

  it("sweeps orphans by prefix, so nested session cwds are still caught", () => {
    // The exact compare this replaces would have matched none of them.
    expect(sessionSrc).toContain("isInsideDir(SDK_WORKSPACE_DIR, cwd)");
    expect(sessionSrc).not.toMatch(
      /path\.resolve\(cwd\) !== path\.resolve\(SDK_WORKSPACE_DIR\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// Per-session inbox
// ---------------------------------------------------------------------------

describe("sdkSessionInboxDir", () => {
  it("sits inside the session's own folder", () => {
    expect(sdkSessionInboxDir("1", "2")).toBe(
      path.join(sdkSessionDir("1", "2"), "inbox"),
    );
  });

  it("nests for a thread, stays flat for a DM", () => {
    expect(sdkSessionInboxDir("thread", "parent")).toBe(
      path.join(SDK_SESSIONS_DIR, "parent", "threads", "thread", "inbox"),
    );
    expect(sdkSessionInboxDir("dm")).toBe(
      path.join(SDK_SESSIONS_DIR, "dm", "inbox"),
    );
  });
});

// ---------------------------------------------------------------------------
// isInsideDir
//
// The reason the orphan sweep can move from an exact compare to a prefix one:
// the near-miss cases have to be wrong in the safe direction.
// ---------------------------------------------------------------------------

describe("isInsideDir", () => {
  it("matches the directory itself", () => {
    expect(isInsideDir("/a/b", "/a/b")).toBe(true);
    expect(isInsideDir("/a/b", "/a/b/")).toBe(true);
  });

  it("matches anything nested below it, at any depth", () => {
    expect(isInsideDir("/a/b", "/a/b/c")).toBe(true);
    expect(isInsideDir("/a/b", "/a/b/sessions/1/threads/2")).toBe(true);
  });

  it("does NOT match a sibling whose name merely starts the same", () => {
    // The case a bare startsWith() would get wrong, and the reason the
    // separator is part of the prefix.
    expect(isInsideDir("/a/b", "/a/b-evil")).toBe(false);
    expect(isInsideDir("/a/b", "/a/b-evil/deep")).toBe(false);
    expect(isInsideDir("/a/b", "/a/bb")).toBe(false);
  });

  it("does not match a parent or an unrelated path", () => {
    expect(isInsideDir("/a/b", "/a")).toBe(false);
    expect(isInsideDir("/a/b", "/x/y")).toBe(false);
  });

  it("normalises before comparing", () => {
    expect(isInsideDir("/a/b", "/a/b/c/../d")).toBe(true);
    expect(isInsideDir("/a/b", "/a/b/../c")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Transcript location
//
// The CLI keys transcripts by cwd, so per-session cwd moves the key. The rule
// below was confirmed by observation rather than read off a contract — which is
// why session.ts also cross-checks it against the init handshake at runtime.
// ---------------------------------------------------------------------------

describe("claudeProjectKey", () => {
  it("replaces every separator with a dash, leading one included", () => {
    expect(claudeProjectKey("/home/alex/discordclaw/data/sdk/workspace")).toBe(
      "-home-alex-discordclaw-data-sdk-workspace",
    );
  });

  it("matches the key observed for a nested session folder", () => {
    expect(
      claudeProjectKey(
        "/home/alex/discordclaw/data/sdk/workspace/sessions/1541618232065261668/threads/1544753751003373571",
      ),
    ).toBe(
      "-home-alex-discordclaw-data-sdk-workspace-sessions-1541618232065261668-threads-1544753751003373571",
    );
  });

  it("resolves a relative path first, so the key is always absolute", () => {
    expect(claudeProjectKey(".")).toBe(claudeProjectKey(process.cwd()));
  });
});

describe("claudeProjectDir", () => {
  it("joins the key under the projects root", () => {
    expect(claudeProjectDir("/a/b", "/root")).toBe(path.join("/root", "-a-b"));
  });
});

describe("migrateTranscript", () => {
  const tmpRoots: string[] = [];

  function tmpRoot(name: string): string {
    const dir = path.join(
      os.tmpdir(),
      `sdk-transcript-${name}-${process.pid}-${tmpRoots.length}`,
    );
    mkdirSync(dir, { recursive: true });
    tmpRoots.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tmpRoots.length > 0) {
      const dir = tmpRoots.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const SESSION = "abc-123";
  const CWD = "/some/session/folder";

  function seedSource(projectsRoot: string, key = "-old-cwd"): string {
    const dir = path.join(projectsRoot, key);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${SESSION}.jsonl`), '{"a":1}\n');
    return dir;
  }

  it("copies a transcript found under a different project key", () => {
    const root = tmpRoot("copy");
    const source = seedSource(root);
    const result = migrateTranscript({
      sessionId: SESSION,
      toCwd: CWD,
      projectsRoot: root,
    });
    expect(result.status).toBe("copied");
    expect(result.from).toBe(source);
    const dest = path.join(claudeProjectDir(CWD, root), `${SESSION}.jsonl`);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe('{"a":1}\n');
  });

  it("copies rather than moves, so a wrong key derivation cannot lose history", () => {
    // The whole reason this is a copy: reverting the cwd change must still
    // resume, and the worst case must be a duplicated file.
    const root = tmpRoot("nondestructive");
    const source = seedSource(root);
    migrateTranscript({ sessionId: SESSION, toCwd: CWD, projectsRoot: root });
    expect(existsSync(path.join(source, `${SESSION}.jsonl`))).toBe(true);
  });

  it("brings the subagent transcripts along", () => {
    const root = tmpRoot("subagents");
    const source = seedSource(root);
    mkdirSync(path.join(source, SESSION, "subagents"), { recursive: true });
    writeFileSync(
      path.join(source, SESSION, "subagents", "agent-x.jsonl"),
      '{"b":2}\n',
    );
    expect(
      migrateTranscript({ sessionId: SESSION, toCwd: CWD, projectsRoot: root })
        .status,
    ).toBe("copied");
    expect(
      existsSync(
        path.join(
          claudeProjectDir(CWD, root),
          SESSION,
          "subagents",
          "agent-x.jsonl",
        ),
      ),
    ).toBe(true);
  });

  it("is a no-op when the destination already has it", () => {
    const root = tmpRoot("present");
    seedSource(root);
    const destDir = claudeProjectDir(CWD, root);
    mkdirSync(destDir, { recursive: true });
    writeFileSync(path.join(destDir, `${SESSION}.jsonl`), "kept\n");
    const result = migrateTranscript({
      sessionId: SESSION,
      toCwd: CWD,
      projectsRoot: root,
    });
    expect(result.status).toBe("already-present");
    // Never clobbers what is already there.
    expect(readFileSync(path.join(destDir, `${SESSION}.jsonl`), "utf8")).toBe(
      "kept\n",
    );
  });

  it("reports source-missing when the CLI has already pruned it", () => {
    // Not an error: run() then fails the resume and starts fresh, which is the
    // behaviour that already existed.
    const root = tmpRoot("pruned");
    expect(
      migrateTranscript({ sessionId: SESSION, toCwd: CWD, projectsRoot: root })
        .status,
    ).toBe("source-missing");
  });

  it("reports source-missing when the projects root does not exist at all", () => {
    expect(
      migrateTranscript({
        sessionId: SESSION,
        toCwd: CWD,
        projectsRoot: path.join(os.tmpdir(), "sdk-transcript-absent-nowhere"),
      }).status,
    ).toBe("source-missing");
  });

  it("refuses a session id that could escape the projects directory", () => {
    const root = tmpRoot("traversal");
    for (const bad of ["../escape", "a/b", "..", ""]) {
      expect(
        migrateTranscript({ sessionId: bad, toCwd: CWD, projectsRoot: root })
          .status,
      ).toBe("failed");
    }
  });

  it("never throws, whatever it is handed", () => {
    const root = tmpRoot("safe");
    seedSource(root);
    expect(() =>
      migrateTranscript({
        sessionId: SESSION,
        // A path that cannot be created: the copy fails, the caller carries on.
        toCwd: "/proc/definitely/not/writable",
        projectsRoot: root,
      }),
    ).not.toThrow();
  });
});
