import { describe, expect, it, vi } from "vitest";

import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { ChannelConfig } from "@/core/ports/publisher";

import { makeFacebookPublisher } from "./facebook-publisher";
import { makeGraphClient } from "./graph-client";

/**
 * Phase 2 video/reels against a MOCKED Graph API. A video still travels as a
 * URL (Meta downloads it itself), unlike a photo — see
 * facebook-publisher.image.test.ts for the byte-upload path.
 *
 * PENDING(graph-video-verify): not run against a real Page from this machine.
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
