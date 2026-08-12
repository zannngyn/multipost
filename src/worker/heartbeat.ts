import { writeFileSync } from "node:fs";

import type { Logger } from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

/**
 * Liveness marker for the Docker HEALTHCHECK: the worker has no HTTP port, so
 * the container is "healthy" only while its event loop still touches this file.
 * A blocked/dead loop stops refreshing it and the container gets restarted.
 */

export interface HeartbeatOptions {
  filePath: string;
  intervalMs: number;
  logger: Logger;
}

export interface HeartbeatHandle {
  stop(): void;
}

function touch(filePath: string): void {
  writeFileSync(filePath, `${new Date().toISOString()}\n`, "utf8");
}

export function startHeartbeat(options: HeartbeatOptions): HeartbeatHandle {
  const { filePath, intervalMs, logger } = options;

  // First write must succeed: a wrong path would leave the container unhealthy
  // forever with no explanation. Fail fast with a clear reason instead.
  try {
    touch(filePath);
  } catch (error) {
    throw AppError.from(error, "INTERNAL", { heartbeat_file: filePath });
  }

  const timer = setInterval(() => {
    try {
      touch(filePath);
    } catch (error) {
      // Do not crash the worker over a heartbeat write: log it, let the health
      // check turn red on its own.
      logger.error("heartbeat write failed", {
        err: AppError.from(error, "INTERNAL", { heartbeat_file: filePath }),
        heartbeat_file: filePath,
      });
    }
  }, intervalMs);

  // Never keep the process alive just for the heartbeat.
  timer.unref();
  logger.info("heartbeat started", { heartbeat_file: filePath, interval_ms: intervalMs });

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
