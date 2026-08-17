import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import { HANDOFF_WINDOW_START_MS, type PostJob } from "@/core/domain/post-job";
import type { Clock, LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { EnqueueOptions, JobQueue } from "@/core/ports/job-queue";
import type {
  ApplyTransitionInput,
  OverdueScanQuery,
  PostJobRepo,
  StaleScanQuery,
} from "@/core/ports/post-job-repo";
import type { ChannelConfigRepo } from "@/core/ports/publisher";

import { channelWriteStubs } from "./__fixtures__/channel-config-repo";

import {
  DEFAULT_OVERDUE_QUEUED_MS,
  DEFAULT_PUBLISHING_STALE_MS,
  REAPER_FAILED_AUDIT_ACTION,
  REAPER_REQUEUED_AUDIT_ACTION,
  makeReapPostJobs,
} from "./reap-post-jobs";

/**
 * The safety net. Two rules dominate every test here:
 *   - a job stuck in `publishing` is NEVER republished (business rule 4);
 *   - anything the reaper touches goes through the optimistic guard, so a live
 *     worker always wins the race.
 */

const TENANT = "00000000-0000-0000-0000-000000000001";
const NOW = Date.parse("2026-08-13T02:00:00.000Z");
const CLOCK: Clock = { now: () => new Date(NOW), nowMs: () => NOW };

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

function makeJob(overrides: Partial<PostJob> = {}): PostJob {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    tenantId: TENANT,
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "TÍM",
    channelId: "fbpage-a",
    format: "image_post",
    status: "publishing",
    attemptCount: 1,
    lastErrorCode: null,
    lastErrorMessage: null,
    publishedPostId: null,
    publishedUrl: null,
    publishedAt: null,
    scheduledPostId: null,
    captionText: "caption",
    media: [{ driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" }],
    scheduledAt: null,
    queueJobId: null,
    ...overrides,
  };
}

interface RepoOptions {
  stale?: PostJob[];
  overdue?: PostJob[];
  rejectTransition?: boolean;
  rejectSetQueueId?: boolean;
  transitionThrows?: boolean;
}

function makeRepo(options: RepoOptions = {}) {
  const transitions: ApplyTransitionInput[] = [];
  const queueIdWrites: Array<{ queueJobId: string | null; auditAction?: string }> = [];
  const scans: { stale: StaleScanQuery[]; overdue: OverdueScanQuery[] } = { stale: [], overdue: [] };
  const repo: PostJobRepo & {
    transitions: ApplyTransitionInput[];
    queueIdWrites: typeof queueIdWrites;
    scans: typeof scans;
    refreshCalls: string[];
  } = {
    transitions,
    queueIdWrites,
    scans,
    refreshCalls: [],
    async createBatchWithJobs() {
      throw new Error("not used");
    },
    async findJobById() {
      return null;
    },
    async listJobsByBatch() {
      return [];
    },
    async listJobs() {
      return { items: [], nextCursor: null };
    },
    async applyTransition(input) {
      transitions.push(input);
      if (options.transitionThrows) throw new AppError("DB_ERROR", { message: "db down" });
      if (options.rejectTransition) return null;
      return input.next;
    },
    async setQueueJobId(input) {
      queueIdWrites.push({ queueJobId: input.queueJobId, auditAction: input.auditAction });
      return !options.rejectSetQueueId;
    },
    async rescheduleJob() {
      return null;
    },
    async listScheduledJobs() {
      return { items: [], nextCursor: null };
    },
    async findStalePublishing(query) {
      scans.stale.push(query);
      return options.stale ?? [];
    },
    async findOverdueQueued(query) {
      scans.overdue.push(query);
      return options.overdue ?? [];
    },
    async findScheduledOnPlatformDue() {
      return [];
    },
    async findLastPublishedAt() {
      return null;
    },
    async refreshBatchStatus(_tenantId, batchId) {
      repo.refreshCalls.push(batchId);
      return {
        batchId,
        tenantId: TENANT,
        productCode: "MGKVX6310",
        status: "failed" as const,
        total: 1,
        byStatus: {
          draft: 0,
          queued: 0,
          publishing: 0,
          scheduled_on_facebook: 0,
          published: 0,
          failed: 1,
          blocked: 0,
        },
        startedAt: new Date(NOW),
        finishedAt: new Date(NOW),
        jobs: [],
      };
    },
    async getBatchSummary() {
      return null;
    },
  };
  return repo;
}

function makeQueue(options: { present?: boolean; enqueueFails?: boolean } = {}) {
  const enqueued: Array<{ payload: unknown; opts?: EnqueueOptions }> = [];
  const asked: string[] = [];
  const queue: JobQueue & { enqueued: typeof enqueued; asked: string[] } = {
    enqueued,
    asked,
    async enqueue(_name, payload, opts) {
      if (options.enqueueFails) throw new AppError("QUEUE_ERROR", { message: "redis down" });
      enqueued.push({ payload, opts });
      return { jobId: opts?.jobId ?? "generated" };
    },
    async remove() {
      return true;
    },
    async has(jobId) {
      asked.push(jobId);
      return options.present ?? false;
    },
    async enqueueRepeatable() {
      return { jobId: "repeatable" };
    },
    async close() {},
  };
  return queue;
}

const CHANNELS: ChannelConfigRepo = {
  findChannel: async () => null,
  listChannels: async () => [],
  getPublishSettings: async () => ({ spacingMs: 0, retryBackoffMs: 1_000, maxAttempts: 3 }),
  ...channelWriteStubs(),
};

function harness(repoOptions: RepoOptions = {}, queueOptions: { present?: boolean; enqueueFails?: boolean } = {}) {
  const lines: LogLine[] = [];
  const repo = makeRepo(repoOptions);
  const queue = makeQueue(queueOptions);
  const reapPostJobs = makeReapPostJobs({
    postJobs: repo,
    queue,
    channels: CHANNELS,
    clock: CLOCK,
    logger: recordingLogger(lines),
  });
  return { reapPostJobs, repo, queue, lines };
}

// --- Edge cases first -------------------------------------------------------

describe("reapPostJobs — a quiet sweep", () => {
  it("reports zero and still logs, so a silent reaper is visible", async () => {
    const { reapPostJobs, lines } = harness();

    const result = await reapPostJobs();

    expect(result).toMatchObject({
      scannedStalePublishing: 0,
      scannedOverdueQueued: 0,
      failed: 0,
      requeued: 0,
      skipped: 0,
    });
    const line = lines.find((entry) => entry.message === "Reaper sweep finished");
    expect(line?.level).toBe("info");
    // No alert when there was nothing to do.
    expect(line?.context?.alert).toBeUndefined();
  });

  it("uses the documented default thresholds", async () => {
    const { reapPostJobs, repo } = harness();
    await reapPostJobs();
    expect(repo.scans.stale[0].olderThan.getTime()).toBe(NOW - DEFAULT_PUBLISHING_STALE_MS);
    // E8.6: "overdue" is measured from the moment the job should have WOKEN UP
    // (T-30), not from T — a lost entry must be found while the handoff is
    // still possible.
    expect(repo.scans.overdue[0].dueBefore.getTime()).toBe(
      NOW - DEFAULT_OVERDUE_QUEUED_MS + HANDOFF_WINDOW_START_MS,
    );
  });

  it("accepts per-run overrides and ignores nonsense ones", async () => {
    const { reapPostJobs, repo } = harness();
    await reapPostJobs({ publishingStaleMs: 60_000, overdueQueuedMs: 0, limit: -5 });
    expect(repo.scans.stale[0].olderThan.getTime()).toBe(NOW - 60_000);
    // 0 and -5 fall back to the defaults instead of scanning "everything".
    expect(repo.scans.overdue[0].dueBefore.getTime()).toBe(
      NOW - DEFAULT_OVERDUE_QUEUED_MS + HANDOFF_WINDOW_START_MS,
    );
    expect(repo.scans.stale[0].limit).toBe(50);
  });
});

// --- (a) stuck in publishing ------------------------------------------------

describe("reapPostJobs — jobs stuck in `publishing`", () => {
  it("marks them failed and NEVER republishes", async () => {
    const stuck = makeJob();
    const { reapPostJobs, repo, queue, lines } = harness({ stale: [stuck] });

    const result = await reapPostJobs();

    expect(result.failed).toBe(1);
    expect(queue.enqueued).toHaveLength(0);
    expect(repo.transitions[0]).toMatchObject({
      from: "publishing",
      reason: "PUBLISHING_STALE",
      auditAction: REAPER_FAILED_AUDIT_ACTION,
    });
    expect(repo.transitions[0].next).toMatchObject({
      status: "failed",
      lastErrorCode: "PUBLISH_FAILED",
    });
    expect(repo.transitions[0].next.lastErrorMessage).toContain("Chạy lại");
    expect(repo.refreshCalls).toEqual(["batch-1"]);
    expect(
      lines.some((line) => line.level === "error" && line.context?.alert === "OPERATOR_ATTENTION"),
    ).toBe(true);
  });

  it("leaves a job that finished during the sweep alone", async () => {
    const { reapPostJobs, repo } = harness({ stale: [makeJob()], rejectTransition: true });
    const result = await reapPostJobs();
    expect(result).toMatchObject({ failed: 0, skipped: 1 });
    expect(repo.refreshCalls).toEqual([]);
  });

  it("keeps sweeping when one row cannot be reaped", async () => {
    const { reapPostJobs, lines } = harness({
      stale: [makeJob({ id: "job-a" }), makeJob({ id: "job-b" })],
      transitionThrows: true,
    });

    const result = await reapPostJobs();

    expect(result).toMatchObject({ scannedStalePublishing: 2, failed: 0, skipped: 2 });
    expect(lines.filter((line) => line.context?.reason === "REAP_FAILED")).toHaveLength(2);
  });
});

// --- (b) overdue queued -----------------------------------------------------

describe("reapPostJobs — overdue scheduled jobs", () => {
  const overdueJob = makeJob({
    status: "queued",
    attemptCount: 0,
    scheduledAt: new Date(NOW - 30 * 60_000),
    queueJobId: "pp.lost-entry",
  });

  it("re-enqueues one whose queue entry is gone, with an audit action", async () => {
    const { reapPostJobs, repo, queue } = harness({ overdue: [overdueJob] }, { present: false });

    const result = await reapPostJobs();

    expect(result.requeued).toBe(1);
    expect(queue.asked).toEqual(["pp.lost-entry"]);
    // New id, stored BEFORE the enqueue, with the reaper's audit action.
    expect(repo.queueIdWrites[0].auditAction).toBe(REAPER_REQUEUED_AUDIT_ACTION);
    expect(queue.enqueued[0].opts?.jobId).toBe(repo.queueIdWrites[0].queueJobId);
    expect(queue.enqueued[0].payload).toEqual({ tenantId: TENANT, postJobId: overdueJob.id });
    expect(queue.enqueued[0].opts?.attempts).toBe(3);
  });

  it("leaves a job whose entry is still there — a second entry means a second run", async () => {
    const { reapPostJobs, repo, queue } = harness({ overdue: [overdueJob] }, { present: true });

    const result = await reapPostJobs();

    expect(result).toMatchObject({ requeued: 0, skipped: 1 });
    expect(queue.enqueued).toHaveLength(0);
    expect(repo.queueIdWrites).toHaveLength(0);
  });

  it("re-enqueues a job that never stored a queue id (nothing to check)", async () => {
    const { reapPostJobs, queue } = harness(
      { overdue: [makeJob({ status: "queued", scheduledAt: new Date(NOW - 60_000) })] },
      { present: true },
    );
    const result = await reapPostJobs();
    expect(result.requeued).toBe(1);
    expect(queue.asked).toEqual([]);
  });

  it("stops when a worker claimed the row during the sweep", async () => {
    const { reapPostJobs, queue } = harness(
      { overdue: [overdueJob], rejectSetQueueId: true },
      { present: false },
    );
    const result = await reapPostJobs();
    expect(result).toMatchObject({ requeued: 0, skipped: 1 });
    expect(queue.enqueued).toHaveLength(0);
  });

  it("puts the queue id back when the enqueue fails", async () => {
    const { reapPostJobs, repo, lines } = harness(
      { overdue: [overdueJob] },
      { present: false, enqueueFails: true },
    );

    const result = await reapPostJobs();

    expect(result).toMatchObject({ requeued: 0, skipped: 1 });
    // Second write restores the previous id so the row claims nothing false.
    expect(repo.queueIdWrites).toHaveLength(2);
    expect(repo.queueIdWrites[1].queueJobId).toBe("pp.lost-entry");
    expect(
      lines.some((line) => line.level === "error" && line.context?.reason === "REQUEUE_FAILED"),
    ).toBe(true);
  });

  it("reads publish settings ONCE per tenant, not once per job", async () => {
    let reads = 0;
    const channels: ChannelConfigRepo = {
      findChannel: async () => null,
      listChannels: async () => [],
      getPublishSettings: async () => {
        reads += 1;
        return { spacingMs: 0, retryBackoffMs: 1_000, maxAttempts: 3 };
      },
      ...channelWriteStubs(),
    };
    const repo = makeRepo({
      overdue: [
        makeJob({ id: "job-a", status: "queued", scheduledAt: new Date(NOW - 60_000) }),
        makeJob({ id: "job-b", status: "queued", scheduledAt: new Date(NOW - 60_000) }),
      ],
    });
    const reapPostJobs = makeReapPostJobs({
      postJobs: repo,
      queue: makeQueue({ present: false }),
      channels,
      clock: CLOCK,
      logger: recordingLogger([]),
    });

    const result = await reapPostJobs();

    expect(result.requeued).toBe(2);
    expect(reads).toBe(1);
  });
});
