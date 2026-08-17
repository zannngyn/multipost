import { describe, expect, it } from "vitest";

import { batchPollInterval } from "@/ui/hooks/usePostBatch";

import {
  BatchStatusResponseSchema,
  POST_JOB_STATUSES,
  POST_JOB_STATUS_LABELS,
  POST_JOB_STATUS_TONES,
  PostJobLogResponseSchema,
  facebookPostUrl,
  formatDurationMs,
  isSettledBatchStatus,
  isSettledJobStatus,
  jobLogSearchParams,
  parseJobLogFilter,
  type BatchStatusResponse,
} from "./post-batch.schema";

/**
 * Edge cases first (CLAUDE.md technical rule 1). Three rules must never regress:
 *  - every status of the domain state machine parses (a missing one breaks the
 *    screen the day the first job reaches it, not the day it is added);
 *  - polling STOPS when a batch is settled (a forever-poll is a silent bug);
 *  - a bad URL filter falls back to "tất cả", it never crashes the screen.
 */

function makeBatch(overrides: Partial<BatchStatusResponse> = {}): BatchStatusResponse {
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "KEM",
    format: "image_post",
    status: "running",
    totals: {
      total: 2,
      published: 0,
      failed: 0,
      blocked: 0,
      queued: 2,
      publishing: 0,
      scheduledOnFacebook: 0,
      draft: 0,
      inProgress: 2,
    },
    startedAt: "2026-08-12T03:00:00.000Z",
    finishedAt: null,
    durationMs: null,
    channels: [],
    summaryMessage: "Đang chạy",
    ...overrides,
  };
}

describe("batchPollInterval", () => {
  it("does not poll before the first payload arrives", () => {
    expect(batchPollInterval(undefined, 0)).toBe(false);
  });

  it("stops polling for every settled batch status", () => {
    for (const status of ["completed", "partial", "blocked", "failed"] as const) {
      expect(batchPollInterval(makeBatch({ status }), 3)).toBe(false);
      expect(isSettledBatchStatus(status)).toBe(true);
    }
  });

  it("keeps polling while jobs are moving, backing off to a ceiling", () => {
    expect(batchPollInterval(makeBatch({ status: "running" }), 0)).toBe(3_000);
    expect(batchPollInterval(makeBatch({ status: "pending" }), 2)).toBe(5_000);
    expect(batchPollInterval(makeBatch({ status: "running" }), 99)).toBe(8_000);
  });
});

describe("parseJobLogFilter", () => {
  it("falls back to 'every status' when the query string is empty", () => {
    expect(parseJobLogFilter(new URLSearchParams())).toEqual({ status: null, batchId: null });
  });

  it("ignores a status that is not in the state machine instead of crashing", () => {
    expect(parseJobLogFilter(new URLSearchParams("status=exploded")).status).toBeNull();
  });

  it("reads a valid status and a batch filter", () => {
    expect(parseJobLogFilter(new URLSearchParams("status=blocked&batchId=b-9"))).toEqual({
      status: "blocked",
      batchId: "b-9",
    });
  });

  it("treats a blank batchId as absent", () => {
    expect(parseJobLogFilter(new URLSearchParams("batchId=%20%20")).batchId).toBeNull();
  });
});

describe("jobLogSearchParams", () => {
  it("keeps the default out of the URL", () => {
    expect(jobLogSearchParams({ status: null, batchId: null }).toString()).toBe("");
  });

  it("round-trips with the parser", () => {
    const filter = { status: "failed", batchId: "b-1" } as const;
    expect(parseJobLogFilter(jobLogSearchParams(filter))).toEqual(filter);
  });
});

describe("post job statuses", () => {
  it("mirrors the whole domain state machine, including scheduled_on_facebook", () => {
    // The mirror is the contract: a status the server can emit but this list
    // does not know makes /jobs and /scheduled fail to parse (E8.6 regression).
    expect([...POST_JOB_STATUSES]).toEqual([
      "draft",
      "queued",
      "publishing",
      "scheduled_on_facebook",
      "published",
      "failed",
      "blocked",
    ]);
  });

  it("gives every status its own label and a tone", () => {
    const labels = POST_JOB_STATUSES.map((status) => POST_JOB_STATUS_LABELS[status]);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
    // No two statuses may read the same: "Facebook đang giữ bài" and "hệ thống
    // đang giữ bài" are different answers to "vì sao bài chưa lên?".
    expect(new Set(labels).size).toBe(POST_JOB_STATUSES.length);
    for (const status of POST_JOB_STATUSES) {
      expect(POST_JOB_STATUS_TONES[status]).toBeDefined();
    }
  });

  it("does not treat a Facebook-held post as done", () => {
    expect(isSettledJobStatus("scheduled_on_facebook")).toBe(false);
    expect(isSettledJobStatus("published")).toBe(true);
  });

  it("keeps the new status filterable from the URL", () => {
    expect(parseJobLogFilter(new URLSearchParams("status=scheduled_on_facebook")).status).toBe(
      "scheduled_on_facebook",
    );
  });
});

describe("response schemas", () => {
  it("accepts a channel that Facebook is holding", () => {
    const payload = makeBatch({
      totals: {
        total: 1,
        published: 0,
        failed: 0,
        blocked: 0,
        queued: 0,
        publishing: 0,
        scheduledOnFacebook: 1,
        draft: 0,
        inProgress: 1,
      },
      channels: [
        {
          channelId: "fbpage-a",
          postJobId: "job-1",
          status: "scheduled_on_facebook",
          attemptCount: 1,
          publishedPostId: null,
          publishedUrl: null,
          publishedAt: null,
          lastErrorCode: null,
          userMessage: "Facebook đã nhận lịch và sẽ tự đăng.",
        },
      ],
    });
    expect(BatchStatusResponseSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects a batch payload with an unknown job status", () => {
    const payload = makeBatch({
      channels: [
        {
          channelId: "facebook",
          postJobId: "job-1",
          status: "exploded" as never,
          attemptCount: 0,
          publishedPostId: null,
          publishedUrl: null,
          publishedAt: null,
          lastErrorCode: null,
          userMessage: "x",
        },
      ],
    });
    expect(BatchStatusResponseSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts an empty job log page", () => {
    const parsed = PostJobLogResponseSchema.safeParse({
      tenantId: "00000000-0000-0000-0000-000000000001",
      items: [],
      nextCursor: null,
      limit: 25,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("formatting helpers", () => {
  it("reads a duration out loud", () => {
    expect(formatDurationMs(0)).toBe("0 giây");
    expect(formatDurationMs(4_400)).toBe("4 giây");
    expect(formatDurationMs(125_000)).toBe("2 phút 5 giây");
  });

  it("builds a Facebook permalink from a post id", () => {
    expect(facebookPostUrl("1234_5678")).toBe("https://www.facebook.com/1234_5678");
  });
});
