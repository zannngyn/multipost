import type { Redis } from "ioredis";
import { z } from "zod";

import { startBullMqJobConsumer } from "@/adapters/queue/bullmq-job-consumer";
import { makeBullMqJobQueue } from "@/adapters/queue/bullmq-job-queue";
import { makeRedisJobProgressStore } from "@/adapters/queue/redis-job-progress";
import { createRedisConnection } from "@/adapters/queue/redis-connection";
import { AppError } from "@/core/domain/errors";
import type { Clock, Logger } from "@/core/ports/infra";
import type { JobConsumer, JobHandlerMap, JobQueue } from "@/core/ports/job-queue";

import { loadConfig, type Config, type EnvRecord } from "./config";
import { closeContainer, makeInfra, makeUsecases, type Usecases } from "./container";

/**
 * Composition root for the WORKER process (and for queue producers such as
 * enqueue-demo). It reuses the web wiring (container.ts: db + usecases) and adds
 * what only a worker has: a Redis connection, a queue and a job consumer.
 *
 * Shared env keys live in composition/config.ts — there is no second copy here.
 * Only WORKER_* keys, which no other process reads, are parsed below.
 */

const WorkerRuntimeSchema = z.object({
  /** Parallel jobs per worker process. Keep low: external APIs are rate-limited. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  /** Liveness marker touched by the worker loop; read by the Docker HEALTHCHECK. */
  WORKER_HEARTBEAT_FILE: z.string().trim().min(1).default("/tmp/mysp-worker-heartbeat"),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  /**
   * Hard deadline for a graceful shutdown. Past it the process exits non-zero
   * instead of hanging forever on a stuck job (Docker would SIGKILL it anyway,
   * but without a log line saying why).
   */
  WORKER_SHUTDOWN_DEADLINE_MS: z.coerce.number().int().min(1).max(300_000).default(30_000),
});

export type WorkerConfig = Config & z.infer<typeof WorkerRuntimeSchema>;

interface EnvIssue {
  path: string;
  message: string;
}

function issuesOf(error: z.ZodError): EnvIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

/** Issues recorded by loadConfig() inside its AppError context, if any. */
function issuesOfAppError(error: AppError): EnvIssue[] {
  const raw = (error.context as { issues?: unknown }).issues;
  return Array.isArray(raw) ? (raw as EnvIssue[]) : [{ path: "(core)", message: error.message }];
}

/**
 * Shared config + worker config in ONE throw: a fresh deploy sees every missing
 * key at once instead of one restart per variable.
 */
export function loadWorkerConfig(env: EnvRecord = process.env): WorkerConfig {
  const runtime = WorkerRuntimeSchema.safeParse(env);

  let base: Config | null = null;
  let baseIssues: EnvIssue[] = [];
  try {
    base = loadConfig(env);
  } catch (error) {
    baseIssues = issuesOfAppError(AppError.from(error, "INVALID_INPUT"));
  }

  if (!base || !runtime.success) {
    const issues = [...baseIssues, ...(runtime.success ? [] : issuesOf(runtime.error))];
    throw new AppError("INVALID_INPUT", {
      message: `Invalid worker environment configuration: ${issues.map((i) => i.path).join(", ")}`,
      userMessage: "Cấu hình worker chưa đầy đủ. Vui lòng liên hệ quản trị viên.",
      context: { scope: "worker", issues },
    });
  }

  return { ...base, ...runtime.data };
}

export interface WorkerContainer {
  config: WorkerConfig;
  logger: Logger;
  clock: Clock;
  queue: JobQueue;
  /** Same usecases the web process runs — one implementation, two entrypoints. */
  usecases: Usecases;
  /** Starts consuming; the caller owns the returned consumer's lifecycle. */
  startConsumer(handlers: JobHandlerMap): JobConsumer;
  /** Closes queue, Redis connection and the DB pool. Close the consumer first. */
  close(): Promise<void>;
}

export function makeWorkerContainer(env: EnvRecord = process.env): WorkerContainer {
  const config = loadWorkerConfig(env);
  // Reuses the web composition root: db handle, clock, logger, usecase wiring.
  const infra = makeInfra(config, { serviceName: "mysp-worker" });
  const logger = infra.logger;

  let connection: Redis | null = null;
  const getConnection = (): Redis => {
    connection ??= createRedisConnection({ url: config.REDIS_URL, logger });
    return connection;
  };

  const queue = makeBullMqJobQueue({ connection: getConnection(), logger });

  return {
    config,
    logger,
    clock: infra.clock,
    queue,
    // The worker passes its OWN queue and progress store so the process keeps a
    // SINGLE Redis connection: publish-post re-enqueues itself when the spacing
    // gate defers, and reports every step of a publish (E7.5) on the same wire.
    usecases: makeUsecases(infra, {
      queue,
      progress: makeRedisJobProgressStore({ connection: getConnection(), logger }),
    }),
    startConsumer(handlers: JobHandlerMap): JobConsumer {
      return startBullMqJobConsumer({
        connection: getConnection(),
        logger,
        handlers,
        concurrency: config.WORKER_CONCURRENCY,
      });
    },
    async close(): Promise<void> {
      await queue.close();
      // quit() waits for pending replies; disconnect() would drop them.
      if (connection) await connection.quit();
      await closeContainer();
    },
  };
}

/**
 * Types re-exported for the worker/ layer: it may not import core directly
 * (docs/07 import matrix — worker sees only composition + core error codes).
 */
export type { Clock, Logger } from "@/core/ports/infra";
export type { JobConsumer, JobEnvelope, JobHandler, JobHandlerMap } from "@/core/ports/job-queue";
export type { Usecases } from "./container";
/**
 * Job NAME (a value, not a type): producer and consumer must agree on it, and
 * the producer lives in core. Re-exported here so worker/ can use it without
 * importing core directly (docs/07 import matrix).
 */
export { PUBLISH_POST_JOB_NAME } from "@/core/usecases/publish-post";
