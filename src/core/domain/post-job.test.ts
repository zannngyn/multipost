import { describe, expect, it } from "vitest";

import { AppError } from "./errors";
import {
  allowedTransitionsFrom,
  canOperatorRetryPostJob,
  canTransitionPostJob,
  deferredPostJobQueueId,
  HANDOFF_FAILED_ERROR_CODE,
  mayHoldUnconfirmedScheduledPost,
  deriveBatchStatus,
  evaluateScheduledAt,
  handoffWakeDelayMs,
  HANDOFF_DEADLINE_MS,
  HANDOFF_RETRY_INTERVAL_MS,
  HANDOFF_WINDOW_START_MS,
  isFinalPostJobStatus,
  isPendingSchedule,
  MAX_SCHEDULE_AHEAD_MS,
  nextHandoffAttemptDelayMs,
  planScheduledPublish,
  toUnixSeconds,
  scheduleRejectionMessage,
  POST_JOB_STATUSES,
  postJobDuplicateKey,
  postJobOperatorMessage,
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
    scheduledPostId: null,
    captionText: "Giannal – MỘT NGÀY DỊU DÀNG",
    media: [{ driveFileId: "d1", fileName: "MGKVX6310-Tím (1).jpg", url: "https://cdn/1.jpg" }],
    scheduledAt: null,
    queueJobId: null,
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
  it("is the (tenant, batch, code, colour, channel, format) tuple, case-normalised", () => {
    const key = postJobDuplicateKey({
      tenantId: "tenant-1",
      batchId: "batch-1",
      productCode: " mgkvx6310 ",
      color: " tím ",
      channelId: "fbpage-a",
      format: "image_post",
    });
    // Same columns, same order as the post_job_duplicate_uq index (gate note #3).
    expect(key).toBe("tenant-1|batch-1|MGKVX6310|TÍM|fbpage-a|image_post");
  });

  it("separates two colours of the same code on the same channel", () => {
    const base = {
      tenantId: "t",
      batchId: "b",
      productCode: "X",
      channelId: "c",
      format: "image_post",
    } as const;
    expect(postJobDuplicateKey({ ...base, color: "TÍM" })).not.toBe(
      postJobDuplicateKey({ ...base, color: "TÔM" }),
    );
  });

  it("separates two tenants that reuse the same batch/product tuple", () => {
    const base = {
      batchId: "b",
      productCode: "X",
      color: "TÍM",
      channelId: "c",
      format: "image_post",
    } as const;
    expect(postJobDuplicateKey({ ...base, tenantId: "t1" })).not.toBe(
      postJobDuplicateKey({ ...base, tenantId: "t2" }),
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
    [["published", "blocked", "failed"], "partial"],
    // Gate note #2: nothing was ever sent to a channel -> "blocked", not "failed".
    [["blocked", "blocked"], "blocked"],
    [["blocked"], "blocked"],
    // A real platform failure is present: it must not be softened to "blocked".
    [["blocked", "failed"], "failed"],
    [["failed", "failed"], "failed"],
  ] as Array<[PostJobStatus[], string]>)("%j -> %s", (statuses, expected) => {
    expect(deriveBatchStatus(statuses)).toBe(expected);
  });
});

