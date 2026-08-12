import { Redis, type RedisOptions } from "ioredis";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";

/**
 * Shared ioredis connection for BullMQ (queue + worker).
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ: blocking commands (BRPOPLPUSH)
 * would otherwise be aborted mid-wait and the worker would die on a blip.
 */

export interface RedisConnectionOptions {
  url: string;
  logger: Logger;
  /** Extra ioredis options; used by tests/ops, never to override the two locked flags. */
  overrides?: RedisOptions;
}

export function createRedisConnection(options: RedisConnectionOptions): Redis {
  const url = options.url?.trim();
  if (!url) {
    throw new AppError("QUEUE_ERROR", {
      message: "REDIS_URL is empty — cannot open a queue connection",
      context: { url_provided: Boolean(options.url) },
    });
  }

  const logger = options.logger.child({ component: "redis-connection" });

  const connection = new Redis(url, {
    ...options.overrides,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Cap reconnect backoff: a dead Redis must not spin the event loop.
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
  });

  // An 'error' event with no listener crashes the process. Log it with context
  // and let ioredis keep retrying; BullMQ surfaces the failure per job.
  connection.on("error", (err: unknown) => {
    logger.error("redis connection error", {
      err: AppError.from(err, "QUEUE_ERROR", { redis_status: connection.status }),
      redis_status: connection.status,
    });
  });
  connection.on("reconnecting", (delay: number) => {
    logger.warn("redis reconnecting", { delay_ms: delay });
  });
  connection.on("ready", () => {
    logger.info("redis connection ready");
  });

  return connection;
}
