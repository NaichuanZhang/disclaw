/**
 * Integration Test: Invocation metrics
 *
 * Validates the counter → flush → report round trip that backs dead-code and
 * low-use detection. Uses the real DB (like the other integration tests) but
 * confines itself to `test.metrics.*` path ids and deletes them afterwards.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, initDb } from "../../src/db/index.js";
import {
  count,
  countCommand,
  countRoute,
  countSkill,
  countTool,
  declarePaths,
  declareCommandPaths,
  declareRoutePaths,
  declareSkillPaths,
  declareToolPaths,
  flushMetrics,
  pendingMetrics,
} from "../../src/metrics/counters.js";
import {
  getDeadPaths,
  getLowUsePaths,
  getMetrics,
  getMetricsSummary,
} from "../../src/metrics/report.js";
import {
  FEATURE_PATHS,
  P,
  commandPath,
  routePath,
  skillPath,
  toolPath,
} from "../../src/metrics/registry.js";

const PREFIX = "test.metrics.";

/** Unique id per run so parallel/repeat runs never collide. */
function tp(name: string): string {
  return `${PREFIX}${name}.${process.pid}`;
}

function row(path: string): Record<string, unknown> | undefined {
  return getDb().prepare("SELECT * FROM invocation_metrics WHERE path = ?").get(path) as
    | Record<string, unknown>
    | undefined;
}

beforeAll(() => {
  initDb();
});

