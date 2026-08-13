import { describe, expect, it, vi } from "vitest";

import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { ChannelConfig } from "@/core/ports/publisher";

import { makeTikTokClient } from "./tiktok-client";
import { makeTikTokPublisher, truncateUtf16 } from "./tiktok-publisher";

/**
 * The E6 adapter against a MOCKED TikTok API (fetch is the seam). It proves the
 * request shapes, the mandatory creator_info gate and the error translation —
 * live posting is blocked by the app audit + domain verification, see the report.
 */

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

const CHANNEL: ChannelConfig = {
  channelId: "tiktok-shop",
  platform: "tiktok",
  name: "Shop TikTok",
  externalId: "open-id-1",
  accessToken: "act.tiktok-secret",
  status: "active",
  tokenExpiresAt: null,
  tiktok: { privacyLevel: "SELF_ONLY", isAigc: true, openId: "open-id-1" },
};

const VIDEO_URL = "https://mysp.example.com/api/media/drive-1?tenant=t&expires=1&sig=ab";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OK = { code: "ok" };
const CREATOR_OK = {
  data: {
    privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"],
    max_video_post_duration_sec: 600,
    creator_username: "shop",
  },
  error: OK,
};

function makePublisher(fetchImpl: typeof fetch) {
  const logger = silentLogger();
  return makeTikTokPublisher({
    client: makeTikTokClient({ logger, fetchImpl }),
    logger,
    // No real waiting, and a clock the timeout test can drive.
    sleep: async () => {},
    pollIntervalMs: 1,
  });
}

function input(overrides: Partial<Parameters<ReturnType<typeof makePublisher>["publishVideoPost"]>[0]> = {}) {
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    channel: CHANNEL,
    caption: "Giannal – MỘT NGÀY DỊU DÀNG",
    videoUrl: VIDEO_URL,
    target: "video" as const,
    idempotencyKey: "key-1",
    ...overrides,
  };
}

/** Answers creator_info, init and status in the order the flow calls them. */
function scriptedFetch(steps: { init?: unknown; status?: unknown[]; creator?: unknown }) {
  const statusQueue = [...(steps.status ?? [{ data: { status: "PUBLISH_COMPLETE" }, error: OK }])];
  return vi.fn(async (url: string) => {
    if (url.endsWith("creator_info/query/")) return jsonResponse(steps.creator ?? CREATOR_OK);
    if (url.endsWith("video/init/")) {
      return jsonResponse(steps.init ?? { data: { publish_id: "v_pub_1" }, error: OK });
    }
    if (url.endsWith("status/fetch/")) {
      return jsonResponse(statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0]);
    }
    throw new Error(`unexpected url ${url}`);
  });
}

// --- Edge cases first -------------------------------------------------------

