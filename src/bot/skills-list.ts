/**
 * Helpers for rendering the `/skills list` reply.
 *
 * Discord caps an embed description at 4096 characters. With enough installed
 * skills (or a few verbose descriptions) the naive "join every full description"
 * approach blows past that cap and the API rejects the whole reply with
 * `Invalid Form Body — embeds[0].description: BASE_TYPE_MAX_LENGTH`.
 *
 * These helpers keep each line short and chunk the result across multiple
 * embeds so the reply is always accepted.
 */

/** Discord's hard limit for a single embed description. */
export const EMBED_DESCRIPTION_LIMIT = 4096;

/** Safety margin so we never bump into the hard limit. */
export const EMBED_DESCRIPTION_BUDGET = 4000;

/** Discord accepts at most 10 embeds per message. */
export const MAX_EMBEDS_PER_REPLY = 10;

/** Per-skill description truncation length in the list view. */
export const SKILL_DESCRIPTION_MAX = 120;

/** Minimal shape needed to render a skill list line. */
export interface SkillListEntry {
  name: string;
  description?: string;
  enabled: boolean;
  source: { type: string };
}

/** Collapse whitespace and truncate a skill description for the list view. */
export function truncateSkillDescription(
  description: string,
  max: number = SKILL_DESCRIPTION_MAX,
): string {
  const flat = description.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function sourceLabel(type: string): string {
  switch (type) {
    case "github":
      return "GitHub";
    case "upload":
      return "Upload";
    default:
      return "Local";
  }
}

/** Render one line of the skill list. */
export function formatSkillListLine(skill: SkillListEntry): string {
  const status = skill.enabled ? "On" : "Off";
  const src = sourceLabel(skill.source.type);
  const desc = skill.description
    ? truncateSkillDescription(skill.description)
    : "_no description_";
  return `**${skill.name}** — ${desc} [${status}] (${src})`;
}

function omissionNotice(count: number): string {
  return `…and ${count} more skill(s) not shown.`;
}

/**
 * Build one or more embed descriptions for the installed skill list.
 *
 * Every returned string is guaranteed to be under {@link EMBED_DESCRIPTION_LIMIT},
 * and at most `maxEmbeds` strings are returned (the last one gets an
 * "…and N more" notice when skills had to be dropped).
 */
export function buildSkillListEmbedDescriptions(
  skills: SkillListEntry[],
  budget: number = EMBED_DESCRIPTION_BUDGET,
  maxEmbeds: number = MAX_EMBEDS_PER_REPLY,
): string[] {
  if (skills.length === 0) return [];

  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const skill of skills) {
    const line = formatSkillListLine(skill);
    // A single line should never exceed the budget on its own.
    const safe =
      line.length > budget ? `${line.slice(0, Math.max(0, budget - 1))}…` : line;
    const cost = current.length === 0 ? safe.length : safe.length + 1;

    if (current.length > 0 && currentLen + cost > budget) {
      chunks.push(current);
      current = [safe];
      currentLen = safe.length;
    } else {
      current.push(safe);
      currentLen += cost;
    }
  }
  if (current.length > 0) chunks.push(current);

  if (chunks.length <= maxEmbeds) {
    return chunks.map((lines) => lines.join("\n"));
  }

  const kept = chunks.slice(0, maxEmbeds);
  let omitted = chunks
    .slice(maxEmbeds)
    .reduce((total, lines) => total + lines.length, 0);
  const last = kept[kept.length - 1]!;

  // Make room for the notice by dropping trailing lines if needed.
  while (
    last.length > 1 &&
    last.join("\n").length + 1 + omissionNotice(omitted).length > budget
  ) {
    last.pop();
    omitted += 1;
  }
  last.push(omissionNotice(omitted));

  return kept.map((lines) => lines.join("\n"));
}
