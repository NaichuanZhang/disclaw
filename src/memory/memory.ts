import { watch, existsSync, statSync, readFileSync, type FSWatcher } from "node:fs";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { DATA_DIR } from "../shared/paths.js";
import { getDb } from "../db/index.js";
import { count as countInvocation } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MEMORY_FILE = join(DATA_DIR, "MEMORY.md");
const MEMORY_DIR = join(DATA_DIR, "memory");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemorySearchResult {
  path: string;
  chunkText: string;
  startLine: number;
  endLine: number;
  score: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** mtime (ms) of each indexed file — avoids re-indexing unchanged files. */
const mtimeCache = new Map<string, number>();

let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

async function discoverMemoryFiles(): Promise<string[]> {
  const files: string[] = [];

  if (existsSync(MEMORY_FILE)) {
    files.push(MEMORY_FILE);
  }

  if (existsSync(MEMORY_DIR)) {
    const entries = await readdir(MEMORY_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(join(MEMORY_DIR, entry.name));
      }
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 1600; // ~400 tokens
const OVERLAP = 320;     // ~80 tokens

interface Chunk {
  text: string;
  startLine: number;
  endLine: number;
}

function chunkFile(content: string): Chunk[] {
  const chunks: Chunk[] = [];

  let pos = 0;        // current char offset into `content`
  let lineIdx = 0;    // current line index

  while (pos < content.length) {
    const end = Math.min(pos + CHUNK_SIZE, content.length);
    let sliceEnd = end;

    // Try to break on a paragraph boundary (double newline) near the end
    if (end < content.length) {
      const paraBreak = content.lastIndexOf("\n\n", end);
      if (paraBreak > pos + CHUNK_SIZE / 2) {
        sliceEnd = paraBreak + 2; // include the double newline
      }
    }

    const chunkText = content.slice(pos, sliceEnd);

    // Compute start/end line numbers (1-based)
    const startLine = lineIdx + 1;
    const linesInChunk = chunkText.split("\n").length;
    const endLine = startLine + linesInChunk - 1;

    chunks.push({ text: chunkText, startLine, endLine });

    // Advance with overlap
    const advance = sliceEnd - pos - OVERLAP;
    const step = Math.max(advance, 1);

    // Count lines we're advancing past
    const advancedText = content.slice(pos, pos + step);
    const advancedLines = advancedText.split("\n").length - 1;
    lineIdx += advancedLines;

    pos += step;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

function indexFile(absPath: string, content: string): void {
  const db = getDb();
  const relPath = relative(DATA_DIR, absPath);

  // Remove old chunks for this file
  db.prepare("DELETE FROM memory_fts WHERE path = ?").run(relPath);

  const chunks = chunkFile(content);
  const insert = db.prepare(
    "INSERT INTO memory_fts (path, chunk_text, start_line, end_line) VALUES (?, ?, ?, ?)"
  );

  const insertAll = db.transaction(() => {
    for (const chunk of chunks) {
      insert.run(relPath, chunk.text, chunk.startLine, chunk.endLine);
    }
  });

  insertAll();
  console.log(`[memory] Indexed ${relPath} (${chunks.length} chunks)`);
}

async function indexAllFiles(): Promise<void> {
  const files = await discoverMemoryFiles();

  for (const absPath of files) {
    const stat = statSync(absPath);
    const mtime = stat.mtimeMs;
    const cached = mtimeCache.get(absPath);

    if (cached !== undefined && cached === mtime) {
      continue; // unchanged
    }

    const content = await readFile(absPath, "utf-8");
    indexFile(absPath, content);
    mtimeCache.set(absPath, mtime);
  }

  // Clean up entries for files that no longer exist
  const currentPaths = new Set(files.map((f) => relative(DATA_DIR, f)));
  for (const [absPath] of mtimeCache) {
    const relPath = relative(DATA_DIR, absPath);
    if (!currentPaths.has(relPath)) {
      getDb().prepare("DELETE FROM memory_fts WHERE path = ?").run(relPath);
      mtimeCache.delete(absPath);
      console.log(`[memory] Removed index for deleted file: ${relPath}`);
    }
  }
}

// ---------------------------------------------------------------------------
// File watcher
// ---------------------------------------------------------------------------

function startWatcher(): void {
  // Watch data directory recursively for .md changes
  if (!existsSync(DATA_DIR)) return;

  watcher = watch(DATA_DIR, { recursive: true }, (_event, filename) => {
    if (!filename || !filename.endsWith(".md")) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        await indexAllFiles();
        console.log("[memory] Re-indexed after file change");
      } catch (err) {
        console.error("[memory] Re-index error:", err);
      }
    }, 1500);
  });

  console.log("[memory] Watching data/ for changes");
}

// ---------------------------------------------------------------------------
// Search (BM25 via FTS5)
// ---------------------------------------------------------------------------

/**
 * Sanitize a query string for FTS5 MATCH.
 * FTS5 treats hyphens, colons, etc. as operators — wrap each token in quotes
 * so they're treated as literal terms.
 */
function sanitizeFts5Query(raw: string): string {
  // Split on whitespace, wrap each token in double quotes (escape internal quotes)
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

export function searchMemory(
  query: string,
  maxResults: number = 5
): MemorySearchResult[] {
  countInvocation(P.memorySearchLocal);
  const db = getDb();

  const safeQuery = sanitizeFts5Query(query);

  const rows = db
    .prepare(
      `SELECT path, chunk_text, start_line, end_line, rank
       FROM memory_fts
       WHERE memory_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(safeQuery, maxResults) as Array<{
      path: string;
      chunk_text: string;
      start_line: number;
      end_line: number;
      rank: number;
    }>;

  return rows.map((row) => ({
    path: row.path,
    chunkText: row.chunk_text,
    startLine: row.start_line,
    endLine: row.end_line,
    score: row.rank, // FTS5 rank (lower = better match)
  }));
}

// ---------------------------------------------------------------------------
// Read specific lines
// ---------------------------------------------------------------------------

export function getMemoryLines(
  filePath: string,
  from?: number,
  lines?: number
): string {
  countInvocation(P.memoryGetLines);
  // filePath is relative to data/ — resolve to absolute
  const absPath = resolve(DATA_DIR, filePath);

  // Path traversal protection
  if (!absPath.startsWith(DATA_DIR + "/") && absPath !== DATA_DIR) {
    return "[memory] Invalid path — access denied";
  }

  if (!existsSync(absPath)) {
    return `[memory] File not found: ${filePath}`;
  }

  const content = readFileSync(absPath, "utf-8");
  const allLines = content.split("\n");

  const startIdx = Math.max((from ?? 1) - 1, 0);
  const count = lines ?? 50;
  const selected = allLines.slice(startIdx, startIdx + count);

  return selected.join("\n");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function initMemory(): Promise<void> {
  // Ensure data/memory directory exists
  if (!existsSync(MEMORY_DIR)) {
    await mkdir(MEMORY_DIR, { recursive: true });
  }

  await indexAllFiles();
  startWatcher();
  console.log("[memory] Initialised");
}

export function stopMemoryWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
    console.log("[memory] Watcher stopped");
  }
}
