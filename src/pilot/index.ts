// ---------------------------------------------------------------------------
// Pilot mode — public surface
//
// Pilot mode routes a single allowlisted Discord channel to a Claude Agent SDK
// session instead of our own agent loop. It is enabled per channel as data:
//   channel_configs.settings.pilot = true
//
// See src/pilot/session.ts for the session lifecycle, policy.ts for the
// permission gate, bridge.ts for the in-process MCP tools and env.ts for the
// child-process environment allowlist.
// ---------------------------------------------------------------------------

export {
  PILOT_DIR,
  PILOT_WORKSPACE_DIR,
  PilotSession,
  activePilotChannelIds,
  activePilotSessionCount,
  ensurePilotDirs,
  initPilot,
  interruptPilotSession,
  isPilotChannelId,
  pilotConfigChannelId,
  stopAllPilotSessions,
  stopPilotSession,
  submitToPilotSession,
  sweepOrphanPilotProcesses,
  type PilotChannelTarget,
  type PilotIncomingMessage,
  type PilotInterruptResult,
} from "./session.js";

export { buildPilotEnv, isSecretEnvVar, PILOT_ENV_ALLOWLIST } from "./env.js";

export {
  checkPilotCommand,
  checkPilotPath,
  defaultPilotPolicyContext,
  evaluatePilotToolCall,
  type PilotPolicyContext,
  type PolicyDecision,
} from "./policy.js";

export { createPilotMcpServer, PILOT_MCP_SERVER_NAME } from "./bridge.js";
