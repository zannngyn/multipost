import { describe, expect, it } from "vitest";

import { deriveBatchStatus, type PostJob, type PostJobStatus } from "@/core/domain/post-job";
import {
  POST_JOB_PROGRESS_STEPS,
  waitingProgress,
  workingProgress,
  type PostJobProgress,
} from "@/core/domain/post-job-progress";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { JobProgressStore } from "@/core/ports/job-progress";
import type { PostBatchSummary, PostJobRepo } from "@/core/ports/post-job-repo";

import { makeGetBatchStatus } from "./get-batch-status";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * E7.5 — the per-channel result table + batch totals. Read-only, so every test
 * is about WHAT the operator sees, especially "vì sao bài này không lên".
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const BATCH = "22222222-2222-2222-2222-222222222222";
const STARTED_AT = new Date("2026-08-13T02:00:00.000Z");
const FINISHED_AT = new Date("2026-08-13T02:04:00.000Z");

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

function job(overrides: Partial<PostJob> = {}): PostJob {
  return {
    id: "job-1",
    tenantId: TENANT,
    batchId: BATCH,
    productCode: "MGKVX6310",
    color: "TÍM",
    channelId: "fbpage-a",
    format: "image_post",
    status: "published",
    attemptCount: 1,
    lastErrorCode: null,
    lastErrorMessage: null,
    publishedPostId: "100_200",
    publishedUrl: "https://facebook.com/100_200",
    publishedAt: FINISHED_AT,
    scheduledPostId: null,
    captionText: "caption",
    media: [{ driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" }],
    scheduledAt: null,
    queueJobId: null,
    ...overrides,
  };
}

function summaryOf(jobs: PostJob[], finished = true): PostBatchSummary {
  const byStatus: Record<PostJobStatus, number> = {
    draft: 0,
    queued: 0,
    publishing: 0,
    scheduled_on_facebook: 0,
    published: 0,
    failed: 0,
    blocked: 0,
  };
  for (const entry of jobs) byStatus[entry.status] += 1;
  return {
    batchId: BATCH,
    tenantId: TENANT,
    productCode: jobs[0]?.productCode ?? "",
    status: deriveBatchStatus(jobs.map((entry) => entry.status)),
    total: jobs.length,
    byStatus,
    startedAt: STARTED_AT,
    finishedAt: finished ? FINISHED_AT : null,
    jobs,
  };
}

/**
 * A progress store that answers from a fixed map, and remembers which ids it was
 * asked about — law 3.1 is partly "do not even ask about a settled job".
 */
function fakeProgress(entries: Record<string, PostJobProgress> = {}) {
  const askedFor: string[][] = [];
  const store: JobProgressStore = {
    async report() {},
    async clear() {},
    async read(_tenantId, postJobIds) {
      askedFor.push([...postJobIds]);
      const map = new Map<string, PostJobProgress>();
      for (const id of postJobIds) {
        const entry = entries[id];
        if (entry) map.set(id, entry);
      }
      return map;
    },
  };
  return { store, askedFor };
}

/** Redis is down: `read` throws instead of honouring its no-throw contract. */
function throwingProgress(): JobProgressStore {
  return {
    async report() {},
    async clear() {},
    async read() {
      throw new Error("ECONNREFUSED 127.0.0.1:6379");
    },
  };
}

function harness(summary: PostBatchSummary | null, progress?: JobProgressStore) {
  const lines: LogLine[] = [];
  const postJobs = {
    async getBatchSummary(_tenantId: string, _batchId: string) {
      return summary;
    },
  } as unknown as PostJobRepo;
  return {
    getBatchStatus: makeGetBatchStatus({
      postJobs,
      progress: progress ?? fakeProgress().store,
      logger: recordingLogger(lines),
    }),
    lines,
  };
}

// --- Edge cases first -------------------------------------------------------

describe("getBatchStatus — rejected calls", () => {
  it.each([
    ["a malformed tenant id", { tenantId: testTenantId("nope"), batchId: BATCH }],
    ["an empty batch id", { tenantId: TENANT, batchId: "   " }],
  ])("rejects %s", async (_label, input) => {
    const { getBatchStatus } = harness(summaryOf([job()]));
    await expect(getBatchStatus(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  // Bug B5 (doc 10 §7): its OWN code, so the route can answer 404 instead of
  // telling the caller their well-formed request was malformed.
  it("reports an unknown batch (or one of another tenant) as BATCH_NOT_FOUND", async () => {
    const { getBatchStatus } = harness(null);
    await expect(getBatchStatus({ tenantId: TENANT, batchId: BATCH })).rejects.toMatchObject({
      code: "BATCH_NOT_FOUND",
      context: { reason: "BATCH_NOT_FOUND", batch_id: BATCH },
    });
  });
});

// --- The summary itself -----------------------------------------------------

describe("getBatchStatus — per-channel table (brief §3/§6)", () => {
  it("returns one line per channel with the link and the Vietnamese reason", async () => {
    const { getBatchStatus } = harness(
      summaryOf([
        job(),
        job({
          id: "job-2",
          channelId: "fbpage-b",
          status: "blocked",
          attemptCount: 0,
          publishedPostId: null,
          publishedUrl: null,
          publishedAt: null,
          scheduledPostId: null,
          lastErrorCode: "OUT_OF_STOCK",
          lastErrorMessage: "Mã MGKVX6310 đã hết hàng — không đăng",
        }),
      ]),
    );

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(result.status).toBe("partial");
    expect(result.totals).toEqual({
      total: 2,
      published: 1,
      failed: 0,
      blocked: 1,
      queued: 0,
      publishing: 0,
      scheduledOnFacebook: 0,
      draft: 0,
      inProgress: 0,
    });
    expect(result.channels).toEqual([
      expect.objectContaining({
        channelId: "fbpage-a",
        status: "published",
        publishedPostId: "100_200",
        publishedUrl: "https://facebook.com/100_200",
        userMessage: "Đã đăng lên kênh (mã bài 100_200)",
      }),
      expect.objectContaining({
        channelId: "fbpage-b",
        status: "blocked",
        lastErrorCode: "OUT_OF_STOCK",
        userMessage: "Mã MGKVX6310 đã hết hàng — không đăng",
      }),
    ]);
    expect(result.startedAt).toEqual(STARTED_AT);
    expect(result.finishedAt).toEqual(FINISHED_AT);
    expect(result.durationMs).toBe(240_000);
  });

  it("calls a batch where every job was blocked 'blocked', not 'failed' (gate note #2)", async () => {
    const blocked = (id: string, channelId: string): PostJob =>
      job({
        id,
        channelId,
        status: "blocked",
        attemptCount: 0,
        publishedPostId: null,
        publishedUrl: null,
        publishedAt: null,
        scheduledPostId: null,
        lastErrorCode: "OUT_OF_STOCK",
        lastErrorMessage: "Mã MGKVX6310 đã hết hàng — không đăng",
      });
    const { getBatchStatus } = harness(
      summaryOf([blocked("job-1", "fbpage-a"), blocked("job-2", "fbpage-b")]),
    );

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(result.status).toBe("blocked");
    expect(result.totals.blocked).toBe(2);
    expect(result.summaryMessage).toContain("bị chặn");
    expect(result.summaryMessage).not.toContain("lỗi");
  });

  it("shows no finish time while a job is still running", async () => {
    const { getBatchStatus } = harness(
      summaryOf([job(), job({ id: "job-2", channelId: "fbpage-b", status: "queued" })], false),
    );

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(result.status).toBe("running");
    expect(result.finishedAt).toBeNull();
    expect(result.durationMs).toBeNull();
    expect(result.totals.inProgress).toBe(1);
    expect(result.channels[1].userMessage).toBe("Đang chờ trong hàng đợi để đăng");
  });

  it("explains a failed channel with its attempt count when no message was stored", async () => {
    const { getBatchStatus } = harness(
      summaryOf([
        job({
          status: "failed",
          attemptCount: 3,
          publishedPostId: null,
          publishedUrl: null,
          publishedAt: null,
          scheduledPostId: null,
          lastErrorCode: "PUBLISH_FAILED",
          lastErrorMessage: null,
        }),
      ]),
    );

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(result.status).toBe("failed");
    expect(result.channels[0].userMessage).toContain("3 lần thử");
    expect(result.channels[0].userMessage).toContain("PUBLISH_FAILED");
  });
});

// --- Progress: decoration, and only where the status allows it (design §5.7) -

describe("getBatchStatus — progress, edge cases first", () => {
  const NOW = new Date("2026-08-13T02:01:00.000Z");

  const running = (overrides: Partial<PostJob> = {}): PostJob =>
    job({
      status: "publishing",
      publishedPostId: null,
      publishedUrl: null,
      publishedAt: null,
      ...overrides,
    });

  it("keeps every row when the progress store is down, with progress: null and one warn", async () => {
    const { getBatchStatus, lines } = harness(
      summaryOf([running(), running({ id: "job-2", channelId: "fbpage-b", status: "queued" })], false),
      throwingProgress(),
    );

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    // The decoration is gone; NOTHING else is.
    expect(result.channels.map((channel) => channel.progress)).toEqual([null, null]);
    expect(result.channels.map((channel) => channel.channelId)).toEqual(["fbpage-a", "fbpage-b"]);
    expect(result.channels[1].userMessage).toBe("Đang chờ trong hàng đợi để đăng");
    expect(result.totals.inProgress).toBe(2);
    expect(lines.filter((line) => line.level === "error")).toHaveLength(0);
    expect(
      lines.find(
        (line) => line.level === "warn" && line.context?.error_code === "QUEUE_ERROR",
      )?.context,
    ).toMatchObject({ tenant_id: TENANT, batch_id: BATCH, post_job_count: 2 });
  });

  it("gives a failed job no progress, even when a key still describes an upload", async () => {
    const stale = workingProgress("uploading_media", {
      attempt: 1,
      now: NOW,
      doneCount: 3,
      totalCount: 10,
      currentItem: "IMG_2041.jpg",
    });
    const { store, askedFor } = fakeProgress({ "job-1": stale });
    const { getBatchStatus } = harness(
      summaryOf([
        job({
          status: "failed",
          lastErrorCode: "PUBLISH_FAILED",
          publishedPostId: null,
          publishedUrl: null,
          publishedAt: null,
        }),
      ]),
      store,
    );

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(result.channels[0].progress).toBeNull();
    // Law 3.1 upstream of the round trip: a settled job is not even asked about.
    expect(askedFor.flat()).not.toContain("job-1");
  });

  it("shows a post Facebook is holding, counting down to the hour it will publish", async () => {
    // The one case where the remaining time is exact: the operator chose it.
    // The reassurance is the point — this post goes out at that hour whether or
    // not our server is running.
    const publishAt = new Date(NOW.getTime() + 45 * 60_000);
    const { store } = fakeProgress({
      "job-1": waitingProgress("waiting_on_facebook", {
        attempt: 1,
        waitUntil: publishAt,
        now: NOW,
      }),
    });
    const { getBatchStatus } = harness(
      summaryOf([job({ status: "scheduled_on_facebook", scheduledPostId: "sched-1" })], false),
      store,
    );

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(result.channels[0].progress).toMatchObject({
      stage: "waiting_on_facebook",
      waitUntil: publishAt,
      doneCount: null,
      totalCount: null,
    });
  });

  it("refuses a stale upload key on a post Facebook is already holding", async () => {
    // The reason `scheduled_on_facebook` pins its stage: the status is stable,
    // so a `waiting_on_facebook` write that failed (best-effort) would leave the
    // previous key claiming "đang tải ảnh 3/10" for DAYS about a post that is
    // finished and handed over.
    const { store } = fakeProgress({
      "job-1": workingProgress("uploading_media", {
        attempt: 1,
        now: NOW,
        doneCount: 3,
        totalCount: 10,
      }),
    });
    const { getBatchStatus } = harness(
      summaryOf([job({ status: "scheduled_on_facebook", scheduledPostId: "sched-1" })], false),
      store,
    );

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(result.channels[0].progress).toBeNull();
    expect(result.channels[0].status).toBe("scheduled_on_facebook");
  });

  it("drops a stale key whose stage is off the stepper instead of drawing step -1", async () => {
    const { store } = fakeProgress({
      "job-1": workingProgress("stopped", { attempt: 1, now: NOW }),
    });
    const { getBatchStatus } = harness(summaryOf([running()], false), store);

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(result.channels[0].progress).toBeNull();
    expect(result.channels[0].status).toBe("publishing");
  });

  it("renders a row with progress next to a row without one", async () => {
    const { store } = fakeProgress({
      "job-1": workingProgress("uploading_media", {
        attempt: 1,
        now: NOW,
        doneCount: 3,
        totalCount: 10,
        currentItem: "IMG_2041.jpg",
      }),
    });
    const { getBatchStatus } = harness(
      summaryOf([running(), running({ id: "job-2", channelId: "fbpage-b", status: "queued" })], false),
      store,
    );

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(result.channels[0].progress).toEqual({
      stage: "uploading_media",
      stepIndex: 2,
      label: "Đang tải ảnh lên kênh 3/10 (IMG_2041.jpg)",
      doneCount: 3,
      totalCount: 10,
      currentItem: "IMG_2041.jpg",
      stageStartedAt: NOW,
      // §3.2 — the upload step never carries a deadline.
      waitUntil: null,
    });
    expect(result.channels[1].progress).toBeNull();
  });

  it("passes the real deadline through for a waiting stage, and no counts", async () => {
    const waitUntil = new Date("2026-08-13T02:02:00.000Z");
    const { store } = fakeProgress({
      "job-1": waitingProgress("waiting_for_spacing", { attempt: 1, waitUntil, now: NOW }),
    });
    const { getBatchStatus } = harness(summaryOf([running({ status: "queued" })], false), store);

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(result.channels[0].progress).toMatchObject({
      stage: "waiting_for_spacing",
      stepIndex: 0,
      waitUntil,
      doneCount: null,
      totalCount: null,
    });
  });

  it("ships the stepper labels from the domain so the screen keeps no copy", async () => {
    const { getBatchStatus } = harness(summaryOf([job()]));

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(result.progressSteps).toEqual([...POST_JOB_PROGRESS_STEPS]);
  });

  it("does not call the store at all for a batch nobody is working on", async () => {
    const { store, askedFor } = fakeProgress();
    const { getBatchStatus } = harness(summaryOf([job()]), store);

    await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(askedFor).toEqual([]);
  });
});

describe("getBatchStatus — logging", () => {
  it("logs every channel with its status and error code", async () => {
    const { getBatchStatus, lines } = harness(
      summaryOf([
        job(),
        job({
          id: "job-2",
          channelId: "fbpage-b",
          status: "failed",
          lastErrorCode: "PUBLISH_FAILED",
          publishedPostId: null,
        }),
      ]),
    );

    await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    const line = lines.find((entry) => entry.message === "Batch status read");
    expect(line?.context).toMatchObject({
      tenant_id: TENANT,
      batch_id: BATCH,
      batch_status: "partial",
      channels: [
        { channel: "fbpage-a", status: "published", error_code: null },
        { channel: "fbpage-b", status: "failed", error_code: "PUBLISH_FAILED" },
      ],
    });
  });
});

/**
 * Onboarding phase 3: a post can be built from data an operator typed, and the
 * tracking screen is where "bài này lấy dữ liệu từ đâu" gets asked — months
 * after the product row may have been re-synced or deleted. The answer must
 * therefore come from the JOB, which is why nothing here joins a product.
 */
describe("getBatchStatus — product origin", () => {
  it("defaults to sheet for a job created before the stamp existed", async () => {
    const { getBatchStatus } = harness(summaryOf([job()]));

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(result.productOrigin).toBe("sheet");
    expect(result.channels[0]?.productOrigin).toBe("sheet");
  });

  it("carries the manual stamp onto the batch and onto its channel line", async () => {
    const { getBatchStatus } = harness(
      summaryOf([
        job({ productOrigin: "manual" }),
        job({ id: "job-2", channelId: "fbpage-b", productOrigin: "manual" }),
      ]),
    );

    const result = await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    expect(result.productOrigin).toBe("manual");
    expect(result.channels.map((channel) => channel.productOrigin)).toEqual(["manual", "manual"]);
  });

  it("logs the origin on the batch line and on every channel", async () => {
    const { getBatchStatus, lines } = harness(summaryOf([job({ productOrigin: "manual" })]));

    await getBatchStatus({ tenantId: TENANT, batchId: BATCH });

    const line = lines.find((entry) => entry.message === "Batch status read");
    expect(line?.context).toMatchObject({
      product_origin: "manual",
      channels: [{ channel: "fbpage-a", product_origin: "manual" }],
    });
  });
});
