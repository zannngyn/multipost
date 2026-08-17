import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PostJob } from "@/core/domain/post-job";
import { PUBLISH_UNCONFIRMED_ERROR_CODE } from "@/core/usecases/reap-post-jobs";

import { harness, jsonResponse, makeJob, NOW, TENANT } from "./__fixtures__/facebook-publish-harness";

/**
 * B2 REGRESSION — the ĐĂNG NGAY path, same wiring as the handoff file next door:
 * the REAL Graph adapter, the REAL publish usecase, only `fetch` mocked.
 *
 * The door this file closes was the most dangerous of the family because NOBODY
 * had to press anything. The three closed before it all needed an operator; this
 * one was BullMQ's own backoff:
 *
 *   1. /feed (or /photos published=true) is dispatched;
 *   2. the answer is lost — timeout, 5xx, a socket hang up. Facebook may have
 *      committed the post anyway;
 *   3. the error map calls that retryable, because the CALL could succeed later;
 *   4. the job went back to `queued` and was rethrown, and BullMQ sent the very
 *      same creating request again. Two posts, no human in the loop.
 *
 * The invariant under test: no creating request is ever dispatched twice for one
 * job without a human deciding to (business rule 4). The proof is negative —
 * count the requests that actually reached the mocked `fetch`.
 *
 * The trade, accepted by PM: an immediate post whose /feed hits a flaky network
 * now stops as `failed` and needs someone to look at the Page. Everything BEFORE
 * the creating request — reading bytes, uploading unpublished photos, the
 * pre-flight guards — still retries exactly as before, and that is most of the
 * error surface (see the last two cases here).
 */

/** No hour on the row: this is "đăng ngay", so nothing hands off to Facebook. */
function immediateJob(overrides: Partial<PostJob> = {}): PostJob {
  return makeJob({ scheduledAt: null, ...overrides });
}

const ALBUM = [
  { driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" },
  { driveFileId: "d2", fileName: "2.jpg", url: "https://cdn/2.jpg" },
];

describe("immediate publish — a lost answer never becomes a second post", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("album: /feed times out -> failed, NOT re-queued, and no second /feed", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith("/photos")) {
        calls.push("photos");
        return jsonResponse({ id: `photo-${calls.length}` });
      }
      calls.push("feed");
      // Facebook committed the post; the answer never came back.
      throw new TypeError("socket hang up");
    });
    const h = harness(fetchImpl as unknown as typeof fetch, immediateJob({ media: ALBUM }));

    await expect(
      h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({
      // In the queue adapter's NON_RETRYABLE_CODES, so BullMQ raises an
      // UnrecoverableError instead of backing off into a second /feed.
      code: "PUBLISH_FAILED",
      context: { publish_evidence: "feed_dispatched", step: "feed", retryable: false },
    });

    expect(calls).toEqual(["photos", "photos", "feed"]);
    const row = h.repo.get("job-1");
    // Before the fix: `queued` + a rethrow, i.e. BullMQ sends /feed again.
    expect(row?.status).toBe("failed");
    expect(row?.lastErrorCode).toBe(PUBLISH_UNCONFIRMED_ERROR_CODE);
    expect(row?.publishedPostId).toBeNull();
    expect(h.queue.enqueued).toHaveLength(0);
    // The sentence an operator can act on: look before deciding anything.
    expect(row?.lastErrorMessage).toContain("CÓ THỂ đã lên kênh");
    expect(row?.lastErrorMessage).toContain("mở Trang kiểm tra");

    // And if the queue does wake on this row anyway (an entry created before the
    // failure, a redelivery), the status guard sends it home without a call.
    const rerun = await h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 2, maxAttempts: 3 });
    expect(rerun.outcome).toBe("skipped");
    expect(calls).toEqual(["photos", "photos", "feed"]);
  });

  it("single photo: the ONE call that publishes is never repeated either", async () => {
    // /photos with published=true IS the creating request — there is no /feed to
    // hang the rule on, which is exactly how this path was missed.
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      calls.push(String(url).endsWith("/photos") ? "photos" : "other");
      throw new TypeError("socket hang up");
    });
    const h = harness(fetchImpl as unknown as typeof fetch, immediateJob());

    await expect(
      h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({
      code: "PUBLISH_FAILED",
      context: { publish_evidence: "feed_dispatched", step: "photos.single" },
    });

    expect(calls).toEqual(["photos"]);
    expect(h.repo.get("job-1")).toMatchObject({
      status: "failed",
      lastErrorCode: PUBLISH_UNCONFIRMED_ERROR_CODE,
    });
    expect(h.queue.enqueued).toHaveLength(0);
  });

  it("a 5xx on /feed does not buy a retry, however transient the error map calls it", async () => {
    // The map says `retryable: true` for an HTTP 500 — and it is right about the
    // CALL. It says nothing about whether repeating it is safe, and Facebook
    // answers 500 on requests it has already committed.
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith("/photos")) {
        calls.push("photos");
        return jsonResponse({ id: `photo-${calls.length}` });
      }
      calls.push("feed");
      return jsonResponse({ error: { code: 2, message: "Service temporarily unavailable" } }, 500);
    });
    const h = harness(fetchImpl as unknown as typeof fetch, immediateJob({ media: ALBUM }));

    await expect(
      h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "PUBLISH_FAILED", context: { retryable: false } });

    expect(calls.filter((entry) => entry === "feed")).toHaveLength(1);
    expect(h.repo.get("job-1")?.lastErrorCode).toBe(PUBLISH_UNCONFIRMED_ERROR_CODE);
    expect(h.queue.enqueued).toHaveLength(0);
  });

  it("leaves no way back into the queue: the button is dark and the API refuses", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith("/photos")) {
        calls.push("photos");
        return jsonResponse({ id: `photo-${calls.length}` });
      }
      calls.push("feed");
      throw new TypeError("socket hang up");
    });
    const h = harness(fetchImpl as unknown as typeof fetch, immediateJob({ media: ALBUM }));

    await expect(
      h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "PUBLISH_FAILED" });
    const callsAfterPublish = [...calls];

    // 1. The screen does not offer "Chạy lại" on a row that may have a post.
    const log = await h.listJobs({ tenantId: TENANT });
    expect(log.items[0]).toMatchObject({ status: "failed", canRetry: false });
    expect(log.items[0].userMessage).toContain("CÓ THỂ đã lên kênh");

    // 2. And the usecase refuses it anyway — the API route is reachable without
    //    the screen, and a stale page still has the old button.
    await expect(h.retry({ tenantId: TENANT, postJobId: "job-1" })).rejects.toMatchObject({
      code: "DUPLICATE_POST_BLOCKED",
      context: { reason: "PUBLISH_OUTCOME_UNKNOWN" },
    });

    expect(h.queue.enqueued).toHaveLength(0);
    // Nothing more reached Facebook: the publish attempt is still the only one.
    expect(calls).toEqual(callsAfterPublish);
  });
});

