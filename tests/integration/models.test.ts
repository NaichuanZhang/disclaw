/**
 * Integration Test: Model Selection
 *
 * Covers src/shared/models.ts — the catalog fetch/cache, the persisted
 * selection, and the resolution precedence that every Anthropic call uses.
 *
 * No external network dependency: the catalog is served by a loopback stub
 * server (success path) or a closed port (fallback path), so this passes in CI
 * sandboxes that cannot reach the real proxy.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";

import { initDb, getConfig, setConfig, deleteConfig } from "../../src/db/index.js";
import {
  AUTOCOMPLETE_LIMIT,
  DEFAULT_MODEL,
  FALLBACK_MODEL_IDS,
  MODEL_CONFIG_KEY,
  cleanModelName,
  clearSelectedModel,
  describeModelResolution,
  getCachedModelList,
  getCachedSelectableModelIds,
  getSelectedModel,
  invalidateModelCache,
  listModels,
  parseModelsResponse,
  rankModelIds,
  resolveModel,
  selectableModelIds,
  setSelectedModel,
} from "../../src/shared/models.js";

// ---------------------------------------------------------------------------
// Environment isolation
//
// These tests run against the real DB and the real process env, so both the
// selected_model row and the two env vars are snapshotted and restored.
// ---------------------------------------------------------------------------

const envSnapshot = {
  baseUrl: process.env.ANTHROPIC_BASE_URL,
  model: process.env.ANTHROPIC_MODEL,
  token: process.env.ANTHROPIC_AUTH_TOKEN,
};
let savedSelection: string | undefined;

/** A port nothing listens on, so the fetch fails fast instead of timing out. */
const UNREACHABLE_BASE_URL = "http://127.0.0.1:1";

beforeAll(() => {
  initDb();
  savedSelection = getConfig(MODEL_CONFIG_KEY);
});