describe("postJobOperatorMessage", () => {
  it("prefers the stored Vietnamese reason of a blocked job", () => {
    const message = postJobOperatorMessage(
      makeJob({
        status: "blocked",
        lastErrorCode: "OUT_OF_STOCK",
        lastErrorMessage: "Mã MGKVX6310 đã hết hàng — không đăng",
      }),
    );
    expect(message).toBe("Mã MGKVX6310 đã hết hàng — không đăng");
  });

  it("still explains a blocked job that lost its message", () => {
    const message = postJobOperatorMessage(
      makeJob({ status: "blocked", lastErrorCode: "TOKEN_EXPIRED", lastErrorMessage: null }),
    );
    expect(message).toContain("TOKEN_EXPIRED");
    expect(message).toContain("chặn");
  });

  it("names the attempt count of a failed job", () => {
    const message = postJobOperatorMessage(
      makeJob({
        status: "failed",
        attemptCount: 3,
        lastErrorCode: "PUBLISH_FAILED",
        lastErrorMessage: null,
      }),
    );
    expect(message).toContain("3 lần thử");
  });

  it("reports the platform post id of a published job", () => {
    const message = postJobOperatorMessage(
      makeJob({ status: "published", publishedPostId: "1234_5678" }),
    );
    expect(message).toContain("1234_5678");
  });

  it.each(["draft", "queued", "publishing"] as PostJobStatus[])(
    "gives a non-empty Vietnamese line for %s too",
    (status) => {
      expect(postJobOperatorMessage(makeJob({ status })).length).toBeGreaterThan(0);
    },
  );
});

// --- Scheduling (E8) --------------------------------------------------------

describe("evaluateScheduledAt", () => {
  const NOW = Date.parse("2026-08-13T02:00:00.000Z");

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a non-date object", {}],
    ["gibberish", "khong-phai-ngay"],
    ["an invalid Date", new Date("nope")],
  ])("refuses %s", (_label, value) => {
    expect(evaluateScheduledAt(value, NOW)).toMatchObject({ ok: false, reason: "NOT_A_DATE" });
  });

  it("refuses a time that already passed — it must never mean 'post now'", () => {
    const past = new Date(NOW - 60_000);
    expect(evaluateScheduledAt(past, NOW)).toMatchObject({ ok: false, reason: "IN_THE_PAST" });
    // "Now" is also refused: a queue round trip cannot happen in zero time.
    expect(evaluateScheduledAt(new Date(NOW), NOW)).toMatchObject({ reason: "IN_THE_PAST" });
  });

  it("refuses a time past the window (PENDING(E8-window): 30 days)", () => {
    const tooFar = new Date(NOW + MAX_SCHEDULE_AHEAD_MS + 60_000);
    expect(evaluateScheduledAt(tooFar, NOW)).toMatchObject({ ok: false, reason: "TOO_FAR_AHEAD" });
    expect(evaluateScheduledAt(new Date(NOW + MAX_SCHEDULE_AHEAD_MS), NOW).ok).toBe(true);
  });

  it("accepts a future time and returns the delay the queue needs", () => {
    const verdict = evaluateScheduledAt(new Date(NOW + 3_600_000), NOW);
    expect(verdict).toMatchObject({ ok: true, delayMs: 3_600_000 });
  });

  it("accepts an ISO string (a JSON body never carries a Date)", () => {
    const verdict = evaluateScheduledAt("2026-08-13T03:00:00.000Z", NOW);
    expect(verdict.ok).toBe(true);
    expect(verdict.at?.toISOString()).toBe("2026-08-13T03:00:00.000Z");
  });

  it("gives every rejection a Vietnamese sentence", () => {
    for (const reason of ["NOT_A_DATE", "IN_THE_PAST", "TOO_FAR_AHEAD"] as const) {
      expect(scheduleRejectionMessage(reason).length).toBeGreaterThan(10);
    }
    expect(scheduleRejectionMessage("TOO_FAR_AHEAD")).toContain("30 ngày");
  });
});

describe("isPendingSchedule", () => {
  const NOW = Date.parse("2026-08-13T02:00:00.000Z");

  it("is true only for a queued job whose time is still ahead", () => {
    expect(isPendingSchedule({ status: "queued", scheduledAt: new Date(NOW + 1) }, NOW)).toBe(true);
    expect(isPendingSchedule({ status: "queued", scheduledAt: new Date(NOW - 1) }, NOW)).toBe(false);
    expect(isPendingSchedule({ status: "queued", scheduledAt: null }, NOW)).toBe(false);
    expect(isPendingSchedule({ status: "publishing", scheduledAt: new Date(NOW + 1) }, NOW)).toBe(
      false,
    );
    expect(isPendingSchedule({ status: "published", scheduledAt: new Date(NOW + 1) }, NOW)).toBe(
      false,
    );
  });
});

