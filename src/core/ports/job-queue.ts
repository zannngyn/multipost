/**
 * Job queue port — core declares what it needs from a background queue.
 * Pure TypeScript: no imports, no BullMQ/Redis vocabulary (see docs/07 section 2).
 *
 * Every option here has a meaning core can reason about (retries, delay,
 * idempotency key). Broker-specific tuning stays inside adapters/queue.
 */

export type JobBackoffStrategy = "fixed" | "exponential";

export interface JobBackoff {
  strategy: JobBackoffStrategy;
  /** Base delay in milliseconds; exponential multiplies it per attempt. */
  delayMs: number;
}

export interface EnqueueOptions {
  /** Total tries including the first one. Must be >= 1. */
  attempts?: number;
  backoff?: JobBackoff;
  /**
   * Stable id, deduplicating enqueues BEST-EFFORT only: the broker ignores a
   * second enqueue with the same id *while that job is still retained*. Once
   * retention evicts it (removeOnComplete/removeOnFail), the same id creates a
   * NEW job. Adapters may also restrict the charset (BullMQ: no ':').
   *
   * Therefore this is NOT the anti-duplicate lock of business rule 4. That lock
   * is a unique constraint on (batch, code, colour, channel, format) in the DB,
   * taken before any publish API call — built in E7.4.
   */
  jobId?: string;
  /** Delay before the job becomes runnable (scheduling, spacing between posts). */
  delayMs?: number;
}

export interface EnqueueResult {
  jobId: string;
}

export interface JobQueue {
  /** Throws AppError('QUEUE_ERROR') when the broker is unreachable. */
  enqueue<TPayload>(
    jobName: string,
    payload: TPayload,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult>;
  close(): Promise<void>;
}

/** What a handler receives. `payload` is UNTRUSTED — validate it with a schema. */
export interface JobEnvelope<TPayload = unknown> {
  jobId: string;
  jobName: string;
  payload: TPayload;
  /** 1-based attempt number (1 = first run). */
  attempt: number;
  maxAttempts: number;
}

export type JobHandler<TPayload = unknown> = (envelope: JobEnvelope<TPayload>) => Promise<void>;

/** jobName -> handler. Unknown names fail the job instead of being ignored. */
export type JobHandlerMap = Readonly<Record<string, JobHandler>>;

/** Running consumer; closing it stops accepting new jobs and drains active ones. */
export interface JobConsumer {
  close(): Promise<void>;
}
