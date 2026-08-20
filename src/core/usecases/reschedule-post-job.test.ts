import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import {
  HANDOFF_WINDOW_START_MS,
  MAX_SCHEDULE_AHEAD_MS,
  type PostJob,
  type PostJobStatus,
} from "@/core/domain/post-job";
import type { Clock, LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { EnqueueOptions, JobQueue } from "@/core/ports/job-queue";
import type { PostJobRepo, RescheduleJobInput } from "@/core/ports/post-job-repo";
import type { ChannelConfigRepo } from "@/core/ports/publisher";

import { channelWriteStubs } from "./__fixtures__/channel-config-repo";

import { makeReschedulePostJob } from "./reschedule-post-job";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/** E8.4 "đổi giờ": what may move, in which order, and what happens on failure. */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const JOB_ID = "11111111-1111-1111-1111-111111111111";
const NOW = Date.parse("2026-08-13T02:00:00.000Z");
const SCHEDULED_AT = new Date(NOW + 3 * 60 * 60 * 1000);
const NEW_AT = new Date(NOW + 6 * 60 * 60 * 1000);

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

const CLOCK: Clock = { now: () => new Date(NOW), nowMs: () => NOW };

function makeJob(overrides: Partial<PostJob> = {}): PostJob {
  return {
    id: JOB_ID,
    tenantId: TENANT,
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "TÍM",
    channelId: "fbpage-a",
    format: "image_post",
    status: "queued",
    attemptCount: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
    publishedPostId: null,
    publishedUrl: null,
    publishedAt: null,
    scheduledPostId: null,
    captionText: "caption",
    media: [{ driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" }],
    scheduledAt: SCHEDULED_AT,
    queueJobId: "pp.old-entry",
    ...overrides,
  };
}

function makeRepo(job: PostJob | null, options: { rejectReschedule?: boolean } = {}) {
  const calls: RescheduleJobInput[] = [];
  let current = job;
  const repo: PostJobRepo & { calls: RescheduleJobInput[]; get(): PostJob | null } = {
    calls,
    get: () => current,
    async createBatchWithJobs() {
      throw new Error("not used");
    },
    async findJobById() {
      return current;
    },
    async listJobsByBatch() {
      return current ? [current] : [];
    },
    async listJobs() {
      return { items: [], nextCursor: null };
    },
    async applyTransition() {
      throw new Error("reschedule must not change the status");
    },
    async setQueueJobId() {
      return true;
    },
    async rescheduleJob(input) {
      calls.push(input);
      if (options.rejectReschedule || !current || current.status !== "queued") return null;
      current = { ...current, scheduledAt: input.scheduledAt, queueJobId: input.queueJobId };
      return current;
    },
    async listScheduledJobs() {
      return { items: [], nextCursor: null };
    },
    async findStalePublishing() {
      return [];
    },
    async findOverdueQueued() {
      return [];
    },
    async findScheduledOnPlatformDue() {
      return [];
    },
    async findLastPublishedAt() {
      return null;
    },
    async refreshBatchStatus() {
      throw new Error("not used");
    },
    async getBatchSummary() {
      return null;
    },
    // E7.5 progress milestones: not what this file is about, but the port
    // requires the method, and a fake that throws would hide a real regression.
    async appendJobEvent() {},
  };
  return repo;
}

function makeQueue(options: { enqueueFails?: boolean; removeFails?: boolean; removed?: boolean } = {}) {
  const enqueued: Array<{ opts?: EnqueueOptions }> = [];
  const removedIds: string[] = [];
  const queue: JobQueue & { enqueued: typeof enqueued; removedIds: string[] } = {
    enqueued,
    removedIds,
    async enqueue(_name, _payload, opts) {
      if (options.enqueueFails) throw new AppError("QUEUE_ERROR", { message: "redis down" });
      enqueued.push({ opts });
      return { jobId: opts?.jobId ?? "generated" };
    },
    async remove(jobId) {
      removedIds.push(jobId);
      if (options.removeFails) throw new AppError("QUEUE_ERROR", { message: "redis down" });
      return options.removed ?? true;
    },
    async has() {
      return true;
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

function harness(
  job: PostJob | null,
  options: {
    rejectReschedule?: boolean;
    enqueueFails?: boolean;
    removeFails?: boolean;
    removed?: boolean;
  } = {},
) {
  const lines: LogLine[] = [];
  const repo = makeRepo(job, { rejectReschedule: options.rejectReschedule });
  const queue = makeQueue(options);
  const reschedulePostJob = makeReschedulePostJob({
    postJobs: repo,
    channels: CHANNELS,
    queue,
    clock: CLOCK,
    logger: recordingLogger(lines),
  });
  return { reschedulePostJob, repo, queue, lines };
}

// --- Edge cases first -------------------------------------------------------

describe("reschedulePostJob — refusals", () => {
  it("rejects a malformed identity", async () => {
    const { reschedulePostJob } = harness(makeJob());
    await expect(
      reschedulePostJob({ tenantId: testTenantId("nope"), postJobId: JOB_ID, newScheduledAt: NEW_AT }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it.each([
    ["a time in the past", new Date(NOW - 1_000), "IN_THE_PAST"],
    ["now", new Date(NOW), "IN_THE_PAST"],
    ["beyond the window", new Date(NOW + MAX_SCHEDULE_AHEAD_MS + 60_000), "TOO_FAR_AHEAD"],
    ["gibberish", "khong-phai-ngay", "NOT_A_DATE"],
  ])("rejects %s", async (_label, value, reason) => {
    const { reschedulePostJob, repo, queue } = harness(makeJob());
    await expect(
      reschedulePostJob({
        tenantId: TENANT,
        postJobId: JOB_ID,
        newScheduledAt: value as Date | string,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason } });
    expect(repo.calls).toHaveLength(0);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("reports a job that does not exist", async () => {
    const { reschedulePostJob } = harness(null);
    await expect(
      reschedulePostJob({ tenantId: TENANT, postJobId: JOB_ID, newScheduledAt: NEW_AT }),
    ).rejects.toMatchObject({ context: { reason: "POST_JOB_NOT_FOUND" } });
  });

  it.each(["published", "publishing", "blocked", "failed", "draft"] as PostJobStatus[])(
    "refuses a %s job",
    async (status) => {
      const { reschedulePostJob, repo } = harness(makeJob({ status }));
      await expect(
        reschedulePostJob({ tenantId: TENANT, postJobId: JOB_ID, newScheduledAt: NEW_AT }),
      ).rejects.toMatchObject({ code: "INVALID_JOB_TRANSITION", context: { reason: "NOT_QUEUED" } });
      expect(repo.calls).toHaveLength(0);
    },
  );

  it("refuses a job that publishes immediately (no hour to move)", async () => {
    const { reschedulePostJob } = harness(makeJob({ scheduledAt: null }));
    await expect(
      reschedulePostJob({ tenantId: TENANT, postJobId: JOB_ID, newScheduledAt: NEW_AT }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "NOT_SCHEDULED" } });
  });

  it("refuses once the scheduled hour has come — a worker may already have it", async () => {
    const { reschedulePostJob, queue } = harness(makeJob({ scheduledAt: new Date(NOW - 1) }));
    await expect(
      reschedulePostJob({ tenantId: TENANT, postJobId: JOB_ID, newScheduledAt: NEW_AT }),
    ).rejects.toMatchObject({ context: { reason: "SCHEDULE_ALREADY_DUE" } });
    expect(queue.enqueued).toHaveLength(0);
    expect(queue.removedIds).toHaveLength(0);
  });

  it("reports the race when the row left `queued` mid-flight", async () => {
    const { reschedulePostJob, queue } = harness(makeJob(), { rejectReschedule: true });
    await expect(
      reschedulePostJob({ tenantId: TENANT, postJobId: JOB_ID, newScheduledAt: NEW_AT }),
    ).rejects.toMatchObject({
      code: "INVALID_JOB_TRANSITION",
      context: { reason: "CONCURRENT_MODIFICATION" },
    });
    // Nothing queued, nothing removed: the worker owns the job.
    expect(queue.enqueued).toHaveLength(0);
    expect(queue.removedIds).toHaveLength(0);
  });

  it("shouts when the new queue entry cannot be created (the old time may still fire)", async () => {
    const { reschedulePostJob, queue, lines } = harness(makeJob(), { enqueueFails: true });

    await expect(
      reschedulePostJob({ tenantId: TENANT, postJobId: JOB_ID, newScheduledAt: NEW_AT }),
    ).rejects.toMatchObject({ code: "QUEUE_ERROR" });

    expect(queue.removedIds).toHaveLength(0);
    expect(
      lines.some((line) => line.level === "error" && line.context?.alert === "OPERATOR_ATTENTION"),
    ).toBe(true);
  });
});

// --- Happy path -------------------------------------------------------------

describe("reschedulePostJob — move the hour", () => {
  it("stores the new time, queues a NEW entry and drops the old one — in that order", async () => {
    const order: string[] = [];
    const { reschedulePostJob, repo, queue } = harness(makeJob());
    const rescheduleJob = repo.rescheduleJob.bind(repo);
    repo.rescheduleJob = async (input) => {
      order.push("db");
      return rescheduleJob(input);
    };
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = async (name, payload, opts) => {
      order.push("enqueue");
      return enqueue(name, payload, opts);
    };
    const remove = queue.remove.bind(queue);
    queue.remove = async (id) => {
      order.push("remove");
      return remove(id);
    };

    const result = await reschedulePostJob({
      tenantId: TENANT,
      postJobId: JOB_ID,
      newScheduledAt: NEW_AT,
      actorUserId: "user-1",
    });

    expect(order).toEqual(["db", "enqueue", "remove"]);
    expect(result).toMatchObject({
      scheduledAt: NEW_AT,
      previousScheduledAt: SCHEDULED_AT,
      delayMs: 6 * 60 * 60 * 1000,
      previousQueueEntryRemoved: true,
    });
    // A fresh queue id: BullMQ ignores an `add` whose id is still retained.
    expect(result.queueJobId).not.toBe("pp.old-entry");
    expect(queue.enqueued[0].opts?.jobId).toBe(result.queueJobId);
    // E8.6: the entry wakes at T-30 (the handoff window), not at T.
    expect(queue.enqueued[0].opts?.delayMs).toBe(6 * 60 * 60 * 1000 - HANDOFF_WINDOW_START_MS);
    expect(queue.removedIds).toEqual(["pp.old-entry"]);
    expect(repo.calls[0]).toMatchObject({
      scheduledAt: NEW_AT,
      previousScheduledAt: SCHEDULED_AT,
      previousQueueJobId: "pp.old-entry",
      actorUserId: "user-1",
      reason: "OPERATOR_RESCHEDULED",
    });
    expect(repo.get()).toMatchObject({ scheduledAt: NEW_AT, queueJobId: result.queueJobId });
  });

  it("accepts an ISO string from a JSON body", async () => {
    const { reschedulePostJob } = harness(makeJob());
    const result = await reschedulePostJob({
      tenantId: TENANT,
      postJobId: JOB_ID,
      newScheduledAt: NEW_AT.toISOString(),
    });
    expect(result.scheduledAt.toISOString()).toBe(NEW_AT.toISOString());
  });

  it("succeeds (loudly) when the old entry cannot be removed", async () => {
    const { reschedulePostJob, lines } = harness(makeJob(), { removeFails: true });

    const result = await reschedulePostJob({
      tenantId: TENANT,
      postJobId: JOB_ID,
      newScheduledAt: NEW_AT,
    });

    expect(result.previousQueueEntryRemoved).toBe(false);
    expect(
      lines.some((line) => line.level === "error" && line.context?.alert === "OPERATOR_ATTENTION"),
    ).toBe(true);
  });

  it("warns when there is no stored queue id to remove", async () => {
    const { reschedulePostJob, queue, lines } = harness(makeJob({ queueJobId: null }));
    const result = await reschedulePostJob({
      tenantId: TENANT,
      postJobId: JOB_ID,
      newScheduledAt: NEW_AT,
    });
    expect(result.previousQueueEntryRemoved).toBe(false);
    expect(queue.removedIds).toHaveLength(0);
    expect(lines.some((line) => line.context?.reason === "QUEUE_ID_MISSING")).toBe(true);
  });
});
