import { Queue } from "bullmq";
import type { Redis } from "ioredis";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type {
  EnqueueOptions,
  EnqueueResult,
  JobQueue,
  QueueWorkerCensus,
  QueueWorkerRegistry,
  RepeatableJobInput,
} from "@/core/ports/job-queue";

import {
  DEFAULT_JOB_OPTIONS,
  KEEP_COMPLETED_JOBS,
  KEEP_FAILED_JOBS,
  QUEUE_NAME,
  toBullJobOptions,
} from "./queue-options";

/** BullMQ implementation of the JobQueue port (producer side). */

export interface BullMqJobQueueDeps {
  connection: Redis;
  logger: Logger;
  queueName?: string;
}

/**
 * BullMQ answers `getWorkers()` with ONE synthetic entry carrying this text
 * (instead of failing) when the server refuses `CLIENT LIST` — some managed
 * Redis offerings do. Counting it would report a worker that does not exist,
 * which is the exact lie this probe is meant to prevent.
 */
const CLIENT_LIST_UNSUPPORTED = "does not support client list";

class BullMqJobQueue implements JobQueue, QueueWorkerRegistry {
  private readonly queue: Queue;
  private readonly logger: Logger;
  private readonly queueName: string;

  constructor(deps: BullMqJobQueueDeps) {
    this.queueName = deps.queueName ?? QUEUE_NAME;
    this.logger = deps.logger.child({ component: "bullmq-queue", queue: this.queueName });
    this.queue = new Queue(this.queueName, {
      connection: deps.connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }

  async enqueue<TPayload>(
    jobName: string,
    payload: TPayload,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult> {
    // Edge cases first: a blank job name would create a job no handler can route.
    const name = jobName?.trim();
    if (!name) {
      throw new AppError("QUEUE_ERROR", {
        message: "jobName must not be empty",
        userMessage: "Không thể tạo công việc nền: thiếu tên công việc.",
        context: { queue: this.queueName },
      });
    }
    if (payload === undefined) {
      throw new AppError("QUEUE_ERROR", {
        message: "job payload must not be undefined",
        userMessage: "Không thể tạo công việc nền: thiếu dữ liệu công việc.",
        context: { queue: this.queueName, job_name: name },
      });
    }

    const jobOptions = toBullJobOptions(opts);

    try {
      const job = await this.queue.add(name, payload, jobOptions);
      if (!job.id) {
        // Happens when a duplicate jobId is rejected by the broker.
        throw new AppError("QUEUE_ERROR", {
          message: "Broker returned a job without id",
          context: { queue: this.queueName, job_name: name, requested_job_id: jobOptions.jobId },
        });
      }
      this.logger.info("job enqueued", {
        job_id: job.id,
        job_name: name,
        attempts: jobOptions.attempts,
        delay_ms: jobOptions.delay ?? 0,
      });
      return { jobId: job.id };
    } catch (error) {
      const appError = AppError.from(error, "QUEUE_ERROR", {
        queue: this.queueName,
        job_name: name,
        requested_job_id: jobOptions.jobId,
      });
      this.logger.error("enqueue failed", { err: appError, job_name: name });
      throw appError;
    }
  }

  /**
   * Drops a not-yet-running job (E8.4). BullMQ's `Queue.remove` deletes the job
   * hash and returns how many keys it removed: 0 means "nothing to remove" —
   * either an unknown id or a job that is ALREADY ACTIVE, since BullMQ refuses
   * to remove a locked job. Both are the same answer for the caller: the queue
   * no longer guarantees anything, the post_job row decides (see the port note).
   */
  async remove(jobId: string): Promise<boolean> {
    const id = typeof jobId === "string" ? jobId.trim() : "";
    if (id.length === 0) {
      throw new AppError("QUEUE_ERROR", {
        message: "remove requires a job id",
        userMessage: "Không huỷ được công việc nền: thiếu mã công việc.",
        context: { queue: this.queueName },
      });
    }

    try {
      const removed = await this.queue.remove(id);
      const ok = removed > 0;
      this.logger.info("job removed from the queue", {
        job_id: id,
        removed: ok,
        // Not an error: an already-running job is handled by the state machine.
        reason: ok ? "REMOVED" : "NOT_FOUND_OR_ACTIVE",
      });
      return ok;
    } catch (error) {
      const appError = AppError.from(error, "QUEUE_ERROR", {
        queue: this.queueName,
        job_id: id,
        operation: "queue.remove",
      });
      this.logger.error("queue remove failed", { err: appError, job_id: id });
      throw appError;
    }
  }

  /**
   * Existence check for the reaper (E11.x). `getJob` looks the job hash up by id
   * whatever state it is in; `undefined` means the broker has nothing under that
   * id — evicted by retention, removed, or never created.
   */
  async has(jobId: string): Promise<boolean> {
    const id = typeof jobId === "string" ? jobId.trim() : "";
    if (id.length === 0) return false;
    try {
      const job = await this.queue.getJob(id);
      return job !== undefined && job !== null;
    } catch (error) {
      const appError = AppError.from(error, "QUEUE_ERROR", {
        queue: this.queueName,
        job_id: id,
        operation: "queue.has",
      });
      this.logger.error("queue lookup failed", { err: appError, job_id: id });
      throw appError;
    }
  }

  /**
   * Worker census (E11 health banner). `Queue.getWorkers()` reads Redis'
   * `CLIENT LIST` and keeps the clients whose name is the queue's own client
   * name (a worker's blocking connection registers itself under it) — so the
   * answer travels through the BROKER and works across containers, unlike a
   * heartbeat file the web process cannot see.
   *
   * NEVER THROWS (see the port): "Redis is down" is a thing this probe must be
   * able to REPORT, not a thing it may fail on. The failure is logged with
   * context and returned as `reachable: false`.
   */
  async countWorkers(): Promise<QueueWorkerCensus> {
    try {
      const workers = await this.queue.getWorkers();
      const rows = Array.isArray(workers) ? workers : [];

      // Edge case first: the "unsupported command" placeholder is one row that
      // is not a worker. Treat it as "could not ask", never as one worker.
      if (rows.length === 1 && isUnsupportedPlaceholder(rows[0])) {
        this.logger.warn("broker cannot list clients — worker count unavailable", {
          reason: "CLIENT_LIST_UNSUPPORTED",
          queue: this.queueName,
        });
        return { workersOnline: 0, reachable: false };
      }

      return { workersOnline: rows.length, reachable: true };
    } catch (error) {
      const appError = AppError.from(error, "QUEUE_ERROR", {
        queue: this.queueName,
        operation: "queue.countWorkers",
      });
      // warn, not error: this runs on every health poll, and an unreachable
      // broker is already reported to the operator through `reachable: false`.
      this.logger.warn("could not count queue workers", {
        err: appError,
        error_code: appError.code,
        queue: this.queueName,
      });
      return { workersOnline: 0, reachable: false };
    }
  }

  /**
   * BullMQ job scheduler (the successor of `repeat`): one row per schedulerId,
   * upserted — so every worker boot re-declares the same schedule instead of
   * adding one more. Changing `everyMs` in env takes effect on the next boot.
   */
  async enqueueRepeatable<TPayload>(input: RepeatableJobInput<TPayload>): Promise<EnqueueResult> {
    const schedulerId = typeof input?.schedulerId === "string" ? input.schedulerId.trim() : "";
    const jobName = typeof input?.jobName === "string" ? input.jobName.trim() : "";
    const everyMs = input?.everyMs;
    if (schedulerId.length === 0 || jobName.length === 0) {
      throw new AppError("QUEUE_ERROR", {
        message: "enqueueRepeatable requires a scheduler id and a job name",
        userMessage: "Không tạo được công việc định kỳ: thiếu định danh.",
        context: { queue: this.queueName, scheduler_id: schedulerId || null },
      });
    }
    if (!Number.isInteger(everyMs) || everyMs <= 0) {
      // A zero/negative period would spin the queue as fast as Redis answers.
      throw new AppError("QUEUE_ERROR", {
        message: "enqueueRepeatable requires a positive interval",
        userMessage: "Chu kỳ chạy công việc định kỳ không hợp lệ.",
        context: { queue: this.queueName, scheduler_id: schedulerId, every_ms: everyMs },
      });
    }

    try {
      const job = await this.queue.upsertJobScheduler(
        schedulerId,
        { every: everyMs },
        {
          name: jobName,
          data: input.payload,
          opts: {
            // One attempt per tick: the next tick IS the retry, and a pile of
            // backed-off reaper runs would all scan the same rows.
            attempts: input.attempts ?? 1,
            removeOnComplete: KEEP_COMPLETED_JOBS,
            removeOnFail: KEEP_FAILED_JOBS,
          },
        },
      );
      this.logger.info("repeatable job scheduled", {
        scheduler_id: schedulerId,
        job_name: jobName,
        every_ms: everyMs,
        next_job_id: job?.id ?? null,
      });
      return { jobId: job?.id ?? schedulerId };
    } catch (error) {
      const appError = AppError.from(error, "QUEUE_ERROR", {
        queue: this.queueName,
        scheduler_id: schedulerId,
        job_name: jobName,
        operation: "queue.enqueueRepeatable",
      });
      this.logger.error("scheduling a repeatable job failed", { err: appError });
      throw appError;
    }
  }

  async close(): Promise<void> {
    try {
      await this.queue.close();
      this.logger.info("queue closed");
    } catch (error) {
      const appError = AppError.from(error, "QUEUE_ERROR", { queue: this.queueName });
      this.logger.error("queue close failed", { err: appError });
      throw appError;
    }
  }
}

/** True for the placeholder row BullMQ returns when CLIENT LIST is refused. */
function isUnsupportedPlaceholder(row: Record<string, string> | undefined): boolean {
  const name = typeof row?.name === "string" ? row.name.toLowerCase() : "";
  return name.includes(CLIENT_LIST_UNSUPPORTED);
}

export function makeBullMqJobQueue(deps: BullMqJobQueueDeps): JobQueue & QueueWorkerRegistry {
  return new BullMqJobQueue(deps);
}
