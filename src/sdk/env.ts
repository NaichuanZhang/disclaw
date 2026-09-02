// ---------------------------------------------------------------------------
// SDK sessions — child process environment
//
// The Claude Agent SDK forks its own CLI as a child process, and that child
// inherits our entire environment. This is a deliberate operator choice: the
// session is unrestricted, so it sees every secret this process holds
// (Discord token, GitHub token, provider API keys) and anything it runs
// through Bash sees them too.
//
// There used to be an allowlist here that stripped secrets. It was removed on
// request, along with the (already unenforced) tool-call policy that lived
// beside it.
// To restore the boundary, filter `source` through an explicit allowlist again
// instead of spreading it.
// ---------------------------------------------------------------------------

/**
 * Read `SDK_<name>`, falling back to the pre-rename `PILOT_<name>`. Returns
 * undefined when neither is set to a non-empty string.
 */
export function pickSdkEnv(
  source: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  for (const key of [`SDK_${name}`, `PILOT_${name}`]) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

const pick = pickSdkEnv;

export interface BuildSdkEnvOptions {
  /** Source environment. Defaults to process.env. */
  source?: NodeJS.ProcessEnv;
  /** Extra values to set explicitly, applied last so they win. */
  overrides?: Record<string, string | undefined>;
}

/**
 * Build the environment for an SDK child process.
 *
 * The full source environment is forwarded, then the marker is set, then the
 * SDK_* model overrides are applied, then explicit `overrides` win. No
 * variable is withheld — including DISCORD_BOT_TOKEN, GH_TOKEN and every
 * provider key.
 */
export function buildSdkEnv(
  options: BuildSdkEnvOptions = {},
): Record<string, string | undefined> {
  const source = options.source ?? process.env;

  // Full inheritance — nothing is filtered out.
  const env: Record<string, string | undefined> = { ...source };

  // Marker so a session child is identifiable from inside the workspace.
  env.DISCORDCLAW_SDK = "1";

  // Session-only overrides, so an operator can point sessions at a separate
  // key/endpoint (or a cheaper model) than the rest of the bot uses. The
  // pre-rename PILOT_* names are still read, so an existing .env keeps working.
  const sessionKey = pick(source, "ANTHROPIC_API_KEY");
  if (sessionKey) {
    env.ANTHROPIC_API_KEY = sessionKey;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  const baseUrl = pick(source, "ANTHROPIC_BASE_URL");
  if (baseUrl) {
    env.ANTHROPIC_BASE_URL = baseUrl;
  }

  const sessionModel = pick(source, "ANTHROPIC_MODEL");
  if (sessionModel) {
    env.ANTHROPIC_MODEL = sessionModel;
  }

  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    env[key] = value;
  }

  return env;
}
