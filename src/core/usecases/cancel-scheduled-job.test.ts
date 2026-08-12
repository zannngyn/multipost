import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import { deriveBatchStatus, type PostJob, type PostJobStatus } from "@/core/domain/post-job";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { JobQueue } from "@/core/ports/job-queue";
import type {
  ApplyTransitionInput,
  PostBatchSummary,
  PostJobRepo,
} from "@/core/ports/post-job-repo";

import {
  CANCELLED_AUDIT_ACTION,
  CANCELLED_ERROR_CODE,
  MAX_CANCEL_NOTE_LENGTH,
  makeCancelScheduledJob,
} from "./cancel-scheduled-job";

/**
 * E8.4 cancel. The rules under test: the database decides (optimistic guard),
 * a published post is never "cancelled", and a queue removal failure is loud
 * but harmless.
 */

const TENANT = "00000000-0000-0000-0000-000000000001";
const JOB_ID = "11111111-1111-1111-1111-111111111111";
const SCHEDULED_AT = new Date("2026-08-13T09:00:00.000Z");

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
    captionText: "Giannal – MỘT NGÀY DỊU DÀNG",
    media: [{ driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" }],
    scheduledAt: SCHEDULED_AT,
    queueJobId: "pp.job-1.MGKVX6310.T-M.fbpage-a",
    ...overrides,
  };
}

function makeRepo(job: PostJob | null, options: { rejectTransition?: boolean } = {}) {
  const transitions: ApplyTransitionInput[] = [];
  let current = job;
  const repo: PostJobRepo & { transitions: ApplyTransitionInput[]; get(): PostJob | null } = {
    transitions,
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
    async applyTransition(input) {
      transitions.push(input);
      if (options.rejectTransition) return null;
      if (!current || current.status !== input.from) return null;
      current = input.next;
      return input.next;
    },
    async setQueueJobId() {
      return true;
    },
    async rescheduleJob() {
      return null;
    },
    async listScheduledJobs() {
      return { items: [], nextCursor: null };
    },
    async findLastPublishedAt() {
      return null;
    },
    async refreshBatchStatus(_tenantId, batchId): Promise<PostBatchSummary> {
      return {
        batchId,
        tenantId: TENANT,
        productCode: "MGKVX6310",
        status: deriveBatchStatus(current ? [current.status] : []),
        total: current ? 1 : 0,
        byStatus: { draft: 0, queued: 0, publishing: 0, published: 0, failed: 0, blocked: 0 },
        startedAt: new Date("2026-08-13T02:00:00.000Z"),
        finishedAt: null,
        jobs: current ? [current] : [],
      };
    },
    async getBatchSummary() {
      return null;
    },
  };
  return repo;
}

function makeQueue(options: { removed?: boolean; fail?: boolean } = {}) {
  const removedIds: string[] = [];
  const queue: JobQueue & { removedIds: string[] } = {
    removedIds,
    async enqueue() {
      throw new Error("cancel must never enqueue");
    },
    async remove(jobId) {
      removedIds.push(jobId);
      if (options.fail) throw new AppError("QUEUE_ERROR", { message: "redis down" });
      return options.removed ?? true;
    },
    async close() {},
  };
  return queue;
}

function harness(
  job: PostJob | null,
  options: { rejectTransition?: boolean; removed?: boolean; queueFails?: boolean } = {},
) {
  const lines: LogLine[] = [];
  const repo = makeRepo(job, { rejectTransition: options.rejectTransition });
  const queue = makeQueue({ removed: options.removed, fail: options.queueFails });
  const cancelScheduledJob = makeCancelScheduledJob({
    postJobs: repo,
    queue,
    logger: recordingLogger(lines),
  });
  return { cancelScheduledJob, repo, queue, lines };
}

// --- Edge cases first -------------------------------------------------------

describe("cancelScheduledJob — refusals", () => {
  it.each([
    ["a malformed tenant id", { tenantId: "nope", postJobId: JOB_ID }],
    ["an empty job id", { tenantId: TENANT, postJobId: "  " }],
  ])("rejects %s", async (_label, input) => {
    const { cancelScheduledJob, queue } = harness(makeJob());
    await expect(cancelScheduledJob(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(queue.removedIds).toHaveLength(0);
  });

  it("reports a job that does not exist", async () => {
    const { cancelScheduledJob } = harness(null);
    await expect(
      cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "POST_JOB_NOT_FOUND" } });
  });

  it("NEVER cancels a published post", async () => {
    const { cancelScheduledJob, repo, queue } = harness(
      makeJob({ status: "published", publishedPostId: "100_200", queueJobId: null }),
    );
    await expect(
      cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID }),
    ).rejects.toMatchObject({
      code: "INVALID_JOB_TRANSITION",
      context: { reason: "ALREADY_PUBLISHED" },
    });
    expect(repo.transitions).toHaveLength(0);
    expect(queue.removedIds).toHaveLength(0);
  });

  it.each(["publishing", "blocked", "failed", "draft"] as PostJobStatus[])(
    "refuses a %s job",
    async (status) => {
      const { cancelScheduledJob, queue } = harness(makeJob({ status }));
      await expect(
        cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID }),
      ).rejects.toMatchObject({ code: "INVALID_JOB_TRANSITION" });
      expect(queue.removedIds).toHaveLength(0);
    },
  );

  it("loses to the worker: the hour came while the operator clicked", async () => {
    const { cancelScheduledJob, queue, lines } = harness(makeJob(), { rejectTransition: true });

    await expect(
      cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID }),
    ).rejects.toMatchObject({
      code: "INVALID_JOB_TRANSITION",
      context: { reason: "CONCURRENT_MODIFICATION" },
    });
    // The queue entry is NOT removed: the worker owns the job now.
    expect(queue.removedIds).toHaveLength(0);
    expect(lines.some((line) => line.context?.alert === "OPERATOR_ATTENTION")).toBe(true);
  });
});

