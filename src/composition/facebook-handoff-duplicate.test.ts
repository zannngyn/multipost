import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deriveBatchStatus,
  transitionPostJob,
  type PostJob,
  type PostJobStatus,
} from "@/core/domain/post-job";
import type { Product } from "@/core/domain/product";
import type { Clock, LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { EnqueueOptions, JobQueue } from "@/core/ports/job-queue";
import type { ApplyTransitionInput, PostBatchSummary, PostJobRepo } from "@/core/ports/post-job-repo";
import type { ProductRepo } from "@/core/ports/product-repo";
import type { ChannelConfig, ChannelConfigRepo, SignMediaUrlFn } from "@/core/ports/publisher";
import { channelWriteStubs } from "@/core/usecases/__fixtures__/channel-config-repo";
import { makeListPostJobs } from "@/core/usecases/list-post-jobs";
import { makePublishPost } from "@/core/usecases/publish-post";
import {
  PUBLISH_UNCONFIRMED_ERROR_CODE,
  STALE_SCHEDULED_PUBLISHING_REASON,
} from "@/core/usecases/reap-post-jobs";
import { SCHEDULE_UNCONFIRMED_ERROR_CODE } from "@/core/usecases/reconcile-scheduled-posts";
import type { ReadMediaBytes } from "@/core/usecases/read-media-bytes";
import { makeRetryPostJob } from "@/core/usecases/retry-post-job";

import { makeFacebookPublisher } from "@/adapters/meta/facebook-publisher";
import { makeGraphClient } from "@/adapters/meta/graph-client";

/**
 * B1 REGRESSION — the REAL Graph adapter wired into the REAL publish usecase,
 * with only the HTTP layer mocked. Unit tests on either side alone cannot catch
 * this bug: it lives exactly in the seam, in what the adapter promises about a
 * Graph answer and what the usecase reads that promise as. It therefore lives in
 * `composition/`, the only layer allowed to know both sides.
 *
 * The scenario, end to end:
 *
 *   1. /feed times out AFTER Facebook committed the scheduled post. The job may
 *      now have a post on the Page and nobody knows it.
 *   2. The job runs again (here: an operator "Chạy lại", which is the only
 *      route left — the worker no longer retries this by itself).
 *   3. The album is re-uploaded and /feed answers #506 DUPLICATE_POST, i.e.
 *      "a post like this already exists". Read as "the schedule was refused, so
 *      nothing was created", it sends the job to the publish-at-the-hour path —
 *      and the Page gets the scheduled post AND a live post in the same minute.
 *
 * The invariant under test: a job that may already have a scheduled post on
 * Facebook never reaches the normal publish path (business rule 4).
 */

const TENANT = "00000000-0000-0000-0000-000000000001";
const NOW = Date.parse("2026-08-13T02:00:00.000Z");
/** Inside the handoff window (T-30..T-12), so a handoff is what runs. */
const SCHEDULED_AT = new Date(NOW + 20 * 60_000);

const CHANNEL: ChannelConfig = {
  channelId: "fbpage-a",
  platform: "facebook",
  name: "Page A",
  externalId: "555000111",
  accessToken: "EAAsecret-token",
  status: "active",
  tokenExpiresAt: null,
};

const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function silentLogger(): Logger {
  const logger: Logger = {
    child: (_bindings: LogBindings) => logger,
    debug: (_message: string, _context?: LogContext) => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

function fixedClock(): Clock {
  return { now: () => new Date(NOW), nowMs: () => NOW };
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
    queueJobId: "pp.job-1",
    ...overrides,
  };
}

/** Same optimistic guard as the Drizzle repo: an UPDATE ... WHERE status = from. */
function makeMemoryRepo(job: PostJob) {
  const store = new Map<string, PostJob>([[job.id, job]]);
  const repo: PostJobRepo & { get(id: string): PostJob | undefined; force(next: PostJob): void } = {
    get: (id) => store.get(id),
    force: (next) => store.set(next.id, next),
    async createBatchWithJobs() {
      throw new Error("not used in this test");
    },
    async findJobById(_tenantId: string, postJobId: string) {
      return store.get(postJobId) ?? null;
    },
    async listJobsByBatch(_tenantId: string, batchId: string) {
      return [...store.values()].filter((entry) => entry.batchId === batchId);
    },
    async listJobs() {
      // Enough for the job log to render this one row: the "Chạy lại" button is
      // decided here, and it is half of the fix under test.
      return {
        items: [...store.values()].map((entry) => ({
          ...entry,
          createdAt: new Date(NOW),
          updatedAt: new Date(NOW),
        })),
        nextCursor: null,
      };
    },
    async applyTransition(input: ApplyTransitionInput) {
      const current = store.get(input.postJobId);
      if (!current || current.status !== input.from) return null;
      store.set(input.postJobId, input.next);
      return input.next;
    },
    async setQueueJobId(input) {
      const current = store.get(input.postJobId);
      if (!current || current.status !== "queued") return false;
      store.set(input.postJobId, { ...current, queueJobId: input.queueJobId });
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
    async refreshBatchStatus(_tenantId: string, batchId: string): Promise<PostBatchSummary> {
      const list = [...store.values()].filter((entry) => entry.batchId === batchId);
      const byStatus = {
        draft: 0,
        queued: 0,
        publishing: 0,
        scheduled_on_facebook: 0,
        published: 0,
        failed: 0,
        blocked: 0,
      } as Record<PostJobStatus, number>;
      return {
        batchId,
        tenantId: TENANT,
        productCode: list[0]?.productCode ?? "",
        status: deriveBatchStatus(list.map((entry) => entry.status)),
        total: list.length,
        byStatus,
        startedAt: new Date(NOW),
        finishedAt: null,
        jobs: list,
      };
    },
    async getBatchSummary() {
      return null;
    },
  };
  return repo;
}

function makeProducts(): ProductRepo {
  const product: Product = {
    content: { code: "MGKVX6310", name: "Giannal", description: null, category: null, season: null },
    operational: { stockRaw: "104", noteRaw: "", colorsRaw: "TÍM" },
    hasConflict: false,
    sourceRows: [2],
  };
  return { findByCode: async () => product, upsertMany: async () => 0, deleteStale: async () => 0 };
}

function makeChannels(): ChannelConfigRepo {
  return {
    findChannel: async () => CHANNEL,
    listChannels: async () => [CHANNEL],
    getPublishSettings: async () => ({ spacingMs: 0, retryBackoffMs: 1_000, maxAttempts: 3 }),
    ...channelWriteStubs(),
  };
}

function makeQueue() {
  const enqueued: Array<{ name: string; payload: unknown; opts?: EnqueueOptions }> = [];
  const queue: JobQueue & { enqueued: typeof enqueued } = {
    enqueued,
    async enqueue(name, payload, opts) {
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

const signMediaUrl: SignMediaUrlFn = (input) => ({
  url: `${input.baseUrl}/api/media/${input.assetId}`,
  path: `/api/media/${input.assetId}`,
  expiresAtMs: NOW + 6 * 60 * 60 * 1000,
  signature: "deadbeef",
});

function harness(fetchImpl: typeof fetch, job: PostJob = makeJob()) {
  const logger = silentLogger();
  const repo = makeMemoryRepo(job);
  const queue = makeQueue();
  const readMediaBytes = vi.fn<ReadMediaBytes>(async () => ({
    bytes: PHOTO_BYTES,
    mimeType: "image/jpeg",
  }));
  const facebook = makeFacebookPublisher({
    graph: makeGraphClient({ logger, fetchImpl, version: "v23.0" }),
    logger,
  });
  const channels = makeChannels();
  const clock = fixedClock();
  const publish = makePublishPost({
    postJobs: repo,
    products: makeProducts(),
    channels,
    publishers: { facebook },
    queue,
    clock,
    logger,
    signMediaUrl,
    mediaBaseUrl: () => "https://mysp.example.com",
    readMediaBytes,
  });
  // The operator's button and the screen that draws it, on the SAME repo the
  // worker uses: the whole point of note 1 is that these three must agree.
  const retry = makeRetryPostJob({ postJobs: repo, channels, queue, clock, logger });
  const listJobs = makeListPostJobs({ postJobs: repo, logger });
  return { publish, retry, listJobs, repo, queue };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("handoff — a job that may already have a scheduled post never publishes normally", () => {
  // Only Date is faked: the adapter measures the remaining lead with the wall
  // clock (it has no Clock port), while the usecase uses the injected one. They
  // are the same clock in production and must be the same clock here.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops at the timeout, and #506 on a later attempt does NOT open the straight-publish path", async () => {
    // --- Attempt 1: Facebook commits the post, the answer never arrives -------
    const calls: string[] = [];
    const timingOut = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith("/photos")) {
        calls.push("photos");
        return jsonResponse({ id: "photo-1" });
      }
      calls.push("feed");
      throw new TypeError("socket hang up");
    });
    const first = harness(timingOut as unknown as typeof fetch);

    await expect(first.publish({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "META_ERROR",
    });

    expect(calls).toEqual(["photos", "feed"]);
    const afterTimeout = first.repo.get("job-1");
    // NOT re-queued: another handoff could ask for a SECOND scheduled post, and
    // a wake-up at the hour would publish next to the first one.
    expect(afterTimeout?.status).toBe("failed");
    expect(afterTimeout?.lastErrorCode).toBe("HANDOFF_FAILED");
    expect(afterTimeout?.lastErrorMessage).toContain("CÓ THỂ đã được tạo trên Trang");
    expect(first.queue.enqueued).toHaveLength(0);

    // --- Attempt 2: an operator runs it again; Facebook answers #506 ----------
    const paths: string[] = [];
    const duplicate = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith("/photos")) {
        paths.push("photos");
        return jsonResponse({ id: "photo-2" });
      }
      paths.push("feed");
      return jsonResponse(
        {
          error: {
            code: 506,
            message: "Duplicate status message",
            type: "OAuthException",
            fbtrace_id: "trace-506",
          },
        },
        400,
      );
    });
    const second = harness(
      duplicate as unknown as typeof fetch,
      // The row as the operator's retry leaves it: queued again, same hour.
      makeJob({ status: "queued", attemptCount: 1, lastErrorCode: "HANDOFF_FAILED" }),
    );

    await expect(second.publish({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "META_ERROR",
      context: { graph_code: 506 },
    });

    expect(paths).toEqual(["photos", "feed"]);
    const afterDuplicate = second.repo.get("job-1");
    // THE assertion this file exists for. Before the fix the job went back to
    // `queued` with a wake-up at T, which published a second post next to the
    // one Facebook had been holding since attempt 1.
    expect(afterDuplicate?.status).toBe("failed");
    expect(afterDuplicate?.publishedPostId).toBeNull();
    expect(second.queue.enqueued).toHaveLength(0);
    // No /photos + /feed pair with `published=true` anywhere: the normal publish
    // path was never entered.
    expect(paths.filter((entry) => entry === "feed")).toHaveLength(1);
  });

  it("still falls back to the hour when the refusal happened BEFORE any /feed", async () => {
    // The case the flag exists for: the album upload ate the lead, so the
    // adapter refuses before dispatching anything. Nothing can exist on the
    // Page, so publishing at the hour is safe — and the post is not lost.
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (!String(url).endsWith("/photos")) throw new Error("/feed must not be called");
      // The upload drags on past Facebook's ~10 minute minimum lead.
      vi.setSystemTime(Date.now() + 11 * 60_000);
      return jsonResponse({ id: "photo-1" });
    });
    const h = harness(fetchImpl as unknown as typeof fetch);

    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.outcome).toBe("deferred");
    expect(result.errorCode).toBe("HANDOFF_REFUSED");
    expect(h.repo.get("job-1")?.status).toBe("queued");
    // One wake-up, exactly at the hour, to publish on the normal path. The
    // usecase's clock is fixed at NOW, so the delay is the full 20 minutes.
    expect(h.queue.enqueued).toHaveLength(1);
    expect(h.queue.enqueued[0]?.opts?.delayMs).toBe(SCHEDULED_AT.getTime() - NOW);
  });
});

