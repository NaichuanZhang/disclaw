/**
 * Where a cron `agentTurn` job should run when its channel is in pilot mode.
 *
 * The decision has two halves and they have different testability: working out
 * *which* channel owns the pilot flag and *where* the session should live is
 * pure bookkeeping, while "is that channel actually flagged" is a DB read. This
 * module is the pure half, so the thread→parent resolution and the
 * don't-nest-threads rule can be tested without a database or a Discord client.
 */

import { pilotConfigChannelId } from "./session.js";

export interface CronPilotRouteInput {
  /** Resolved delivery channel for the job (may be absent). */
  channelId?: string | null;
  /** Whether that channel is itself a thread. */
  isThread?: boolean;
  /** Parent channel id when `isThread` is true. */
  parentId?: string | null;
  /** Whether the delivery target is a DM channel. Pilot mode is guild-only. */
  isDM?: boolean;
}

export interface CronPilotRoute {
  /** Channel whose `settings.pilot` flag decides this — a thread's parent. */
  configChannelId: string;
  /**
   * Channel the pilot session is keyed to *if no thread is created*. Cron
   * normally delivers into a fresh thread, in which case the caller keys the
   * session to that thread id instead (see `needsThread`).
   */
  sessionChannelId: string;
  /**
   * True when the caller should create a thread before submitting. Cron output
   * is thread-only by policy, and a thread cannot contain another thread.
   */
  needsThread: boolean;
}

/**
 * Plan the pilot route for a cron job. Returns null when there is nothing to
 * route (no delivery channel, or a DM — pilot mode is per guild channel).
 *
 * The caller still has to check the flag: `isPilotChannelId(configChannelId)`.
 */
export function planPilotCronRoute(
  input: CronPilotRouteInput,
): CronPilotRoute | null {
  const channelId = input.channelId?.trim();
  if (!channelId) return null;

  const isThread = input.isThread === true;
  const configChannelId = pilotConfigChannelId({
    channelId,
    isDM: input.isDM === true,
    isThread,
    parentId: input.parentId ?? null,
  });
  if (!configChannelId) return null;

  return {
    configChannelId,
    sessionChannelId: channelId,
    needsThread: !isThread,
  };
}
