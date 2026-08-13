import { UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";

import { AppError, type ErrorCode } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type { JobConsumer, JobHandlerMap } from "@/core/ports/job-queue";

import { DEFAULT_ATTEMPTS, QUEUE_NAME, nextBackoffMs } from "./queue-options";

/**
 * BullMQ implementation of the consumer side.
 * It owns ALL broker vocabulary: retries, UnrecoverableError, worker events.
 * Handlers stay plain async functions over a JobEnvelope.
 */

/**
 * Retrying these is pure waste: the input will not become valid, and the missing
 * row will not appear, inside a retry window measured in seconds. They are
 * failed immediately via UnrecoverableError (after being logged with context).
 *
 * The mapping "error code -> retryable?" lives HERE, in the broker adapter:
 * handlers stay free of BullMQ vocabulary and just throw an AppError.
 */
export const NON_RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "JOB_PAYLOAD_INVALID",
  "INVALID_INPUT",
  // Business failure, not an outage: a tenant is created by an operator, not by
  // waiting. Burning 3 attempts on it only delays the error report.
  "TENANT_NOT_FOUND",
  // --- Publishing (E5/E7). A retry cannot restock an item, mint a token,
  // configure a channel, or undo a post that already exists. publish-post
  // records the reason on the post_job row before these ever reach the queue;
  // they are listed here as defence in depth for the paths that DO throw.
  "OUT_OF_STOCK",
  "DUPLICATE_POST_BLOCKED",
  "CHANNEL_NOT_CONFIGURED",
  "TOKEN_EXPIRED",
  "INVALID_JOB_TRANSITION",
  // A clip that breaks the target's limits, or a file ffprobe cannot read: the
  // next attempt reads the same bytes and reaches the same verdict.
  "VIDEO_SPEC_INVALID",
  "VIDEO_PROBE_FAILED",
  // The usecase already spent every allowed attempt (or hit a non-retryable
  // platform error) and moved the job to `failed`.
  "PUBLISH_FAILED",
]);

export interface BullMqJobConsumerDeps {
  connection: Redis;
  logger: Logger;
  handlers: JobHandlerMap;
  queueName?: string;
  concurrency?: number;
}

function attemptOf(job: Job): number {
  // attemptsStarted is set when the job is moved to active (1 on first run);
  // fall back to attemptsMade (failures so far) for older payloads.
  return job.attemptsStarted > 0 ? job.attemptsStarted : job.attemptsMade + 1;
}

function maxAttemptsOf(job: Job): number {
  return job.opts.attempts ?? DEFAULT_ATTEMPTS;
}

export function startBullMqJobConsumer(deps: BullMqJobConsumerDeps): JobConsumer {
  const queueName = deps.queueName ?? QUEUE_NAME;
  const logger = deps.logger.child({ component: "bullmq-consumer", queue: queueName });
  const handlerNames = Object.keys(deps.handlers);

  // Edge case first: a consumer with no handler would silently drain the queue.
  if (handlerNames.length === 0) {
    throw new AppError("QUEUE_ERROR", {
      message: "No job handler registered — refusing to start a consumer",
      userMessage: "Worker chưa đăng ký loại công việc nào — không thể khởi động.",
      context: { queue: queueName },
    });
  }

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const attempt = attemptOf(job);
      const maxAttempts = maxAttemptsOf(job);
      const jobLogger = logger.child({
        job_id: job.id ?? "unknown",
        job_name: job.name,
        attempt,
        max_attempts: maxAttempts,
      });

      const handler = deps.handlers[job.name];
      if (!handler) {
        const appError = new AppError("QUEUE_ERROR", {
          message: `No handler registered for job name "${job.name}"`,
          userMessage: `Không có bộ xử lý cho công việc "${job.name}" — công việc bị từ chối.`,
          context: { queue: queueName, job_id: job.id, registered: handlerNames },
        });
        jobLogger.error("job rejected: unknown job name", { err: appError });
        // Registering the handler requires a deploy; retrying now is pointless.
        throw new UnrecoverableError(`${appError.code}: ${appError.message}`);
      }

      jobLogger.info("job received");
      const startedAt = Date.now();

      try {
        await handler({
          jobId: job.id ?? "unknown",
          jobName: job.name,
          payload: job.data,
          attempt,
          maxAttempts,
        });
        jobLogger.info("job processed", { duration_ms: Date.now() - startedAt });
      } catch (error) {
        const appError = AppError.from(error, "INTERNAL", {
          queue: queueName,
          job_id: job.id,
          job_name: job.name,
          attempt,
        });
        jobLogger.error("job handler threw", {
          err: appError,
          duration_ms: Date.now() - startedAt,
        });
        if (NON_RETRYABLE_CODES.has(appError.code)) {
          throw new UnrecoverableError(`${appError.code}: ${appError.message}`);
        }
        // Rethrow so BullMQ applies attempts + backoff. The 'failed' event logs the retry plan.
        throw appError;
      }
    },
    {
      connection: deps.connection,
      concurrency: deps.concurrency ?? 1,
    },
  );

  worker.on("completed", (job: Job) => {
    logger.info("job completed", {
      job_id: job.id ?? "unknown",
      job_name: job.name,
      attempt: attemptOf(job),
    });
  });

  worker.on("failed", (job: Job | undefined, error: Error) => {
    if (!job) {
      // Happens when the broker loses the job (lock expired, job evicted while
      // active). Without the queue context this line is undebuggable.
      logger.error("job failed without job context", {
        err: AppError.from(error, "QUEUE_ERROR", { queue: queueName }),
        queue: queueName,
        registered_job_names: handlerNames,
        concurrency: deps.concurrency ?? 1,
        reason: "broker reported a failure with no job payload attached",
      });
      return;
    }
    const maxAttempts = maxAttemptsOf(job);
    // After a failure attemptsMade counts this failure, so it IS the attempt number.
    const attempt = job.attemptsMade > 0 ? job.attemptsMade : attemptOf(job);
    const unrecoverable = error?.name === "UnrecoverableError";
    const willRetry = !unrecoverable && attempt < maxAttempts;
    const backoff = job.opts.backoff;
    const nextDelayMs =
      willRetry && backoff && typeof backoff === "object"
        ? nextBackoffMs({ type: backoff.type as "fixed" | "exponential", delay: backoff.delay ?? 0 }, attempt)
        : undefined;

    logger.error("job failed", {
      err: error,
      job_id: job.id ?? "unknown",
      job_name: job.name,
      attempt,
      max_attempts: maxAttempts,
      will_retry: willRetry,
      unrecoverable,
      next_backoff_ms: nextDelayMs,
      failed_reason: job.failedReason,
    });
  });

  // Broker-level problem (lost connection, lock error). Never kills the worker.
  worker.on("error", (error: Error) => {
    logger.error("worker error event", {
      err: AppError.from(error, "QUEUE_ERROR", { queue: queueName }),
    });
  });

  logger.info("consumer started", {
    concurrency: deps.concurrency ?? 1,
    job_names: handlerNames,
  });

  return {
    async close(): Promise<void> {
      try {
        await worker.close();
        logger.info("consumer closed");
      } catch (error) {
        const appError = AppError.from(error, "QUEUE_ERROR", { queue: queueName });
        logger.error("consumer close failed", { err: appError });
        throw appError;
      }
    },
  };
}
