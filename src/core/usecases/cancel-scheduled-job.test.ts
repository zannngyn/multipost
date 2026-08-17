import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import {
  canOperatorRetryPostJob,
  deriveBatchStatus,
  type PostJob,
  type PostJobStatus,
} from "@/core/domain/post-job";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { JobQueue } from "@/core/ports/job-queue";
import type {
  ApplyTransitionInput,
  PostBatchSummary,
  PostJobRepo,
} from "@/core/ports/post-job-repo";
import type {
  ChannelConfig,
  ChannelConfigRepo,
  ChannelPublisher,
  RemotePostState,
} from "@/core/ports/publisher";

import { channelWriteStubs } from "./__fixtures__/channel-config-repo";
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
    scheduledPostId: null,
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
    async refreshBatchStatus(_tenantId, batchId): Promise<PostBatchSummary> {
      return {
        batchId,
        tenantId: TENANT,
        productCode: "MGKVX6310",
        status: deriveBatchStatus(current ? [current.status] : []),
        total: current ? 1 : 0,
        byStatus: {
          draft: 0,
          queued: 0,
          publishing: 0,
          scheduled_on_facebook: 0,
          published: 0,
          failed: 0,
          blocked: 0,
        },
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

const CHANNEL: ChannelConfig = {
  channelId: "fbpage-a",
  platform: "facebook",
  name: "Page A",
  externalId: "555000111",
  accessToken: "secret",
  status: "active",
  tokenExpiresAt: null,
};

function makeChannels(channel: ChannelConfig | null): ChannelConfigRepo {
  return {
    findChannel: async () => channel,
    listChannels: async () => (channel ? [channel] : []),
    getPublishSettings: async () => ({ spacingMs: 0, retryBackoffMs: 1_000, maxAttempts: 3 }),
    ...channelWriteStubs(),
  };
}

function harness(
  job: PostJob | null,
  options: {
    rejectTransition?: boolean;
    removed?: boolean;
    queueFails?: boolean;
    /** E8.6 — what Facebook says about the post it is holding. */
    remoteState?: RemotePostState;
    /** The platform could not be ASKED at all (dead token, network). */
    stateThrows?: unknown;
    deleteThrows?: unknown;
    deleteReturns?: boolean;
    channel?: ChannelConfig | null;
    /** Build the usecase WITHOUT platform access (the pre-E8.6 wiring). */
    withoutPlatform?: boolean;
  } = {},
) {
  const lines: LogLine[] = [];
  const repo = makeRepo(job, { rejectTransition: options.rejectTransition });
  const queue = makeQueue({ removed: options.removed, fail: options.queueFails });
  const deleted: string[] = [];
  const facebook: ChannelPublisher = {
    async publishImagePost() {
      throw new Error("cancel must never publish");
    },
    async publishVideoPost() {
      throw new Error("cancel must never publish");
    },
    scheduled: {
      async schedulePost() {
        throw new Error("cancel must never schedule");
      },
      async getPostState(input) {
        if (options.stateThrows) throw options.stateThrows;
        return (
          options.remoteState ?? { state: "scheduled" as const, postId: input.postId, publishAt: null }
        );
      },
      async deleteScheduledPost(input) {
        deleted.push(input.postId);
        if (options.deleteThrows) throw options.deleteThrows;
        return options.deleteReturns ?? true;
      },
    },
  };
  const cancelScheduledJob = makeCancelScheduledJob({
    postJobs: repo,
    queue,
    logger: recordingLogger(lines),
    ...(options.withoutPlatform
      ? {}
      : {
          channels: makeChannels(options.channel === undefined ? CHANNEL : options.channel),
          publishers: { facebook },
        }),
  });
  return { cancelScheduledJob, repo, queue, lines, deleted };
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
      // E8.6 — the trail must say WHERE the post was waiting and whether
      // anything had to be removed from the platform.
      cancelled_from: "queued",
      platform_post_deleted: false,
      scheduled_post_id: null,
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

/**
 * E8.6 — cancelling a post FACEBOOK is holding. The invariant of this whole
 * block: the row is never marked cancelled while Facebook would still publish.
 */
describe("cancelScheduledJob — a post Facebook is holding (E8.6)", () => {
  const handedOff = (overrides: Partial<PostJob> = {}): PostJob =>
    makeJob({
      status: "scheduled_on_facebook",
      scheduledPostId: "555000111_777",
      queueJobId: null,
      ...overrides,
    });

  // --- Edge cases first ------------------------------------------------------

  it("does NOT cancel the row when the platform refuses the deletion", async () => {
    const h = harness(handedOff(), {
      deleteThrows: new AppError("META_ERROR", {
        message: "Graph said no",
        // What the Graph error map writes for a 5xx / rate limit. In a CANCEL it
        // is a lie: nothing retries a cancel.
        userMessage: "Máy chủ Facebook đang lỗi — hệ thống sẽ thử lại.",
      }),
    });

    const error = await h
      .cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID })
      .then(() => null)
      .catch((thrown: unknown) => thrown as AppError);

    expect(error?.code).toBe("META_ERROR");
    // The ONE sentence this branch exists for.
    expect(error?.userMessage).toContain("VẪN SẼ TỰ ĐĂNG");
    expect(error?.userMessage).toContain("xoá thủ công");
    // And never the publish-path promise of a retry that nobody makes.
    expect(error?.userMessage).not.toContain("thử lại");

    // The row still says "Facebook has it" — which is the truth.
    expect(h.repo.transitions).toHaveLength(0);
    expect(h.repo.get()?.status).toBe("scheduled_on_facebook");
    // The dangerous branch must be loud, with the ids needed to find the post.
    expect(
      h.lines.some(
        (line) =>
          line.level === "error" &&
          line.context?.alert === "OPERATOR_ATTENTION" &&
          line.context?.reason === "PLATFORM_DELETE_FAILED",
      ),
    ).toBe(true);
  });

  it("does NOT cancel the row when the platform cannot even be asked", async () => {
    const h = harness(handedOff(), {
      stateThrows: new AppError("TOKEN_EXPIRED", { message: "token revoked" }),
    });

    await expect(
      h.cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID }),
    ).rejects.toMatchObject({
      code: "TOKEN_EXPIRED",
      userMessage: expect.stringContaining("VẪN SẼ TỰ ĐĂNG"),
    });
    expect(h.deleted).toHaveLength(0);
    expect(h.repo.transitions).toHaveLength(0);
    expect(h.repo.get()?.status).toBe("scheduled_on_facebook");
  });

  it("refuses when Facebook already published the post", async () => {
    const h = harness(handedOff(), {
      remoteState: {
        state: "published",
        postId: "555000111_777",
        url: "https://www.facebook.com/page/posts/777",
        publishedAt: new Date(),
      },
    });

    await expect(
      h.cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID }),
    ).rejects.toMatchObject({
      code: "INVALID_JOB_TRANSITION",
      context: { reason: "ALREADY_PUBLISHED_ON_PLATFORM" },
    });
    // A live post is NEVER deleted behind the operator's back.
    expect(h.deleted).toHaveLength(0);
    expect(h.repo.transitions).toHaveLength(0);
  });

  it("refuses with a Vietnamese instruction when the platform cannot be reached", async () => {
    for (const options of [
      { withoutPlatform: true },
      { channel: null },
    ] as const) {
      const h = harness(handedOff(), options);
      await expect(
        h.cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID }),
      ).rejects.toMatchObject({
        code: "INVALID_JOB_TRANSITION",
        userMessage: expect.stringContaining("VẪN SẼ TỰ ĐĂNG"),
      });
      expect(h.repo.transitions).toHaveLength(0);
    }
  });

  it("refuses a row with no platform post id instead of pretending", async () => {
    const h = harness(handedOff({ scheduledPostId: null }));
    await expect(
      h.cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID }),
    ).rejects.toMatchObject({
      code: "INVALID_JOB_TRANSITION",
      context: { reason: "SCHEDULED_POST_ID_MISSING" },
    });
  });

  // --- Happy path ------------------------------------------------------------

  it("deletes the post on Facebook FIRST, then blocks the row", async () => {
    const h = harness(handedOff());

    const result = await h.cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID });

    expect(h.deleted).toEqual(["555000111_777"]);
    expect(result).toMatchObject({ status: "blocked", platformPostDeleted: true });
    expect(result.userMessage).toContain("gỡ bài đã hẹn khỏi Facebook");
    const transition = h.repo.transitions[0];
    expect(transition.from).toBe("scheduled_on_facebook");
    expect(transition.next.status).toBe("blocked");
    expect(transition.next.lastErrorCode).toBe(CANCELLED_ERROR_CODE);
    expect(transition.auditAction).toBe(CANCELLED_AUDIT_ACTION);
    expect(transition.auditPayload).toMatchObject({
      cancelled_from: "scheduled_on_facebook",
      platform_post_deleted: true,
      scheduled_post_id: "555000111_777",
    });
    // The id is dropped from the ROW (it lives on in the audit payload above):
    // Facebook confirmed the object is gone, and a dead id left behind would
    // later refuse the re-run of a job that has nothing on the Page.
    expect(transition.next.scheduledPostId).toBeNull();
    expect(canOperatorRetryPostJob(transition.next)).toBe(true);
    // Nothing to remove from the queue: Facebook was holding this one.
    expect(h.queue.removedIds).toHaveLength(0);
  });

  /**
   * BEHAVIOUR CHANGE (was: "still cancels the row when the post was already gone
   * from the Page"). An answer we cannot read is not proof that the post
   * disappeared — Graph gives the same 100/33 for a wrong token — so the DELETE
   * still runs, and it is the DELETE that decides.
   */
  it("asks the platform to delete anyway when it gave no readable state", async () => {
    const h = harness(handedOff(), {
      remoteState: { state: "unknown", reason: "OBJECT_NOT_READABLE_100_33" },
    });

    const result = await h.cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID });

    // Facebook confirmed the deletion, so the cancel is honest.
    expect(h.deleted).toEqual(["555000111_777"]);
    expect(result).toMatchObject({ status: "blocked", platformPostDeleted: true });
    expect(
      h.lines.some(
        (line) =>
          line.context?.reason === "OBJECT_NOT_READABLE_100_33" &&
          line.context?.alert === "OPERATOR_ATTENTION",
      ),
    ).toBe(true);
  });

  it("refuses — never reports a cancel — when the unreadable post cannot be deleted either", async () => {
    const h = harness(handedOff(), {
      remoteState: { state: "unknown", reason: "OBJECT_NOT_READABLE_100_33" },
      deleteThrows: new AppError("META_ERROR", {
        message: "Graph would not delete post 555000111_777: object not readable (100/33)",
        userMessage:
          "Facebook không cho đọc/gỡ bài đã hẹn này — hệ thống KHÔNG xác nhận được là bài đã biến mất.",
      }),
    });

    await expect(
      h.cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID }),
    ).rejects.toMatchObject({
      code: "META_ERROR",
      userMessage: expect.stringContaining("VẪN SẼ TỰ ĐĂNG"),
    });
    expect(h.repo.transitions).toHaveLength(0);
    expect(h.repo.get()?.status).toBe("scheduled_on_facebook");
  });

  it("cancels with an honest sentence when the platform reports it never held the post", async () => {
    const h = harness(handedOff(), { deleteReturns: false });

    const result = await h.cancelScheduledJob({ tenantId: TENANT, postJobId: JOB_ID });

    expect(result).toMatchObject({ status: "blocked", platformPostDeleted: false });
    // Not "đã gỡ khỏi Facebook": nothing was removed, Facebook simply has none.
    expect(result.userMessage).toContain("không còn giữ bài này");
    expect(h.repo.get()?.status).toBe("blocked");
  });
});
