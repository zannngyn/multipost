import { z } from "zod";

/**
 * Contract of `GET /api/posts/worker-health` (E11.1 delta).
 *
 * Why this screen needs it: a queued job with `attempt_count: 0` and no error
 * looks identical whether a worker is about to pick it up or no worker exists
 * at all. The job log alone can never tell those apart, so the silence has to
 * be broken by a separate reading of the machine that drains the queue.
 *
 * `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so the
 * shape is mirrored here. Server data is external data: parse before render.
 */

export const WorkerHealthSchema = z.object({
  /** 0 means nobody is draining the queue. */
  workersOnline: z.number().int().min(0),
  /** false = the queue itself could not be asked; nothing may be concluded. */
  queueReachable: z.boolean(),
  /** Queued jobs never attempted once — schedules not yet due are excluded. */
  untouchedQueuedJobs: z.number().int().min(0),
  /** Wait of the oldest of those jobs; null when there are none. */
  oldestUntouchedWaitMs: z.number().min(0).nullable(),
  checkedAt: z.iso.datetime(),
});

export type WorkerHealth = z.infer<typeof WorkerHealthSchema>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * "22 phút" / "2 giờ 5 phút" — how long the oldest untouched post has waited.
 *
 * Returns null for anything unusable (negative, NaN, Infinity) so the caller
 * drops the sentence instead of printing "NaN phút": a wrong number in an
 * alarm costs more trust than a missing one.
 */
export function formatWaitDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < MINUTE_MS) return "dưới 1 phút";
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} phút`;

  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${hours} giờ` : `${hours} giờ ${minutes} phút`;
  }

  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  return hours === 0 ? `${days} ngày` : `${days} ngày ${hours} giờ`;
}
