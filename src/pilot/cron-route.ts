/**
 * Where a cron `agentTurn` job runs.
 *
 * Every agent turn is served by a Claude Agent SDK session now, so this module
 * no longer decides *whether* pilot applies — only *where* the session lives:
 * which channel owns the `settings.pilot` flag (informational only), which id
 * the session keys to, and whether a thread has to be created first. It stays
 * pure so the thread→parent resolution and the don't-nest-threads rule can be
 * tested without a database or a Discord client.
 */

import { pilotConfigChannelId } from "./session.js";

export interface CronPilotRouteInput {
  /** Resolved delivery channel for the job (may be absent). */
  channelId?: string | null;
  /** Whether that channel is itself a thread. */
  isThread?: boolean;
  /** Parent channel id when `isThread` is true. */
  parentId?: string | null;
  /** Whether the delivery target is a DM channel. DMs hold no channel config. */
  isDM?: boolean;
}

export interface CronPilotRoute {
  /**
   * Channel whose `settings.pilot` flag *would* apply here — a thread's parent.
   * Informational: routing no longer depends on the flag. Null for a DM and for
   * a thread whose parent is unknown, neither of which can carry channel config.
   */
  configChannelId: string | null;
  /**
   * Channel the pilot session is keyed to *if no thread is created*. Cron
   * normally delivers into a fresh thread, in which case the caller keys the
   * session to that thread id instead (see `needsThread`).
   */
  sessionChannelId: string;
  /**
   * True when the caller should create a thread before submitting. Cron output
   * is thread-only by policy, but a thread cannot contain another thread and a
   * DM cannot contain one at all.
   */
  needsThread: boolean;
}

export type CronAgentRuntime = "sdk" | "main";

/**
 * Which runtime cron `agentTurn` jobs run on. `sdk` (the default) hands every
 * job to a Claude Agent SDK session; `CRON_RUNTIME=main` forces the in-process
 * agent loop back. An escape hatch rather than a feature: it exists so a bad
 * SDK run can be undone with an env flip and a restart instead of a revert.
 *
 * Read per call rather than captured at import, so the flip needs no rebuild.
 */
export function cronAgentRuntime(): CronAgentRuntime {
  return (process.env.CRON_RUNTIME || "").trim().toLowerCase() === "main"
    ? "main"
    : "sdk";
}

/**
 * Plan the pilot route for a cron job. Returns null only when there is nothing
 * to route — no delivery channel at all, which leaves the caller no place to
 * put a session.
 */
export function planPilotCronRoute(
  input: CronPilotRouteInput,
): CronPilotRoute | null {
  const channelId = input.channelId?.trim();
  if (!channelId) return null;

  const isThread = input.isThread === true;
  const isDM = input.isDM === true;

  return {
    configChannelId: pilotConfigChannelId({
      channelId,
      isDM,
      isThread,
      parentId: input.parentId ?? null,
    }),
    sessionChannelId: channelId,
    needsThread: !isThread && !isDM,
  };
}