describe("TikTok publisher — refused before any call", () => {
  it.each([
    ["a reels target (TikTok has no such surface)", { target: "reels" as const }],
    ["no video URL", { videoUrl: "" }],
    ["a non-http URL", { videoUrl: "drive://file/1" }],
    ["an empty caption", { caption: "   " }],
  ])("refuses %s", async (_label, patch) => {
    const fetchImpl = scriptedFetch({});
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(publisher.publishVideoPost(input(patch))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a channel of another platform", async () => {
    const fetchImpl = scriptedFetch({});
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(
      publisher.publishVideoPost(
        input({ channel: { ...CHANNEL, platform: "facebook" } }),
      ),
    ).rejects.toMatchObject({ code: "CHANNEL_NOT_CONFIGURED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a channel with no privacy level (the API requires one)", async () => {
    const fetchImpl = scriptedFetch({});
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(
      publisher.publishVideoPost(input({ channel: { ...CHANNEL, tiktok: undefined } })),
    ).rejects.toMatchObject({ code: "CHANNEL_NOT_CONFIGURED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an image post — out of scope this phase", async () => {
    const publisher = makePublisher(scriptedFetch({}) as unknown as typeof fetch);
    await expect(
      publisher.publishImagePost({
        tenantId: "t",
        channel: CHANNEL,
        caption: "x",
        media: [{ driveFileId: "d", fileName: "f.jpg", url: "https://cdn/1.jpg" }],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("TikTok publisher — the creator_info gate", () => {
  it("refuses a privacy level the account does not allow, before init", async () => {
    const fetchImpl = scriptedFetch({
      creator: { data: { privacy_level_options: ["PUBLIC_TO_EVERYONE"] }, error: OK },
    });
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(publisher.publishVideoPost(input())).rejects.toMatchObject({
      code: "PUBLISH_FAILED",
      context: { reason: "PRIVACY_LEVEL_MISMATCH", retryable: false },
    });
    // creator_info only: nothing was initiated.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a clip longer than the account's own cap", async () => {
    const fetchImpl = scriptedFetch({
      creator: {
        data: { privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 60 },
        error: OK,
      },
    });
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(publisher.publishVideoPost(input({ durationSec: 90 }))).rejects.toMatchObject({
      code: "VIDEO_SPEC_INVALID",
      context: { reason: "DURATION_ABOVE_ACCOUNT_LIMIT", max_duration_sec: 60 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a creator_info answer it cannot read", async () => {
    const fetchImpl = scriptedFetch({ creator: { data: {}, error: OK } });
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(publisher.publishVideoPost(input())).rejects.toMatchObject({
      code: "PUBLISH_FAILED",
      context: { step: "creator_info", retryable: false },
    });
  });
});

describe("TikTok publisher — happy path", () => {
  it("sends title, privacy level, is_aigc and PULL_FROM_URL, then polls to completion", async () => {
    const fetchImpl = scriptedFetch({
      status: [
        { data: { status: "PROCESSING_UPLOAD" }, error: OK },
        { data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["7300"] }, error: OK },
      ],
    });
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    const result = await publisher.publishVideoPost(input());

    // creator_info -> init -> status (processing) -> status (complete)
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const initCall = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(initCall[0]).toBe("https://open.tiktokapis.com/v2/post/publish/video/init/");
    const headers = initCall[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer act.tiktok-secret");
    expect(headers["Content-Type"]).toBe("application/json; charset=UTF-8");
    const body = JSON.parse(initCall[1].body as string);
    expect(body).toEqual({
      post_info: {
        title: "Giannal – MỘT NGÀY DỊU DÀNG",
        privacy_level: "SELF_ONLY",
        disable_duet: false,
        disable_stitch: false,
        disable_comment: false,
        is_aigc: true,
      },
      source_info: { source: "PULL_FROM_URL", video_url: VIDEO_URL },
    });
    expect(result.postId).toBe("7300");
  });

  it("falls back to the publish_id when TikTok reports no public post id", async () => {
    const fetchImpl = scriptedFetch({ init: { data: { publish_id: "v_pub_42" }, error: OK } });
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    const result = await publisher.publishVideoPost(input());
    expect(result).toEqual({ postId: "v_pub_42", url: null });
  });

  it("truncates a caption over 2200 UTF-16 units without splitting an emoji", async () => {
    const long = `${"a".repeat(2199)}😀`;
    expect(truncateUtf16(long, 2200)).toHaveLength(2199);
    expect(truncateUtf16("abc", 2200)).toBe("abc");
  });
});

describe("TikTok publisher — failures", () => {
  it.each([
    ["access_token_invalid", "TOKEN_EXPIRED", false],
    ["rate_limit_exceeded", "TIKTOK_ERROR", true],
    ["spam_risk_too_many_posts", "TIKTOK_ERROR", true],
    ["unaudited_client_can_only_post_to_private_accounts", "PUBLISH_FAILED", false],
    ["url_ownership_unverified", "PUBLISH_FAILED", false],
    ["privacy_level_option_mismatch", "PUBLISH_FAILED", false],
  ])("maps %s to %s (retryable=%s)", async (slug, expectedCode, retryable) => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("creator_info/query/")) return jsonResponse(CREATOR_OK);
      return jsonResponse({ data: {}, error: { code: slug, message: slug, log_id: "log-1" } }, 400);
    });
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(publisher.publishVideoPost(input())).rejects.toMatchObject({
      code: expectedCode,
      context: { provider: "tiktok", tiktok_code: slug, retryable, log_id: "log-1" },
    });
  });

  it("treats a 200 whose envelope says otherwise as a failure", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("creator_info/query/")) return jsonResponse(CREATOR_OK);
      // HTTP 200 + an error slug: TikTok's documented shape.
      return jsonResponse({ data: {}, error: { code: "spam_risk_too_many_posts" } }, 200);
    });
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(publisher.publishVideoPost(input())).rejects.toMatchObject({
      code: "TIKTOK_ERROR",
      context: { retryable: true },
    });
  });

  it("maps a FAILED status through the same table as an HTTP error", async () => {
    const fetchImpl = scriptedFetch({
      status: [{ data: { status: "FAILED", fail_reason: "file_format_check_failed" }, error: OK }],
    });
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(publisher.publishVideoPost(input())).rejects.toMatchObject({
      code: "PUBLISH_FAILED",
      context: { tiktok_code: "file_format_check_failed", retryable: false },
    });
  });

  it("stops waiting after the timeout and refuses to retry (a retry could double-post)", async () => {
    let clock = 0;
    const fetchImpl = scriptedFetch({
      status: [{ data: { status: "PROCESSING_UPLOAD" }, error: OK }],
    });
    const publisher = makeTikTokPublisher({
      client: makeTikTokClient({ logger: silentLogger(), fetchImpl: fetchImpl as unknown as typeof fetch }),
      logger: silentLogger(),
      sleep: async () => {
        clock += 30_000;
      },
      now: () => clock,
      pollIntervalMs: 1,
      pollTimeoutMs: 60_000,
    });

    await expect(publisher.publishVideoPost(input())).rejects.toMatchObject({
      code: "PUBLISH_FAILED",
      context: { last_status: "PROCESSING_UPLOAD", retryable: false, alert: "OPERATOR_ATTENTION" },
    });
  });

  it("wraps a transport failure as retryable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(publisher.publishVideoPost(input())).rejects.toMatchObject({
      code: "TIKTOK_ERROR",
      context: { provider: "tiktok", retryable: true, reason: "TRANSPORT" },
    });
  });
});
