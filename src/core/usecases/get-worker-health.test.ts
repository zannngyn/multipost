import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { Clock, LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { QueueWorkerCensus, QueueWorkerRegistry } from "@/core/ports/job-queue";
import type {
  UntouchedQueuedJobs,
  UntouchedQueuedQuery,
  UntouchedQueuedRepo,
} from "@/core/ports/post-job-repo";

import { makeGetWorkerHealth } from "./get-worker-health";

/**
 * E11 worker-health probe. The ONE invariant every test here defends: this
 * usecase never throws — a dead Redis and a dead database are precisely what it
 * has to report, so an exception would break the screen that shows the outage.
 *
 * The scheduled-vs-due filtering is SQL and lives in
 * post-job-repo.untouched-queued.integration.test.ts; what is checked here is
 * that the usecase hands the repo the instant it needs to do it.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-17T10:00:00.000Z");

interface LogLine {
  level: string;
  message: string;
  context?: LogContext;
}

function recordingLogger(lines: LogLine[]): Logger {
  const make = (): Logger => ({
    child: (_bindings: LogBindings) => make(),
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  });
  return make();
}

const clock: Clock = { now: () => new Date(NOW), nowMs: () => NOW.getTime() };

function makeHarness(options: {
  census?: QueueWorkerCensus;
  censusThrows?: unknown;
  untouched?: UntouchedQueuedJobs;
  repoThrows?: unknown;
}) {
  const lines: LogLine[] = [];
  const queries: UntouchedQueuedQuery[] = [];

  const workers: QueueWorkerRegistry = {
    async countWorkers() {
      if (options.censusThrows) throw options.censusThrows;
      return options.census ?? { workersOnline: 0, reachable: true };
    },
  };

  const postJobs: UntouchedQueuedRepo = {
    async countUntouchedQueued(query) {
      queries.push(query);
      if (options.repoThrows) throw options.repoThrows;
      return options.untouched ?? { count: 0, oldestWaitingSince: null };
    },
  };

  return {
    lines,
    queries,
    getWorkerHealth: makeGetWorkerHealth({
      workers,
      postJobs,
      clock,
      logger: recordingLogger(lines),
    }),
  };
}

// --- Edge cases first -------------------------------------------------------

describe("getWorkerHealth — failures never escape", () => {
  it("reports queueReachable=false instead of throwing when Redis is down", async () => {
    const harness = makeHarness({
      censusThrows: new AppError("QUEUE_ERROR", { message: "connect ECONNREFUSED" }),
      untouched: { count: 4, oldestWaitingSince: new Date(NOW.getTime() - 60_000) },
    });

    const health = await harness.getWorkerHealth({ tenantId: TENANT });

    expect(health.queueReachable).toBe(false);
    expect(health.workersOnline).toBe(0);
    // The DB half still answers: the operator sees WHAT is stuck, not just that
    // the broker is unreachable.
    expect(health.untouchedQueuedJobs).toBe(4);
    expect(health.oldestUntouchedWaitMs).toBe(60_000);
    expect(
      harness.lines.some(
        (line) => line.level === "warn" && line.context?.reason === "WORKER_CENSUS_FAILED",
      ),
    ).toBe(true);
  });

  it("passes an adapter's `reachable: false` through as the alert it is", async () => {
    const harness = makeHarness({ census: { workersOnline: 0, reachable: false } });

    const health = await harness.getWorkerHealth({ tenantId: TENANT });

    expect(health).toMatchObject({ queueReachable: false, workersOnline: 0 });
  });

  it("keeps reporting the queue when counting jobs fails, and never throws", async () => {
    const harness = makeHarness({
      census: { workersOnline: 2, reachable: true },
      repoThrows: new AppError("DB_ERROR", { message: "connection terminated" }),
    });

    const health = await harness.getWorkerHealth({ tenantId: TENANT });

    expect(health).toMatchObject({
      workersOnline: 2,
      queueReachable: true,
      untouchedQueuedJobs: 0,
      oldestUntouchedWaitMs: null,
    });
    expect(
      harness.lines.some(
        (line) =>
          line.level === "warn" && line.context?.reason === "UNTOUCHED_QUEUED_COUNT_FAILED",
      ),
    ).toBe(true);
  });

  it("survives a non-Error thrown by a faulty adapter", async () => {
    const harness = makeHarness({ censusThrows: "redis exploded" });
    await expect(harness.getWorkerHealth({ tenantId: TENANT })).resolves.toMatchObject({
      queueReachable: false,
    });
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["not-a-uuid", "malformed"],
  ])("does not query jobs for a %s tenant id, and still does not throw", async (tenantId) => {
    const harness = makeHarness({ census: { workersOnline: 1, reachable: true } });

    const health = await harness.getWorkerHealth({ tenantId });

    expect(harness.queries).toHaveLength(0);
    expect(health).toMatchObject({
      workersOnline: 1,
      queueReachable: true,
      untouchedQueuedJobs: 0,
      oldestUntouchedWaitMs: null,
    });
    expect(
      harness.lines.some(
        (line) => line.level === "warn" && line.context?.error_code === "INVALID_INPUT",
      ),
    ).toBe(true);
  });

  it("treats a garbage worker count as unknown rather than fabricating one", async () => {
    const harness = makeHarness({
      census: { workersOnline: Number.NaN, reachable: true } as QueueWorkerCensus,
    });

    const health = await harness.getWorkerHealth({ tenantId: TENANT });

    expect(health).toMatchObject({ workersOnline: 0, queueReachable: false });
  });

  it("clamps a negative wait (clock skew) to zero", async () => {
    const harness = makeHarness({
      census: { workersOnline: 0, reachable: true },
      untouched: { count: 1, oldestWaitingSince: new Date(NOW.getTime() + 5_000) },
    });

    const health = await harness.getWorkerHealth({ tenantId: TENANT });

    expect(health.oldestUntouchedWaitMs).toBe(0);
  });

  it("reports no wait when the repo counts jobs but gives no instant", async () => {
    const harness = makeHarness({
      census: { workersOnline: 0, reachable: true },
      untouched: { count: 2, oldestWaitingSince: null },
    });

    const health = await harness.getWorkerHealth({ tenantId: TENANT });

    expect(health).toMatchObject({ untouchedQueuedJobs: 2, oldestUntouchedWaitMs: null });
  });
});

// --- Happy path -------------------------------------------------------------

describe("getWorkerHealth — normal answers", () => {
  it("reports a healthy queue with nothing waiting", async () => {
    const harness = makeHarness({ census: { workersOnline: 1, reachable: true } });

    const health = await harness.getWorkerHealth({ tenantId: TENANT });

    expect(health).toEqual({
      workersOnline: 1,
      queueReachable: true,
      untouchedQueuedJobs: 0,
      oldestUntouchedWaitMs: null,
      checkedAt: NOW,
    });
  });

  it("hands the repo the tenant and the instant that separates due from planned", async () => {
    const harness = makeHarness({ census: { workersOnline: 0, reachable: true } });

    await harness.getWorkerHealth({ tenantId: `  ${TENANT}  ` });

    expect(harness.queries).toEqual([{ tenantId: TENANT, now: NOW }]);
  });

  it("warns in the log when jobs wait and no worker is online", async () => {
    const harness = makeHarness({
      census: { workersOnline: 0, reachable: true },
      untouched: { count: 5, oldestWaitingSince: new Date(NOW.getTime() - 20 * 60_000) },
    });

    const health = await harness.getWorkerHealth({ tenantId: TENANT });

    expect(health).toMatchObject({
      workersOnline: 0,
      queueReachable: true,
      untouchedQueuedJobs: 5,
      oldestUntouchedWaitMs: 20 * 60_000,
    });
    const warning = harness.lines.find(
      (line) => line.level === "warn" && line.context?.untouched_queued_jobs === 5,
    );
    expect(warning?.context).toMatchObject({ workers_online: 0, queue_reachable: true });
  });

  it("stays quiet (debug only) while workers are online", async () => {
    const harness = makeHarness({
      census: { workersOnline: 2, reachable: true },
      untouched: { count: 3, oldestWaitingSince: new Date(NOW.getTime() - 1_000) },
    });

    await harness.getWorkerHealth({ tenantId: TENANT });

    expect(harness.lines.some((line) => line.level === "warn")).toBe(false);
    expect(harness.lines.some((line) => line.level === "debug")).toBe(true);
  });
});
