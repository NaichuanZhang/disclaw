import { describe, it, expect } from "vitest";
import {
  EMBED_DESCRIPTION_LIMIT,
  MAX_EMBEDS_PER_REPLY,
  SKILL_DESCRIPTION_MAX,
  buildSkillListEmbedDescriptions,
  formatSkillListLine,
  truncateSkillDescription,
  type SkillListEntry,
} from "../../src/bot/skills-list.js";

function makeSkills(count: number, descLength: number): SkillListEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `skill-${i}`,
    description: "x".repeat(descLength),
    enabled: i % 2 === 0,
    source: { type: i % 3 === 0 ? "github" : i % 3 === 1 ? "upload" : "local" },
  }));
}

describe("truncateSkillDescription", () => {
  it("leaves short descriptions untouched", () => {
    expect(truncateSkillDescription("short and sweet")).toBe("short and sweet");
  });

  it("collapses whitespace and newlines", () => {
    expect(truncateSkillDescription("a\n  b\tc")).toBe("a b c");
  });

  it("truncates long descriptions with an ellipsis", () => {
    const out = truncateSkillDescription("y".repeat(500));
    expect(out.length).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("formatSkillListLine", () => {
  it("includes name, status and source", () => {
    const line = formatSkillListLine({
      name: "mem9",
      description: "cloud memory",
      enabled: true,
      source: { type: "github" },
    });
    expect(line).toBe("**mem9** — cloud memory [On] (GitHub)");
  });

  it("handles a missing description and disabled state", () => {
    const line = formatSkillListLine({
      name: "qr-code",
      enabled: false,
      source: { type: "local" },
    });
    expect(line).toBe("**qr-code** — _no description_ [Off] (Local)");
  });
});

describe("buildSkillListEmbedDescriptions", () => {
  it("returns nothing for an empty list", () => {
    expect(buildSkillListEmbedDescriptions([])).toEqual([]);
  });

  it("fits the real-world case (20 verbose skills) in a single embed", () => {
    const descriptions = buildSkillListEmbedDescriptions(makeSkills(20, 900));
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]!.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
  });

  it("keeps every embed description under Discord's limit for 30 verbose skills", () => {
    const descriptions = buildSkillListEmbedDescriptions(makeSkills(30, 900));
    expect(descriptions.length).toBeGreaterThan(0);
    for (const description of descriptions) {
      expect(description.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
    }
  });

  it("stays under the limit and embed count for a pathological list", () => {
    const descriptions = buildSkillListEmbedDescriptions(makeSkills(5000, 900));
    expect(descriptions.length).toBeLessThanOrEqual(MAX_EMBEDS_PER_REPLY);
    for (const description of descriptions) {
      expect(description.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
    }
    expect(descriptions[descriptions.length - 1]).toContain("more skill(s) not shown");
  });

  it("splits into multiple embeds when the budget is exceeded", () => {
    const descriptions = buildSkillListEmbedDescriptions(makeSkills(60, 900), 500);
    expect(descriptions.length).toBeGreaterThan(1);
    for (const description of descriptions) {
      expect(description.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_LIMIT);
    }
  });

  it("lists every skill when they all fit", () => {
    const skills = makeSkills(12, 40);
    const descriptions = buildSkillListEmbedDescriptions(skills);
    const joined = descriptions.join("\n");
    for (const skill of skills) {
      expect(joined).toContain(`**${skill.name}**`);
    }
  });
});