describe("immediate publish — everything before the creating request still retries", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a rate-limited photo upload goes back to `queued` and publishes on the next run", async () => {
    // The half of the error surface the fix must NOT touch: an unpublished photo
    // is not a post, so repeating the upload cannot double-post anything.
    let failUpload = true;
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith("/photos")) {
        calls.push("photos");
        if (failUpload && calls.filter((c) => c === "photos").length === 2) {
          failUpload = false;
          return jsonResponse(
            { error: { code: 4, message: "Application request limit reached" } },
            400,
          );
        }
        return jsonResponse({ id: `photo-${calls.length}` });
      }
      calls.push("feed");
      return jsonResponse({ id: "555000111_LIVE" });
    });
    const h = harness(fetchImpl as unknown as typeof fetch, immediateJob({ media: ALBUM }));

    // Attempt 1: the second photo is throttled. Nothing was published.
    await expect(
      h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({
      code: "META_ERROR",
      context: { graph_code: 4, platform_created_nothing: true },
    });
    expect(calls).toEqual(["photos", "photos"]);
    expect(h.repo.get("job-1")).toMatchObject({ status: "queued", lastErrorCode: "META_ERROR" });

    // Attempt 2 (BullMQ's backoff, which this path keeps): it goes out.
    const result = await h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 2, maxAttempts: 3 });

    expect(result.outcome).toBe("published");
    expect(h.repo.get("job-1")).toMatchObject({
      status: "published",
      publishedPostId: "555000111_LIVE",
    });
    expect(calls).toEqual(["photos", "photos", "photos", "photos", "feed"]);
  });

  it("an unreadable photo keeps its own DRIVE_ERROR and its retry", async () => {
    // Reading bytes sends nothing to Facebook. The job must stay retryable AND
    // the error must still name which photo failed, at which step.
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      calls.push(String(url));
      return jsonResponse({ id: "photo-1" });
    });
    const h = harness(fetchImpl as unknown as typeof fetch, immediateJob({ media: ALBUM }));
    h.readMediaBytes.mockImplementation(async (input: { assetId?: string }) => {
      if (input?.assetId === "d2") throw new Error("Drive timed out");
      return { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" };
    });

    await expect(
      h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({
      code: "DRIVE_ERROR",
      context: { step: "media.read", media_index: 1, platform_created_nothing: true },
    });

    expect(h.repo.get("job-1")).toMatchObject({ status: "queued", lastErrorCode: "DRIVE_ERROR" });
    // Only the first photo was uploaded; no /feed, so nothing to double-post.
    expect(calls).toHaveLength(1);
  });
});
