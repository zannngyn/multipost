import { describe, expect, it } from "vitest";

import { batchPollInterval } from "@/ui/hooks/usePostBatch";
import { jobLogPollInterval, nextJobLogPoll } from "@/ui/hooks/usePostJobs";

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
  type PostJobLogEntry,
  type PostJobLogResponse,
  type PostJobStatus,
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
    productOrigin: "sheet",
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
    progressSteps: [],
    ...overrides,
  };
}

/** A channel row with no live progress — the common case, and the old shape. */
function makeChannel(
  overrides: Partial<BatchStatusResponse["channels"][number]> = {},
): BatchStatusResponse["channels"][number] {
  return {
    channelId: "fbpage-a",
    postJobId: "job-1",
    status: "queued",
    productOrigin: "sheet",
    attemptCount: 0,
    publishedPostId: null,
    publishedUrl: null,
    publishedAt: null,
    lastErrorCode: null,
    userMessage: "Đang chờ trong hàng đợi để đăng",
    progress: null,
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

  it("polls fast while a channel is publishing, however far the backoff had run", () => {
    const publishing = makeBatch({
      status: "running",
      channels: [makeChannel({ status: "publishing", attemptCount: 1 })],
    });
    // The backoff is IGNORED here, not merely shortened: a stepper refreshed on
    // an 8s curve is what this exception exists to prevent.
    expect(batchPollInterval(publishing, 0)).toBe(1_500);
    expect(batchPollInterval(publishing, 99)).toBe(1_500);
  });

  it("returns to the backoff once nothing is publishing any more", () => {
    const queuedOnly = makeBatch({
      status: "running",
      channels: [makeChannel({ status: "queued" })],
    });
    expect(batchPollInterval(queuedOnly, 99)).toBe(8_000);
  });

  it("stops polling on a settled batch even while a row still says publishing", () => {
    // A stale row must not outrank the batch verdict — otherwise the screen
    // polls forever on a finished batch.
    const settled = makeBatch({
      status: "completed",
      channels: [makeChannel({ status: "publishing" })],
    });
    expect(batchPollInterval(settled, 1)).toBe(false);
  });
});

function makeJobEntry(overrides: Partial<PostJobLogEntry> = {}): PostJobLogEntry {
  return {
    postJobId: "job-1",
    batchId: "batch-1",
    productCode: "MGKVX6310",
    productOrigin: "sheet",
    color: "KEM",
    channelId: "fbpage-a",
    format: "image_post",
    status: "published",
    attemptCount: 1,
    lastErrorCode: null,
    userMessage: "Đã đăng",
    publishedPostId: "1234_5678",
    publishedUrl: "https://www.facebook.com/1234_5678",
    publishedAt: "2026-08-12T03:01:00.000Z",
    scheduledAt: null,
    createdAt: "2026-08-12T03:00:00.000Z",
    updatedAt: "2026-08-12T03:01:00.000Z",
    canRetry: false,
    ...overrides,
  };
}

function makeJobPage(statuses: readonly PostJobStatus[]): PostJobLogResponse {
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    items: statuses.map((status, index) =>
      makeJobEntry({ postJobId: `job-${index}`, status, canRetry: status === "failed" }),
    ),
    nextCursor: null,
    limit: 25,
  };
}

describe("jobLogPollInterval", () => {
  it("does not poll before the first page arrives", () => {
    expect(jobLogPollInterval(undefined, 0)).toBe(false);
    expect(jobLogPollInterval([], 0)).toBe(false);
  });

  it("does not poll an empty log — there is nothing that can change", () => {
    expect(jobLogPollInterval([makeJobPage([])], 0)).toBe(false);
  });

  it("stops polling when every loaded job has settled", () => {
    expect(jobLogPollInterval([makeJobPage(["published", "failed", "blocked"])], 5)).toBe(false);
  });

  it("polls fast while a job is queued or publishing, backing off to a ceiling", () => {
    expect(jobLogPollInterval([makeJobPage(["queued"])], 0)).toBe(2_000);
    expect(jobLogPollInterval([makeJobPage(["publishing"])], 3)).toBe(5_000);
    expect(jobLogPollInterval([makeJobPage(["queued"])], 99)).toBe(15_000);
  });

  it("never answers with a negative interval, whatever the tick count says", () => {
    // TanStack quietly declines to schedule a negative timeout, so a negative
    // number here is not a small mistake — it is polling that stops silently.
    expect(jobLogPollInterval([makeJobPage(["queued"])], -16)).toBe(2_000);
  });

  it("keeps polling when the active job is on a later page", () => {
    const pages = [makeJobPage(["published"]), makeJobPage(["published", "publishing"])];
    expect(jobLogPollInterval(pages, 0)).toBe(2_000);
  });

  it("leaves a Facebook-held or draft job alone — neither moves in seconds", () => {
    // `scheduled_on_facebook` is not settled, but it changes on the
    // reconciliation sweep hours later; a 2s poll would ask forever.
    expect(jobLogPollInterval([makeJobPage(["scheduled_on_facebook"])], 0)).toBe(false);
    expect(jobLogPollInterval([makeJobPage(["draft"])], 0)).toBe(false);
    expect(isSettledJobStatus("scheduled_on_facebook")).toBe(false);
  });
});

