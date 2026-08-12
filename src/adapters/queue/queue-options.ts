/**
 * Pure mapping between the JobQueue port vocabulary and BullMQ job options.
 * Kept free of I/O so it is unit-testable without a Redis server.
 */

import { AppError } from "@/core/domain/errors";
import type { EnqueueOptions } from "@/core/ports/job-queue";

/** Single queue for now; per-channel queues arrive with E7 fan-out. */
export const QUEUE_NAME = "mysp-jobs";

export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = 1_000;
/** Keep a short success trail, a long failure trail — failures are what we debug. */
export const KEEP_COMPLETED_JOBS = 100;
export const KEEP_FAILED_JOBS = 1_000;

/**
 * Charset a custom job id may use. BullMQ builds Redis keys from the id and
 * rejects ':' at runtime; the rest of the whitelist keeps ids safe in logs,
 * URLs and Redis key scans. Enough for the E5 key shape
 * (batch-code-colour-channel-format).
 */
const JOB_ID_CHAR = /^[A-Za-z0-9._-]$/;
const JOB_ID_ALLOWED_DESCRIPTION = "letters, digits, '.', '_' and '-'";
const JOB_ID_MAX_LENGTH = 255;

export interface BullJobOptions {
  attempts: number;
  backoff: { type: "fixed" | "exponential"; delay: number };
  removeOnComplete: number;
  removeOnFail: number;
  jobId?: string;
  delay?: number;
}

export const DEFAULT_JOB_OPTIONS: BullJobOptions = {
  attempts: DEFAULT_ATTEMPTS,
  backoff: { type: "exponential", delay: DEFAULT_BACKOFF_MS },
  removeOnComplete: KEEP_COMPLETED_JOBS,
  removeOnFail: KEEP_FAILED_JOBS,
};

function invalid(message: string, context: Record<string, unknown>): AppError {
  return new AppError("QUEUE_ERROR", {
    message,
    userMessage: "Tham số công việc nền không hợp lệ — không thể đưa vào hàng đợi.",
    context,
  });
}

/**
 * Edge cases first: a caller passing attempts = 0, a negative delay or an empty
 * jobId would silently produce a job that never runs or that breaks the
 * anti-duplicate lock. Reject instead of defaulting.
 */
export function toBullJobOptions(opts?: EnqueueOptions): BullJobOptions {
  if (!opts) return { ...DEFAULT_JOB_OPTIONS };

  const result: BullJobOptions = { ...DEFAULT_JOB_OPTIONS };

  if (opts.attempts !== undefined) {
    if (!Number.isInteger(opts.attempts) || opts.attempts < 1) {
      throw invalid("attempts must be an integer >= 1", { attempts: opts.attempts });
    }
    result.attempts = opts.attempts;
  }

  if (opts.backoff !== undefined) {
    const { strategy, delayMs } = opts.backoff;
    if (strategy !== "fixed" && strategy !== "exponential") {
      throw invalid("backoff strategy must be 'fixed' or 'exponential'", { strategy });
    }
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw invalid("backoff delayMs must be a non-negative number", { delayMs });
    }
    result.backoff = { type: strategy, delay: Math.round(delayMs) };
  }

  if (opts.delayMs !== undefined) {
    if (!Number.isFinite(opts.delayMs) || opts.delayMs < 0) {
      throw invalid("delayMs must be a non-negative number", { delayMs: opts.delayMs });
    }
    result.delay = Math.round(opts.delayMs);
  }

  if (opts.jobId !== undefined) {
    const jobId = opts.jobId.trim();
    if (jobId.length === 0) {
      throw invalid("jobId must not be empty", { jobId: opts.jobId });
    }
    // The broker rejects ':' at runtime ("Custom Ids cannot contain :") because
    // it builds its Redis keys with it. Reject here, at the single validation
    // boundary, instead of letting a "valid" id die inside the broker.
    // Rejecting rather than sanitising: a job id is an idempotency key. Rewriting
    // it silently would let two different keys collapse into one (or the caller's
    // stored key stop matching the queued one) — a duplicate-post bug in E5.
    const offending = [...new Set(jobId.split("").filter((char) => !JOB_ID_CHAR.test(char)))];
    if (offending.length > 0) {
      throw invalid(
        `jobId may only contain ${JOB_ID_ALLOWED_DESCRIPTION} — offending characters: ${offending.join(" ")}`,
        { jobId, offending_characters: offending, allowed: JOB_ID_ALLOWED_DESCRIPTION },
      );
    }
    if (jobId.length > JOB_ID_MAX_LENGTH) {
      throw invalid(`jobId must be at most ${JOB_ID_MAX_LENGTH} characters`, {
        jobId_length: jobId.length,
      });
    }
    result.jobId = jobId;
  }

  return result;
}

/**
 * Delay BullMQ will wait before the next attempt, for logging only.
 * Mirrors bullmq's built-in strategies (exponential: 2^(n-1) * delay).
 */
export function nextBackoffMs(
  backoff: BullJobOptions["backoff"],
  attemptsMade: number,
): number | undefined {
  if (attemptsMade < 1) return undefined;
  if (backoff.type === "fixed") return backoff.delay;
  return Math.round(Math.pow(2, attemptsMade - 1) * backoff.delay);
}
