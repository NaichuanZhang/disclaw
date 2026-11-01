import { getConfig, setConfig, deleteConfig } from "../db/index.js";
import { createLogger } from "../logging/logger.js";
import { count } from "../metrics/counters.js";
import { P } from "../metrics/registry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const log = createLogger("models");

/** Built-in default when nothing else is configured. */
export const DEFAULT_MODEL = "anthropic.claude-opus-5-5";

/** Key in the global `config` table holding the persisted selection. */
export const MODEL_CONFIG_KEY = "selected_model";

/** Discord allows at most 25 autocomplete choices per response. */
export const AUTOCOMPLETE_LIMIT = 25;

const REQUEST_TIMEOUT_MS = 5000; // 5s — matches mem9; never awaited on the autocomplete path
const CACHE_TTL_MS = 5 * 60_000; // 5min — model catalogs change rarely
const FAILURE_BACKOFF_MS = 30_000; // don't hammer a proxy that is down

/**
 * Chat models verified against the proxy. Used when the catalog cannot be
 * fetched so model selection never presents an empty list.
 */
export const FALLBACK_MODEL_IDS: readonly string[] = [
  "anthropic.claude-opus-5-5",
  "anthropic.claude-sonnet-5-5",
  "anthropic.claude-haiku-5-5",
];

/** Order tried when a model (or its whole family) is gone from the catalog. */
export const FAMILY_FALLBACK_ORDER: readonly string[] = ["opus", "sonnet", "haiku"];

const KNOWN_FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"] as const;

export interface ParsedModelId {
  family: string;
  /** [major, minor]; minor is 0 when the id carries none. */
  version: [number, number];
}

/**
 * Read the model family and version out of an id, whatever the provider
 * prefix: `anthropic.claude-opus-5-5`, `bedrock-claude-opus-5-1m`,
 * `claude-sonnet-4-20250514`, `claude-3-5-sonnet`. A trailing `-1m` is a
 * context-window suffix, not a minor version, and an 8-digit date is not
 * either. Undefined when no known family appears in the id.
 */
export function parseModelFamily(id: string): ParsedModelId | undefined {
  const s = id.toLowerCase();
  const fam = KNOWN_FAMILIES.join("|");

  const after = new RegExp(`(${fam})-(\\d+)(?:-(\\d{1,2})(?!\\d|m\\b))?`).exec(s);
  if (after) {
    return { family: after[1], version: [Number(after[2]), after[3] ? Number(after[3]) : 0] };
  }
  const before = new RegExp(`claude-(\\d+)(?:-(\\d{1,2}))?-(${fam})`).exec(s);
  if (before) {
    return { family: before[3], version: [Number(before[1]), before[2] ? Number(before[2]) : 0] };
  }
  const bare = new RegExp(`(${fam})`).exec(s);
  return bare ? { family: bare[1], version: [0, 0] } : undefined;
}

/**
 * The newest model of a family among `ids` (highest version; the first listed
 * wins a tie, so the proxy's own ordering decides between 5-5 and 5-5-1m).
 */
export function pickByFamily(family: string, ids: readonly string[]): string | undefined {
  let best: { id: string; version: [number, number] } | undefined;
  for (const id of ids) {
    const parsed = parseModelFamily(id);
    if (!parsed || parsed.family !== family.toLowerCase()) continue;
    const [maj, min] = parsed.version;
    if (!best || maj > best.version[0] || (maj === best.version[0] && min > best.version[1])) {
      best = { id, version: parsed.version };
    }
  }
  return best?.id;
}

/**
 * Closest available model to `wanted`: its own family first, then each family
 * in `order`, then whatever the catalog lists first. Undefined only when `ids`
 * is empty.
 */
export function pickClosestModel(
  wanted: string | undefined,
  ids: readonly string[],
  order: readonly string[] = FAMILY_FALLBACK_ORDER,
): string | undefined {
  const own = wanted ? parseModelFamily(wanted)?.family : undefined;
  const families = own ? [own, ...order.filter((f) => f !== own)] : [...order];
  for (const f of families) {
    const hit = pickByFamily(f, ids);
    if (hit) return hit;
  }
  return ids[0];
}

