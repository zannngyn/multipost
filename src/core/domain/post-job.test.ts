import { describe, expect, it } from "vitest";

import { AppError } from "./errors";
import {
  allowedTransitionsFrom,
  canTransitionPostJob,
  deferredPostJobQueueId,
  deriveBatchStatus,
  isFinalPostJobStatus,
  POST_JOB_STATUSES,
  postJobDuplicateKey,
  postJobQueueId,
  transitionPostJob,
  type PostJob,
  type PostJobStatus,
} from "./post-job";

function makeJob(overrides: Partial<PostJob> = {}): PostJob {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    tenantId: "00000000-0000-0000-0000-000000000001",
    batchId: "22222222-2222-2222-2222-222222222222",
    productCode: "MGKVX6310",
    color: "TÍM",
    channelId: "fbpage-a",
    format: "image_post",
    status: "draft",
    attemptCount: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
    publishedPostId: null,
    publishedUrl: null,
    publishedAt: null,
    captionText: "Giannal – MỘT NGÀY DỊU DÀNG",
    media: [{ driveFileId: "d1", fileName: "MGKVX6310-Tím (1).jpg", url: "https://cdn/1.jpg" }],
    scheduledAt: null,
    ...overrides,
  };
}

// --- Edge cases first (CLAUDE.md technical rule 1) --------------------------

describe("transitionPostJob — forbidden edges", () => {
  it("rejects a job whose status is not a known state", () => {
    const job = makeJob({ status: "weird" as PostJobStatus });
    expect(() => transitionPostJob(job, "queued")).toThrowError(
      expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }),
    );
  });

  it("rejects an unknown target status", () => {
    expect(() => transitionPostJob(makeJob(), "gone" as PostJobStatus)).toThrowError(
      expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }),
    );
  });

  it("never leaves published — a second publish is the worst possible bug", () => {
    const published = makeJob({ status: "published", publishedPostId: "123_456" });
    for (const status of POST_JOB_STATUSES) {
      expect(() => transitionPostJob(published, status)).toThrow(AppError);
    }
    expect(allowedTransitionsFrom("published")).toEqual([]);
    expect(isFinalPostJobStatus("published")).toBe(true);
  });

  it("refuses draft -> publishing (a job must be queued before a worker claims it)", () => {
    expect(canTransitionPostJob("draft", "publishing")).toBe(false);
    expect(() => transitionPostJob(makeJob(), "publishing")).toThrowError(
      expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }),
    );
  });

  it("refuses queued -> published (nothing may skip the publishing claim)", () => {
    const job = makeJob({ status: "queued" });
    expect(() =>
      transitionPostJob(job, "published", { publishedPostId: "1_2" }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }));
  });

  it("refuses self-loops", () => {
    for (const status of POST_JOB_STATUSES) {
      expect(canTransitionPostJob(status, status)).toBe(false);
    }
  });

  it("refuses published without a platform post id (a lost link is not 'published')", () => {
    const job = makeJob({ status: "publishing", attemptCount: 1 });
    expect(() => transitionPostJob(job, "published", { publishedPostId: "   " })).toThrowError(
      expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }),
    );
  });

  it("refuses blocked/failed without an error code (no unexplained dead post)", () => {
    const queued = makeJob({ status: "queued" });
    expect(() => transitionPostJob(queued, "blocked")).toThrowError(
      expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }),
    );
    const publishing = makeJob({ status: "publishing" });
    expect(() => transitionPostJob(publishing, "failed", { errorCode: "" })).toThrowError(
      expect.objectContaining({ code: "INVALID_JOB_TRANSITION" }),
    );
  });

  it("carries the offending edge in the error context so a log explains itself", () => {
    try {
      transitionPostJob(makeJob({ status: "blocked", lastErrorCode: "OUT_OF_STOCK" }), "published", {
        publishedPostId: "1_2",
      });
      throw new Error("expected a throw");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      const appError = error as AppError;
      expect(appError.context).toMatchObject({
        from: "blocked",
        to: "published",
        channel: "fbpage-a",
        product_code: "MGKVX6310",
      });
    }
  });
});

// --- Every allowed edge -----------------------------------------------------

