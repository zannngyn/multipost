import { describe, expect, it, vi } from "vitest";

import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { ChannelConfig } from "@/core/ports/publisher";

import { makeFacebookPublisher } from "./facebook-publisher";
import { makeGraphClient } from "./graph-client";

/**
 * Integration test of the E5 adapter against a MOCKED Graph API (fetch is the
 * seam). It proves the request shapes and the error translation without a Page
 * token — the real Page run is still pending, see the report.
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
  channelId: "fbpage-a",
  platform: "facebook",
  name: "Page A",
  externalId: "555000111",
  accessToken: "EAAsecret-token",
  status: "active",
  tokenExpiresAt: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makePublisher(fetchImpl: typeof fetch, version = "v23.0") {
  const logger = silentLogger();
  return makeFacebookPublisher({
    graph: makeGraphClient({ logger, fetchImpl, version }),
    logger,
  });
}

function formOf(call: unknown[]): URLSearchParams {
  const init = call[1] as RequestInit;
  return init.body as URLSearchParams;
}

// --- Edge cases first -------------------------------------------------------

describe("makeFacebookPublisher — rejected inputs (nothing is sent)", () => {
  it("refuses a non-facebook channel", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(
      publisher.publishImagePost({
        tenantId: "t1",
        channel: { ...CHANNEL, platform: "tiktok" },
        caption: "x",
        media: [{ driveFileId: "d", fileName: "f.jpg", url: "https://cdn/f.jpg" }],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "CHANNEL_NOT_CONFIGURED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an empty album and an 11-photo album", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    const media = Array.from({ length: 11 }, (_, index) => ({
      driveFileId: `d${index}`,
      fileName: `f${index}.jpg`,
      url: `https://cdn/f${index}.jpg`,
    }));

    await expect(
      publisher.publishImagePost({ tenantId: "t1", channel: CHANNEL, caption: "x", media: [], idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      publisher.publishImagePost({ tenantId: "t1", channel: CHANNEL, caption: "x", media, idempotencyKey: "k" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an empty caption", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(
      publisher.publishImagePost({
        tenantId: "t1",
        channel: CHANNEL,
        caption: "   ",
        media: [{ driveFileId: "d", fileName: "f.jpg", url: "https://cdn/f.jpg" }],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("makeFacebookPublisher — Graph failures", () => {
  it("maps an expired token to TOKEN_EXPIRED and stops after the first call", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ error: { code: 190, error_subcode: 463, message: "Session expired" } }, 401),
      );
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      publisher.publishImagePost({
        tenantId: "t1",
        channel: CHANNEL,
        caption: "Penny – NGÀY MỚI",
        media: [
          { driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" },
          { driveFileId: "d2", fileName: "2.jpg", url: "https://cdn/2.jpg" },
        ],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED", context: { retryable: false } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps a rate limit to a retryable META_ERROR", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { code: 613 } }, 400));
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(
      publisher.publishImagePost({
        tenantId: "t1",
        channel: CHANNEL,
        caption: "x",
        media: [{ driveFileId: "d", fileName: "f.jpg", url: "https://cdn/f.jpg" }],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "META_ERROR", context: { retryable: true, reason: "RATE_LIMITED" } });
  });

  it("treats a 200 without an id as a failure, not as a published post", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(
      publisher.publishImagePost({
        tenantId: "t1",
        channel: CHANNEL,
        caption: "x",
        media: [{ driveFileId: "d", fileName: "f.jpg", url: "https://cdn/f.jpg" }],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "META_ERROR", context: { retryable: false } });
  });

  it("does not publish the album when one photo upload fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "photo-1" }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 1609005 } }, 400));
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      publisher.publishImagePost({
        tenantId: "t1",
        channel: CHANNEL,
        caption: "x",
        media: [
          { driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" },
          { driveFileId: "d2", fileName: "2.jpg", url: "https://cdn/2.jpg" },
        ],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "META_ERROR", context: { reason: "MEDIA_FETCH_FAILED" } });
    // Two photo calls, and crucially NO /feed call: no half-empty album post.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls.at(-1)?.[0])).toContain("/photos");
  });
});

// --- Happy paths ------------------------------------------------------------

describe("makeFacebookPublisher — happy paths", () => {
  it("posts a single photo with the caption in one call", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ id: "9001", post_id: "555000111_9001" }));
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    const result = await publisher.publishImagePost({
      tenantId: "t1",
      channel: CHANNEL,
      caption: "Penny – MỘT NGÀY DỊU DÀNG",
      media: [{ driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" }],
      idempotencyKey: "batch|MR0AC6080||fbpage-a|image_post",
    });

    expect(result).toEqual({
      postId: "555000111_9001",
      url: "https://www.facebook.com/555000111_9001",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://graph.facebook.com/v23.0/555000111/photos");
    const form = formOf(fetchImpl.mock.calls[0] as unknown[]);
    expect(form.get("url")).toBe("https://cdn/1.jpg");
    expect(form.get("message")).toBe("Penny – MỘT NGÀY DỊU DÀNG");
    expect(form.get("published")).toBe("true");
    expect(form.get("access_token")).toBe("EAAsecret-token");
  });

  it("uploads N unpublished photos and attaches them to one feed post", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "p1" }))
      .mockResolvedValueOnce(jsonResponse({ id: "p2" }))
      .mockResolvedValueOnce(jsonResponse({ id: "p3" }))
      .mockResolvedValueOnce(jsonResponse({ id: "555000111_9100" }));
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    const result = await publisher.publishImagePost({
      tenantId: "t1",
      channel: CHANNEL,
      caption: "Giannal – NẮNG THÁNG TÁM",
      media: [
        { driveFileId: "d1", fileName: "1.jpg", url: "https://cdn/1.jpg" },
        { driveFileId: "d2", fileName: "2.jpg", url: "https://cdn/2.jpg" },
        { driveFileId: "d3", fileName: "3.jpg", url: "https://cdn/3.jpg" },
      ],
      idempotencyKey: "k",
    });

    expect(result.postId).toBe("555000111_9100");
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    const photoForm = formOf(fetchImpl.mock.calls[0] as unknown[]);
    expect(photoForm.get("published")).toBe("false");
    expect(photoForm.get("message")).toBeNull();

    const [feedUrl] = fetchImpl.mock.calls[3];
    expect(String(feedUrl)).toBe("https://graph.facebook.com/v23.0/555000111/feed");
    const feedForm = formOf(fetchImpl.mock.calls[3] as unknown[]);
    expect(feedForm.get("message")).toBe("Giannal – NẮNG THÁNG TÁM");
    expect(feedForm.get("attached_media[0]")).toBe('{"media_fbid":"p1"}');
    expect(feedForm.get("attached_media[2]")).toBe('{"media_fbid":"p3"}');
  });

  it("keeps the album order the operator chose (cover first)", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "cover" }))
      .mockResolvedValueOnce(jsonResponse({ id: "second" }))
      .mockResolvedValueOnce(jsonResponse({ id: "555000111_9200" }));
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    await publisher.publishImagePost({
      tenantId: "t1",
      channel: CHANNEL,
      caption: "x",
      media: [
        { driveFileId: "d25", fileName: "MR (25).jpg", url: "https://cdn/25.jpg" },
        { driveFileId: "d3", fileName: "MR (3).jpg", url: "https://cdn/3.jpg" },
      ],
      idempotencyKey: "k",
    });

    expect(formOf(fetchImpl.mock.calls[0] as unknown[]).get("url")).toBe("https://cdn/25.jpg");
    const feedForm = formOf(fetchImpl.mock.calls[2] as unknown[]);
    expect(feedForm.get("attached_media[0]")).toBe('{"media_fbid":"cover"}');
    expect(feedForm.get("attached_media[1]")).toBe('{"media_fbid":"second"}');
  });
});

// --- Phase 2: video + reels (E5.3/E5.4) -------------------------------------

describe("publishVideoPost — feed video", () => {
  const VIDEO_URL = "https://cdn.example/api/media/drive-1?tenant=t&expires=1&sig=ab";

  it("posts file_url + description to /{page-id}/videos", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "999", post_id: "555000111_999" }));
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    const result = await publisher.publishVideoPost({
      tenantId: "t-1",
      channel: CHANNEL,
      caption: "Giannal – MỘT NGÀY DỊU DÀNG",
      videoUrl: VIDEO_URL,
      target: "video",
      idempotencyKey: "key-1",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v23.0/555000111/videos");
    const form = formOf(fetchImpl.mock.calls[0] as unknown[]);
    expect(form.get("file_url")).toBe(VIDEO_URL);
    expect(form.get("description")).toBe("Giannal – MỘT NGÀY DỊU DÀNG");
    // The token travels in the body, never the query string.
    expect(form.get("access_token")).toBe("EAAsecret-token");
    expect(result).toEqual({
      postId: "555000111_999",
      url: "https://www.facebook.com/555000111_999",
    });
  });

  it("falls back to the video id when Graph returns no post_id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "999" }));
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    const result = await publisher.publishVideoPost({
      tenantId: "t-1",
      channel: CHANNEL,
      caption: "caption",
      videoUrl: VIDEO_URL,
      target: "video",
      idempotencyKey: "key-1",
    });
    expect(result.postId).toBe("999");
    // "999" is not a "<page>_<post>" permalink: no link rather than a wrong one.
    expect(result.url).toBeNull();
  });

  it.each([
    ["no video URL", { videoUrl: "" }],
    ["a non-http URL", { videoUrl: "drive://file/1" }],
    ["an empty caption", { caption: "   " }],
    ["an unknown target", { target: "story" as unknown as "video" }],
  ])("refuses %s before any HTTP call", async (_label, patch) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "999" }));
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(
      publisher.publishVideoPost({
        tenantId: "t-1",
        channel: CHANNEL,
        caption: "caption",
        videoUrl: VIDEO_URL,
        target: "video",
        idempotencyKey: "key-1",
        ...patch,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps an expired token to TOKEN_EXPIRED (no retry upstream)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 190, error_subcode: 463, message: "Session expired" } }, 400),
    );
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(
      publisher.publishVideoPost({
        tenantId: "t-1",
        channel: CHANNEL,
        caption: "caption",
        videoUrl: VIDEO_URL,
        target: "video",
        idempotencyKey: "key-1",
      }),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
  });

  it("refuses a 200 without a usable id instead of claiming success", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(
      publisher.publishVideoPost({
        tenantId: "t-1",
        channel: CHANNEL,
        caption: "caption",
        videoUrl: VIDEO_URL,
        target: "video",
        idempotencyKey: "key-1",
      }),
    ).rejects.toMatchObject({ code: "META_ERROR", context: { retryable: false } });
  });
});

describe("publishVideoPost — reels (3 phases)", () => {
  const VIDEO_URL = "https://cdn.example/api/media/drive-1?tenant=t&expires=1&sig=ab";

  it("walks start -> upload -> finish and returns the post id", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("rupload.facebook.com")) {
        // The bytes are transferred BY URL: headers carry everything.
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers.Authorization).toBe("OAuth EAAsecret-token");
        expect(headers.file_url).toBe(VIDEO_URL);
        return jsonResponse({ success: true });
      }
      const body = init?.body as URLSearchParams;
      if (body.get("upload_phase") === "start") {
        return jsonResponse({
          video_id: "vid-1",
          upload_url: "https://rupload.facebook.com/video-upload/v23.0/vid-1",
        });
      }
      expect(body.get("upload_phase")).toBe("finish");
      expect(body.get("video_id")).toBe("vid-1");
      expect(body.get("video_state")).toBe("PUBLISHED");
      expect(body.get("description")).toBe("Reel caption");
      return jsonResponse({ success: true, post_id: "555000111_777" });
    });

    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);
    const result = await publisher.publishVideoPost({
      tenantId: "t-1",
      channel: CHANNEL,
      caption: "Reel caption",
      videoUrl: VIDEO_URL,
      target: "reels",
      idempotencyKey: "key-1",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      postId: "555000111_777",
      url: "https://www.facebook.com/555000111_777",
    });
  });

  it("refuses when the finish phase answers success=false", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("rupload.facebook.com")) return jsonResponse({ success: true });
      const body = init?.body as URLSearchParams;
      return body.get("upload_phase") === "start"
        ? jsonResponse({ video_id: "vid-1" })
        : jsonResponse({ success: false });
    });
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      publisher.publishVideoPost({
        tenantId: "t-1",
        channel: CHANNEL,
        caption: "Reel caption",
        videoUrl: VIDEO_URL,
        target: "reels",
        idempotencyKey: "key-1",
      }),
    ).rejects.toMatchObject({ code: "META_ERROR", context: { step: "reels.finish" } });
  });

  it("stops at the start phase when the token is dead", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 190, message: "Session expired" } }, 400),
    );
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      publisher.publishVideoPost({
        tenantId: "t-1",
        channel: CHANNEL,
        caption: "Reel caption",
        videoUrl: VIDEO_URL,
        target: "reels",
        idempotencyKey: "key-1",
      }),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("propagates an upload-phase failure as a Graph error", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("rupload.facebook.com")) {
        return jsonResponse({ error: { code: 1609005, message: "Error parsing file" } }, 400);
      }
      const body = init?.body as URLSearchParams;
      return body.get("upload_phase") === "start"
        ? jsonResponse({ video_id: "vid-1" })
        : jsonResponse({ success: true });
    });
    const publisher = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      publisher.publishVideoPost({
        tenantId: "t-1",
        channel: CHANNEL,
        caption: "Reel caption",
        videoUrl: VIDEO_URL,
        target: "reels",
        idempotencyKey: "key-1",
      }),
    ).rejects.toMatchObject({ code: "META_ERROR" });
    // start + upload, never the finish phase.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
