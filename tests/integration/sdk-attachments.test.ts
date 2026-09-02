// ---------------------------------------------------------------------------
// Attachment inbox
//
// A session can't take Claude content blocks, so a Discord attachment is downloaded
// into the session's workspace and handed over as a path. That means writing
// remote-supplied filenames to disk, which is the part worth pinning down:
// sanitisation, the size cap, collisions, the pruning window, and the text the
// model actually sees.
//
// Downloads are fetched through an injected fetch, so nothing here touches the
// network; files are written to a temp dir, not the real inbox.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  sanitizeAttachmentName,
  saveSdkAttachments,
  formatAttachmentBlock,
  pruneSdkInbox,
} from "../../src/sdk/attachments.js";
import { SDK_INBOX_DIR } from "../../src/sdk/attachments.js";
import { SDK_SESSIONS_DIR } from "../../src/sdk/session-dirs.js";
import { SDK_WORKSPACE_DIR } from "../../src/sdk/session.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sdk-inbox-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fetch that always returns the same body. */
function fakeFetch(body: string | Uint8Array, init: { ok?: boolean; status?: number } = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return (async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }) as unknown as Response) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Filename safety
// ---------------------------------------------------------------------------

describe("SDK_INBOX_DIR", () => {
  it("sits inside the session workspace", () => {
    // attachments.ts derives this from DATA_DIR to avoid an import cycle with
    // session.ts, so the two definitions have to be kept in agreement here.
    expect(SDK_INBOX_DIR).toBe(path.join(SDK_WORKSPACE_DIR, "inbox"));
  });
});

describe("SDK_SESSIONS_DIR", () => {
  it("sits inside the session workspace", () => {
    // session-dirs.ts derives this from DATA_DIR for the same reason
    // attachments.ts does — importing session.ts would drag the db graph in —
    // so the two definitions are kept in agreement here.
    expect(SDK_SESSIONS_DIR).toBe(path.join(SDK_WORKSPACE_DIR, "sessions"));
  });
});