/**
 * Gate note 1 — the other half of the same invariant, and the one the previous
 * round left open: the WORKER stops such a job, but the operator's "Chạy lại"
 * button put it straight back into the queue, and from `queued` the clock alone
 * decided which kind of double post came out:
 *
 *      T-30 ──────────── T-12 ──────── T ────────►
 *        │  hand_off      │   wait      │  publish_now
 *        │  2nd SCHEDULED │   publish   │  live post next to the
 *        │  post          │   at T      │  one Facebook holds
 *
 * All three start from a legal `queued` row, so no status guard downstream can
 * see them coming. The refusal therefore lives on the row itself, and this file
 * checks it with the REAL Graph adapter behind it: the proof is that the mocked
 * `fetch` is never touched, i.e. not one byte reached Facebook.
 */
describe("operator retry — a job that may hold a scheduled post is refused at every hour", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The row exactly as failUnconfirmedHandoff leaves it. */
  function unconfirmedHandoff(scheduledAt: Date): PostJob {
    return makeJob({
      status: "failed",
      attemptCount: 1,
      lastErrorCode: "HANDOFF_FAILED",
      lastErrorMessage:
        "Không xác nhận được kết quả giao lịch cho Facebook (Không kết nối được tới Facebook) — " +
        "bài hẹn CÓ THỂ đã được tạo trên Trang. Hệ thống dừng lại và KHÔNG tự đăng lại để tránh đăng trùng: " +
        "hãy mở Trang, mục bài đã lên lịch, xoá bài nếu thấy rồi hẹn lại.",
      scheduledAt,
      queueJobId: null,
    });
  }

  /**
   * A Facebook that would happily take a SECOND schedule (a real Page does: the
   * album is re-uploaded, so #506 is not guaranteed) and would happily publish.
   * If any call reaches it, the Page ends up with two posts.
   */
  function willingFacebook(calls: string[]) {
    return vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith("/photos")) {
        calls.push("photos");
        return jsonResponse({ id: "photo-second" });
      }
      calls.push("feed");
      return jsonResponse({ id: "555000111_SECOND" });
    });
  }

  it.each([
    ["inside the handoff window (T-30..T-12) — would create a SECOND scheduled post", 20 * 60_000],
    ["in the dead zone (T-12..T) — would wake at T and publish next to it", 5 * 60_000],
    ["after the hour — would publish immediately next to it", -3 * 60_000],
  ])("refuses the retry pressed %s", async (_label, offsetMs) => {
    const calls: string[] = [];
    const fetchImpl = willingFacebook(calls);
    const h = harness(
      fetchImpl as unknown as typeof fetch,
      unconfirmedHandoff(new Date(NOW + offsetMs)),
    );

    // 1. The screen does not offer the action in the first place.
    const log = await h.listJobs({ tenantId: TENANT });
    expect(log.items[0]).toMatchObject({ status: "failed", canRetry: false });
    expect(log.items[0].userMessage).toContain("CÓ THỂ đã được tạo trên Trang");

    // 2. And the usecase refuses it anyway — the API route is reachable without
    //    the screen, and a stale page still has the old button.
    await expect(h.retry({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "DUPLICATE_POST_BLOCKED",
      context: { reason: "HANDOFF_OUTCOME_UNKNOWN" },
    });

    // 3. Nothing was queued, so no worker run can follow.
    expect(h.queue.enqueued).toHaveLength(0);
    expect(h.repo.get("job-1")?.status).toBe("failed");
    expect(h.repo.get("job-1")?.queueJobId).toBeNull();

    // 4. And if a worker did wake on this row anyway (a stale entry from before
    //    the failure), the status guard sends it home without a call.
    const afterWorker = await h.publish({ tenantId: TENANT, postJobId: "job-1" });
    expect(afterWorker.outcome).toBe("skipped");

    // THE assertion: not one request reached Facebook on any of the three paths.
    expect(calls).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.repo.get("job-1")?.publishedPostId).toBeNull();
    expect(h.repo.get("job-1")?.scheduledPostId).toBeNull();
  });

  it("still lets an ORDINARY failure of a scheduled post be retried", async () => {
    // The guard must not swallow real work: this job's handoff never happened,
    // nothing is waiting on the Page, and the operator must be able to re-run it.
    const calls: string[] = [];
    const h = harness(
      willingFacebook(calls) as unknown as typeof fetch,
      makeJob({
        status: "failed",
        lastErrorCode: "PUBLISH_FAILED",
        lastErrorMessage: "Đăng bài thất bại sau số lần thử cho phép.",
        queueJobId: null,
      }),
    );

    const log = await h.listJobs({ tenantId: TENANT });
    expect(log.items[0].canRetry).toBe(true);

    const result = await h.retry({ tenantId: TENANT, postJobId: "job-1" });

    expect(result.status).toBe("queued");
    expect(h.queue.enqueued).toHaveLength(1);
  });
});

