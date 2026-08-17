import { z } from "zod";

import { AppError } from "@/core/domain/errors";

/**
 * Env knobs of the reaper, parsed in the WORKER layer.
 *
 * They belong next to WORKER_CONCURRENCY in composition/config + worker-container
 * (one schema, one throw listing every bad key) — TODO(config-owner): move them
 * there. They are parsed here for now because composition is owned by another
 * agent this sprint; the shape below is what should be merged over.
 *
 * Defaults are deliberately generous: the reaper is a safety net, and a net that
 * fires too early would fight the spacing gate and the retry backoff.
 */

export const ReaperEnvSchema = z.object({
  /** Sweep period. 5 minutes: fast enough to matter, cheap enough to ignore. */
  WORKER_REAPER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(24 * 60 * 60_000)
    .default(300_000),
  /** A `publishing` row untouched for this long has lost its worker. */
  WORKER_PUBLISHING_STALE_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60_000)
    .default(900_000),
  /** Grace after a scheduled time before a queued job counts as overdue. */
  WORKER_OVERDUE_QUEUED_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60_000)
    .default(600_000),
  /** Rows touched per sweep, per category. */
  WORKER_REAPER_LIMIT: z.coerce.number().int().min(1).max(500).default(50),

  // --- E8.6 reconciliation of posts Facebook is holding ---------------------
  /**
   * How often to ask Facebook "did you publish it?". 2 minutes: the handed-over
   * post is already safe, this only decides how fast the link appears on the
   * operator screen.
   */
  WORKER_RECONCILE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(24 * 60 * 60_000)
    .default(120_000),
  /** Grace after the hour before the first question (Meta is not punctual). */
  WORKER_RECONCILE_GRACE_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(24 * 60 * 60_000)
    .default(180_000),
  /** After this long with no confirmation the job is marked failed. */
  WORKER_RECONCILE_GIVE_UP_MS: z.coerce
    .number()
    .int()
    .min(5 * 60_000)
    .max(7 * 24 * 60 * 60_000)
    .default(24 * 60 * 60_000),
  WORKER_RECONCILE_LIMIT: z.coerce.number().int().min(1).max(500).default(50),
});

export type ReaperConfig = z.infer<typeof ReaperEnvSchema>;

export function loadReaperConfig(env: NodeJS.ProcessEnv = process.env): ReaperConfig {
  const parsed = ReaperEnvSchema.safeParse(env);
  if (parsed.success) return parsed.data;

  // Same failure shape as loadWorkerConfig: every bad key at once.
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
  throw new AppError("INVALID_INPUT", {
    message: `Invalid reaper configuration: ${issues.map((i) => i.path).join(", ")}`,
    userMessage: "Cấu hình công việc quét bài kẹt chưa đúng. Vui lòng liên hệ quản trị viên.",
    context: { scope: "worker.reaper", issues },
  });
}
