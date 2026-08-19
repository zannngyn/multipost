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
  /**
   * Drops a job that has not run yet (E8.4: reschedule / cancel a scheduled
   * post). Returns false when there is nothing to remove — an unknown id, or a
   * job the broker is already running.
   *
   * NOT a guarantee that the work will not happen: a job picked up a
   * millisecond earlier keeps running. The authority stays the post_job row +
   * the optimistic `queued -> publishing` claim, which is why callers write the
   * new state to the database BEFORE touching the queue.
   */
  remove(jobId: string): Promise<boolean>;
  /**
   * Is this job still known to the broker (waiting, delayed, active or retained)?
   *
   * Used by the reaper to tell "the post is queued and an entry will fire" from
   * "the post is queued and NOTHING will ever fire" — the state a lost/evicted
   * entry leaves behind, which no status alone can express. `false` is never
   * proof that the work did not happen: retention may simply have evicted a
   * finished job. The caller pairs it with the post_job row.
   */
  has(jobId: string): Promise<boolean>;
  /**
   * Registers (or updates) a job that repeats every `everyMs`. Idempotent by
   * `schedulerId`: calling it on every worker boot must not create a second
   * schedule — that is the whole reason this is not a plain `enqueue` with a
   * delay the handler re-arms.
   */
  enqueueRepeatable<TPayload>(input: RepeatableJobInput<TPayload>): Promise<EnqueueResult>;
  close(): Promise<void>;
}

/**
 * Answer of `QueueWorkerRegistry.countWorkers` — an OPERATIONAL signal, never a
 * business gate.
 *
 * `workersOnline: 0` is NOT proof that nothing will run the queue: a broker that
 * just restarted, a client registry that lags behind, or a hosted Redis without
 * the client-list command all produce a zero (or an unreachable answer) while
 * workers are perfectly alive. Read it as "nobody seems to be consuming this
 * queue — tell the operator", and NEVER as "it is safe to skip/duplicate work".
 *
 * Concretely: no publish path may branch on this number. The only thing allowed
 * to decide whether a post goes out is the post_job row + its optimistic
 * `queued -> publishing` claim.
 */
export interface QueueWorkerCensus {
  /** Consumers the broker currently reports for this queue. Never negative. */
  readonly workersOnline: number;
  /**
   * False when the broker could not be asked at all (connection refused, command
   * unsupported...). The count is then 0 and means NOTHING — the caller shows
   * "không hỏi được hàng đợi", which is itself the alert.
   */
  readonly reachable: boolean;
}

/**
 * The "is anybody consuming this queue?" probe (E11 worker-health banner).
 *
 * Deliberately NOT part of `JobQueue`: producing work and inspecting the
 * consumer registry are different jobs, and keeping them apart is what stops a
 * publish usecase from ever depending on a worker count (see the warning above).
 *
 * Contract for implementers: `countWorkers` MUST NOT throw. A broker failure is
 * exactly the case this probe exists to report, so it is returned as
 * `{ workersOnline: 0, reachable: false }` plus a logged warning — an exception
 * here would take down the very screen that has to show the outage.
 */
export interface QueueWorkerRegistry {
  countWorkers(): Promise<QueueWorkerCensus>;
}

export interface RepeatableJobInput<TPayload> {
  /** Stable identity of the SCHEDULE (not of one run). */
  readonly schedulerId: string;
  readonly jobName: string;
  readonly payload: TPayload;
  readonly everyMs: number;
  /** Attempts per RUN. A periodic job should not pile up retries: default 1. */
  readonly attempts?: number;
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
