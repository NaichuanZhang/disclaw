// ---------------------------------------------------------------------------
// Pilot mode — child process environment allowlist
//
// The Claude Agent SDK forks its own CLI as a child process. By default a
// child inherits our entire environment, which would hand every secret we
// hold (Discord token, GitHub token, API keys) to anything the pilot session
// can run through Bash. We therefore build the child env from an explicit
// allowlist instead of spreading process.env.
// ---------------------------------------------------------------------------

/**
 * Environment variables the pilot child process is allowed to inherit.
 * Everything else is dropped. Keep this list boring: only things needed to
 * run node/git/shell tooling and locate the user's Claude credentials.
 */
export const PILOT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "NODE_ENV",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "SYSTEMROOT",
  "COMSPEC",
];

/**
 * Names that must never reach the child even if someone adds them to the
 * allowlist or the extra-allow env var. Belt and braces.
 */
const SECRET_NAME_PATTERN =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|API_KEY|_KEY|PRIVATE|WEBHOOK|COOKIE|SESSION|DSN|OAUTH|BEARER)/i;

/** True when an env var name looks like it carries a secret. */
export function isSecretEnvVar(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/**
 * Extra variable names an operator explicitly wants forwarded, e.g.
 * `PILOT_ENV_EXTRA_ALLOW=HTTPS_PROXY,NO_PROXY`. Secret-looking names are
 * still refused.
 */
function extraAllowedNames(): string[] {
  const raw = process.env.PILOT_ENV_EXTRA_ALLOW;
  if (!raw) return [];
  return raw
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0 && !isSecretEnvVar(n));
}

export interface BuildPilotEnvOptions {
  /** Source environment. Defaults to process.env. */
  source?: NodeJS.ProcessEnv;
  /** Extra values to set explicitly (not subject to the allowlist filter). */
  overrides?: Record<string, string | undefined>;
}

/**
 * Model-auth variables. These are the one category of credential the child
 * genuinely needs — without them the SDK session cannot talk to a model at all
 * ("Not logged in"). There is no subscription login on this host
 * (`~/.claude/.credentials.json` holds only MCP OAuth tokens), so pilot uses
 * the same proxy credentials the bot uses.
 *
 * Consequences, stated plainly:
 *   - pilot token spend lands on the same budget as the rest of the bot
 *   - the auth token exists in the child's environment, so the policy in
 *     policy.ts must (and does) refuse environment-dumping shell commands
 *
 * Set PILOT_INHERIT_MODEL_AUTH=false to withhold them; pilot then only works
 * if PILOT_ANTHROPIC_API_KEY / PILOT_ANTHROPIC_BASE_URL are provided.
 */
const MODEL_AUTH_VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
] as const;

/** True unless explicitly disabled. */
function inheritModelAuth(source: NodeJS.ProcessEnv): boolean {
  return source.PILOT_INHERIT_MODEL_AUTH !== "false";
}

/**
 * Build the environment for a pilot child process.
 *
 * Everything is dropped except the allowlist above, the model-auth variables
 * (see MODEL_AUTH_VARS) and any explicit PILOT_* overrides. In particular
 * DISCORD_BOT_TOKEN, GH_TOKEN, EIGENAI_API_KEY, DAYTONA_API_KEY, Strava and
 * Alpaca credentials never reach the child.
 */
export function buildPilotEnv(
  options: BuildPilotEnvOptions = {},
): Record<string, string | undefined> {
  const source = options.source ?? process.env;
  const allowed = new Set<string>([
    ...PILOT_ENV_ALLOWLIST,
    ...extraAllowedNames(),
  ]);

  const env: Record<string, string | undefined> = {};
  for (const name of allowed) {
    if (isSecretEnvVar(name)) continue;
    const value = source[name];
    if (typeof value === "string" && value.length > 0) {
      env[name] = value;
    }
  }

  // Marker so a pilot child is identifiable from inside the sandbox.
  env.DISCORDCLAW_PILOT = "1";

  // Model credentials — required for the session to reach a model at all.
  if (inheritModelAuth(source)) {
    for (const name of MODEL_AUTH_VARS) {
      const value = source[name];
      if (typeof value === "string" && value.length > 0) {
        env[name] = value;
      }
    }
  }

  // Explicit pilot-only overrides win over the inherited values, so an
  // operator can point pilot at a separate key/endpoint (or a cheaper model).
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