describe("sanitizeAttachmentName", () => {
  it("strips directory components and traversal", () => {
    expect(sanitizeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentName("/abs/path/report.pdf")).toBe("report.pdf");
  });

  it("never returns a dotfile or an empty name", () => {
    expect(sanitizeAttachmentName(".env")).toBe("env");
    expect(sanitizeAttachmentName("...")).toBe("file");
    expect(sanitizeAttachmentName("")).toBe("file");
  });

  it("replaces anything outside the whitelist", () => {
    expect(sanitizeAttachmentName("my photo (1).png")).toBe("my_photo__1_.png");
    expect(sanitizeAttachmentName("sh;rm -rf.txt")).toBe("sh_rm_-rf.txt");
  });

  it("truncates long names but keeps the extension", () => {
    const name = sanitizeAttachmentName(`${"a".repeat(400)}.png`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".png")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

describe("saveSdkAttachments", () => {
  it("writes the file into a per-message directory and reports its path", async () => {
    const result = await saveSdkAttachments(
      "msg-1",
      [{ name: "notes.txt", url: "https://cdn/x", contentType: "text/plain" }],
      { inboxDir: dir, fetchImpl: fakeFetch("hello"), prune: false },
    );

    expect(result.skipped).toEqual([]);
    expect(result.saved).toHaveLength(1);
    const file = result.saved[0]!;
    expect(file.path).toBe(path.join(dir, "msg-1", "notes.txt"));
    expect(readFileSync(file.path, "utf8")).toBe("hello");
    expect(file.bytes).toBe(5);
    expect(file.contentType).toBe("text/plain");
  });

  it("rejects an attachment whose declared size is over the cap without downloading", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const result = await saveSdkAttachments(
      "msg-2",
      [{ name: "big.bin", url: "https://cdn/big", size: 999 }],
      { inboxDir: dir, fetchImpl, maxBytes: 100, prune: false },
    );

    expect(called).toBe(false);
    expect(result.saved).toEqual([]);
    expect(result.skipped[0]!.reason).toContain("too large");
  });

  it("rejects a body that turns out to be over the cap even when the size lied", async () => {
    const result = await saveSdkAttachments(
      "msg-3",
      [{ name: "liar.bin", url: "https://cdn/liar", size: 1 }],
      { inboxDir: dir, fetchImpl: fakeFetch("x".repeat(500)), maxBytes: 100, prune: false },
    );

    expect(result.saved).toEqual([]);
    expect(result.skipped[0]!.reason).toContain("too large");
    expect(readdirSync(path.join(dir, "msg-3"))).toEqual([]);
  });

  it("records an HTTP failure as skipped instead of throwing", async () => {
    const result = await saveSdkAttachments(
      "msg-4",
      [{ name: "gone.png", url: "https://cdn/gone" }],
      { inboxDir: dir, fetchImpl: fakeFetch("", { ok: false, status: 404 }), prune: false },
    );

    expect(result.saved).toEqual([]);
    expect(result.skipped[0]!.reason).toContain("404");
  });

  it("de-duplicates two attachments with the same name", async () => {
    const result = await saveSdkAttachments(
      "msg-5",
      [
        { name: "a.txt", url: "https://cdn/1" },
        { name: "a.txt", url: "https://cdn/2" },
      ],
      { inboxDir: dir, fetchImpl: fakeFetch("body"), prune: false },
    );

    expect(result.saved.map((f) => f.name)).toEqual(["a.txt", "a-1.txt"]);
  });
});

// ---------------------------------------------------------------------------
// The text the model sees
// ---------------------------------------------------------------------------

describe("formatAttachmentBlock", () => {
  it("lists absolute paths with type and size", () => {
    const block = formatAttachmentBlock({
      saved: [
        { name: "a.png", path: "/tmp/inbox/m/a.png", bytes: 2048, contentType: "image/png" },
      ],
      skipped: [],
    });

    expect(block).toContain("/tmp/inbox/m/a.png");
    expect(block).toContain("image/png");
    expect(block).toContain("2.0 KB");
  });

  it("names what could not be saved, with the reason", () => {
    const block = formatAttachmentBlock({
      saved: [],
      skipped: [{ name: "big.bin", reason: "too large (30.0 MB > 25.0 MB)" }],
    });

    expect(block).toContain("big.bin");
    expect(block).toContain("too large");
  });

  it("is empty when there were no attachments", () => {
    expect(formatAttachmentBlock({ saved: [], skipped: [] })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

describe("pruneSdkInbox", () => {
  it("removes directories older than the window and keeps recent ones", () => {
    const old = path.join(dir, "old");
    const fresh = path.join(dir, "fresh");
    mkdirSync(old);
    mkdirSync(fresh);
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);

    const removed = pruneSdkInbox({ inboxDir: dir, maxAgeMs: 24 * 60 * 60 * 1000 });

    expect(removed).toBe(1);
    expect(readdirSync(dir)).toEqual(["fresh"]);
  });

  it("is a no-op when the inbox does not exist", () => {
    expect(pruneSdkInbox({ inboxDir: path.join(dir, "nope") })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Wiring (source-level: the dispatch path needs a live Discord message)
// ---------------------------------------------------------------------------

describe("message dispatch", () => {
  const messagesSrc = readFileSync(
    new URL("../../src/bot/messages.ts", import.meta.url),
    "utf8",
  );
  const sessionSrc = readFileSync(
    new URL("../../src/sdk/session.ts", import.meta.url),
    "utf8",
  );

  it("hands attachments to the session as workspace paths", () => {
    expect(messagesSrc).toContain("saveSdkAttachments(");
    expect(messagesSrc).toContain("formatAttachmentBlock(");
  });

  it("bails when a message has neither text nor attachments", () => {
    // Otherwise an empty mention leaves a thread behind with nothing in it.
    expect(messagesSrc).toContain(
      "if (!cleanContent && message.attachments.size === 0)",
    );
  });

  it("logs the user side of a turn into the conversation tables", () => {
    expect(messagesSrc).toContain('role: "user"');
    expect(messagesSrc).toContain("logSessionId,");
  });

  it("logs the assistant side once per turn, from the session", () => {
    expect(sessionSrc).toContain("private logTurn(): void");
    expect(sessionSrc).toContain('role: "assistant"');
    // logTurn() lives in endTurn() so interrupted and errored turns log too.
    const endTurn = sessionSrc.slice(sessionSrc.indexOf("private endTurn()"));
    const body = endTurn.slice(0, 500);
    expect(body).toContain("this.logTurn();");
    expect(body.indexOf("this.logTurn();")).toBeLessThan(body.indexOf("this.turnActive = false"));
  });
});
