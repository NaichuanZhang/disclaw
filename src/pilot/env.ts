// ---------------------------------------------------------------------------
// Pilot mode — child process environment
//
// The Claude Agent SDK forks its own CLI as a child process, and that child
// inherits our entire environment. This is a deliberate operator choice: the
// pilot session is unrestricted, so it sees every secret this process holds
// (Discord token, GitHub token, provider API keys) and anything it runs
// through Bash sees them too.
//
// There used to be an allowlist here that stripped secrets. It was removed on
// request along with the (already unenforced) tool-call policy in policy.ts.
// To restore the boundary, filter `source` through an explicit allowlist again
// instead of spreading it.
// ---------------------------------------------------------------------------

export interface BuildPilotEnvOptions {
  /** Source environment. Defaults to process.env. */
  source?: NodeJS.ProcessEnv;
  /** Extra values to set explicitly, applied last so they win. */
  overrides?: Record<string, string | undefined>;
}

/**
 * Build the environment for a pilot child process.
 *
 * The full source environment is forwarded, then the pilot marker is set, then
 * the PILOT_* model overrides are applied, then explicit `overrides` win. No
 * variable is withheld — including DISCORD_BOT_TOKEN, GH_TOKEN and every
 * provider key.
 */
export function buildPilotEnv(
  options: BuildPilotEnvOptions = {},
): Record<string, string | undefined> {
  const source = options.source ?? process.env;

  // Full inheritance — nothing is filtered out.
  const env: Record<string, string | undefined> = { ...source };

  // Marker so a pilot child is identifiable from inside the workspace.
  env.DISCORDCLAW_PILOT = "1";

  // Pilot-only overrides, so an operator can point pilot at a separate
  // key/endpoint (or a cheaper model) than the rest of the bot uses.
  const pilotKey = source.PILOT_ANTHROPIC_API_KEY;
  if (typeof pilotKey === "string" && pilotKey.length > 0) {
    env.ANTHROPIC_API_KEY = pilotKey;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  const baseUrl = source.PILOT_ANTHROPIC_BASE_URL;
  if (typeof baseUrl === "string" && baseUrl.length > 0) {
    env.ANTHROPIC_BASE_URL = baseUrl;
  }

  const pilotModel = source.PILOT_ANTHROPIC_MODEL;
  if (typeof pilotModel === "string" && pilotModel.length > 0) {
    env.ANTHROPIC_MODEL = pilotModel;
  }

  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    env[key] = value;
  }

  return env;
}