describe("transitionPostJob — queue id bookkeeping (E8.4)", () => {
  it("stores the queue id on the transition that queues the job", () => {
    const queued = transitionPostJob(makeJob(), "queued", { queueJobId: "pp.job-1.x" });
    expect(queued.queueJobId).toBe("pp.job-1.x");
  });

  it("keeps the existing id when a retry does not pass a new one", () => {
    const job = makeJob({ status: "failed", queueJobId: "pp.old" });
    expect(transitionPostJob(job, "queued").queueJobId).toBe("pp.old");
  });

  it("clears it once the job is published or stopped — a stale id could delete someone else's entry", () => {
    const publishing = makeJob({ status: "publishing", queueJobId: "pp.old" });
    expect(
      transitionPostJob(publishing, "published", { publishedPostId: "1_2" }).queueJobId,
    ).toBeNull();
    expect(
      transitionPostJob(publishing, "blocked", { errorCode: "OUT_OF_STOCK" }).queueJobId,
    ).toBeNull();
    expect(
      transitionPostJob(publishing, "failed", { errorCode: "PUBLISH_FAILED" }).queueJobId,
    ).toBeNull();
  });
});

// --- E8.6: the post Facebook holds ------------------------------------------

describe("transitionPostJob — scheduled_on_facebook (E8.6)", () => {
  const publishing = makeJob({ status: "publishing", attemptCount: 1, queueJobId: "pp.job-1" });

  it("refuses the handoff state without the platform post id", () => {
    // Without it nothing can reconcile or delete the post, and Facebook still
    // publishes at the hour: an unidentified scheduled post cannot be stopped.
    expect(() => transitionPostJob(publishing, "scheduled_on_facebook", {})).toThrow(AppError);
    expect(() =>
      transitionPostJob(publishing, "scheduled_on_facebook", { scheduledPostId: "   " }),
    ).toThrow(AppError);
  });

  it("stores the platform post id and drops the queue entry", () => {
    const handed = transitionPostJob(publishing, "scheduled_on_facebook", {
      scheduledPostId: " 555_1 ",
      reason: "HANDED_OFF_TO_PLATFORM",
    });
    expect(handed.status).toBe("scheduled_on_facebook");
    expect(handed.scheduledPostId).toBe("555_1");
    // NOT published: no post id, no timestamp, nothing to show as a live link.
    expect(handed.publishedPostId).toBeNull();
    expect(handed.publishedAt).toBeNull();
    expect(handed.queueJobId).toBeNull();
  });

  it("only leaves for published, failed or blocked — never back to the queue", () => {
    expect(allowedTransitionsFrom("scheduled_on_facebook")).toEqual([
      "published",
      "failed",
      "blocked",
    ]);
    // Re-queueing would upload the album again and put TWO posts on the Page.
    expect(canTransitionPostJob("scheduled_on_facebook", "queued")).toBe(false);
    expect(canTransitionPostJob("scheduled_on_facebook", "publishing")).toBe(false);
  });

  it("becomes published only with a post id (the reconciliation sweep)", () => {
    const handed = transitionPostJob(publishing, "scheduled_on_facebook", {
      scheduledPostId: "555_1",
    });
    expect(() => transitionPostJob(handed, "published", {})).toThrow(AppError);
    const published = transitionPostJob(handed, "published", {
      publishedPostId: "555_1",
      publishedUrl: "https://www.facebook.com/page/posts/1",
    });
    expect(published.status).toBe("published");
    expect(published.publishedUrl).toBe("https://www.facebook.com/page/posts/1");
    // The handoff id stays on the row as the trace of how it got there.
    expect(published.scheduledPostId).toBe("555_1");
  });

  it("counts as RUNNING in a batch — nothing is live yet", () => {
    expect(deriveBatchStatus(["scheduled_on_facebook"])).toBe("running");
    expect(deriveBatchStatus(["published", "scheduled_on_facebook"])).toBe("running");
    expect(isFinalPostJobStatus("scheduled_on_facebook")).toBe(false);
  });
});