describe("nextJobLogPoll", () => {
  const activePages = [makeJobPage(["queued"])];

  it("slows down on a failing query instead of giving up on it", () => {
    // Neither extreme is right. The fast curve on top of a 500 is a request
    // storm; `false` is worse, because the operator watching a batch drain
    // never blurs the tab, so focus-refetch cannot rescue the screen and one
    // unlucky 500 would freeze the log until a manual reload.
    expect(nextJobLogPoll({ isError: true, pages: activePages, updateCount: 40, base: 37 })).toEqual(
      { interval: 30_000, base: null },
    );
  });

  /**
   * The regression that made this an object instead of a bare number: `base`
   * lives in a hook ref, `dataUpdateCount` lives on the Query object, and
   * changing the status filter swaps the Query without remounting the hook. A
   * negative elapsed reached `refetchInterval` as a negative interval, which
   * TanStack silently refuses to schedule (`isValidTimeout` wants >= 0) —
   * polling stopped with no error anywhere.
   */
  it("never produces a negative interval when the anchor outlives its query", () => {
    const stale = nextJobLogPoll({
      isError: false,
      pages: activePages,
      updateCount: 2,
      base: 18,
    });
    expect(stale.interval === false || stale.interval >= 0).toBe(true);
    // And it does not merely clamp to something absurd: the curve restarts.
    expect(stale.interval).toBe(2_000);
  });

  it("starts a new session at the fast end however old the query is", () => {
    // The bug this guards: a tab open all day has a huge `dataUpdateCount`, so
    // feeding it raw would open a brand new batch at the 15s ceiling.
    expect(nextJobLogPoll({ isError: false, pages: activePages, updateCount: 400, base: null })
      ).toEqual({ interval: 2_000, base: 400 });
  });

  it("backs off by the ticks of THIS session, not of the whole query", () => {
    expect(
      nextJobLogPoll({ isError: false, pages: activePages, updateCount: 403, base: 400 }),
    ).toEqual({ interval: 5_000, base: 400 });
  });

  it("drops the anchor when the session ends, so the next batch starts fast", () => {
    const settled = [makeJobPage(["published"])];
    expect(nextJobLogPoll({ isError: false, pages: settled, updateCount: 405, base: 400 })).toEqual({
      interval: false,
      base: null,
    });
    // …and the batch after it opens at the minimum again.
    expect(
      nextJobLogPoll({ isError: false, pages: activePages, updateCount: 406, base: null }).interval,
    ).toBe(2_000);
  });
});

describe("batch progress payload", () => {
  it("parses a payload from a server that sends no progress at all", () => {
    // Backward compatibility is the reason both fields carry `.default()`: a
    // deploy where the browser is newer than the server must not blank the page.
    const { progressSteps: _steps, ...batch } = makeBatch();
    const { progress: _progress, ...channel } = makeChannel();
    const parsed = BatchStatusResponseSchema.safeParse({ ...batch, channels: [channel] });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.progressSteps).toEqual([]);
    expect(parsed.data?.channels[0]?.progress).toBeNull();
  });

  it("parses a live upload step with its counts and no deadline", () => {
    const parsed = BatchStatusResponseSchema.safeParse(
      makeBatch({
        progressSteps: ["Chờ hàng đợi", "Kiểm tồn", "Tải ảnh", "Gửi lên kênh", "Xong"],
        channels: [
          makeChannel({
            status: "publishing",
            progress: {
              stage: "uploading_media",
              stepIndex: 2,
              label: "Đang tải ảnh lên kênh 3/10 (IMG_2041.jpg)",
              doneCount: 3,
              totalCount: 10,
              currentItem: "IMG_2041.jpg",
              stageStartedAt: "2026-08-12T03:00:10.000Z",
              waitUntil: null,
            },
          }),
        ],
      }),
    );

    expect(parsed.success).toBe(true);
    // §3.2: an upload carries counts and NEVER a deadline to count down to.
    expect(parsed.data?.channels[0]?.progress?.waitUntil).toBeNull();
    expect(parsed.data?.channels[0]?.progress?.totalCount).toBe(10);
  });

  it("rejects a progress block whose timestamps are not real dates", () => {
    const parsed = BatchStatusResponseSchema.safeParse(
      makeBatch({
        channels: [
          makeChannel({
            status: "publishing",
            progress: {
              stage: "uploading_media",
              stepIndex: 2,
              label: "x",
              doneCount: 1,
              totalCount: 2,
              currentItem: null,
              stageStartedAt: "hôm qua",
              waitUntil: null,
            },
          }),
        ],
      }),
    );

    expect(parsed.success).toBe(false);
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
        makeChannel({
          status: "scheduled_on_facebook",
          attemptCount: 1,
          userMessage: "Facebook đã nhận lịch và sẽ tự đăng.",
        }),
      ],
    });
    expect(BatchStatusResponseSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects a batch payload with an unknown job status", () => {
    const payload = makeBatch({
      channels: [makeChannel({ channelId: "facebook", status: "exploded" as never })],
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
