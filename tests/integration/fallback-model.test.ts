import { describe, it, expect } from "vitest";
import { resolveFallbackModel } from "../../src/shared/models.js";

const IDS = [
  "anthropic.claude-opus-5-5",
  "anthropic.claude-sonnet-5-5",
  "anthropic.claude-haiku-5-5",
];

describe("resolveFallbackModel", () => {
  it("steps down one family", () => {
    expect(resolveFallbackModel("anthropic.claude-opus-5-5", undefined, IDS)).toBe(
      "anthropic.claude-sonnet-5-5",
    );
    expect(resolveFallbackModel("anthropic.claude-sonnet-5-5", undefined, IDS)).toBe(
      "anthropic.claude-haiku-5-5",
    );
  });

  it("sends fable/mythos down to opus", () => {
    expect(resolveFallbackModel("bedrock-claude-fable-5", undefined, IDS)).toBe(
      "anthropic.claude-opus-5-5",
    );
  });

  it("never returns the primary and has no fallback for the only haiku", () => {
    expect(resolveFallbackModel("anthropic.claude-haiku-5-5", undefined, IDS)).toBeUndefined();
  });

  it("falls back to another haiku version when one exists", () => {
    expect(
      resolveFallbackModel("anthropic.claude-haiku-5-5", undefined, [...IDS, "claude-haiku-4-5"]),
    ).toBe("claude-haiku-4-5");
  });

  it("skips families missing from the catalog", () => {
    expect(
      resolveFallbackModel("anthropic.claude-opus-5-5", undefined, [
        "anthropic.claude-opus-5-5",
        "anthropic.claude-haiku-5-5",
      ]),
    ).toBe("anthropic.claude-haiku-5-5");
  });

  it("honours the explicit override, off switch and self-match", () => {
    expect(resolveFallbackModel("a", "my-model", IDS)).toBe("my-model");
    expect(resolveFallbackModel("a", "off", IDS)).toBeUndefined();
    expect(resolveFallbackModel("a", "a", IDS)).toBeUndefined();
  });

  it("uses the built-in list on a cold cache and never throws", () => {
    expect(resolveFallbackModel("anthropic.claude-opus-5-5")).toBe("anthropic.claude-sonnet-5-5");
  });
});