describe("planScheduledPublish (E8.6 window)", () => {
  const NOW = Date.parse("2026-08-13T02:00:00.000Z");
  const at = (offsetMs: number): Date => new Date(NOW + offsetMs);

  // --- Edge cases first ------------------------------------------------------

  it("treats a post with no hour as publish-now, not late", () => {
    expect(planScheduledPublish(null, NOW)).toEqual({ action: "publish_now", lateByMs: 0 });
    expect(planScheduledPublish(new Date("nope"), NOW)).toEqual({
      action: "publish_now",
      lateByMs: 0,
    });
  });

  it("waits until the window opens when the hour is far away", () => {
    expect(planScheduledPublish(at(2 * 60 * 60_000), NOW)).toEqual({
      action: "wait",
      wakeInMs: 2 * 60 * 60_000 - HANDOFF_WINDOW_START_MS,
      reason: "BEFORE_HANDOFF_WINDOW",
    });
  });

  it("hands over anywhere between T-30 and T-12, the two measured bounds", () => {
    expect(planScheduledPublish(at(HANDOFF_WINDOW_START_MS), NOW)).toEqual({
      action: "hand_off",
      leadMs: HANDOFF_WINDOW_START_MS,
    });
    expect(planScheduledPublish(at(20 * 60_000), NOW)).toEqual({
      action: "hand_off",
      leadMs: 20 * 60_000,
    });
    // Exactly at the deadline still counts: the upload has 12 minutes, Facebook
    // needs the last ~10.
    expect(planScheduledPublish(at(HANDOFF_DEADLINE_MS), NOW)).toEqual({
      action: "hand_off",
      leadMs: HANDOFF_DEADLINE_MS,
    });
  });

  it("waits for the hour once it is too late to hand over — it never publishes early", () => {
    expect(planScheduledPublish(at(HANDOFF_DEADLINE_MS - 1), NOW)).toEqual({
      action: "wait",
      wakeInMs: HANDOFF_DEADLINE_MS - 1,
      reason: "TOO_LATE_TO_HAND_OFF",
    });
    expect(planScheduledPublish(at(60_000), NOW)).toEqual({
      action: "wait",
      wakeInMs: 60_000,
      reason: "TOO_LATE_TO_HAND_OFF",
    });
  });

  it("publishes immediately once the hour has passed, and says how late", () => {
    expect(planScheduledPublish(at(0), NOW)).toEqual({ action: "publish_now", lateByMs: 0 });
    expect(planScheduledPublish(at(-3 * 60_000), NOW)).toEqual({
      action: "publish_now",
      lateByMs: 3 * 60_000,
    });
  });

  it("only waits for the hour when the post cannot be handed over at all", () => {
    expect(planScheduledPublish(at(20 * 60_000), NOW, { canHandOff: false })).toEqual({
      action: "wait",
      wakeInMs: 20 * 60_000,
      reason: "HANDOFF_NOT_AVAILABLE",
    });
  });
});

describe("nextHandoffAttemptDelayMs (E8.6 retries inside the window)", () => {
  const NOW = Date.parse("2026-08-13T02:00:00.000Z");
  const at = (offsetMs: number): Date => new Date(NOW + offsetMs);

  it("uses the retry interval while another attempt fits before the deadline", () => {
    expect(nextHandoffAttemptDelayMs(at(30 * 60_000), NOW)).toBe(HANDOFF_RETRY_INTERVAL_MS);
    // T-17: +5' lands on T-12, exactly the last possible start.
    expect(nextHandoffAttemptDelayMs(at(17 * 60_000), NOW)).toBe(HANDOFF_RETRY_INTERVAL_MS);
  });

  it("waits for the hour itself when no attempt fits any more", () => {
    // T-16: +5' would land at T-11, below the deadline, so it waits for T.
    expect(nextHandoffAttemptDelayMs(at(16 * 60_000), NOW)).toBe(16 * 60_000);
    expect(nextHandoffAttemptDelayMs(at(60_000), NOW)).toBe(60_000);
  });

  it("never returns a negative delay for an hour already gone", () => {
    expect(nextHandoffAttemptDelayMs(at(-60_000), NOW)).toBe(0);
  });
});

