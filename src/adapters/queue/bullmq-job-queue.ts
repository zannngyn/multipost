import { Queue } from "bullmq";
import type { Redis } from "ioredis";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type { EnqueueOptions, EnqueueResult, JobQueue } from "@/core/ports/job-queue";

import { DEFAULT_JOB_OPTIONS, QUEUE_NAME, toBullJobOptions } from "./queue-options";

/** BullMQ implementation of the JobQueue port (producer side). */

export interface BullMqJobQueueDeps {
  connection: Redis;
  logger: Logger;
  queueName?: string;
}

class BullMqJobQueue implements JobQueue {
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

export function makeBullMqJobQueue(deps: BullMqJobQueueDeps): JobQueue {
  return new BullMqJobQueue(deps);
}
