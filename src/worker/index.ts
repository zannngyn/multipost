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
import {
  HEALTHCHECK_TENANT_JOB_NAME,
  makeHealthcheckTenantHandler,
} from "./jobs/healthcheck-tenant-job";
import { PUBLISH_POST_JOB_NAME, makePublishPostHandler } from "./jobs/publish-post-job";

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

/** Drain order: stop taking new jobs, let active ones finish, then close I/O. */
async function drain(): Promise<"drained"> {
  heartbeat?.stop();
  if (consumer) await consumer.close();
  await container?.close();
  return "drained";
}

/**
 * Graceful shutdown WITH a deadline. Without one a job stuck on an external call
 * would hold the process until Docker's SIGKILL — no log, no explanation.
 * Past the deadline we exit non-zero and say so; connections die with the process.
 */
async function shutdown(signal: string): Promise<void> {
  if (closing) return; // Second Ctrl+C: ignore, the first drain is still running.
  closing = true;
  const log = logger;
  const deadlineMs = container?.config.WORKER_SHUTDOWN_DEADLINE_MS ?? 30_000;
  const startedAt = Date.now();
  log?.info("shutdown requested", { signal, deadline_ms: deadlineMs });

  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    deadlineTimer = setTimeout(() => resolve("deadline"), deadlineMs);
  });

  try {
    const outcome = await Promise.race([drain(), deadline]);
    clearTimeout(deadlineTimer);

    if (outcome === "deadline") {
      log?.error("shutdown deadline exceeded — forcing exit", {
        signal,
        deadline_ms: deadlineMs,
        duration_ms: Date.now() - startedAt,
        exit_code: 1,
        reason: "drain did not finish in time (job still active or broker unreachable)",
      });
      process.exit(1);
    }

    log?.info("worker stopped cleanly", {
      signal,
      duration_ms: Date.now() - startedAt,
      exit_code: 0,
    });
    process.exit(0);
  } catch (error) {
    clearTimeout(deadlineTimer);
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

  // Handler map: one entry per job name.
  const handlers = {
    [ECHO_JOB_NAME]: makeEchoHandler(logger),
    [HEALTHCHECK_TENANT_JOB_NAME]: makeHealthcheckTenantHandler({
      logger,
      healthcheckTenant: deps.usecases.healthcheckTenant,
    }),
    [PUBLISH_POST_JOB_NAME]: makePublishPostHandler({
      logger,
      publishPost: deps.usecases.publishPost,
    }),
  };
  consumer = deps.startConsumer(handlers);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("worker ready", {
    job_names: Object.keys(handlers),
    shutdown_deadline_ms: deps.config.WORKER_SHUTDOWN_DEADLINE_MS,
  });
}

main().catch((error: unknown) => {
  logFatal("worker failed to start", error);
  process.exit(1);
});
