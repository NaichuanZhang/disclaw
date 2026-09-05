// ---------------------------------------------------------------------------
// Claude Agent SDK sessions — public surface
//
// This is the bot's agent runtime. Every Discord channel, thread and DM is
// served by a long-lived Claude Agent SDK child process, as is every cron
// `agentTurn` job (see cron-route.ts for where a cron session is keyed).
//
// Sessions are unrestricted: tool calls are unguarded
// (permissionMode: 'bypassPermissions') and the child inherits the full
// process environment, secrets included.
//
// See src/sdk/session.ts for the session lifecycle, bridge.ts for the
// in-process MCP tools and env.ts for the child-process environment.
// ---------------------------------------------------------------------------

export {
  SDK_DIR,
  SDK_WORKSPACE_DIR,
  SdkSession,
  activeSdkChannelIds,
  activeSdkSessionCount,
  activeSdkSessions,
  type SdkLiveSession,
  ensureSdkDirs,
  hasLiveSdkSession,
  initSdk,
  interruptSdkSession,
  resetSdkSession,
  stopAllSdkSessions,
  stopSdkSession,
  submitToSdkSession,
  sdkSessionChannelIdsUnder,
  interruptSdkSessionsUnder,
  stopSdkSessionsUnder,
  resetSdkSessionScope,
  sweepOrphanSdkProcesses,
  type SdkChannelTarget,
  type SdkIncomingMessage,
  type SdkInterruptResult,
} from "./session.js";

export { buildSdkEnv, pickSdkEnv } from "./env.js";

export { createBridgeMcpServer, BRIDGE_MCP_SERVER_NAME } from "./bridge.js";
export {
  planSdkCronRoute,
  type CronSdkRoute,
  type CronSdkRouteInput,
} from "./cron-route.js";

export {
  CLAUDE_PROJECTS_DIR,
  SDK_SESSIONS_DIR,
  claudeProjectDir,
  claudeProjectKey,
  ensureSdkSessionDir,
  isInsideDir,
  migrateTranscript,
  sdkSessionDir,
  sdkSessionInboxDir,
  type MigrateTranscriptOptions,
  type TranscriptMigrationResult,
  type TranscriptMigrationStatus,
} from "./session-dirs.js";
