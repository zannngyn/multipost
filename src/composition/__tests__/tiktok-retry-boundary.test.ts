import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelConfig } from "@/core/ports/publisher";
import { PUBLISH_UNCONFIRMED_ERROR_CODE } from "@/core/usecases/reap-post-jobs";

import { makeTikTokClient } from "@/adapters/tiktok/tiktok-client";
import { makeTikTokPublisher } from "@/adapters/tiktok/tiktok-publisher";

import { harness, jsonResponse, makeJob, NOW, TENANT } from "../__fixtures__/facebook-publish-harness";

/**
 * The TikTok half of the "no automatic second creating request" rule, with the
 * REAL TikTok adapter wired into the REAL publish usecase and only `fetch`
 * mocked.
 *
 * It exists because the rule is enforced in publish-post, which is shared by
 * EVERY publisher: the moment a retry needs proof that nothing was created, a
 * publisher that never carried that proof loses its retries silently. Nothing in
 * the Facebook tests would have noticed. So both sides are pinned here:
 *
 *   creator_info fails  -> still retried (init/ was never sent)
 *   init/ fails         -> stopped, PUBLISH_UNCONFIRMED, no second init/
 */

const TIKTOK_CHANNEL: ChannelConfig = {
  channelId: "tiktok-shop",
  platform: "tiktok",
  name: "Shop TikTok",
  externalId: "open-id-1",
  accessToken: "act.secret",
  status: "active",
  tokenExpiresAt: null,
  tiktok: { privacyLevel: "SELF_ONLY", isAigc: true, openId: "open-id-1" },
};

const CREATOR_OK = {
  data: { privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 600 },
  error: { code: "ok" },
};

function tiktokJob() {
  return makeJob({
    format: "video_post",
    channelId: "tiktok-shop",
    scheduledAt: null,
    media: [{ driveFileId: "drive-1", fileName: "clip.mp4", url: "https://cdn/clip.mp4" }],
  });
}

function wire(fetchImpl: typeof fetch) {
  const logger = {
    child: () => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Parameters<typeof makeTikTokPublisher>[0]["logger"];
  const tiktok = makeTikTokPublisher({
    client: makeTikTokClient({ logger, fetchImpl }),
    logger,
    sleep: async () => {},
    pollIntervalMs: 1,
  });
  return harness(fetchImpl, tiktokJob(), {
    channel: TIKTOK_CHANNEL,
    publishers: { tiktok },
  });
}

describe("TikTok through publishPost — the retry boundary is init/", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the retry when creator_info fails: no creating request was sent", async () => {
    // The regression this file guards against: TikTok carried no evidence flag
    // at all, so making the caller demand one would have turned every ordinary
    // TikTok outage into a dead job.
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      calls.push(String(url).split("/v2/")[1] ?? String(url));
      return jsonResponse({ error: { code: "rate_limit_exceeded", message: "slow down" } }, 429);
    });
    const h = wire(fetchImpl as unknown as typeof fetch);

    await expect(
      h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({ code: "TIKTOK_ERROR" });

    expect(calls).toEqual(["post/publish/creator_info/query/"]);
    expect(h.repo.get("job-1")).toMatchObject({
      status: "queued",
      lastErrorCode: "TIKTOK_ERROR",
    });
  });

  it("stops the job when init/ was dispatched and gave no answer", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      calls.push(path.split("/v2/")[1] ?? path);
      if (path.endsWith("creator_info/query/")) return jsonResponse(CREATOR_OK);
      // TikTok may already own the publish task and pull the file.
      throw new TypeError("socket hang up");
    });
    const h = wire(fetchImpl as unknown as typeof fetch);

    await expect(
      h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 1, maxAttempts: 3 }),
    ).rejects.toMatchObject({
      code: "PUBLISH_FAILED",
      context: { publish_evidence: "feed_dispatched", step: "init" },
    });

    expect(calls).toEqual(["post/publish/creator_info/query/", "post/publish/video/init/"]);
    expect(h.repo.get("job-1")).toMatchObject({
      status: "failed",
      lastErrorCode: PUBLISH_UNCONFIRMED_ERROR_CODE,
    });
    expect(h.queue.enqueued).toHaveLength(0);

    // A queue redelivery finds a row nothing may publish again.
    const rerun = await h.publish({ tenantId: TENANT, postJobId: "job-1", attempt: 2, maxAttempts: 3 });
    expect(rerun.outcome).toBe("skipped");
    expect(calls).toHaveLength(2);
  });
});