/**
 * The other three doors of the same shape, found by the gate after the handoff
 * one was closed. Each one produces a `failed` row that an operator could
 * re-run while Facebook holds — or may hold — the post:
 *
 *   1. the reconciliation sweep gives up: `failed` + SCHEDULE_UNCONFIRMED, and
 *      the row STILL CARRIES the id of a post Facebook really created;
 *   2. the reaper stops a scheduled job stuck in `publishing`, which is exactly
 *      what a worker killed after /feed leaves behind;
 *   3. the handoff succeeds but the row moved under us (the reaper fired while a
 *      10-photo album was uploading) — Facebook holds the post, our row says
 *      `failed`.
 *
 * Checked here, with the REAL Graph adapter wired in, because the proof is
 * negative: the mocked `fetch` is never touched, i.e. not one byte reached
 * Facebook on any road out of those rows.
 */
describe("the three remaining doors — no re-run for a row the platform may hold a post for", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** DOOR 1 — the row `giveUp` in reconcile-scheduled-posts leaves behind. */
  function reconcilerGaveUp(scheduledAt: Date): PostJob {
    return makeJob({
      status: "failed",
      attemptCount: 1,
      lastErrorCode: SCHEDULE_UNCONFIRMED_ERROR_CODE,
      lastErrorMessage:
        "Không xác nhận được bài đã hẹn trên Facebook sau nhiều lần kiểm tra (mã bài 555000111_HELD) — " +
        "bài CÓ THỂ vẫn nằm trên Trang.",
      // The id of a post Facebook accepted: this row is not a suspicion.
      scheduledPostId: "555000111_HELD",
      scheduledAt,
      queueJobId: null,
    });
  }

  /** DOOR 2 — the row the reaper leaves on a SCHEDULED job stuck in publishing. */
  function reaperStoppedScheduled(scheduledAt: Date): PostJob {
    return transitionPostJob(
      makeJob({ status: "publishing", attemptCount: 1, scheduledAt, queueJobId: null }),
      "failed",
      {
        reason: STALE_SCHEDULED_PUBLISHING_REASON,
        errorCode: PUBLISH_UNCONFIRMED_ERROR_CODE,
        errorMessage:
          "Bài hẹn giờ bị kẹt ở trạng thái đang đăng (worker dừng giữa chừng) — " +
          "Facebook CÓ THỂ đã nhận bài này.",
      },
    );
  }

  it.each([
    ["DOOR 1 (reconciler gave up, id in hand)", reconcilerGaveUp],
    ["DOOR 2 (reaper stopped a scheduled job mid-publish)", reaperStoppedScheduled],
  ])("%s: the button is dark, the API refuses, Facebook is never called", async (_label, row) => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      calls.push(String(url));
      return jsonResponse({ id: "555000111_SECOND" });
    });
    // The hour is already inside the handoff window, i.e. the most dangerous
    // moment: a re-queue here asks Facebook for a SECOND scheduled post.
    const h = harness(fetchImpl as unknown as typeof fetch, row(new Date(NOW + 20 * 60_000)));

    const log = await h.listJobs({ tenantId: TENANT });
    expect(log.items[0]).toMatchObject({ status: "failed", canRetry: false });

    await expect(h.retry({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "DUPLICATE_POST_BLOCKED",
    });

    expect(h.queue.enqueued).toHaveLength(0);
    expect(h.repo.get("job-1")?.status).toBe("failed");
    expect(calls).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * DOOR 3, played out for real: the reaper marks the row `failed` WHILE the
   * album is still uploading (15' stale window vs. a slow 10-photo album), then
   * /feed succeeds and Facebook is holding a post our row knows nothing about.
   */
  it("DOOR 3: a handoff that wins on Facebook but loses the row still refuses the re-run", async () => {
    let repo: ReturnType<typeof makeMemoryRepo> | null = null;
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.includes("/photos")) {
        calls.push("photos");
        // The reaper fires mid-upload, exactly as it would at 15 minutes.
        const current = repo?.get("job-1");
        if (current && current.status === "publishing") {
          repo?.force(
            transitionPostJob(current, "failed", {
              reason: STALE_SCHEDULED_PUBLISHING_REASON,
              errorCode: PUBLISH_UNCONFIRMED_ERROR_CODE,
              errorMessage: "Bài hẹn giờ bị kẹt ở trạng thái đang đăng (worker dừng giữa chừng).",
            }),
          );
        }
        return jsonResponse({ id: "photo-1" });
      }
      calls.push("feed");
      // Facebook accepted the schedule. The post EXISTS from here on.
      return jsonResponse({ id: "555000111_HELD" });
    });

    const h = harness(fetchImpl as unknown as typeof fetch);
    repo = h.repo;

    // The worker run ends loudly: it may not pretend the handoff never happened.
    const error = await h.publish({ tenantId: TENANT, postJobId: "job-1" }).then(
      () => null,
      (caught: unknown) => caught as { code: string; context?: Record<string, unknown> },
    );
    expect(error?.code).toBe("INTERNAL");
    expect(error?.context).toMatchObject({
      scheduled_post_id: "555000111_HELD",
      row_status_now: "failed",
      row_error_code_now: PUBLISH_UNCONFIRMED_ERROR_CODE,
    });
    expect(calls).toEqual(["photos", "feed"]);

    // And the row the reaper left behind offers no way back into the queue.
    const log = await h.listJobs({ tenantId: TENANT });
    expect(log.items[0]).toMatchObject({ status: "failed", canRetry: false });
    await expect(h.retry({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "DUPLICATE_POST_BLOCKED",
      context: { reason: "PUBLISH_OUTCOME_UNKNOWN" },
    });
    expect(h.queue.enqueued).toHaveLength(0);
    // Nothing more was sent: the two calls above are still the only ones.
    expect(calls).toEqual(["photos", "feed"]);
  });
});
