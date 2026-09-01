/**
 * Pure parts of "Viết caption cho N kênh" — what the run consists of, and how
 * it is reported. The hook (`useCaptionFanOut`) owns the timers and the calls;
 * everything here can be tested without React or a network.
 */

/** Where one channel's call has got to. */
export type CaptionFanOutStatus = "pending" | "done" | "error";

/**
 * How many AI calls may be in flight at once.
 *
 * Three, not "all of them": the gateway is rate-limited per tenant and each
 * call can escalate models and retry, so firing ten at once buys 429s rather
 * than speed. Three keeps a five-page post under two rounds while leaving room
 * for another operator on the same tenant.
 */
export const CAPTION_FANOUT_CONCURRENCY = 3;

export interface CaptionFanOutPlan {
  /** The channels to write for, de-duplicated and in the order given. */
  readonly channelIds: string[];
  /** Workers to start — never more than there are channels. */
  readonly concurrency: number;
}

/**
 * Turns a selection into a runnable plan.
 *
 * De-duplicates because a repeated id would mean two calls racing to write the
 * same tab, and the loser's text would silently win or lose depending on
 * timing. Blank ids are dropped rather than sent to a server that would only
 * answer 400.
 */
export function fanOutPlan(
  channelIds: readonly string[],
  maxConcurrency: number = CAPTION_FANOUT_CONCURRENCY,
): CaptionFanOutPlan {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const channelId of channelIds ?? []) {
    const trimmed = typeof channelId === "string" ? channelId.trim() : "";
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }

  return {
    channelIds: unique,
    concurrency: Math.max(1, Math.min(maxConcurrency, unique.length)),
  };
}

/** What one channel's generation produced. Exactly one of the two is set. */
export interface CaptionFanOutAnswer {
  /** The caption to put on this channel's tab. */
  readonly text?: string;
  /** Why this channel has none — the server's own sentence. */
  readonly reason?: string;
}

export interface CaptionFanOutEvents {
  /** A channel's call is starting. */
  readonly onPending: (channelId: string) => void;
  /** A channel finished with a caption. */
  readonly onText: (channelId: string, text: string) => void;
  /** A channel finished without one, and why. */
  readonly onError: (channelId: string, reason: string) => void;
  /** A channel settled either way — what the progress counter counts. */
  readonly onSettled: (channelId: string) => void;
}

/**
 * THE fan-out loop, with the network injected.
 *
 * Pure control flow on purpose: "one channel failing must not stop the others"
 * (CLAUDE.md business rule 6) is the kind of rule that quietly breaks in a
 * refactor, and this repo has no DOM test environment to catch it in a
 * component. Here it is a plain async function a node test can drive with a
 * fake `generate`.
 *
 * Guarantees:
 *  - every channel is attempted exactly once, whatever the others do;
 *  - a rejection is turned into that channel's `onError` and NOTHING is
 *    rethrown out of the loop — the caller's job is to show N outcomes, not to
 *    die on the first one;
 *  - `onSettled` fires once per channel, success or failure, so the counter can
 *    never stall short of the total;
 *  - `isCurrent()` is asked before each call and before each write, so a
 *    superseded run stops instead of writing over newer text.
 */
export async function runCaptionFanOut(input: {
  channelIds: readonly string[];
  concurrency?: number;
  generate: (channelId: string) => Promise<CaptionFanOutAnswer>;
  events: CaptionFanOutEvents;
  /** False once this run has been superseded (or the screen went away). */
  isCurrent?: () => boolean;
}): Promise<void> {
  const plan = fanOutPlan(input.channelIds, input.concurrency ?? CAPTION_FANOUT_CONCURRENCY);
  if (plan.channelIds.length === 0) return;

  const isCurrent = input.isCurrent ?? (() => true);
  const queue = [...plan.channelIds];

  async function one(channelId: string): Promise<void> {
    input.events.onPending(channelId);
    try {
      const answer = await input.generate(channelId);
      if (!isCurrent()) return;
      if (answer.text && answer.text.trim().length > 0) {
        input.events.onText(channelId, answer.text);
        return;
      }
      // A call that came back with nothing usable IS a failure for this
      // channel: a green tick over an empty box is the lie to avoid.
      input.events.onError(
        channelId,
        answer.reason ?? "AI không trả về caption nào cho kênh này.",
      );
    } catch (error) {
      if (!isCurrent()) return;
      // Not swallowed: it becomes this channel's stated reason. The loop
      // continues because the other channels are independent posts.
      input.events.onError(channelId, describeUnknownFailure(error));
    } finally {
      if (isCurrent()) input.events.onSettled(channelId);
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      const channelId = queue.shift();
      if (channelId === undefined) return;
      if (!isCurrent()) return;
      await one(channelId);
    }
  }

  await Promise.all(Array.from({ length: plan.concurrency }, () => worker()));
}

/** Last-resort wording when a throw carries no operator sentence of its own. */
function describeUnknownFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message.length > 0
    ? `Không gọi được AI cho kênh này (${message}).`
    : "Không gọi được AI cho kênh này. Hãy thử lại.";
}

/**
 * The progress line, in words. "Đã viết 2/3 kênh…" while it runs, a summary
 * once it stops — and the summary NAMES the failures rather than hiding them
 * behind a count of successes (business rule 5).
 *
 * Returns "" when there is nothing to report, so the caller renders nothing at
 * all instead of an empty live region announcing itself.
 */
export function describeFanOut(input: {
  isRunning: boolean;
  done: number;
  total: number;
  failed: number;
}): string {
  if (input.total === 0) return "";
  if (input.isRunning) return `Đang viết caption — đã xong ${input.done}/${input.total} kênh…`;
  if (input.failed === 0) return `Đã viết caption cho ${input.total} kênh.`;
  const written = input.total - input.failed;
  return `Đã viết ${written}/${input.total} kênh — ${input.failed} kênh lỗi, xem tab có chấm đỏ và bấm “Viết lại”.`;
}
