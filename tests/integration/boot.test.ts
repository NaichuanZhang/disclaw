/**
 * Integration Test: Boot Critical Path
 *
 * Validates the core pipeline that every message flows through:
 *   DB init → Soul load → Memory indexing → System prompt assembly → Response parsing
 *
 * This is the "heartbeat" test — if this fails, the bot cannot function.
 * It does NOT call the Claude API (no network dependency).
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// 1. Database initialization
// ---------------------------------------------------------------------------
describe("Database", () => {
  it("initializes without errors", async () => {
    // initDb() creates tables with IF NOT EXISTS — safe to call on real DB
    const { initDb } = await import("../../src/db/index.js");
    expect(() => initDb()).not.toThrow();
  });

  it("can create and retrieve a session", async () => {
    const { getDb, initDb } = await import("../../src/db/index.js");
    initDb();

    const db = getDb();
    const testSessionId = `test-session-${Date.now()}`;
    const testKey = `test-key-${Date.now()}`;

    // Insert a session
    db.prepare(
      `INSERT INTO sessions (id, discord_key, created_at, last_active) VALUES (?, ?, ?, ?)`
    ).run(testSessionId, testKey, Date.now(), Date.now());

    // Retrieve it
    const row = db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(testSessionId) as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!.discord_key).toBe(testKey);

    // Cleanup
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(testSessionId);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(testSessionId);
  });

  it("has all required tables", async () => {
    const { getDb, initDb } = await import("../../src/db/index.js");
    initDb();

    const db = getDb();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    // Core tables that must exist
    const required = [
      "sessions",
      "messages",
      "channel_configs",
      "config",
      "evolutions",
      "signals",
      "reflection_runs",
      "message_history",
    ];

    for (const table of required) {
      expect(tableNames, `Missing table: ${table}`).toContain(table);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Soul loading
// ---------------------------------------------------------------------------
describe("Soul", () => {
  it("loads soul content", async () => {
    const { initSoul, getSoul, stopSoulWatcher } = await import(
      "../../src/soul/soul.js"
    );

    await initSoul();
    const soul = getSoul();

    expect(soul).toBeTruthy();
    expect(typeof soul).toBe("string");
    expect(soul.length).toBeGreaterThan(0);

    stopSoulWatcher();
  });
});

// ---------------------------------------------------------------------------
// 3. Memory system
// ---------------------------------------------------------------------------
describe("Memory", () => {
  it("initializes and indexes without errors", async () => {
    // Ensure DB is ready (memory uses FTS5 table)
    const { initDb } = await import("../../src/db/index.js");
    initDb();

    const { initMemory, stopMemoryWatcher } = await import(
      "../../src/memory/memory.js"
    );

    await expect(initMemory()).resolves.not.toThrow();
    stopMemoryWatcher();
  });

  it("search returns results array (even if empty)", async () => {
    const { initDb } = await import("../../src/db/index.js");
    initDb();

    const { searchMemory } = await import("../../src/memory/memory.js");
    const results = searchMemory("test query");

    expect(Array.isArray(results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Skills service
// ---------------------------------------------------------------------------
describe("Skills", () => {
  it("initializes without crashing", async () => {
    const { SkillService } = await import("../../src/skills/service.js");

    const service = new SkillService();
    await service.init();

    const skills = service.list();
    expect(Array.isArray(skills)).toBe(true);
    // Skills count may be 0 in worktree environments — that's okay,
    // the important thing is it doesn't crash

    service.stop();
  });

  it("builds skills prompt section", async () => {
    const { SkillService } = await import("../../src/skills/service.js");

    const service = new SkillService();
    await service.init();

    const prompt = service.buildSkillsPromptSection();
    expect(typeof prompt).toBe("string");

    // If skills exist, the prompt should contain the available_skills block
    if (service.list().length > 0) {
      expect(prompt).toContain("<available_skills>");
    }

    service.stop();
  });
});

// ---------------------------------------------------------------------------
// 5. Tool registration (all tools importable without crash)
// ---------------------------------------------------------------------------
describe("Tool Registration", () => {
  it("memory tools export correctly", async () => {
    const { memoryTools } = await import("../../src/memory/tools.js");
    expect(Array.isArray(memoryTools)).toBe(true);
    expect(memoryTools.length).toBeGreaterThan(0);

    for (const tool of memoryTools) {
      expect(tool.name).toBeTruthy();
      expect(tool.input_schema).toBeTruthy();
    }
  });

  it("discord tools export correctly", async () => {
    const { discordTools } = await import("../../src/agent/tools.js");
    expect(Array.isArray(discordTools)).toBe(true);
    expect(discordTools.length).toBeGreaterThan(0);
  });

  it("skill tools export correctly", async () => {
    const { skillTools } = await import("../../src/skills/tools.js");
    expect(Array.isArray(skillTools)).toBe(true);
    expect(skillTools.length).toBeGreaterThan(0);
  });

  it("dangerous tools export correctly", async () => {
    const { dangerousTools } = await import("../../src/agent/dangerous-tools.js");
    expect(Array.isArray(dangerousTools)).toBe(true);
    expect(dangerousTools.length).toBeGreaterThan(0);
  });

  it("evolution tools export correctly", async () => {
    const { evolutionTools } = await import("../../src/evolution/tools.js");
    expect(Array.isArray(evolutionTools)).toBe(true);
    expect(evolutionTools.length).toBeGreaterThan(0);
  });

  it("all tool names are unique", async () => {
    const { memoryTools } = await import("../../src/memory/tools.js");
    const { discordTools } = await import("../../src/agent/tools.js");
    const { skillTools } = await import("../../src/skills/tools.js");
    const { dangerousTools } = await import("../../src/agent/dangerous-tools.js");
    const { evolutionTools } = await import("../../src/evolution/tools.js");

    const allNames = [
      ...memoryTools.map((t) => t.name),
      ...discordTools.map((t) => t.name),
      ...skillTools.map((t) => t.name),
      ...dangerousTools.map((t) => t.name),
      ...evolutionTools.map((t) => t.name),
    ];

    const uniqueNames = new Set(allNames);
    expect(uniqueNames.size).toBe(allNames.length);
  });
});
