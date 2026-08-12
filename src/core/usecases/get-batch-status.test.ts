import { describe, expect, it } from "vitest";

import { deriveBatchStatus, type PostJob, type PostJobStatus } from "@/core/domain/post-job";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { PostBatchSummary, PostJobRepo } from "@/core/ports/post-job-repo";

import { makeGetBatchStatus } from "./get-batch-status";

/**
 * E7.5 — the per-channel result table + batch totals. Read-only, so every test
 * is about WHAT the operator sees, especially "vì sao bài này không lên".
 */

const TENANT = "00000000-0000-0000-0000-000000000001";
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
    captionText: "caption",
    media: [{ driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" }],
    scheduledAt: null,
    ...overrides,
  };
}

function summaryOf(jobs: PostJob[], finished = true): PostBatchSummary {
  const byStatus: Record<PostJobStatus, number> = {
    draft: 0,
    queued: 0,
    publishing: 0,
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

function harness(summary: PostBatchSummary | null) {
  const lines: LogLine[] = [];
  const postJobs = {
    async getBatchSummary(_tenantId: string, _batchId: string) {
      return summary;
    },
  } as unknown as PostJobRepo;
  return { getBatchStatus: makeGetBatchStatus({ postJobs, logger: recordingLogger(lines) }), lines };
}

// --- Edge cases first -------------------------------------------------------

describe("getBatchStatus — rejected calls", () => {
  it.each([
    ["a malformed tenant id", { tenantId: "nope", batchId: BATCH }],
    ["an empty batch id", { tenantId: TENANT, batchId: "   " }],
  ])("rejects %s", async (_label, input) => {
    const { getBatchStatus } = harness(summaryOf([job()]));
    await expect(getBatchStatus(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("reports an unknown batch (or one of another tenant) as not found", async () => {
    const { getBatchStatus } = harness(null);
    await expect(getBatchStatus({ tenantId: TENANT, batchId: BATCH })).rejects.toMatchObject({
      code: "INVALID_INPUT",
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
