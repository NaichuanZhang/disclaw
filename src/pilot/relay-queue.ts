// ---------------------------------------------------------------------------
// Pilot mode — outbound relay queue
//
// A pilot turn can emit a dozen tool-call lines in a second. Discord allows
// roughly 5 messages per 5 seconds per channel, so relaying each block as its
// own message earns 429s and silently loses lines. The main agent path solves
// this with a batching progress handler (see bot/messages.ts); this is the
// pilot equivalent.
//
// Two knobs, both order-preserving:
//   - coalescing: consecutive low-priority lines (tool-call markers) are merged
//     into one message on a short debounce
//   - throttling: a token bucket caps how many sends we make per window and
//     waits rather than dropping
//
// Everything drains through a single promise chain, so the channel transcript
// keeps the order the SDK produced.
// ---------------------------------------------------------------------------

/** Default debounce before a batch of coalescing lines is sent. */
const DEFAULT_DEBOUNCE_MS = 1_200;

/** Default token bucket: Discord's practical per-channel ceiling. */
const DEFAULT_MAX_SENDS = 5;
const DEFAULT_WINDOW_MS = 5_000;

/**
 * Cap for a merged batch. Below Discord's 2000-char limit so a coalesced batch
 * stays a single message (the send function may still chunk longer text).
 */
const DEFAULT_MAX_MERGED_CHARS = 1_900;

export interface PilotRelayQueueOptions {
  /** Performs the actual send. May chunk internally. */
  send: (text: string) => Promise<unknown>;
  /** How long to wait for more coalescing lines before flushing. */
  debounceMs?: number;
  /** Max sends per window before we start waiting. */
  maxSendsPerWindow?: number;
  /** Token bucket window. */
  windowMs?: number;
  /** Max characters in a merged batch. */
  maxMergedChars?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Injectable sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Called when a send throws. Sends are never retried. */
  onError?: (err: unknown) => void;
}

interface Entry {
  text: string;
  coalesce: boolean;
}

export class PilotRelayQueue {
  private buffer: Entry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private sendTimes: number[] = [];
  private closed = false;

  private readonly send: (text: string) => Promise<unknown>;
  private readonly debounceMs: number;
  private readonly maxSendsPerWindow: number;
  private readonly windowMs: number;
  private readonly maxMergedChars: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onError?: (err: unknown) => void;

  constructor(options: PilotRelayQueueOptions) {
    this.send = options.send;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxSendsPerWindow = options.maxSendsPerWindow ?? DEFAULT_MAX_SENDS;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxMergedChars = options.maxMergedChars ?? DEFAULT_MAX_MERGED_CHARS;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.onError = options.onError;
  }

  /** True when nothing is waiting to be sent. */
  get isEmpty(): boolean {
    return this.buffer.length === 0;
  }

  /**
   * Queue a line that should go out promptly (assistant text, warnings).
   * Anything already queued goes first, so order is preserved.
   */
  push(text: string): void {
    if (this.closed || !text) return;
    this.buffer.push({ text, coalesce: false });
    void this.flush();
  }

  /**
   * Queue a low-priority line (a tool-call marker). Consecutive ones are merged
   * into a single message after a short debounce.
   */
  pushCoalescing(text: string): void {
    if (this.closed || !text) return;
    this.buffer.push({ text, coalesce: true });
    this.scheduleFlush();
  }

  /** Send everything queued now. Resolves once the buffer has drained. */
  flush(): Promise<void> {
    this.clearTimer();
    this.chain = this.chain.then(() => this.drain());
    return this.chain;
  }

  /** Flush, then refuse further work. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.closed) {
      await this.chain.catch(() => {});
      return;
    }
    const pending = this.flush();
    this.closed = true;
    await pending.catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.takeBatch();
      await this.throttle();
      try {
        await this.send(batch);
      } catch (err) {
        // A failed send is reported and dropped: retrying risks duplicating
        // half a transcript, and the turn must keep moving either way.
        this.onError?.(err);
      }
    }
  }

  /**
   * Take the next message to send: a single non-coalescing entry, or as many
   * consecutive coalescing entries as fit in one message.
   */
  private takeBatch(): string {
    const first = this.buffer.shift()!;
    if (!first.coalesce) return first.text;

    let text = first.text;
    while (this.buffer.length > 0 && this.buffer[0].coalesce) {
      const merged = `${text}\n${this.buffer[0].text}`;
      if (merged.length > this.maxMergedChars) break;
      text = merged;
      this.buffer.shift();
    }
    return text;
  }

  /** Wait, if needed, so we stay under the per-window send cap. */
  private async throttle(): Promise<void> {
    this.forgetOldSends(this.now());

    if (this.sendTimes.length >= this.maxSendsPerWindow) {
      const waitMs = this.windowMs - (this.now() - this.sendTimes[0]);
      if (waitMs > 0) await this.sleep(waitMs);
      this.forgetOldSends(this.now());
    }

    this.sendTimes.push(this.now());
  }

  private forgetOldSends(now: number): void {
    this.sendTimes = this.sendTimes.filter((t) => now - t < this.windowMs);
  }
}
