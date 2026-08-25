import { describe, expect, it } from "vitest";

import { AppError } from "@/core/domain/errors";
import { canOperatorRetryPostJob, type PostJob } from "@/core/domain/post-job";
import type { Clock, LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { ApplyTransitionInput, OverdueScanQuery, PostJobRepo } from "@/core/ports/post-job-repo";
import type {
  ChannelConfig,
  ChannelConfigRepo,
  ChannelPlatform,
  ChannelPublisher,
  RemotePostState,
} from "@/core/ports/publisher";

import { channelWriteStubs } from "./__fixtures__/channel-config-repo";
import {
  DEFAULT_RECONCILE_GRACE_MS,
  RECONCILED_PUBLISHED_AUDIT_ACTION,
  RECONCILED_UNCONFIRMED_AUDIT_ACTION,
  SCHEDULE_UNCONFIRMED_ERROR_CODE,
  makeReconcileScheduledPosts,
} from "./reconcile-scheduled-posts";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * E8.6 — the sweep that asks Facebook "did you publish it?".
 *
 * One rule dominates every test here: NOTHING becomes `published` without the
 * platform saying so, and nothing is ever re-sent.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
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
    id: "job-1",
    tenantId: TENANT,
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "TÍM",
    channelId: "fbpage-a",
    format: "image_post",
    status: "scheduled_on_facebook",
    attemptCount: 1,
    lastErrorCode: null,
    lastErrorMessage: null,
    publishedPostId: null,
    publishedUrl: null,
    publishedAt: null,
    scheduledPostId: "555000111_777",
    captionText: "caption",
    media: [{ driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" }],
    // Ten minutes ago: past the grace, so the sweep asks about it.
    scheduledAt: new Date(NOW - 10 * 60_000),
    queueJobId: null,
    ...overrides,
  };
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

function makeRepo(jobs: PostJob[], options: { rejectTransition?: boolean } = {}) {
  const transitions: ApplyTransitionInput[] = [];
  const scans: OverdueScanQuery[] = [];
  const repo: PostJobRepo & { transitions: ApplyTransitionInput[]; scans: OverdueScanQuery[] } = {
    transitions,
    scans,
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
      return options.rejectTransition ? null : input.next;
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
    async findScheduledOnPlatformDue(query) {
      scans.push(query);
      return jobs;
    },
    async findLastPublishedAt() {
      return null;
    },
    async findBatchSpacingMs() {
      // No per-run gap: the tenant setting applies, as it always did.
      return null;
    },
    async refreshBatchStatus() {
      return {
        batchId: "batch-1",
        tenantId: TENANT,
        productCode: "MGKVX6310",
        status: "running" as const,
        total: 1,
        byStatus: {
          draft: 0,
          queued: 0,
          publishing: 0,
          scheduled_on_facebook: 1,
          published: 0,
          failed: 0,
          blocked: 0,
        },
        startedAt: new Date(NOW),
        finishedAt: null,
        jobs: [],
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

function makeChannels(channel: ChannelConfig | null): ChannelConfigRepo {
  return {
    findChannel: async () => channel,
    listChannels: async () => (channel ? [channel] : []),
    getPublishSettings: async () => ({ spacingMs: 0, retryBackoffMs: 1_000, maxAttempts: 3 }),
    ...channelWriteStubs(),
  };
}

function harness(options: {
  jobs?: PostJob[];
  state?: RemotePostState;
  askThrows?: unknown;
  channel?: ChannelConfig | null;
  withoutScheduler?: boolean;
  rejectTransition?: boolean;
} = {}) {
  const jobs = options.jobs ?? [makeJob()];
  const repo = makeRepo(jobs, { rejectTransition: options.rejectTransition });
  const lines: LogLine[] = [];
  const asked: string[] = [];

  const facebook: ChannelPublisher = {
    async publishImagePost() {
      throw new Error("the reconciler must never publish");
    },
    async publishVideoPost() {
      throw new Error("the reconciler must never publish");
    },
    ...(options.withoutScheduler
      ? {}
      : {
          scheduled: {
            async schedulePost() {
              throw new Error("the reconciler must never schedule");
            },
            async getPostState(input) {
              asked.push(input.postId);
              if (options.askThrows) throw options.askThrows;
              return (
                options.state ?? {
                  state: "published" as const,
                  postId: input.postId,
                  url: "https://www.facebook.com/page/posts/777",
                  publishedAt: new Date(NOW - 9 * 60_000),
                }
              );
            },
            async deleteScheduledPost() {
              throw new Error("the reconciler must never delete");
            },
          },
        }),
  };
  const publishers: Partial<Record<ChannelPlatform, ChannelPublisher>> = { facebook };

  return {
    repo,
    lines,
    asked,
    reconcile: makeReconcileScheduledPosts({
      postJobs: repo,
      channels: makeChannels(options.channel === undefined ? CHANNEL : options.channel),
      publishers,
      clock: CLOCK,
      logger: recordingLogger(lines),
    }),
  };
}

// --- Edge cases first -------------------------------------------------------

describe("reconcileScheduledPosts — nothing is assumed", () => {
  it("only asks about hours that are already past the grace", async () => {
    const h = harness({ jobs: [] });
    await h.reconcile();
    expect(h.repo.scans[0].dueBefore.getTime()).toBe(NOW - DEFAULT_RECONCILE_GRACE_MS);
  });

  it("leaves a post alone while Facebook still reports it as scheduled", async () => {
    const h = harness({ state: { state: "scheduled", postId: "555000111_777", publishAt: null } });

    const result = await h.reconcile();

    expect(result.waiting).toBe(1);
    expect(result.published).toBe(0);
    expect(h.repo.transitions).toHaveLength(0);
  });

  it("never publishes on an unreadable answer — it waits and says why", async () => {
    const h = harness({ state: { state: "unknown", reason: "NO_IS_PUBLISHED_FIELD" } });

    const result = await h.reconcile();

    expect(result.waiting).toBe(1);
    expect(h.repo.transitions).toHaveLength(0);
    expect(
      h.lines.some((line) => line.level === "warn" && line.context?.reason === "NO_IS_PUBLISHED_FIELD"),
    ).toBe(true);
  });

  it("keeps waiting when the platform cannot be asked at all (token, network)", async () => {
    const h = harness({
      askThrows: new AppError("TOKEN_EXPIRED", { message: "token gone" }),
    });

    const result = await h.reconcile();

    expect(result.waiting).toBe(1);
    expect(h.repo.transitions).toHaveLength(0);
    expect(h.lines.some((line) => line.level === "error")).toBe(true);
  });

  it("does not touch the row when another writer moved it first", async () => {
    const h = harness({ rejectTransition: true });

    const result = await h.reconcile();

    expect(result.skipped).toBe(1);
    expect(result.published).toBe(0);
  });

  it("keeps sweeping when one row explodes", async () => {
    const h = harness({
      jobs: [makeJob({ id: "job-1" }), makeJob({ id: "job-2" })],
      askThrows: new Error("boom"),
    });

    const result = await h.reconcile();

    expect(result.scanned).toBe(2);
    expect(result.waiting).toBe(2);
  });
});

// --- Happy path -------------------------------------------------------------

describe("reconcileScheduledPosts — closing the loop", () => {
  it("publishes the job only when Facebook says the post is live, with ITS permalink", async () => {
    const h = harness();

    const result = await h.reconcile();

    expect(result.published).toBe(1);
    expect(h.asked).toEqual(["555000111_777"]);
    const transition = h.repo.transitions[0];
    expect(transition.from).toBe("scheduled_on_facebook");
    expect(transition.next.status).toBe("published");
    expect(transition.next.publishedPostId).toBe("555000111_777");
    // Facebook's own URL, not a string we assembled.
    expect(transition.next.publishedUrl).toBe("https://www.facebook.com/page/posts/777");
    expect(transition.next.publishedAt).toEqual(new Date(NOW - 9 * 60_000));
    expect(transition.auditAction).toBe(RECONCILED_PUBLISHED_AUDIT_ACTION);
  });

  /**
   * BEHAVIOUR CHANGE (was: "blocks a post somebody deleted on the Page").
   * Graph's 100/33 answer — the one that used to be read as "deleted" — is also
   * what a wrong token or a missing permission produces. The platform now
   * reports `unknown`, and this sweep must NOT settle the job on it: a `blocked`
   * row says "bài sẽ không lên" while Facebook may still publish at the hour.
   */
  it("never blocks a post Graph refuses to show — it keeps waiting", async () => {
    const h = harness({ state: { state: "unknown", reason: "OBJECT_NOT_READABLE_100_33" } });

    const result = await h.reconcile();

    expect(result.waiting).toBe(1);
    expect(result.published).toBe(0);
    // Nothing was written: the row still says "Facebook đang giữ".
    expect(h.repo.transitions).toHaveLength(0);
    expect(
      h.lines.some(
        (line) =>
          line.context?.reason === "OBJECT_NOT_READABLE_100_33" &&
          line.context?.alert === "OPERATOR_ATTENTION",
      ),
    ).toBe(true);
  });

  it("fails an unreadable post only after the horizon, telling the operator to look", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: new Date(NOW - 48 * 60 * 60_000) })],
      state: { state: "unknown", reason: "OBJECT_NOT_READABLE_100_33" },
    });

    const result = await h.reconcile({ giveUpMs: 24 * 60 * 60_000 });

    expect(result.failed).toBe(1);
    const transition = h.repo.transitions[0];
    expect(transition.next.status).toBe("failed");
    expect(transition.next.lastErrorCode).toBe(SCHEDULE_UNCONFIRMED_ERROR_CODE);
    // Never "Facebook sẽ không đăng nữa" — the operator is sent to the Page.
    expect(transition.next.lastErrorMessage).toContain("mở Trang");
    expect(transition.auditAction).toBe(RECONCILED_UNCONFIRMED_AUDIT_ACTION);
  });

  it("gives up after the horizon and tells the operator to check the Page first", async () => {
    const h = harness({
      jobs: [makeJob({ scheduledAt: new Date(NOW - 48 * 60 * 60_000) })],
      state: { state: "unknown", reason: "NO_IS_PUBLISHED_FIELD" },
    });

    const result = await h.reconcile({ giveUpMs: 24 * 60 * 60_000 });

    expect(result.failed).toBe(1);
    const transition = h.repo.transitions[0];
    expect(transition.next.status).toBe("failed");
    expect(transition.next.lastErrorCode).toBe(SCHEDULE_UNCONFIRMED_ERROR_CODE);
    // The same instruction the reaper gives: look before you re-run.
    expect(transition.next.lastErrorMessage).toContain("mở Trang");
    expect(transition.auditAction).toBe(RECONCILED_UNCONFIRMED_AUDIT_ACTION);
  });

  /**
   * DOOR 1. `failed` here does NOT mean "press Chạy lại": the row still carries
   * the id of an object Facebook created, so a re-run publishes a second post
   * next to it. Before this, the only thing standing between the operator and
   * that duplicate was a sentence next to a lit button.
   */
  it("leaves a row nobody may re-run, and says so", async () => {
    const h = harness({
      jobs: [
        makeJob({
          scheduledAt: new Date(NOW - 48 * 60 * 60_000),
          scheduledPostId: "1000000000_2000000000",
        }),
      ],
      state: { state: "unknown", reason: "NO_IS_PUBLISHED_FIELD" },
    });

    await h.reconcile({ giveUpMs: 24 * 60 * 60_000 });

    const next = h.repo.transitions[0].next;
    // The id survives the move to `failed` — it is what refuses the re-run.
    expect(next.scheduledPostId).toBe("1000000000_2000000000");
    expect(canOperatorRetryPostJob(next)).toBe(false);

    const message = next.lastErrorMessage ?? "";
    expect(message).toContain("1000000000_2000000000");
    expect(message).toContain("bài đã lên lịch");
    // The old text invited the exact duplicate this row is about.
    expect(message).not.toContain("rồi mới bấm Chạy lại");
  });

  it("fails a row that carries no platform post id — nothing could ever confirm it", async () => {
    const h = harness({ jobs: [makeJob({ scheduledPostId: null })] });

    const result = await h.reconcile();

    expect(result.failed).toBe(1);
    expect(h.asked).toHaveLength(0);
    expect(h.repo.transitions[0].next.lastErrorCode).toBe(SCHEDULE_UNCONFIRMED_ERROR_CODE);
  });

  it("waits (and shouts) when the channel or the scheduler is gone", async () => {
    const noChannel = harness({ channel: null });
    const first = await noChannel.reconcile();
    expect(first.waiting).toBe(1);
    expect(noChannel.lines.some((line) => line.context?.reason === "CHANNEL_MISSING")).toBe(true);

    const noScheduler = harness({ withoutScheduler: true });
    const second = await noScheduler.reconcile();
    expect(second.skipped).toBe(1);
    expect(
      noScheduler.lines.some((line) => line.context?.reason === "SCHEDULER_NOT_WIRED"),
    ).toBe(true);
  });
});
