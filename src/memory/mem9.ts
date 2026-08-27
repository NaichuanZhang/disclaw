import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../shared/paths.js";
import { count } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface Mem9Config {
  api_key: string;
  base_url: string;
  agent_id: string;
}

const AUTH_PATH = join(DATA_DIR, "skills", "mem9", "auth.json");
const REQUEST_TIMEOUT_MS = 5000; // 5s — don't block local memory if mem9 is slow

let config: Mem9Config | null = null;
let configLoaded = false;

function getConfig(): Mem9Config | null {
  if (configLoaded) return config;
  configLoaded = true;

  try {
    if (!existsSync(AUTH_PATH)) {
      console.log("[mem9] No auth.json found — mem9 disabled");
      return null;
    }
    const raw = readFileSync(AUTH_PATH, "utf-8");
    const json = JSON.parse(raw) as {
      api_key: string;
      base_url?: string;
      agent_id?: string;
    };

    config = {
      api_key: json.api_key,
      base_url: json.base_url ?? "https://api.mem9.ai",
      agent_id: json.agent_id ?? "discordclaw",
    };

    console.log("[mem9] Loaded config — cloud memory enabled");
    return config;
  } catch (err) {
    console.error("[mem9] Failed to load auth.json:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types (matches actual mem9 API response shape)
// ---------------------------------------------------------------------------

export interface Mem9Memory {
  id: string;
  content: string;
  memory_type?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  agent_id?: string;
  state?: string;
  version?: number;
  created_at?: string;
  updated_at?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAbortable(): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return { controller, clear: () => clearTimeout(timer) };
}

function baseUrl(cfg: Mem9Config): string {
  return `${cfg.base_url}/v1alpha1/mem9s/${cfg.api_key}`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search mem9 cloud memory. Returns results or empty array on failure.
 * Never throws — gracefully degrades if mem9 is unavailable.
 */
export async function searchMem9(
  query: string,
  maxResults: number = 5,
): Promise<Mem9Memory[]> {
  count(P.memoryMem9Search);
  const cfg = getConfig();
  if (!cfg) return [];

  try {
    const url = `${baseUrl(cfg)}/memories?query=${encodeURIComponent(query)}&page_size=${maxResults}`;
    const { controller, clear } = makeAbortable();

    const response = await fetch(url, {
      method: "GET",
      headers: { "X-API-Key": cfg.api_key, Accept: "application/json" },
      signal: controller.signal,
    });
    clear();

    if (!response.ok) {
      console.error(`[mem9] Search failed: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = (await response.json()) as { memories?: Mem9Memory[] };
    const memories = data.memories ?? [];
    console.log(`[mem9] Search "${query}" → ${memories.length} results`);
    return memories;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[mem9] Search timed out");
    } else {
      console.error("[mem9] Search error:", err);
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Store a memory in mem9 cloud. Returns true on success (202 accepted).
 * mem9 auto-decomposes long content into atomic memories with tags.
 * Never throws.
 */
export async function storeMem9(
  content: string,
  metadata?: Record<string, unknown>,
): Promise<boolean> {
  count(P.memoryMem9Store);
  const cfg = getConfig();
  if (!cfg) return false;

  try {
    const url = `${baseUrl(cfg)}/memories`;
    const { controller, clear } = makeAbortable();

    const body: Record<string, unknown> = { content, agent_id: cfg.agent_id };
    if (metadata) body.metadata = metadata;

    const response = await fetch(url, {
      method: "POST",
      headers: { "X-API-Key": cfg.api_key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clear();

    if (!response.ok) {
      console.error(`[mem9] Store failed: ${response.status} ${response.statusText}`);
      return false;
    }

    console.log(`[mem9] Stored: "${content.slice(0, 80)}${content.length > 80 ? "..." : ""}"`);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[mem9] Store timed out");
    } else {
      console.error("[mem9] Store error:", err);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update a memory in mem9 cloud. Uses PUT (full replace).
 * Never throws.
 */
export async function updateMem9(
  memoryId: string,
  content: string,
): Promise<boolean> {
  count(P.memoryMem9Update);
  const cfg = getConfig();
  if (!cfg) return false;

  try {
    const url = `${baseUrl(cfg)}/memories/${memoryId}`;
    const { controller, clear } = makeAbortable();

    const response = await fetch(url, {
      method: "PUT",
      headers: { "X-API-Key": cfg.api_key, "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    });
    clear();

    if (!response.ok) {
      console.error(`[mem9] Update failed: ${response.status} ${response.statusText}`);
      return false;
    }

    console.log(`[mem9] Updated memory ${memoryId}`);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[mem9] Update timed out");
    } else {
      console.error("[mem9] Update error:", err);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a memory from mem9 cloud. Returns true on success (204).
 * Never throws.
 */
export async function deleteMem9(memoryId: string): Promise<boolean> {
  count(P.memoryMem9Delete);
  const cfg = getConfig();
  if (!cfg) return false;

  try {
    const url = `${baseUrl(cfg)}/memories/${memoryId}`;
    const { controller, clear } = makeAbortable();

    const response = await fetch(url, {
      method: "DELETE",
      headers: { "X-API-Key": cfg.api_key },
      signal: controller.signal,
    });
    clear();

    if (!response.ok && response.status !== 204) {
      console.error(`[mem9] Delete failed: ${response.status} ${response.statusText}`);
      return false;
    }

    console.log(`[mem9] Deleted memory ${memoryId}`);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[mem9] Delete timed out");
    } else {
      console.error("[mem9] Delete error:", err);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Check if mem9 is configured and available.
 */
export function isMem9Enabled(): boolean {
  return getConfig() !== null;
}
