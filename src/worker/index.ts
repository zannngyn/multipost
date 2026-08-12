/**
 * Worker entrypoint. Thin by design (docs/07 section 2): it wires process-level
 * error handling, pulls dependencies from the composition root and registers job
 * handlers. All business logic lives in core usecases.
 *
 * Startup order matters: process guards are installed BEFORE anything that can
 * throw asynchronously, so a crash during boot is still logged as JSON.
 */

import {
  makeWorkerContainer,
  type JobConsumer,
  type Logger,
  type WorkerContainer,
} from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

import { startHeartbeat, type HeartbeatHandle } from "./heartbeat";
import { ECHO_JOB_NAME, makeEchoHandler } from "./jobs/echo-job";

let logger: Logger | null = null;
let container: WorkerContainer | null = null;
let consumer: JobConsumer | null = null;
let heartbeat: HeartbeatHandle | null = null;
let closing = false;

/** Logs before the container (and pino) exists — stderr JSON, same shape-ish. */
function logFatal(message: string, error: unknown): void {
  const appError = AppError.from(error, "INTERNAL");
  if (logger) {
    logger.error(message, { err: appError });
    return;
  }
  process.stderr.write(
    `${JSON.stringify({
      level: "fatal",
      time: new Date().toISOString(),
      service: "mysp-worker",
      msg: message,
      err: appError.toLogObject(),
    })}\n`,
  );
}

// --- Process-level guards (CLAUDE.md #4) ------------------------------------
// An unhandled rejection/exception leaves the process in an unknown state:
// log with stack, then exit(1) so Docker restarts a clean one.
process.on("unhandledRejection", (reason: unknown) => {
  logFatal("unhandledRejection — exiting", reason);
  process.exit(1);
});

process.on("uncaughtException", (error: unknown) => {
  logFatal("uncaughtException — exiting", error);
  process.exit(1);
});

async function shutdown(signal: string): Promise<void> {
  if (closing) return; // Second Ctrl+C: ignore, the first drain is still running.
  closing = true;
  const log = logger;
  log?.info("shutdown requested", { signal });

  try {
    heartbeat?.stop();
    // Close the consumer first: stop taking new jobs, let active ones finish.
    if (consumer) await consumer.close();
    await container?.close();
    log?.info("worker stopped cleanly", { signal });
    process.exit(0);
  } catch (error) {
    logFatal("shutdown failed", error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const deps = makeWorkerContainer();
  container = deps;
  logger = deps.logger;

  logger.info("worker starting", {
    node_version: process.version,
    pid: process.pid,
    concurrency: deps.config.WORKER_CONCURRENCY,
  });

  heartbeat = startHeartbeat({
    filePath: deps.config.WORKER_HEARTBEAT_FILE,
    intervalMs: deps.config.WORKER_HEARTBEAT_INTERVAL_MS,
    logger,
  });

  // Handler map: one entry per job name. Real jobs land in E5 (publish-post).
  consumer = deps.startConsumer({
    [ECHO_JOB_NAME]: makeEchoHandler(logger),
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("worker ready", { job_names: [ECHO_JOB_NAME] });
}

main().catch((error: unknown) => {
  logFatal("worker failed to start", error);
  process.exit(1);
});
