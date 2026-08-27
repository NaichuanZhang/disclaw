// ---------------------------------------------------------------------------
// Invocation metrics report (CLI)
// ---------------------------------------------------------------------------
//
//   npx tsx scripts/metrics-report.ts            # full report
//   npx tsx scripts/metrics-report.ts --kind=tool
//   npx tsx scripts/metrics-report.ts --threshold=10 --stale-days=14
//
// Reads the live DB; safe to run while the bot is up (the bot flushes its own
// buffered counts every 60s, so numbers may lag by up to a minute).
// ---------------------------------------------------------------------------

import { initDb } from "../src/db/index.js";
import {
  getDeadPaths,
  getLowUsePaths,
  getMetrics,
  getMetricsSummary,
  getObservationWindow,
  getStalePaths,
  type MetricRow,
} from "../src/metrics/report.js";
import type { PathKind } from "../src/metrics/registry.js";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.split("=").slice(1).join("=");
}

const KINDS: PathKind[] = ["command", "tool", "route", "skill", "feature", "branch"];
const kindArg = arg("kind");
const kind = KINDS.includes(kindArg as PathKind) ? (kindArg as PathKind) : undefined;
const threshold = parseInt(arg("threshold") ?? "", 10) || 5;
const staleDays = parseInt(arg("stale-days") ?? "", 10) || 30;
const topN = parseInt(arg("top") ?? "", 10) || 15;

if (kindArg && !kind) {
  console.error(`Unknown --kind=${kindArg}. Expected one of: ${KINDS.join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function fmtDate(ts: number | null): string {
  return ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 16) : "never";
}

function fmtRows(rows: MetricRow[], opts?: { showCount?: boolean }): string {
  if (rows.length === 0) return "  (none)\n";
  const pad = Math.min(52, Math.max(...rows.map((r) => r.path.length)));
  return (
    rows
      .map((r) => {
        const head = `  ${r.path.padEnd(pad)}`;
        const tail = opts?.showCount ? `  ${String(r.count).padStart(6)}  ${fmtDate(r.lastSeen)}` : "";
        const desc = r.description ? `\n      ${r.description}` : "";
        return head + tail + desc;
      })
      .join("\n") + "\n"
  );
}

function section(title: string): void {
  console.log(`\n${title}\n${"─".repeat(title.length)}`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

initDb();

const window = getObservationWindow();
const summary = getMetricsSummary();

console.log("Invocation metrics");
console.log("==================");
console.log(`Observed from : ${fmtDate(window.since)}`);
console.log(`Last activity : ${fmtDate(window.until)}`);
if (window.since === null) {
  console.log("\nNothing observed yet — the bot has not run with metrics enabled.");
}

section("Coverage by kind");
if (summary.length === 0) {
  console.log("  (nothing declared yet)");
} else {
  console.log("  kind        declared    dead   invocations");
  for (const s of summary) {
    console.log(
      `  ${s.kind.padEnd(10)} ${String(s.declared).padStart(8)} ${String(s.dead).padStart(7)} ${String(
        s.invocations,
      ).padStart(13)}`,
    );
  }
}

section(`Dead — declared, never invoked${kind ? ` (kind: ${kind})` : ""}`);
console.log("  Strong dead-code candidates. Verify against the observation window above.");
console.log(fmtRows(getDeadPaths({ kind })));

section("Idle by design — error/fallback paths that never fired");
const rareIdle = getDeadPaths({ kind, includeRare: true }).filter((r) => r.rare);
console.log("  Expected to be idle. Not deletion candidates.");
console.log(fmtRows(rareIdle));

section(`Low use — invoked ${threshold} time(s) or fewer`);
console.log(fmtRows(getLowUsePaths({ threshold, kind }), { showCount: true }));

section(`Stale — used once, nothing in the last ${staleDays} day(s)`);
console.log(fmtRows(getStalePaths({ days: staleDays }), { showCount: true }));

section(`Top ${topN} busiest paths`);
console.log(fmtRows(getMetrics({ kind, minCount: 1, limit: topN }), { showCount: true }));