afterAll(() => {
  if (savedSelection === undefined) {
    deleteConfig(MODEL_CONFIG_KEY);
  } else {
    setConfig(MODEL_CONFIG_KEY, savedSelection);
  }

  if (envSnapshot.baseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = envSnapshot.baseUrl;

  if (envSnapshot.model === undefined) delete process.env.ANTHROPIC_MODEL;
  else process.env.ANTHROPIC_MODEL = envSnapshot.model;

  if (envSnapshot.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = envSnapshot.token;

  invalidateModelCache();
});

// ---------------------------------------------------------------------------
// 1. Response parsing — pure
// ---------------------------------------------------------------------------
describe("parseModelsResponse", () => {
  it("parses the real LiteLLM /v1/models shape", () => {
    const models = parseModelsResponse({
      object: "list",
      data: [
        {
          id: "bedrock-claude-opus-5-1m",
          object: "model",
          created: 1677610602,
          owned_by: "openai",
          mode: "chat",
          max_input_tokens: 200000,
          max_output_tokens: 64000,
        },
      ],
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: "bedrock-claude-opus-5-1m",
      mode: "chat",
      maxInputTokens: 200000,
      maxOutputTokens: 64000,
    });
  });

  it("tolerates entries with no mode or token limits", () => {
    const models = parseModelsResponse({ data: [{ id: "bedrock-llama4-maverick" }] });
    expect(models).toEqual([
      { id: "bedrock-llama4-maverick", mode: undefined, maxInputTokens: undefined, maxOutputTokens: undefined },
    ]);
  });

  it("drops malformed entries instead of throwing", () => {
    const models = parseModelsResponse({
      data: [null, 42, "nope", {}, { id: "" }, { id: 7 }, { id: "keeper", mode: "chat" }],
    });
    expect(models.map((m) => m.id)).toEqual(["keeper"]);
  });

  it("returns an empty list for junk input", () => {
    for (const junk of [null, undefined, {}, [], { data: "not-an-array" }, 5]) {
      expect(parseModelsResponse(junk)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Filtering and ranking — pure
// ---------------------------------------------------------------------------
describe("selectableModelIds", () => {
  it("puts chat models first and excludes non-chat modes", () => {
    const ids = selectableModelIds({
      source: "proxy",
      models: [
        { id: "cohere-embed-multilingual-v3", mode: "embedding" },
        { id: "bedrock-nova-premier" }, // mode omitted — usable, but ranked after chat
        { id: "bedrock-claude-sonnet-5", mode: "chat" },
        { id: "stability-sd3-5-large", mode: "image_generation" },
      ],
    });

    expect(ids).toEqual(["bedrock-claude-sonnet-5", "bedrock-nova-premier"]);
  });

  it("excludes non-chat models the proxy reports without a mode", () => {
    const ids = selectableModelIds({
      source: "proxy",
      models: [
        { id: "cohere-embed-english-v3" },
        { id: "stability-sd3-5-large" },
        { id: "bedrock-claude-fable-5", mode: "chat" },
      ],
    });

    expect(ids).toEqual(["bedrock-claude-fable-5"]);
  });
});

describe("rankModelIds", () => {
  const many = Array.from({ length: 40 }, (_, i) => `model-${i}`);

  it("never returns more than Discord's autocomplete limit", () => {
    expect(AUTOCOMPLETE_LIMIT).toBe(25);
    expect(rankModelIds(many, "")).toHaveLength(AUTOCOMPLETE_LIMIT);
    expect(rankModelIds(many, "model")).toHaveLength(AUTOCOMPLETE_LIMIT);
  });

  it("filters case-insensitively by substring", () => {
    const ids = ["bedrock-claude-opus-5-1m", "bedrock-claude-sonnet-5", "bedrock-nova-premier"];
    expect(rankModelIds(ids, "OPUS")).toEqual(["bedrock-claude-opus-5-1m"]);
    expect(rankModelIds(ids, "claude")).toEqual([
      "bedrock-claude-opus-5-1m",
      "bedrock-claude-sonnet-5",
    ]);
    expect(rankModelIds(ids, "  sonnet  ")).toEqual(["bedrock-claude-sonnet-5"]);
    expect(rankModelIds(ids, "zzz")).toEqual([]);
  });

  it("returns everything (up to the limit) for an empty query", () => {
    expect(rankModelIds(["a", "b"], "")).toEqual(["a", "b"]);
  });
});

describe("cleanModelName", () => {
  it("strips ANSI artifacts and whitespace", () => {
    expect(cleanModelName("  bedrock-claude-opus-5-1m  ")).toBe("bedrock-claude-opus-5-1m");
    expect(cleanModelName("bedrock-claude-opus-5-1m\x1b[0m")).toBe("bedrock-claude-opus-5-1m");
    expect(cleanModelName("bedrock-claude-opus-5-1m[0m")).toBe("bedrock-claude-opus-5-1m");
  });
});

// ---------------------------------------------------------------------------
// 3. Catalog fetch — falls back rather than throwing
// ---------------------------------------------------------------------------
describe("listModels with an unreachable proxy", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_BASE_URL = UNREACHABLE_BASE_URL;
    invalidateModelCache();
  });

  it("returns the built-in fallback list and never throws", async () => {
    const list = await listModels({ force: true });

    expect(list.source).toBe("fallback");
    expect(list.models.map((m) => m.id)).toEqual([...FALLBACK_MODEL_IDS]);
    expect(list.models.every((m) => m.mode === "chat")).toBe(true);
  });

  it("includes the default model in the fallback list", async () => {
    const ids = selectableModelIds(await listModels({ force: true }));
    expect(ids).toContain(DEFAULT_MODEL);
  });

  it("does not cache the fallback, so a recovered proxy is not hidden", async () => {
    await listModels({ force: true });
    expect(getCachedModelList()).toBeUndefined();
    expect(getCachedSelectableModelIds()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Persisted selection
// ---------------------------------------------------------------------------
describe("selection persistence", () => {
  beforeEach(() => {
    clearSelectedModel();
    invalidateModelCache();
  });

  it("round-trips through the config table", () => {
    expect(getSelectedModel()).toBeUndefined();

    setSelectedModel("bedrock-claude-sonnet-5");
    expect(getSelectedModel()).toBe("bedrock-claude-sonnet-5");
    // Same value a fresh process would read at boot.
    expect(getConfig(MODEL_CONFIG_KEY)).toBe("bedrock-claude-sonnet-5");
  });

  it("normalizes the stored value", () => {
    setSelectedModel("  bedrock-claude-fable-5  ");
    expect(getSelectedModel()).toBe("bedrock-claude-fable-5");
  });

  it("holds until the next selection", () => {
    setSelectedModel("bedrock-claude-sonnet-5");
    setSelectedModel("bedrock-claude-haiku-4-5");
    expect(getSelectedModel()).toBe("bedrock-claude-haiku-4-5");
  });

  it("clearSelectedModel removes the row entirely", () => {
    setSelectedModel("bedrock-claude-sonnet-5");
    clearSelectedModel();
    expect(getSelectedModel()).toBeUndefined();
    expect(getConfig(MODEL_CONFIG_KEY)).toBeUndefined();
  });

  it("treats a blank stored value as unset", () => {
    setConfig(MODEL_CONFIG_KEY, "   ");
    expect(getSelectedModel()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Resolution precedence
// ---------------------------------------------------------------------------
describe("resolveModel precedence", () => {
  beforeEach(() => {
    clearSelectedModel();
    delete process.env.ANTHROPIC_MODEL;
    // A cold cache disables self-healing, so synthetic ids survive resolution.
    invalidateModelCache();
  });

  it("falls back to DEFAULT_MODEL when nothing is configured", () => {
    expect(resolveModel()).toBe(DEFAULT_MODEL);
    expect(describeModelResolution().source).toBe("default");
  });

  it("uses ANTHROPIC_MODEL when there is no saved selection", () => {
    process.env.ANTHROPIC_MODEL = "env-model";
    expect(resolveModel()).toBe("env-model");
    expect(describeModelResolution().source).toBe("env");
  });

  it("lets the saved selection beat ANTHROPIC_MODEL", () => {
    process.env.ANTHROPIC_MODEL = "env-model";
    setSelectedModel("saved-model");

    const resolution = describeModelResolution();
    expect(resolution.model).toBe("saved-model");
    expect(resolution.source).toBe("config");
    expect(resolution.saved).toBe("saved-model");
    expect(resolution.env).toBe("env-model");
  });

  it("lets an explicit override beat everything", () => {
    process.env.ANTHROPIC_MODEL = "env-model";
    setSelectedModel("saved-model");

    expect(resolveModel("override-model")).toBe("override-model");
    expect(describeModelResolution("override-model").source).toBe("override");
  });

  it("ignores blank and whitespace-only overrides", () => {
    setSelectedModel("saved-model");
    expect(resolveModel("")).toBe("saved-model");
    expect(resolveModel("   ")).toBe("saved-model");
    expect(resolveModel(undefined)).toBe("saved-model");
  });

  it("strips ANSI artifacts from env values", () => {
    process.env.ANTHROPIC_MODEL = "env-model\x1b[0m";
    expect(resolveModel()).toBe("env-model");
  });

  it("never throws and always returns a non-empty id", () => {
    for (const override of [undefined, "", "  ", "x"]) {
      expect(() => resolveModel(override)).not.toThrow();
      expect(resolveModel(override).length).toBeGreaterThan(0);
    }
  });
});

describe("self-healing with a cold cache", () => {
  it("leaves an unknown model alone rather than blocking on a fetch", () => {
    process.env.ANTHROPIC_BASE_URL = UNREACHABLE_BASE_URL;
    invalidateModelCache();
    clearSelectedModel();
    delete process.env.ANTHROPIC_MODEL;

    // resolveModel() sits on the message hot path. With no warm catalog it must
    // pass the configured value straight through, not go looking for a better one.
    setSelectedModel("no-such-model");
    expect(resolveModel()).toBe("no-such-model");
    expect(describeModelResolution().healed).toBeUndefined();

    clearSelectedModel();
  });
});

// ---------------------------------------------------------------------------
// 6. The real fetch path, against a local stub proxy
//
// Uses a loopback HTTP server rather than a mock so the actual fetch, header,
// parse, cache, and self-heal code all run. Still network-free.
// ---------------------------------------------------------------------------
describe("listModels against a stub proxy", () => {
  /**
   * Mirrors the live proxy's shape. Padded so more than AUTOCOMPLETE_LIMIT
   * entries survive filtering — that is the case the 25-cap has to handle.
   */
  const CATALOG = {
    object: "list",
    data: [
      { id: "bedrock-claude-opus-5-1m", mode: "chat", max_input_tokens: 200000, max_output_tokens: 64000 },
      { id: "bedrock-claude-sonnet-5", mode: "chat" },
      { id: "cohere-embed-multilingual-v3", mode: "embedding" },
      { id: "stability-sd3-5-large", mode: "image_generation" },
      { id: "bedrock-nova-premier" },
      ...Array.from({ length: 25 }, (_, i) => ({ id: `bedrock-filler-${i}`, mode: "chat" })),
    ],
  };
  const TOTAL = CATALOG.data.length; // 30
  const SELECTABLE = TOTAL - 2; // minus the embedding and image-generation entries

  let server: import("node:http").Server;
  let requests: Array<{ url?: string; auth?: string }> = [];

  beforeAll(async () => {
    const { createServer } = await import("node:http");
    server = createServer((req, res) => {
      requests.push({
        url: req.url,
        auth: req.headers.authorization ?? (req.headers["x-api-key"] as string | undefined),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(CATALOG));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const port = (server.address() as import("node:net").AddressInfo).port;
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    invalidateModelCache();
  });

  beforeEach(() => {
    requests = [];
    invalidateModelCache();
    clearSelectedModel();
    delete process.env.ANTHROPIC_MODEL;
  });

  it("fetches /v1/models and authenticates", async () => {
    const list = await listModels({ force: true });

    expect(list.source).toBe("proxy");
    expect(list.models).toHaveLength(TOTAL);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/v1/models");
    expect(requests[0].auth).toBe("Bearer test-token");
  });

  it("serves subsequent reads from the cache", async () => {
    await listModels({ force: true });
    const cached = await listModels();

    expect(cached.source).toBe("cache");
    expect(requests).toHaveLength(1); // no second round trip
    expect(getCachedModelList()?.models).toHaveLength(TOTAL);
  });

  it("collapses concurrent callers into one request", async () => {
    const results = await Promise.all([listModels(), listModels(), listModels()]);

    expect(requests).toHaveLength(1);
    expect(results.every((r) => r.models.length === TOTAL)).toBe(true);
  });

  it("filters the catalog down to chat-capable ids", async () => {
    const ids = await listModels({ force: true }).then(selectableModelIds);

    expect(ids).not.toContain("cohere-embed-multilingual-v3");
    expect(ids).not.toContain("stability-sd3-5-large");
    expect(ids[0]).toBe("bedrock-claude-opus-5-1m");
    expect(ids.at(-1)).toBe("bedrock-nova-premier"); // mode omitted → ranked last
  });

  it("caps autocomplete choices at 25 even though the catalog has more", async () => {
    const ids = await listModels({ force: true }).then(selectableModelIds);

    expect(ids).toHaveLength(SELECTABLE);
    expect(SELECTABLE).toBeGreaterThan(AUTOCOMPLETE_LIMIT);
    expect(rankModelIds(ids, "")).toHaveLength(AUTOCOMPLETE_LIMIT);
  });

  it("exposes the warm catalog to the synchronous autocomplete path", async () => {
    await listModels({ force: true });
    expect(getCachedSelectableModelIds()).toEqual(
      selectableModelIds(getCachedModelList()!),
    );
  });

  it("self-heals a selection the proxy no longer advertises", async () => {
    await listModels({ force: true }); // warm the cache
    setSelectedModel("bedrock-claude-retired-9");

    const resolution = describeModelResolution();
    expect(resolution.saved).toBe("bedrock-claude-retired-9");
    expect(resolution.healed).toBe(true);
    expect(resolution.model).toBe(DEFAULT_MODEL);
    expect(resolveModel()).toBe(DEFAULT_MODEL);
  });

  it("leaves an advertised selection untouched", async () => {
    await listModels({ force: true });
    setSelectedModel("bedrock-claude-sonnet-5");

    const resolution = describeModelResolution();
    expect(resolution.model).toBe("bedrock-claude-sonnet-5");
    expect(resolution.healed).toBeUndefined();
  });

  it("self-heals a per-job override too", async () => {
    await listModels({ force: true });

    expect(resolveModel("bedrock-claude-retired-9")).toBe(DEFAULT_MODEL);
    expect(resolveModel("bedrock-claude-sonnet-5")).toBe("bedrock-claude-sonnet-5");
  });
});

// ---------------------------------------------------------------------------
// 7. Discord command surface
// ---------------------------------------------------------------------------
describe("command declarations", () => {
  it("declares /model with autocomplete on name", async () => {
    const { slashCommands } = await import("../../src/bot/commands.js");
    const model = slashCommands.find((c) => c.name === "model");

    expect(model).toBeDefined();
    const options = (model!.options ?? []) as Array<Record<string, unknown>>;
    const name = options.find((o) => o.name === "name");

    expect(name).toBeDefined();
    expect(name!.autocomplete).toBe(true);
    expect(name!.required).toBe(false);
    expect(options.map((o) => o.name)).toEqual(expect.arrayContaining(["name", "reset", "refresh"]));
  });

  it("declares an autocompleting model option on /cron add", async () => {
    const { slashCommands } = await import("../../src/bot/commands.js");
    const cron = slashCommands.find((c) => c.name === "cron");
    const add = ((cron!.options ?? []) as Array<Record<string, unknown>>).find(
      (o) => o.name === "add",
    );

    const model = ((add!.options ?? []) as Array<Record<string, unknown>>).find(
      (o) => o.name === "model",
    );

    expect(model).toBeDefined();
    expect(model!.autocomplete).toBe(true);
    expect(model!.required).toBe(false);
  });

  it("declares /cron set-model taking an autocompleting model", async () => {
    const { slashCommands } = await import("../../src/bot/commands.js");
    const cron = slashCommands.find((c) => c.name === "cron");
    const setModel = ((cron!.options ?? []) as Array<Record<string, unknown>>).find(
      (o) => o.name === "set-model",
    );

    expect(setModel).toBeDefined();
    const options = (setModel!.options ?? []) as Array<Record<string, unknown>>;
    expect(options.map((o) => o.name)).toEqual(["id", "model"]);
    expect(options.every((o) => o.required === true)).toBe(true);
    expect(options.find((o) => o.name === "model")!.autocomplete).toBe(true);
  });
});
