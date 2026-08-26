// ---------------------------------------------------------------------------
// Skill tool definitions for the Anthropic Messages API
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR } from "../shared/paths.js";
import { getSkillService } from "./service.js";

/**
 * A disabled skill is absent from the prompt listing, so a model only reaches
 * for one by name — but the tools read straight off disk and used to serve it
 * anyway, in both runtimes. Treat disabled as not installed.
 */
function disabledSkillError(skillName: string): string | null {
  const skill = getSkillService()?.getByName(skillName);
  if (skill && skill.enabled === false) {
    return JSON.stringify({
      error: `Skill "${skillName}" is disabled`,
    });
  }
  return null;
}

export const skillTools = [
  {
    name: "read_skill",
    description:
      "Read the full content of an installed skill's SKILL.md or any companion file within the skill directory. Use this when a task matches a skill's description from the available skills list.",
    input_schema: {
      type: "object" as const,
      properties: {
        skill_name: {
          type: "string",
          description: "Name of the skill (from <available_skills>)",
        },
        file: {
          type: "string",
          description:
            "Relative path within the skill directory (default: SKILL.md)",
        },
      },
      required: ["skill_name"],
    },
  },
  {
    name: "list_skill_files",
    description:
      "List all files in an installed skill's directory to discover companion scripts, references, and resources.",
    input_schema: {
      type: "object" as const,
      properties: {
        skill_name: {
          type: "string",
          description: "Name of the skill",
        },
      },
      required: ["skill_name"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export function handleSkillTool(
  name: string,
  input: Record<string, unknown>,
): string {
  try {
    switch (name) {
      case "read_skill": {
        const skillName = input.skill_name as string;
        const file = (input.file as string) || "SKILL.md";

        // Validate skill directory exists
        const skillDir = path.join(SKILLS_DIR, skillName);
        if (!fs.existsSync(skillDir)) {
          return JSON.stringify({ error: `Skill "${skillName}" not found` });
        }
        const disabled = disabledSkillError(skillName);
        if (disabled) return disabled;

        // Path traversal protection
        const resolved = path.resolve(skillDir, file);
        if (!resolved.startsWith(skillDir + path.sep) && resolved !== skillDir) {
          return JSON.stringify({ error: "Invalid file path" });
        }

        if (!fs.existsSync(resolved)) {
          return JSON.stringify({
            error: `File not found: ${file} in skill "${skillName}"`,
          });
        }

        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          return JSON.stringify({ error: `"${file}" is a directory, not a file` });
        }

        // Size limit: 256KB
        if (stat.size > 256 * 1024) {
          return JSON.stringify({
            error: `File too large: ${stat.size} bytes (max 256KB)`,
          });
        }

        const content = fs.readFileSync(resolved, "utf-8");
        return JSON.stringify({
          skill: skillName,
          file,
          path: resolved,
          content,
        });
      }

      case "list_skill_files": {
        const skillName = input.skill_name as string;
        const skillDir = path.join(SKILLS_DIR, skillName);

        if (!fs.existsSync(skillDir)) {
          return JSON.stringify({ error: `Skill "${skillName}" not found` });
        }
        const disabledList = disabledSkillError(skillName);
        if (disabledList) return disabledList;

        const files = listFilesRecursive(skillDir, skillDir);
        return JSON.stringify({ skill: skillName, files });
      }

      default:
        return JSON.stringify({ error: `Unknown skill tool: ${name}` });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[skills] Tool "${name}" failed:`, msg);
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively list all files in a directory, returning relative paths.
 */
function listFilesRecursive(dir: string, baseDir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      // Skip hidden directories
      if (entry.name.startsWith(".")) continue;
      results.push(...listFilesRecursive(fullPath, baseDir));
    } else {
      results.push(relativePath);
    }
  }

  return results;
}