afterAll(() => {
  // Ids are namespaced by kind (`tool.test.metrics.…`), so match anywhere in
  // the path rather than only at the start.
  getDb().prepare("DELETE FROM invocation_metrics WHERE path LIKE ?").run(`%${PREFIX}%`);
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("invocation_metrics schema", () => {
  it("exists after initDb", () => {
    const table = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invocation_metrics'")
      .get();
    expect(table).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Count → flush
// ---------------------------------------------------------------------------

describe("counting and flushing", () => {
  it("buffers in memory and only writes on flush", () => {
    const path = tp("buffered");
    count(path);
    expect(pendingMetrics()[path]).toBe(1);
    expect(row(path)).toBeUndefined();

    flushMetrics();
    expect(pendingMetrics()[path]).toBeUndefined();
    expect(row(path)?.count).toBe(1);
  });

  it("accumulates across flushes and preserves first_seen", () => {
    const path = tp("accumulate");
    count(path, 3);
    flushMetrics();
    const first = row(path);
    expect(first?.count).toBe(3);

    count(path, 2);
    flushMetrics();
    const second = row(path);
    expect(second?.count).toBe(5);
    expect(second?.first_seen).toBe(first?.first_seen);
    expect(second?.last_seen as number).toBeGreaterThanOrEqual(first?.last_seen as number);
  });

  it("is a no-op when there is nothing pending", () => {
    flushMetrics();
    expect(flushMetrics()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Declaration → dead-code detection
// ---------------------------------------------------------------------------

describe("dead-code detection", () => {
  it("seeds declared paths at count 0 and reports them as dead", () => {
    const path = tp("never-called");
    declarePaths([{ path, kind: "feature", description: "never invoked" }]);

    expect(row(path)?.count).toBe(0);
    expect(getDeadPaths().map((r) => r.path)).toContain(path);
  });

  it("stops reporting a path as dead once it is invoked", () => {
    const path = tp("called-once");
    declarePaths([{ path, kind: "feature", description: "invoked once" }]);
    expect(getDeadPaths().map((r) => r.path)).toContain(path);

    count(path);
    flushMetrics();
    expect(getDeadPaths().map((r) => r.path)).not.toContain(path);
  });

  it("excludes `rare` paths from dead unless asked — idle error handlers are fine", () => {
    const path = tp("rare-branch");
    declarePaths([{ path, kind: "branch", description: "recovery path", rare: true }]);

    expect(getDeadPaths().map((r) => r.path)).not.toContain(path);
    expect(getDeadPaths({ includeRare: true }).map((r) => r.path)).toContain(path);
  });

  it("re-declaring refreshes metadata without resetting the count", () => {
    const path = tp("redeclared");
    declarePaths([{ path, kind: "feature", description: "before" }]);
    count(path, 7);
    flushMetrics();

    declarePaths([{ path, kind: "feature", description: "after" }]);
    expect(row(path)?.count).toBe(7);
    expect(row(path)?.description).toBe("after");
  });
});

// ---------------------------------------------------------------------------
// Low-use reporting
// ---------------------------------------------------------------------------

describe("low-use reporting", () => {
  it("returns invoked-but-rare paths and excludes never-invoked ones", () => {
    const low = tp("low-use");
    const dead = tp("low-use-dead");
    declarePaths([
      { path: low, kind: "feature", description: "barely used" },
      { path: dead, kind: "feature", description: "unused" },
    ]);
    count(low, 2);
    flushMetrics();

    const paths = getLowUsePaths({ threshold: 3 }).map((r) => r.path);
    expect(paths).toContain(low);
    expect(paths).not.toContain(dead);
    expect(getLowUsePaths({ threshold: 1 }).map((r) => r.path)).not.toContain(low);
  });

  it("orders getMetrics by count descending", () => {
    const busy = tp("busy");
    const quiet = tp("quiet");
    count(busy, 50);
    count(quiet, 1);
    flushMetrics();

    const rows = getMetrics({ minCount: 1, limit: 500 });
    const busyIdx = rows.findIndex((r) => r.path === busy);
    const quietIdx = rows.findIndex((r) => r.path === quiet);
    expect(busyIdx).toBeGreaterThanOrEqual(0);
    expect(quietIdx).toBeGreaterThan(busyIdx);
  });

  it("summarises by kind", () => {
    const path = tp("summary");
    declarePaths([{ path, kind: "feature", description: "for the rollup" }]);
    const summary = getMetricsSummary();
    const feature = summary.find((s) => s.kind === "feature");
    expect(feature).toBeDefined();
    expect(feature!.declared).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Dynamic declaration from existing manifests
// ---------------------------------------------------------------------------

describe("dynamic declaration", () => {
  it("declares commands and their subcommands, ignoring non-subcommand options", () => {
    const name = tp("cmd");
    declareCommandPaths([
      {
        name,
        description: "test command",
        options: [
          { name: "sub", description: "a subcommand", type: 1 },
          { name: "text", description: "a string option", type: 3 },
        ],
      },
    ]);

    expect(row(commandPath(name))).toBeTruthy();
    expect(row(commandPath(name, "sub"))).toBeTruthy();
    expect(row(commandPath(name, "text"))).toBeUndefined();
  });

  it("counts a command and its subcommand together", () => {
    const name = tp("cmd-count");
    countCommand(name, "sub");
    flushMetrics();
    expect(row(commandPath(name))?.count).toBe(1);
    expect(row(commandPath(name, "sub"))?.count).toBe(1);
  });

  it("declares tools and skills", () => {
    const tool = tp("tool");
    const skill = tp("skill");
    declareToolPaths([{ name: tool, description: "a tool" }]);
    declareSkillPaths([{ name: skill, description: "a skill" }]);

    expect(row(toolPath(tool))?.kind).toBe("tool");
    expect(row(skillPath(skill))?.kind).toBe("skill");

    countTool(tool);
    countSkill(skill);
    flushMetrics();
    expect(row(toolPath(tool))?.count).toBe(1);
    expect(row(skillPath(skill))?.count).toBe(1);
  });

  it("declares routes from an Express-shaped router stack", () => {
    const p = `/${tp("route")}`;
    declareRoutePaths({
      stack: [
        { route: { path: p, methods: { get: true, _all: true } } },
        { route: undefined },
        {},
      ],
    });

    expect(row(routePath("get", p))?.kind).toBe("route");
    expect(row(routePath("_all", p))).toBeUndefined();

    countRoute("GET", p);
    flushMetrics();
    expect(row(routePath("get", p))?.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Registry hygiene
// ---------------------------------------------------------------------------

describe("path registry", () => {
  it("has no duplicate path ids", () => {
    const paths = FEATURE_PATHS.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("declares a spec for every id exported from P", () => {
    const declaredPaths = new Set(FEATURE_PATHS.map((s) => s.path));
    for (const id of Object.values(P)) {
      expect(declaredPaths, `missing spec for ${id}`).toContain(id);
    }
  });

  it("gives every spec a non-empty description", () => {
    for (const spec of FEATURE_PATHS) {
      expect(spec.description.length, `empty description for ${spec.path}`).toBeGreaterThan(0);
    }
  });

  it("builds namespaced path ids", () => {
    expect(commandPath("cron")).toBe("command.cron");
    expect(commandPath("cron", "list")).toBe("command.cron.list");
    expect(toolPath("bash")).toBe("tool.bash");
    expect(routePath("get", "/status")).toBe("route.GET /status");
    expect(skillPath("readlist")).toBe("skill.readlist");
  });
});