describe("transitionPostJob — allowed edges", () => {
  const edges: Array<[PostJobStatus, PostJobStatus]> = [
    ["draft", "queued"],
    ["draft", "blocked"],
    ["draft", "failed"],
    ["queued", "publishing"],
    ["queued", "blocked"],
    ["queued", "failed"],
    ["publishing", "published"],
    ["publishing", "queued"],
    ["publishing", "failed"],
    ["publishing", "blocked"],
    ["failed", "queued"],
    ["blocked", "queued"],
  ];

  it.each(edges)("allows %s -> %s", (from, to) => {
    expect(canTransitionPostJob(from, to)).toBe(true);
    const next = transitionPostJob(makeJob({ status: from }), to, {
      errorCode: "META_ERROR",
      errorMessage: "Facebook từ chối bài đăng",
      publishedPostId: "123_456",
      publishedUrl: "https://facebook.com/123_456",
      publishedAt: new Date("2026-08-13T02:00:00.000Z"),
    });
    expect(next.status).toBe(to);
  });

  it("does not mutate the input job", () => {
    const job = makeJob({ status: "queued" });
    const next = transitionPostJob(job, "publishing");
    expect(job.status).toBe("queued");
    expect(job.attemptCount).toBe(0);
    expect(next.attemptCount).toBe(1);
  });

  it("counts one attempt per claim, so a crashed worker still leaves a trace", () => {
    let job = makeJob({ status: "queued" });
    job = transitionPostJob(job, "publishing");
    job = transitionPostJob(job, "queued", { errorCode: "META_ERROR" });
    job = transitionPostJob(job, "publishing");
    expect(job.attemptCount).toBe(2);
  });

  it("clears the last error once the post is live", () => {
    const job = makeJob({
      status: "publishing",
      attemptCount: 2,
      lastErrorCode: "META_ERROR",
      lastErrorMessage: "rate limit",
    });
    const published = transitionPostJob(job, "published", {
      publishedPostId: " 123_456 ",
      publishedUrl: "https://facebook.com/123_456",
      publishedAt: new Date("2026-08-13T02:00:00.000Z"),
    });
    expect(published).toMatchObject({
      status: "published",
      publishedPostId: "123_456",
      lastErrorCode: null,
      lastErrorMessage: null,
      attemptCount: 2,
    });
  });

  it("keeps the previous error when a retry goes back to queued without a new one", () => {
    const job = makeJob({ status: "publishing", lastErrorCode: "META_ERROR" });
    expect(transitionPostJob(job, "queued").lastErrorCode).toBe("META_ERROR");
  });

  it("records the block reason on the job (that IS the answer to 'why not live?')", () => {
    const job = makeJob({ status: "publishing", attemptCount: 1 });
    const blocked = transitionPostJob(job, "blocked", {
      errorCode: "OUT_OF_STOCK",
      errorMessage: "Mã MGKVX6310 đã hết hàng — không đăng",
      reason: "STOCK_ZERO",
    });
    expect(blocked).toMatchObject({
      status: "blocked",
      lastErrorCode: "OUT_OF_STOCK",
      lastErrorMessage: "Mã MGKVX6310 đã hết hàng — không đăng",
    });
  });
});

// --- Anti-duplicate key -----------------------------------------------------

describe("postJobDuplicateKey", () => {
  it("is the (batch, code, colour, channel, format) tuple, case-normalised", () => {
    const key = postJobDuplicateKey({
      batchId: "batch-1",
      productCode: " mgkvx6310 ",
      color: " tím ",
      channelId: "fbpage-a",
      format: "image_post",
    });
    expect(key).toBe("batch-1|MGKVX6310|TÍM|fbpage-a|image_post");
  });

  it("separates two colours of the same code on the same channel", () => {
    const base = { batchId: "b", productCode: "X", channelId: "c", format: "image_post" } as const;
    expect(postJobDuplicateKey({ ...base, color: "TÍM" })).not.toBe(
      postJobDuplicateKey({ ...base, color: "TÔM" }),
    );
  });
});

describe("postJobQueueId", () => {
  it("only emits characters BullMQ accepts in a custom id", () => {
    const id = postJobQueueId(makeJob());
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(id.length).toBeLessThanOrEqual(255);
  });

  it("stays unique for two colours that sanitise to the same ASCII", () => {
    const a = postJobQueueId(makeJob({ id: "aaaaaaaa-1111-1111-1111-111111111111", color: "TÍM" }));
    const b = postJobQueueId(makeJob({ id: "bbbbbbbb-1111-1111-1111-111111111111", color: "TÔM" }));
    expect(a).not.toBe(b);
  });

  it("gives a deferred re-enqueue a DIFFERENT id (BullMQ would drop a repeat)", () => {
    const job = makeJob();
    expect(deferredPostJobQueueId(job, 1)).not.toBe(postJobQueueId(job));
    expect(deferredPostJobQueueId(job, 1)).not.toBe(deferredPostJobQueueId(job, 2));
    expect(deferredPostJobQueueId(job, 1).length).toBeLessThanOrEqual(255);
  });
});

// --- Batch summary ----------------------------------------------------------

describe("deriveBatchStatus", () => {
  it.each([
    [[], "pending"],
    [["draft", "draft"], "pending"],
    [["queued", "published"], "running"],
    [["publishing", "failed"], "running"],
    [["published", "published"], "completed"],
    [["published", "blocked"], "partial"],
    [["published", "failed"], "partial"],
    [["blocked", "failed"], "failed"],
    [["blocked", "blocked"], "failed"],
  ] as Array<[PostJobStatus[], string]>)("%j -> %s", (statuses, expected) => {
    expect(deriveBatchStatus(statuses)).toBe(expected);
  });
});
