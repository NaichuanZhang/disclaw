/**
 * Where a cron `agentTurn` job runs.
 *
 * Every agent turn is served by a Claude Agent SDK session, so this module does
 * not decide *whether* a session is used — only *where* it lives: which id the
 * session keys to, and whether a thread has to be created first. It stays pure
 * so the don't-nest-threads rule can be tested without a database or a Discord
 * client.
 */

export interface CronSdkRouteInput {
  /** Resolved delivery channel for the job (may be absent). */
  channelId?: string | null;
  /** Whether that channel is itself a thread. */
  isThread?: boolean;
  /** Parent channel id when `isThread` is true. */
  parentId?: string | null;
  /** Whether the delivery target is a DM channel. DMs hold no channel config. */
  isDM?: boolean;
}

export interface CronSdkRoute {
  /**
   * Channel the session is keyed to *if no thread is created*. Cron normally
   * delivers into a fresh thread, in which case the caller keys the session to
   * that thread id instead (see `needsThread`).
   */
  sessionChannelId: string;
  /**
   * True when the caller should create a thread before submitting. Cron output
   * is thread-only by policy, but a thread cannot contain another thread and a
   * DM cannot contain one at all.
   */
  needsThread: boolean;
}

/**
 * Plan the route for a cron job. Returns null only when there is nothing to
 * route — no delivery channel at all, which leaves the caller no place to put a
 * session.
 */
export function planSdkCronRoute(
  input: CronSdkRouteInput,
): CronSdkRoute | null {
  const channelId = input.channelId?.trim();
  if (!channelId) return null;

  return {
    sessionChannelId: channelId,
    needsThread: input.isThread !== true && input.isDM !== true,
  };
}
