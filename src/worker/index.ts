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
import {
  CLEANUP_UPLOADS_JOB_NAME,
  CLEANUP_UPLOADS_SCHEDULER_ID,
  makeCleanupUploadsHandler,
} from "./jobs/cleanup-uploads-job";
import {
  CLEANUP_MEDIA_CACHE_JOB_NAME,
  CLEANUP_MEDIA_CACHE_SCHEDULER_ID,
  makeCleanupMediaCacheHandler,
} from "./jobs/cleanup-media-cache-job";
import { PUBLISH_POST_JOB_NAME, makePublishPostHandler } from "./jobs/publish-post-job";
import {
  REAP_POST_JOBS_JOB_NAME,
  REAP_POST_JOBS_SCHEDULER_ID,
  makeReapPostJobsHandler,
} from "./jobs/reap-post-jobs-job";
import { loadReaperConfig } from "./reaper-schedule";

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
    [REAP_POST_JOBS_JOB_NAME]: makeReapPostJobsHandler({
      logger,
      reapPostJobs: deps.usecases.reapPostJobs,
    }),
    [CLEANUP_UPLOADS_JOB_NAME]: makeCleanupUploadsHandler({
      logger,
      cleanupUploads: deps.usecases.cleanupUploads,
    }),
    [CLEANUP_MEDIA_CACHE_JOB_NAME]: makeCleanupMediaCacheHandler({
      logger,
      cleanupMediaCache: deps.usecases.cleanupMediaCache,
    }),
  };
  consumer = deps.startConsumer(handlers);

  // The periodic sweep is declared AFTER the consumer exists, so the first tick
  // has somewhere to run. `upsertJobScheduler` is idempotent: N worker replicas
  // (or N restarts) still mean ONE schedule.
  const reaperConfig = loadReaperConfig();
  await deps.queue.enqueueRepeatable({
    schedulerId: REAP_POST_JOBS_SCHEDULER_ID,
    jobName: REAP_POST_JOBS_JOB_NAME,
    everyMs: reaperConfig.WORKER_REAPER_INTERVAL_MS,
    payload: {
      publishingStaleMs: reaperConfig.WORKER_PUBLISHING_STALE_MS,
      overdueQueuedMs: reaperConfig.WORKER_OVERDUE_QUEUED_MS,
      limit: reaperConfig.WORKER_REAPER_LIMIT,
    },
    attempts: 1,
  });

  // E9.4 — hourly, not every 5 minutes: it only ever removes files older than a
  // day, so a faster tick would just re-scan the same rows.
  await deps.queue.enqueueRepeatable({
    schedulerId: CLEANUP_UPLOADS_SCHEDULER_ID,
    jobName: CLEANUP_UPLOADS_JOB_NAME,
    everyMs: 60 * 60_000,
    payload: {},
    attempts: 1,
  });

  // E3.6 — hourly for the same reason: the cache TTL is measured in days, so a
  // faster tick would only re-walk the same files. It needs the cache volume
  // mounted at MEDIA_CACHE_ROOT, the same path the web process writes to.
  await deps.queue.enqueueRepeatable({
    schedulerId: CLEANUP_MEDIA_CACHE_SCHEDULER_ID,
    jobName: CLEANUP_MEDIA_CACHE_JOB_NAME,
    everyMs: 60 * 60_000,
    payload: {},
    attempts: 1,
  });

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("worker ready", {
    job_names: Object.keys(handlers),
    shutdown_deadline_ms: deps.config.WORKER_SHUTDOWN_DEADLINE_MS,
    reaper_interval_ms: reaperConfig.WORKER_REAPER_INTERVAL_MS,
    publishing_stale_ms: reaperConfig.WORKER_PUBLISHING_STALE_MS,
    overdue_queued_ms: reaperConfig.WORKER_OVERDUE_QUEUED_MS,
  });
}

main().catch((error: unknown) => {
  logFatal("worker failed to start", error);
  process.exit(1);
});
