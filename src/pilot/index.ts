// ---------------------------------------------------------------------------
// Pilot mode — public surface
//
// Pilot mode routes a single allowlisted Discord channel to a Claude Agent SDK
// session instead of our own agent loop. It is enabled per channel as data:
//   channel_configs.settings.pilot = true
//
// Cron `agentTurn` jobs are the exception: they run on an SDK session whatever
// the channel flag says (see cron-route.ts).
//
// Pilot sessions are unrestricted: tool calls are unguarded
// (permissionMode: 'bypassPermissions') and the child inherits the full
// process environment, secrets included.
//
// See src/pilot/session.ts for the session lifecycle, bridge.ts for the
// in-process MCP tools and env.ts for the child-process environment.
// ---------------------------------------------------------------------------

export {
  PILOT_DIR,
  PILOT_WORKSPACE_DIR,
  PilotSession,
  activePilotChannelIds,
  activePilotSessionCount,
  ensurePilotDirs,
  hasLivePilotSession,
  initPilot,
  interruptPilotSession,
  isPilotChannelId,
  pilotConfigChannelId,
  resetPilotSession,
  stopAllPilotSessions,
  stopPilotSession,
  submitToPilotSession,
  pilotSessionChannelIdsUnder,
  interruptPilotSessionsUnder,
  stopPilotSessionsUnder,
  resetPilotSessionScope,
  sweepOrphanPilotProcesses,
  type PilotChannelTarget,
  type PilotIncomingMessage,
  type PilotInterruptResult,
} from "./session.js";

export { buildPilotEnv } from "./env.js";

export { createPilotMcpServer, PILOT_MCP_SERVER_NAME } from "./bridge.js";
export {
  cronAgentRuntime,
  planPilotCronRoute,
  type CronAgentRuntime,
  type CronPilotRoute,
  type CronPilotRouteInput,
} from "./cron-route.js";
