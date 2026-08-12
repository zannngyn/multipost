import type { Redis } from "ioredis";
import { z } from "zod";

import { makeSystemClock } from "@/adapters/clock/system-clock";
import { makePinoLogger } from "@/adapters/logging/pino-logger";
import { startBullMqJobConsumer } from "@/adapters/queue/bullmq-job-consumer";
import { makeBullMqJobQueue } from "@/adapters/queue/bullmq-job-queue";
import { createRedisConnection } from "@/adapters/queue/redis-connection";
import { AppError } from "@/core/domain/errors";
import type { Clock, Logger } from "@/core/ports/infra";
import type { JobConsumer, JobHandlerMap, JobQueue } from "@/core/ports/job-queue";

/**
 * Composition root for the WORKER process (and for queue producers such as
 * enqueue-demo). The web container (container.ts) stays untouched.
 *
 * TODO(E1): merge this env schema into composition/config.ts once that file is
 * stable — the worker needs a strict SUBSET of the web config (no Google/session
 * keys), so it must not fail to boot on a missing web-only variable.
 */

const WorkerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_PRETTY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  REDIS_URL: z
    .string()
    .trim()
    .min(1, "REDIS_URL must not be empty")
    .refine(
      (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
      "REDIS_URL must be a redis connection string",
    ),
  /** Parallel jobs per worker process. Keep low: external APIs are rate-limited. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  /** Liveness marker touched by the worker loop; read by the Docker HEALTHCHECK. */
  WORKER_HEARTBEAT_FILE: z.string().trim().min(1).default("/tmp/mysp-worker-heartbeat"),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
});

export type WorkerConfig = z.infer<typeof WorkerEnvSchema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = WorkerEnvSchema.safeParse(env);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));

  throw new AppError("INVALID_INPUT", {
    message: `Invalid worker environment configuration: ${issues.map((i) => i.path).join(", ")}`,
    userMessage: "Cấu hình worker chưa đầy đủ. Vui lòng liên hệ quản trị viên.",
    context: { issues },
  });
}

export interface WorkerContainer {
  config: WorkerConfig;
  logger: Logger;
  clock: Clock;
  queue: JobQueue;
  /** Starts consuming; the caller owns the returned consumer's lifecycle. */
  startConsumer(handlers: JobHandlerMap): JobConsumer;
  /** Closes queue + Redis connection. Close the consumer first. */
  close(): Promise<void>;
}

export function makeWorkerContainer(env: NodeJS.ProcessEnv = process.env): WorkerContainer {
  const config = loadWorkerConfig(env);
  const logger = makePinoLogger({
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
    base: { service: "mysp-worker", env: config.NODE_ENV },
  });

  let connection: Redis | null = null;
  const getConnection = (): Redis => {
    connection ??= createRedisConnection({ url: config.REDIS_URL, logger });
    return connection;
  };

  const queue = makeBullMqJobQueue({ connection: getConnection(), logger });

  return {
    config,
    logger,
    clock: makeSystemClock(),
    queue,
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
    },
  };
}

/**
 * Types re-exported for the worker/ layer: it may not import core directly
 * (docs/07 import matrix — worker sees only composition + core error codes).
 */
export type { Clock, Logger } from "@/core/ports/infra";
export type { JobConsumer, JobEnvelope, JobHandler, JobHandlerMap } from "@/core/ports/job-queue";
