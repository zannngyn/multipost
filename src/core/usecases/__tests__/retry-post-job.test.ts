import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import {
  canOperatorRetryPostJob,
  deriveBatchStatus,
  type PostJob,
  type PostJobStatus,
} from "@/core/domain/post-job";
import type { Clock, LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { EnqueueOptions, JobQueue } from "@/core/ports/job-queue";
import type {
  ApplyTransitionInput,
  PostBatchSummary,
  PostJobRepo,
} from "@/core/ports/post-job-repo";
import type { ChannelConfigRepo } from "@/core/ports/publisher";

import { channelWriteStubs } from "../__fixtures__/channel-config-repo";
import type { UserRepo } from "@/core/ports/user-repo";

import { PUBLISH_POST_JOB_NAME } from "../publish-post";
import { makeRetryPostJob } from "../retry-post-job";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * E11.1 "chạy lại". The rule under test is what it REFUSES: a published job must
 * never be re-queued, and a retry must not skip any publish gate.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

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

const CLOCK: Clock = {
  now: () => new Date("2026-08-13T02:00:00.000Z"),
  nowMs: () => Date.parse("2026-08-13T02:00:00.000Z"),
};

function makeJob(overrides: Partial<PostJob> = {}): PostJob {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    tenantId: TENANT,
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "TÍM",
    channelId: "fbpage-a",
    format: "image_post",
    status: "failed",
    attemptCount: 3,
    lastErrorCode: "PUBLISH_FAILED",
    lastErrorMessage: "Đăng bài thất bại sau số lần thử cho phép.",
    publishedPostId: null,
    publishedUrl: null,
    publishedAt: null,
    scheduledPostId: null,
    captionText: "Giannal – MỘT NGÀY DỊU DÀNG",
    media: [{ driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" }],
    scheduledAt: null,
    queueJobId: null,
    ...overrides,
  };
}

function makeRepo(jobs: PostJob[], options: { rejectTransition?: boolean } = {}) {
  const store = new Map(jobs.map((job) => [job.id, job]));
  const transitions: Array<{
    from: PostJobStatus;
    to: PostJobStatus;
    reason: string;
    actorUserId: string | null;
  }> = [];
  const repo: PostJobRepo & {
    transitions: typeof transitions;
    get(id: string): PostJob | undefined;
    refreshCalls: string[];
  } = {
    transitions,
    refreshCalls: [],
    get: (id) => store.get(id),
    async createBatchWithJobs() {
      throw new Error("not used");
    },
    async findJobById(_tenantId, postJobId) {
      return store.get(postJobId) ?? null;
    },
    async listJobsByBatch(_tenantId, batchId) {
      return [...store.values()].filter((job) => job.batchId === batchId);
    },
    async listJobs() {
      return { items: [], nextCursor: null };
    },
    async applyTransition(input: ApplyTransitionInput) {
      transitions.push({
        from: input.from,
        to: input.next.status,
        reason: input.reason,
        actorUserId: input.actorUserId ?? null,
      });
      if (options.rejectTransition) return null;
      const current = store.get(input.postJobId);
      if (!current || current.status !== input.from) return null;
      store.set(input.postJobId, input.next);
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
    async findBatchSpacingMs() {
      // No per-run gap: the tenant setting applies, as it always did.
      return null;
    },
    async refreshBatchStatus(_tenantId, batchId): Promise<PostBatchSummary> {
      repo.refreshCalls.push(batchId);
      const list = [...store.values()].filter((job) => job.batchId === batchId);
      return {
        batchId,
        tenantId: TENANT,
        productCode: list[0]?.productCode ?? "",
        status: deriveBatchStatus(list.map((job) => job.status)),
        total: list.length,
        byStatus: {
          draft: 0,
          queued: 0,
          publishing: 0,
          scheduled_on_facebook: 0,
          published: 0,
          failed: 0,
          blocked: 0,
        },
        startedAt: CLOCK.now(),
        finishedAt: null,
        jobs: list,
      };
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

function makeQueue(options: { fail?: boolean } = {}) {
  const enqueued: Array<{ name: string; payload: unknown; opts?: EnqueueOptions }> = [];
  const queue: JobQueue & { enqueued: typeof enqueued } = {
    enqueued,
    async enqueue(name, payload, opts) {
      if (options.fail) throw new AppError("QUEUE_ERROR", { message: "redis down" });
      enqueued.push({ name, payload, opts });
      return { jobId: opts?.jobId ?? "generated" };
    },
    async remove() {
      return true;
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
  getPublishSettings: async () => ({ spacingMs: 60_000, retryBackoffMs: 1_000, maxAttempts: 3 }),
  ...channelWriteStubs(),
};

/** app_user lookup: the audit trail's "who pressed chạy lại?". */
function makeUsers(byEmail: Record<string, string>, options: { fail?: boolean } = {}) {
  const asked: string[] = [];
  const users: UserRepo & { asked: string[] } = {
    asked,
    async findUserIdByEmail(_tenantId, email) {
      asked.push(email);
      if (options.fail) throw new AppError("DB_ERROR", { message: "app_user unreachable" });
      return byEmail[email.trim().toLowerCase()] ?? null;
    },
    /**
     * Retry resolves its actor from the session E-MAIL (a replayed job payload
     * may carry nothing else), so this arm must never be reached. Throwing
     * rather than returning null: a silent switch to the account key would
     * otherwise leave every audit row anonymous with all tests still green.
     */
    async findUserIdByAccount() {
      throw new Error("retryPostJob must resolve its actor by e-mail, not by account");
    },
  };
  return users;
}

function harness(
  jobs: PostJob[],
  options: {
    queueFails?: boolean;
    rejectTransition?: boolean;
    users?: UserRepo;
  } = {},
) {
  const lines: LogLine[] = [];
  const repo = makeRepo(jobs, { rejectTransition: options.rejectTransition });
  const queue = makeQueue({ fail: options.queueFails });
  const retryPostJob = makeRetryPostJob({
    postJobs: repo,
    channels: CHANNELS,
    queue,
    clock: CLOCK,
    logger: recordingLogger(lines),
    users: options.users,
  });
  return { retryPostJob, repo, queue, lines };
}

// --- Edge cases first -------------------------------------------------------

describe("retryPostJob — refusals", () => {
  it.each([
    ["a malformed tenant id", { tenantId: testTenantId("nope"), postJobId: "job-1" }],
    ["an empty job id", { tenantId: TENANT, postJobId: "  " }],
  ])("rejects %s", async (_label, input) => {
    const { retryPostJob, queue } = harness([makeJob()]);
    await expect(retryPostJob(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(queue.enqueued).toHaveLength(0);
  });

  it("reports a job that does not exist for this tenant", async () => {
    const { retryPostJob } = harness([]);
    await expect(
      retryPostJob({ tenantId: TENANT, postJobId: "22222222-2222-2222-2222-222222222222" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "POST_JOB_NOT_FOUND" } });
  });

  it("NEVER re-queues a published job (business rule 4)", async () => {
    const job = makeJob({ status: "published", publishedPostId: "100_200" });
    const { retryPostJob, repo, queue } = harness([job]);

    await expect(retryPostJob({ tenantId: TENANT, postJobId: job.id })).rejects.toMatchObject({
      code: "INVALID_JOB_TRANSITION",
      context: { reason: "ALREADY_PUBLISHED", published_post_id: "100_200" },
    });
    expect(queue.enqueued).toHaveLength(0);
    expect(repo.transitions).toHaveLength(0);
    expect(repo.get(job.id)?.status).toBe("published");
  });

  it.each(["queued", "publishing", "draft"] as PostJobStatus[])(
    "refuses a %s job — it is not the operator's to re-queue",
    async (status) => {
      const job = makeJob({ status });
      const { retryPostJob, queue } = harness([job]);
      await expect(retryPostJob({ tenantId: TENANT, postJobId: job.id })).rejects.toMatchObject({
        code: "INVALID_JOB_TRANSITION",
      });
      expect(queue.enqueued).toHaveLength(0);
    },
  );

  /**
   * Gate note 1 (E8.6). `failed` + HANDOFF_FAILED = the handoff ended without a
   * verdict, so Facebook may be holding a scheduled post for this job. The
   * status alone says "retryable", and each of the three moments an operator
   * could press the button leads somewhere different and equally bad — which is
   * why the refusal has to sit on the ROW, not on the clock.
   */
  it.each([
    ["inside the handoff window (T-30..T-12)", 20 * 60_000],
    ["in the dead zone (T-12..T)", 5 * 60_000],
    ["after the hour has passed", -3 * 60_000],
  ])(
    "refuses a job whose handoff outcome is unknown — pressed %s",
    async (_label, offsetMs) => {
      const job = makeJob({
        status: "failed",
        lastErrorCode: "HANDOFF_FAILED",
        lastErrorMessage:
          "Không xác nhận được kết quả giao lịch cho Facebook — bài hẹn CÓ THỂ đã được tạo trên Trang.",
        scheduledAt: new Date(CLOCK.nowMs() + offsetMs),
        queueJobId: null,
      });
      const { retryPostJob, repo, queue, lines } = harness([job]);

      await expect(retryPostJob({ tenantId: TENANT, postJobId: job.id })).rejects.toMatchObject({
        code: "DUPLICATE_POST_BLOCKED",
        context: { reason: "HANDOFF_OUTCOME_UNKNOWN", last_error_code: "HANDOFF_FAILED" },
      });

      // Nothing moved and nothing was queued: no second handoff, no publish.
      expect(repo.transitions).toHaveLength(0);
      expect(repo.get(job.id)?.status).toBe("failed");
      expect(queue.enqueued).toHaveLength(0);

      const refusal = lines.find(
        (line) =>
          line.message === "Retry refused: the platform may already hold a post for this job",
      );
      expect(refusal?.level).toBe("warn");
      expect(refusal?.context?.alert).toBe("OPERATOR_ATTENTION");
    },
  );

  it("tells the operator to check the Page instead of pressing Chạy lại", async () => {
    const job = makeJob({
      status: "failed",
      lastErrorCode: "HANDOFF_FAILED",
      scheduledAt: new Date(CLOCK.nowMs() + 20 * 60_000),
    });
    const { retryPostJob } = harness([job]);

    const error = await retryPostJob({ tenantId: TENANT, postJobId: job.id }).catch(
      (caught: unknown) => caught as AppError,
    );

    expect(error.userMessage).toContain("bài đã lên lịch");
    expect(error.userMessage).toContain("xoá bài nếu thấy");
    expect(error.userMessage).toContain("soạn lại");
  });

  it("fails closed when the row lost its scheduled hour", async () => {
    // The hour is NOT part of the condition on purpose: only a scheduled job can
    // carry this code, so a row without one is already wrong — and a guard that
    // switches itself off on odd data is not a guard.
    const job = makeJob({ status: "failed", lastErrorCode: "HANDOFF_FAILED", scheduledAt: null });
    const { retryPostJob, queue } = harness([job]);

    await expect(retryPostJob({ tenantId: TENANT, postJobId: job.id })).rejects.toMatchObject({
      code: "DUPLICATE_POST_BLOCKED",
    });
    expect(queue.enqueued).toHaveLength(0);
  });

  /**
   * DOOR 1 — the reconciliation sweep gave up on a post Facebook confirmedly
   * created (the row still carries its id). Before this guard the row said
   * `failed`, the button was lit, and pressing it published a live post next to
   * the one Facebook was holding. The old hedge was a sentence next to that
   * button; a sentence is not a lock.
   */
  it.each([
    ["inside the handoff window (T-30..T-12)", 20 * 60_000],
    ["in the dead zone (T-12..T)", 5 * 60_000],
    ["after the hour has passed", -3 * 60_000],
  ])(
    "DOOR 1: refuses a job the reconciler gave up on — pressed %s",
    async (_label, offsetMs) => {
      const job = makeJob({
        status: "failed",
        lastErrorCode: "SCHEDULE_UNCONFIRMED",
        lastErrorMessage: "Không xác nhận được bài đã hẹn trên Facebook sau nhiều lần kiểm tra.",
        // The proof: Facebook created this object for this job.
        scheduledPostId: "1000000000_2000000000",
        scheduledAt: new Date(CLOCK.nowMs() + offsetMs),
      });
      const { retryPostJob, repo, queue } = harness([job]);

      const error = await retryPostJob({ tenantId: TENANT, postJobId: job.id }).catch(
        (caught: unknown) => caught as AppError,
      );

      expect(error).toMatchObject({
        code: "DUPLICATE_POST_BLOCKED",
        context: {
          reason: "PLATFORM_HOLDS_SCHEDULED_POST",
          scheduled_post_id: "1000000000_2000000000",
        },
      });
      // The id is IN the sentence: an operator cannot delete a post they cannot
      // find, and the Page's scheduled list is long.
      expect(error.userMessage).toContain("1000000000_2000000000");
      expect(error.userMessage).toContain("bài đã lên lịch");
      expect(repo.transitions).toHaveLength(0);
      expect(repo.get(job.id)?.status).toBe("failed");
      expect(queue.enqueued).toHaveLength(0);
    },
  );

  /**
   * DOORS 2 & 3 — the reaper stopped a SCHEDULED job that died in `publishing`
   * (the typical case: the worker was killed after /feed was dispatched, or
   * while a 10-photo album was still uploading past the 15' stale window).
   * Facebook may hold the post, and it is not in the feed the operator checks.
   */
  it("DOORS 2+3: refuses a scheduled job the reaper stopped mid-publish", async () => {
    const job = makeJob({
      status: "failed",
      lastErrorCode: "PUBLISH_UNCONFIRMED",
      lastErrorMessage: "Bài hẹn giờ bị kẹt ở trạng thái đang đăng (worker dừng giữa chừng).",
      scheduledAt: new Date(CLOCK.nowMs() + 20 * 60_000),
      attemptCount: 1,
    });
    const { retryPostJob, repo, queue } = harness([job]);

    const error = await retryPostJob({ tenantId: TENANT, postJobId: job.id }).catch(
      (caught: unknown) => caught as AppError,
    );

    expect(error).toMatchObject({
      code: "DUPLICATE_POST_BLOCKED",
      context: { reason: "PUBLISH_OUTCOME_UNKNOWN" },
    });
    // Both places, because the reaper cannot tell which kind of post it made.
    expect(error.userMessage).toContain("bài đã đăng");
    expect(error.userMessage).toContain("bài đã lên lịch");
    expect(repo.transitions).toHaveLength(0);
    expect(queue.enqueued).toHaveLength(0);
  });

  /**
   * The button and the API must answer the SAME question. They used to be two
   * expressions in two files; a third rule added to one of them would have hidden
   * the button while the API still accepted the call (or worse, the reverse).
   */
  it("never disagrees with canOperatorRetryPostJob (the predicate the job log draws with)", async () => {
    const rows: PostJob[] = [
      makeJob({ id: "row-failed-plain", status: "failed", lastErrorCode: "PUBLISH_FAILED" }),
      makeJob({ id: "row-blocked-stock", status: "blocked", lastErrorCode: "OUT_OF_STOCK" }),
      makeJob({
        id: "row-blocked-cancelled",
        status: "blocked",
        lastErrorCode: "OPERATOR_CANCELLED",
        scheduledPostId: "1000000000_3000000000",
      }),
      makeJob({ id: "row-handoff", status: "failed", lastErrorCode: "HANDOFF_FAILED" }),
      makeJob({
        id: "row-unconfirmed",
        status: "failed",
        lastErrorCode: "SCHEDULE_UNCONFIRMED",
        scheduledPostId: "1000000000_2000000000",
      }),
      makeJob({ id: "row-reaped", status: "failed", lastErrorCode: "PUBLISH_UNCONFIRMED" }),
      makeJob({ id: "row-published", status: "published", publishedPostId: "1_2" }),
      makeJob({ id: "row-queued", status: "queued" }),
      makeJob({ id: "row-publishing", status: "publishing" }),
      makeJob({ id: "row-draft", status: "draft" }),
      makeJob({ id: "row-scheduled", status: "scheduled_on_facebook", scheduledPostId: "1_9" }),
    ];

    for (const row of rows) {
      const { retryPostJob, queue } = harness([row]);
      const accepted = await retryPostJob({ tenantId: TENANT, postJobId: row.id }).then(
        () => true,
        () => false,
      );
      expect({ id: row.id, accepted }).toEqual({
        id: row.id,
        accepted: canOperatorRetryPostJob(row),
      });
      // Whatever the verdict, a refusal never leaves a queue entry behind.
      expect(queue.enqueued).toHaveLength(accepted ? 1 : 0);
    }
  });

  it("still re-queues a scheduled job that failed for an ORDINARY reason", async () => {
    // The guard must be narrow: a scheduled post that simply failed to publish
    // has nothing waiting on the Page, and refusing it would strand real work.
    const job = makeJob({
      status: "failed",
      lastErrorCode: "PUBLISH_FAILED",
      scheduledAt: new Date(CLOCK.nowMs() + 20 * 60_000),
    });
    const { retryPostJob, repo, queue } = harness([job]);

    const result = await retryPostJob({ tenantId: TENANT, postJobId: job.id });

    expect(result.status).toBe("queued");
    expect(repo.get(job.id)?.status).toBe("queued");
    expect(queue.enqueued).toHaveLength(1);
  });

  it("refuses when another writer moved the row first (no double queue entry)", async () => {
    const job = makeJob();
    const { retryPostJob, queue } = harness([job], { rejectTransition: true });
    await expect(retryPostJob({ tenantId: TENANT, postJobId: job.id })).rejects.toMatchObject({
      code: "INVALID_JOB_TRANSITION",
      context: { reason: "CONCURRENT_MODIFICATION" },
    });
    expect(queue.enqueued).toHaveLength(0);
  });

  it("puts the job back to its previous status when the queue is down", async () => {
    const job = makeJob({ status: "blocked", lastErrorCode: "OUT_OF_STOCK" });
    const { retryPostJob, repo, lines } = harness([job], { queueFails: true });

    await expect(retryPostJob({ tenantId: TENANT, postJobId: job.id })).rejects.toMatchObject({
      code: "QUEUE_ERROR",
    });
    // queued (optimistic) then back to blocked — never left dangling in `queued`.
    expect(repo.transitions.map((entry) => `${entry.from}->${entry.to}`)).toEqual([
      "blocked->queued",
      "queued->blocked",
    ]);
    expect(repo.get(job.id)?.status).toBe("blocked");
    expect(lines.some((line) => line.level === "error")).toBe(true);
  });
});

// --- Happy path -------------------------------------------------------------

describe("retryPostJob — re-queue", () => {
  it.each(["failed", "blocked"] as PostJobStatus[])("re-queues a %s job", async (status) => {
    const job = makeJob({ status, lastErrorCode: "OUT_OF_STOCK" });
    const { retryPostJob, repo, queue } = harness([job]);

    const result = await retryPostJob({ tenantId: TENANT, postJobId: job.id, actorUserId: "u-1" });

    expect(result).toMatchObject({
      postJobId: job.id,
      previousStatus: status,
      status: "queued",
      channelId: "fbpage-a",
    });
    expect(repo.get(job.id)?.status).toBe("queued");
    expect(repo.refreshCalls).toEqual(["batch-1"]);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0].name).toBe(PUBLISH_POST_JOB_NAME);
    expect(queue.enqueued[0].payload).toEqual({ tenantId: TENANT, postJobId: job.id });
    expect(queue.enqueued[0].opts?.attempts).toBe(3);
    expect(queue.enqueued[0].opts?.backoff).toEqual({ strategy: "exponential", delayMs: 1_000 });
  });

  it("uses a FRESH queue id — BullMQ would drop a repeat of the first run's id", async () => {
    const job = makeJob();
    const { retryPostJob, queue } = harness([job]);
    const result = await retryPostJob({ tenantId: TENANT, postJobId: job.id });
    expect(queue.enqueued[0].opts?.jobId).toBe(result.queueJobId);
    expect(result.queueJobId).toContain(".d");
    expect(result.queueJobId).not.toBe(`pp.${job.id}.MGKVX6310.T-M.fbpage-a`);
  });

  it("does NOT publish anything itself — the stock recheck stays in publish-post", async () => {
    const job = makeJob({ status: "blocked", lastErrorCode: "OUT_OF_STOCK" });
    const { retryPostJob, repo, queue } = harness([job]);

    const result = await retryPostJob({ tenantId: TENANT, postJobId: job.id });

    // Only ONE transition (-> queued): no claim, no publish, no published id.
    expect(repo.transitions.map((entry) => entry.to)).toEqual(["queued"]);
    expect(repo.get(job.id)?.publishedPostId).toBeNull();
    expect(result.userMessage).toContain("tồn kho sẽ được kiểm tra lại");
    expect(queue.enqueued[0].payload).toEqual({ tenantId: TENANT, postJobId: job.id });
  });

  it("keeps the attempt count (history is not erased by a retry)", async () => {
    const job = makeJob({ attemptCount: 3 });
    const { retryPostJob } = harness([job]);
    const result = await retryPostJob({ tenantId: TENANT, postJobId: job.id });
    expect(result.attemptCount).toBe(3);
  });

  it("logs the previous status and error so the audit answers 'why was it re-run?'", async () => {
    const job = makeJob({ status: "blocked", lastErrorCode: "TOKEN_EXPIRED" });
    const { retryPostJob, lines } = harness([job]);
    await retryPostJob({ tenantId: TENANT, postJobId: job.id, actorUserId: "u-9" });

    const line = lines.find((entry) => entry.message === "Post job re-queued by an operator");
    expect(line?.context).toMatchObject({
      previous_status: "blocked",
      previous_error_code: "TOKEN_EXPIRED",
      actor_user_id: "u-9",
    });
  });
});

describe("retryPostJob — audit actor", () => {
  const USER_ID = "99999999-9999-9999-9999-999999999999";

  it("resolves the session e-mail to an app_user id for the audit row", async () => {
    const users = makeUsers({ "van@example.com": USER_ID });
    const { retryPostJob, repo } = harness([makeJob()], { users });

    await retryPostJob({
      tenantId: TENANT,
      postJobId: makeJob().id,
      actorEmail: "  Van@Example.com ",
    });

    // Lower-cased before the lookup: app_user.email is stored lower-cased.
    expect((users as unknown as { asked: string[] }).asked).toEqual(["van@example.com"]);
    expect(repo.transitions[0]).toMatchObject({ to: "queued", actorUserId: USER_ID });
  });

  it("prefers an explicit actorUserId and never queries app_user", async () => {
    const users = makeUsers({ "van@example.com": USER_ID });
    const { retryPostJob, repo } = harness([makeJob()], { users });

    await retryPostJob({
      tenantId: TENANT,
      postJobId: makeJob().id,
      actorUserId: "11111111-2222-3333-4444-555555555555",
      actorEmail: "van@example.com",
    });

    expect((users as unknown as { asked: string[] }).asked).toEqual([]);
    expect(repo.transitions[0].actorUserId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("still retries (anonymously) when the e-mail has no app_user row", async () => {
    const users = makeUsers({});
    const { retryPostJob, repo, queue, lines } = harness([makeJob()], { users });

    const result = await retryPostJob({
      tenantId: TENANT,
      postJobId: makeJob().id,
      actorEmail: "nguoi-la@example.com",
    });

    expect(result.status).toBe("queued");
    expect(queue.enqueued).toHaveLength(1);
    expect(repo.transitions[0].actorUserId).toBeNull();
    expect(
      lines.some((line) => line.level === "warn" && line.context?.reason === "ACTOR_NOT_FOUND"),
    ).toBe(true);
  });

  it("still retries when the app_user lookup itself fails", async () => {
    const users = makeUsers({}, { fail: true });
    const { retryPostJob, queue, lines } = harness([makeJob()], { users });

    const result = await retryPostJob({
      tenantId: TENANT,
      postJobId: makeJob().id,
      actorEmail: "van@example.com",
    });

    expect(result.status).toBe("queued");
    expect(queue.enqueued).toHaveLength(1);
    expect(
      lines.some((line) => line.level === "warn" && line.context?.reason === "ACTOR_LOOKUP_FAILED"),
    ).toBe(true);
  });

  it("warns when an e-mail is given but no resolver is wired", async () => {
    const { retryPostJob, repo, lines } = harness([makeJob()]);

    await retryPostJob({ tenantId: TENANT, postJobId: makeJob().id, actorEmail: "van@example.com" });

    expect(repo.transitions[0].actorUserId).toBeNull();
    expect(
      lines.some(
        (line) => line.level === "warn" && line.context?.reason === "ACTOR_RESOLVER_NOT_WIRED",
      ),
    ).toBe(true);
  });

  it("writes no actor at all for an automated retry", async () => {
    const { retryPostJob, repo } = harness([makeJob()], { users: makeUsers({}) });
    await retryPostJob({ tenantId: TENANT, postJobId: makeJob().id });
    expect(repo.transitions[0].actorUserId).toBeNull();
  });
});