/** Modes that cannot serve a chat completion. */
const NON_CHAT_MODES = new Set(["embedding", "image_generation", "rerank"]);

/** Id prefixes for non-chat models that the proxy reports without a mode. */
const NON_CHAT_PREFIXES = ["cohere-embed", "stability"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProxyModel {
  id: string;
  /** "chat" | "image_generation" | "embedding" | undefined — LiteLLM omits it for many entries */
  mode?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export type ModelListSource = "proxy" | "cache" | "fallback";

export interface ModelList {
  models: ProxyModel[];
  source: ModelListSource;
  /** Epoch ms of the underlying proxy fetch. Absent for "fallback". */
  fetchedAt?: number;
}

export interface ModelResolution {
  /** What will actually be sent to the API. */
  model: string;
  /** Which precedence tier won. */
  source: "override" | "config" | "env" | "default";
  /** Persisted selection, if any. */
  saved?: string;
  /** Raw ANTHROPIC_MODEL value, if any. */
  env?: string;
  /** True when the winning value was absent from a warm catalog and replaced. */
  healed?: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cache: ModelList | null = null;
let inflight: Promise<ModelList> | null = null;
let lastFailureAt = 0;

/** Ids already warned about, so a bad selection logs once rather than per turn. */
const warnedIds = new Set<string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAbortable(): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return { controller, clear: () => clearTimeout(timer) };
}

/** Strip ANSI escape artifacts from env values (e.g. trailing [1m] from shell). */
export function cleanModelName(s: string): string {
  return s.replace(/\x1b\[[\d;]*m/g, "").replace(/\[[\d;]*m\]?$/g, "").trim();
}

/** Normalize a candidate; empty-after-cleaning counts as unset. */
function candidate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = cleanModelName(raw);
  return cleaned.length > 0 ? cleaned : undefined;
}

function fallbackList(): ModelList {
  return {
    models: FALLBACK_MODEL_IDS.map((id) => ({ id, mode: "chat" })),
    source: "fallback",
  };
}

function isChatCapable(model: ProxyModel): boolean {
  if (model.mode && NON_CHAT_MODES.has(model.mode)) return false;
  return !NON_CHAT_PREFIXES.some((p) => model.id.startsWith(p));
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Parse a LiteLLM / Anthropic `/v1/models` response into ProxyModel entries.
 * Pure and defensive — malformed entries are dropped rather than throwing.
 */
export function parseModelsResponse(json: unknown): ProxyModel[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  const models: ProxyModel[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || raw.id.length === 0) continue;

    models.push({
      id: raw.id,
      mode: typeof raw.mode === "string" ? raw.mode : undefined,
      maxInputTokens:
        typeof raw.max_input_tokens === "number" ? raw.max_input_tokens : undefined,
      maxOutputTokens:
        typeof raw.max_output_tokens === "number" ? raw.max_output_tokens : undefined,
    });
  }
  return models;
}

async function fetchModels(): Promise<ModelList> {
  // Read env at call time so runtime changes and tests take effect.
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!baseUrl) {
    // Direct api.anthropic.com has no LiteLLM-style catalog for this key setup.
    return fallbackList();
  }

  const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  const { controller, clear } = makeAbortable();

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}`, "x-api-key": token } : {}),
      },
      signal: controller.signal,
    });
    clear();

    if (!response.ok) {
      log.warn("Model list fetch failed", {
        status: response.status,
        statusText: response.statusText,
      });
      lastFailureAt = Date.now();
      return fallbackList();
    }

    const models = parseModelsResponse(await response.json());
    if (models.length === 0) {
      log.warn("Model list fetch returned no usable entries");
      lastFailureAt = Date.now();
      return fallbackList();
    }

    lastFailureAt = 0;
    const chatCount = models.filter((m) => m.mode === "chat").length;
    log.info(`Fetched ${models.length} models from proxy (${chatCount} chat)`);
    return { models, source: "proxy", fetchedAt: Date.now() };
  } catch (err: unknown) {
    clear();
    const timedOut = err instanceof Error && err.name === "AbortError";
    log.warn(
      timedOut
        ? `Model list fetch timed out after ${REQUEST_TIMEOUT_MS}ms`
        : `Model list fetch errored: ${String(err)}`,
    );
    lastFailureAt = Date.now();
    return fallbackList();
  }
}

/**
 * Fetch the model catalog, or return the TTL-cached copy.
 *
 * Never throws. Falls back to FALLBACK_MODEL_IDS when the proxy is
 * unreachable. Failures are not cached, but are rate-limited by
 * FAILURE_BACKOFF_MS so a down proxy is not hammered.
 */
export async function listModels(opts?: { force?: boolean }): Promise<ModelList> {
  const now = Date.now();

  if (!opts?.force && cache && now - (cache.fetchedAt ?? 0) < CACHE_TTL_MS) {
    return { ...cache, source: "cache" };
  }

  if (!opts?.force && !cache && now - lastFailureAt < FAILURE_BACKOFF_MS) {
    return fallbackList();
  }

  // Collapse concurrent callers (e.g. autocomplete keystrokes) into one request.
  if (!inflight) {
    count(P.modelsListFetch);
    inflight = fetchModels().finally(() => {
      inflight = null;
    });
  }

  const result = await inflight;
  if (result.source === "proxy") cache = result;
  return result;
}

/** Cached catalog only — undefined when cold. Sync; safe on latency-critical paths. */
export function getCachedModelList(): ModelList | undefined {
  if (!cache) return undefined;
  if (Date.now() - (cache.fetchedAt ?? 0) >= CACHE_TTL_MS) return undefined;
  return { ...cache, source: "cache" };
}

export function invalidateModelCache(): void {
  count(P.modelsCacheInvalidate);
  cache = null;
  lastFailureAt = 0;
}

/**
 * Warm the cache without blocking. Never throws and is never awaited —
 * called at boot so the first autocomplete sees the real catalog.
 */
export function warmModelCache(): void {
  count(P.modelsCacheWarm);
  void listModels().catch(() => {
    /* listModels never throws; this is belt-and-braces */
  });
}

/** Chat-capable ids, chat-mode first, preserving proxy order within each tier. */
export function selectableModelIds(list: ModelList): string[] {
  const usable = list.models.filter(isChatCapable);
  const chat = usable.filter((m) => m.mode === "chat").map((m) => m.id);
  const rest = usable.filter((m) => m.mode !== "chat").map((m) => m.id);
  return [...chat, ...rest];
}

/** Ranked selectable ids, fetching the catalog if needed. Never throws. */
export async function listSelectableModelIds(): Promise<string[]> {
  return selectableModelIds(await listModels());
}

/** Sync cache-only variant for the autocomplete path. undefined = cold cache. */
export function getCachedSelectableModelIds(): string[] | undefined {
  const list = getCachedModelList();
  return list ? selectableModelIds(list) : undefined;
}

/**
 * Filter ids by a case-insensitive substring query.
 *
 * The AUTOCOMPLETE_LIMIT slice happens here rather than at call sites — Discord
 * rejects a response with more than 25 choices outright, and the catalog
 * already exceeds that.
 */
export function rankModelIds(ids: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  const matched = q.length === 0 ? [...ids] : ids.filter((id) => id.toLowerCase().includes(q));
  return matched.slice(0, AUTOCOMPLETE_LIMIT);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Persisted selection, or undefined. Never throws (DB may not be initialized). */
export function getSelectedModel(): string | undefined {
  try {
    return candidate(getConfig(MODEL_CONFIG_KEY));
  } catch {
    return undefined;
  }
}

export function setSelectedModel(id: string): void {
  setConfig(MODEL_CONFIG_KEY, cleanModelName(id));
  warnedIds.clear();
}

export function clearSelectedModel(): void {
  deleteConfig(MODEL_CONFIG_KEY);
  warnedIds.clear();
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the model to use and report which tier won.
 *
 * Precedence: explicit override (per-cron-job, or the model router's pick for
 * a new interactive session — see shared/model-router.ts, which itself yields
 * to a persisted selection) > persisted selection > the ANTHROPIC_MODEL env
 * var > DEFAULT_MODEL.
 *
 * The persisted selection deliberately outranks the env var: a runtime choice
 * that a deploy-time value could override would not be a runtime choice, and a
 * stale env value would silently defeat every selection.
 *
 * Never throws.
 */
export function describeModelResolution(override?: string): ModelResolution {
  const saved = getSelectedModel();
  const env = candidate(process.env.ANTHROPIC_MODEL);
  const cleanOverride = candidate(override);

  let model: string;
  let source: ModelResolution["source"];
  if (cleanOverride) {
    model = cleanOverride;
    source = "override";
  } else if (saved) {
    model = saved;
    source = "config";
  } else if (env) {
    model = env;
    source = "env";
  } else {
    model = DEFAULT_MODEL;
    source = "default";
  }

  const resolution: ModelResolution = { model, source, saved, env };

  // Self-heal a model the proxy no longer advertises. Only acts on a warm
  // catalog — a cold cache must never block a message.
  const cached = getCachedModelIdSet();
  if (cached && !cached.has(model)) {
    const ids = getCachedSelectableModelIds() ?? [];
    const sameFamily = (() => {
      const fam = parseModelFamily(model)?.family;
      return fam ? pickByFamily(fam, ids) : undefined;
    })();
    const replacement =
      sameFamily ?? (cached.has(DEFAULT_MODEL) ? DEFAULT_MODEL : pickClosestModel(undefined, ids));
    if (replacement && replacement !== model) {
      if (!warnedIds.has(model)) {
        warnedIds.add(model);
        log.warn(
          `Model "${model}" (from ${source}) is not advertised by the proxy — using "${replacement}"`,
        );
      }
      resolution.model = replacement;
      resolution.healed = true;
    }
  }

  return resolution;
}

function getCachedModelIdSet(): Set<string> | undefined {
  const list = getCachedModelList();
  return list ? new Set(list.models.map((m) => m.id)) : undefined;
}

/**
 * The model to send to the API. Sync, never throws — sits on the message hot path.
 */
export function resolveModel(override?: string): string {
  try {
    return describeModelResolution(override).model;
  } catch {
    return candidate(override) ?? candidate(process.env.ANTHROPIC_MODEL) ?? DEFAULT_MODEL;
  }
}

/** Strongest to weakest; a fallback only ever steps down this list. */
const DOWNGRADE_ORDER: readonly string[] = ["mythos", "fable", "opus", "sonnet", "haiku"];

/**
 * The model an SDK session should fail over to when `primary` is overloaded or
 * unavailable. Steps down one family at a time (opus -> sonnet -> haiku), picks
 * the newest of that family from the catalog, and never returns `primary`
 * itself. The weakest family has nowhere to step down to, so it falls back to
 * another haiku version if one exists. `explicit` is the operator override:
 * "off"/"none"/"false" disables, anything else wins verbatim (unless it equals
 * `primary`). Without a pin, `envModel` (the ANTHROPIC_MODEL env value, passed
 * in so this stays pure) is the default fallback unless it equals `primary`.
 * Sync, never throws; undefined means "no fallback".
 */
export function resolveFallbackModel(
  primary: string,
  explicit?: string,
  ids?: readonly string[],
  envModel?: string,
): string | undefined {
  try {
    const pinned = candidate(explicit);
    if (pinned) {
      if (/^(off|none|false|0)$/i.test(pinned)) return undefined;
      return pinned === primary ? undefined : pinned;
    }
    const fromEnv = candidate(envModel);
    if (fromEnv && fromEnv !== primary) return fromEnv;
    const catalog = (ids ?? getCachedSelectableModelIds() ?? FALLBACK_MODEL_IDS).filter(
      (id) => id !== primary,
    );
    const own = parseModelFamily(primary)?.family;
    const idx = own ? DOWNGRADE_ORDER.indexOf(own) : -1;
    const lower = idx >= 0 ? DOWNGRADE_ORDER.slice(idx + 1) : FAMILY_FALLBACK_ORDER;
    for (const family of lower) {
      const hit = pickByFamily(family, catalog);
      if (hit) return hit;
    }
    return own ? pickByFamily(own, catalog) : undefined;
  } catch {
    return undefined;
  }
}