describe("handoffWakeDelayMs / toUnixSeconds", () => {
  const NOW = Date.parse("2026-08-13T02:00:00.000Z");

  it("wakes the queue entry at the START of the window", () => {
    expect(handoffWakeDelayMs(new Date(NOW + 60 * 60_000), NOW)).toBe(
      60 * 60_000 - HANDOFF_WINDOW_START_MS,
    );
  });

  it("wakes immediately when the window is already open (or the hour has passed)", () => {
    expect(handoffWakeDelayMs(new Date(NOW + 10 * 60_000), NOW)).toBe(0);
    expect(handoffWakeDelayMs(new Date(NOW - 60_000), NOW)).toBe(0);
    expect(handoffWakeDelayMs(null, NOW)).toBe(0);
  });

  it("converts to the unix SECONDS Meta expects", () => {
    const at = new Date("2026-08-13T02:00:00.999Z");
    // Floored, never rounded up: a rounded-up second could push a borderline
    // schedule past a boundary Meta measures itself.
    expect(toUnixSeconds(at)).toBe(Math.floor(at.getTime() / 1000));
    expect(toUnixSeconds(at) * 1000).toBe(at.getTime() - 999);
  });
});

/**
 * E8.6 — the row-level half of business rule 4. `failed` alone says "an operator
 * may re-run this"; `failed` + HANDOFF_FAILED says "Facebook may already be
 * holding a post for it", and those two must never be confused, because every
 * road out of `queued` ends on the Page.
 */
describe("mayHoldUnconfirmedScheduledPost / canOperatorRetryPostJob", () => {
  const unconfirmed = makeJob({
    status: "failed",
    lastErrorCode: HANDOFF_FAILED_ERROR_CODE,
    scheduledAt: new Date("2026-08-13T03:00:00.000Z"),
  });

  it("recognises the row failUnconfirmedHandoff leaves behind", () => {
    expect(mayHoldUnconfirmedScheduledPost(unconfirmed)).toBe(true);
    expect(canOperatorRetryPostJob(unconfirmed)).toBe(false);
  });

  it("fails closed when the row lost its scheduled hour", () => {
    // The hour is not part of the condition on purpose: a guard that switches
    // itself off on odd data is not a guard. (The signature does not even accept
    // `scheduledAt`, which is the point — it cannot be read.)
    expect(mayHoldUnconfirmedScheduledPost(makeJob({ ...unconfirmed, scheduledAt: null }))).toBe(
      true,
    );
  });

  it("stays narrow: only `failed` + that one code", () => {
    expect(mayHoldUnconfirmedScheduledPost({ ...unconfirmed, status: "blocked" })).toBe(false);
    expect(
      mayHoldUnconfirmedScheduledPost({ ...unconfirmed, lastErrorCode: "PUBLISH_FAILED" }),
    ).toBe(false);
    expect(mayHoldUnconfirmedScheduledPost({ ...unconfirmed, lastErrorCode: null })).toBe(false);
    expect(mayHoldUnconfirmedScheduledPost(null)).toBe(false);
  });

  it("keeps every ordinary failed/blocked job retryable", () => {
    expect(
      canOperatorRetryPostJob(makeJob({ status: "failed", lastErrorCode: "PUBLISH_FAILED" })),
    ).toBe(true);
    expect(
      canOperatorRetryPostJob(makeJob({ status: "blocked", lastErrorCode: "OUT_OF_STOCK" })),
    ).toBe(true);
  });

  it.each([
    "draft",
    "queued",
    "publishing",
    "scheduled_on_facebook",
    "published",
  ] as PostJobStatus[])("refuses %s", (status) => {
    expect(canOperatorRetryPostJob(makeJob({ status }))).toBe(false);
  });
});