// --- Happy path -------------------------------------------------------------

describe("cancelScheduledJob — cancel", () => {
  it("blocks the row with OPERATOR_CANCELLED and its own audit action", async () => {
    const { cancelScheduledJob, repo, queue } = harness(makeJob());

    const result = await cancelScheduledJob({
      tenantId: TENANT,
      postJobId: JOB_ID,
      actorUserId: "user-1",
      note: "khách đổi ý",
    });

    expect(result).toMatchObject({
      status: "blocked",
      queueEntryRemoved: true,
      channelId: "fbpage-a",
      scheduledAt: SCHEDULED_AT,
    });
    expect(repo.transitions[0]).toMatchObject({
      from: "queued",
      reason: "OPERATOR_CANCELLED",
      auditAction: CANCELLED_AUDIT_ACTION,
      actorUserId: "user-1",
    });
    expect(repo.get()).toMatchObject({
      status: "blocked",
      lastErrorCode: CANCELLED_ERROR_CODE,
      // Cleared with the transition: the entry is gone, the id must not linger.
      queueJobId: null,
    });
    expect(queue.removedIds).toEqual(["pp.job-1.MGKVX6310.T-M.fbpage-a"]);
  });

  it("writes the row BEFORE touching the queue", async () => {
    const order: string[] = [];
    const { cancelScheduledJob, repo, queue } = harness(makeJob());
    const applyTransition = repo.applyTransition.bind(repo);
    repo.applyTransition = async (input) => {
      order.push("db");
      return applyTransition(input);
    };
    const remove = queue.remove.bind(queue);
    queue.remove = async (id) => {
      order.push("queue");
      return remove(id);
    };

    await cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID });

    expect(order).toEqual(["db", "queue"]);
  });

  it("still cancels when the queue entry is already gone", async () => {
    const { cancelScheduledJob, lines } = harness(makeJob(), { removed: false });
    const result = await cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID });
    expect(result.status).toBe("blocked");
    expect(result.queueEntryRemoved).toBe(false);
    expect(lines.some((line) => line.context?.reason === "ENTRY_NOT_REMOVED")).toBe(true);
  });

  it("still cancels when the queue itself is down, and says so loudly", async () => {
    const { cancelScheduledJob, repo, lines } = harness(makeJob(), { queueFails: true });

    const result = await cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID });

    expect(result.status).toBe("blocked");
    expect(result.queueEntryRemoved).toBe(false);
    expect(repo.get()?.status).toBe("blocked");
    expect(
      lines.some((line) => line.level === "error" && line.context?.alert === "OPERATOR_ATTENTION"),
    ).toBe(true);
  });

  it("handles a job that has no stored queue id", async () => {
    const { cancelScheduledJob, queue, lines } = harness(makeJob({ queueJobId: null }));
    const result = await cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID });
    expect(result.queueEntryRemoved).toBe(false);
    expect(queue.removedIds).toHaveLength(0);
    expect(lines.some((line) => line.context?.reason === "QUEUE_ID_MISSING")).toBe(true);
  });
});

describe("cancelScheduledJob — the operator note (audit payload)", () => {
  it("stores the note, the actor e-mail and the cancelled hour in the audit row", async () => {
    const { cancelScheduledJob, repo } = harness(makeJob());

    await cancelScheduledJob({
      tenantId: TENANT,
      postJobId: JOB_ID,
      actorEmail: "Van@Example.com",
      note: "  khách   đổi ý  ",
    });

    expect(repo.transitions[0].auditPayload).toEqual({
      note: "khách đổi ý",
      actor_email: "van@example.com",
      cancelled_scheduled_at: SCHEDULED_AT.toISOString(),
    });
  });

  it("caps a very long note before it reaches the row", async () => {
    const { cancelScheduledJob, repo } = harness(makeJob());
    await cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID, note: "x".repeat(2_000) });
    const note = (repo.transitions[0].auditPayload as { note: string }).note;
    expect(note.length).toBe(MAX_CANCEL_NOTE_LENGTH + 1);
    expect(note.endsWith("…")).toBe(true);
  });

  it.each([undefined, null, "   "])("stores null for the empty note %p", async (note) => {
    const { cancelScheduledJob, repo } = harness(makeJob());
    await cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID, note });
    expect((repo.transitions[0].auditPayload as { note: string | null }).note).toBeNull();
  });
});
