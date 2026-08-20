import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { ChannelConfig, PublishMediaBytes, PublishMediaItem } from "@/core/ports/publisher";

import { makeFacebookPublisher } from "./facebook-publisher";
import { makeGraphClient } from "./graph-client";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * Photo posting against a MOCKED Graph API (fetch is the seam).
 *
 * The one thing every test here watches: the photo travels as multipart
 * `source` BYTES, not as `url=`. Handing Graph a URL made Facebook fetch the
 * file itself and abandon it around 30s — 4 of 10 photos on a measured real
 * post; the same 10 uploaded as bytes went 10/10.
 */

const TOKEN = "EAAsecret-token";

interface LogLine {
  level: string;
  message: string;
  context?: unknown;
}

function recordingLogger(): Logger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const record =
    (level: string) =>
    (message: string, context?: LogContext) => {
      lines.push({ level, message, context });
    };
  const logger = {
    lines,
    child: (_bindings: LogBindings) => logger,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  } as Logger & { lines: LogLine[] };
  return logger;
}

const CHANNEL: ChannelConfig = {
  channelId: "fbpage-a",
  platform: "facebook",
  name: "Page A",
  externalId: "555000111",
  accessToken: TOKEN,
  status: "active",
  tokenExpiresAt: null,
};

/** A real JPEG magic number, so nothing here looks like an empty buffer. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makePublisher(fetchImpl: typeof fetch, logger = recordingLogger()) {
  return {
    logger,
    publisher: makeFacebookPublisher({
      graph: makeGraphClient({ logger, fetchImpl, version: "v23.0" }),
      logger,
    }),
  };
}

/** One album item whose bytes are read lazily, with a spy on the read. */
function photo(
  driveFileId: string,
  fileName: string,
  options: {
    bytes?: Uint8Array;
    mimeType?: string | null;
    fail?: unknown;
  } = {},
): PublishMediaItem & { readBytes: ReturnType<typeof vi.fn> } {
  // `mimeType: null` is a real case (Drive reports none), so undefined and null
  // must not collapse into the same default here.
  const mimeType = "mimeType" in options ? options.mimeType ?? null : "image/jpeg";
  const readBytes = vi.fn(async (): Promise<PublishMediaBytes> => {
    if (options.fail) throw options.fail;
    return { bytes: options.bytes ?? JPEG, mimeType };
  });
  return { driveFileId, fileName, readBytes };
}

function bodyOf(call: unknown[]): FormData {
  return (call[1] as RequestInit).body as FormData;
}

/** The uploaded part of a /photos call. */
function sourceOf(call: unknown[]): File {
  const part = bodyOf(call).get("source");
  if (!(part instanceof Blob)) throw new Error("the request carries no `source` file part");
  return part as File;
}

// --- Edge cases first -------------------------------------------------------

describe("publishImagePost — rejected inputs (nothing is sent, nothing is read)", () => {
  it("refuses a non-facebook channel", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);
    const item = photo("d", "f.jpg");

    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: { ...CHANNEL, platform: "tiktok" },
        caption: "x",
        media: [item],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "CHANNEL_NOT_CONFIGURED" });
    expect(fetchImpl).not.toHaveBeenCalled();
    // The guard runs before any byte is read: no Drive traffic for a bad call.
    expect(item.readBytes).not.toHaveBeenCalled();
  });

  it("refuses an empty album and an 11-photo album", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);
    const media = Array.from({ length: 11 }, (_, index) => photo(`d${index}`, `f${index}.jpg`));

    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "x",
        media: [],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "x",
        media,
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(media.every((item) => item.readBytes.mock.calls.length === 0)).toBe(true);
  });

  it("refuses an empty caption", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "   ",
        media: [photo("d", "f.jpg")],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("publishImagePost — the bytes cannot be read", () => {
  it("refuses an EMPTY body before Graph is called", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "x",
        media: [photo("d1", "1.jpg", { bytes: new Uint8Array(0) })],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_NOT_FOUND",
      context: { reason: "EMPTY_MEDIA_BYTES", file_name: "1.jpg", retryable: false },
    });
    // Graph answers an empty part with an opaque "invalid image file"; the
    // refusal must happen here, where the file name is still known.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names WHICH photo failed to read and never posts the album", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: "p1" }));
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);
    const first = photo("d1", "1.jpg");
    const broken = photo("d2", "2.jpg", {
      fail: new AppError("DRIVE_ERROR", { message: "Drive timed out" }),
    });
    const third = photo("d3", "3.jpg");

    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "x",
        media: [first, broken, third],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({
      code: "DRIVE_ERROR",
      context: {
        media_index: 1,
        drive_file_id: "d2",
        file_name: "2.jpg",
        step: "media.read",
        tenant_id: "t1",
        channel: "fbpage-a",
      },
    });

    // Photo 1 was uploaded, photo 3 was never even READ (lazy), and no /feed
    // call happened — a half album must not become a post.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(third.readBytes).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls.every(([url]) => String(url).endsWith("/photos"))).toBe(true);
  });

  it("keeps MEDIA_NOT_FOUND (a deleted file) instead of turning it into a Drive outage", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "x",
        media: [
          photo("d1", "1.jpg", {
            fail: new AppError("MEDIA_NOT_FOUND", {
              message: "gone",
              context: { retryable: false },
            }),
          }),
        ],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_NOT_FOUND",
      context: { retryable: false, media_index: 0, drive_file_id: "d1" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("publishImagePost — Graph failures", () => {
  it("maps an expired token to TOKEN_EXPIRED and stops after the first upload", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ error: { code: 190, error_subcode: 463, message: "Session expired" } }, 401),
      );
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);
    const second = photo("d2", "2.jpg");

    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "Penny – NGÀY MỚI",
        media: [photo("d1", "1.jpg"), second],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED", context: { retryable: false } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.readBytes).not.toHaveBeenCalled();
  });

  it("maps a rate limit to a retryable META_ERROR", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { code: 613 } }, 400));
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "x",
        media: [photo("d", "f.jpg")],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({
      code: "META_ERROR",
      context: { retryable: true, reason: "RATE_LIMITED" },
    });
  });

  it("treats a 200 without an id as a failure, not as a published post", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);
    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "x",
        media: [photo("d", "f.jpg")],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "META_ERROR", context: { retryable: false } });
  });

  it("does not publish the album when one photo upload fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "photo-1" }))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 324 } }, 400));
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "x",
        media: [photo("d1", "1.jpg"), photo("d2", "2.jpg")],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "META_ERROR" });
    // Two photo calls, and crucially NO /feed call: no half-empty album post.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls.at(-1)?.[0])).toContain("/photos");
  });

  it("never lets the Page token reach a log line", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: { code: 100, message: `bad param ${TOKEN}` } }, 400));
    const logger = recordingLogger();
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch, logger);

    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "x",
        media: [photo("d", "f.jpg")],
        idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ code: "META_ERROR" });

    // The URL carries no token either — it lives in the multipart body.
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain(TOKEN);
    const ourLines = logger.lines.map((line) =>
      JSON.stringify({ message: line.message, context: line.context }),
    );
    // Meta echoed the token inside its own error message; that is Meta's text,
    // and what matters is that WE never add it as a field of our own.
    for (const line of ourLines) {
      const context = JSON.parse(line).context ?? {};
      expect(JSON.stringify(context.access_token ?? null)).not.toContain(TOKEN);
    }
  });
});

// --- Happy paths ------------------------------------------------------------

describe("publishImagePost — happy paths", () => {
  it("uploads a single photo's BYTES with the caption in one call", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ id: "9001", post_id: "555000111_9001" }));
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);

    const result = await publisher.publishImagePost({
      tenantId: testTenantId("t1"),
      channel: CHANNEL,
      caption: "Penny – MỘT NGÀY DỊU DÀNG",
      media: [photo("d1", "1.jpg")],
      idempotencyKey: "batch|MR0AC6080||fbpage-a|image_post",
    });

    expect(result).toEqual({
      postId: "555000111_9001",
      url: "https://www.facebook.com/555000111_9001",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      "https://graph.facebook.com/v23.0/555000111/photos",
    );

    const form = bodyOf(fetchImpl.mock.calls[0] as unknown[]);
    expect(form).toBeInstanceOf(FormData);
    // The whole point: bytes in `source`, and NO `url` field at all.
    expect(form.get("url")).toBeNull();
    const source = sourceOf(fetchImpl.mock.calls[0] as unknown[]);
    expect(source.size).toBe(JPEG.length);
    expect(source.type).toBe("image/jpeg");
    expect(source.name).toBe("1.jpg");
    expect(form.get("message")).toBe("Penny – MỘT NGÀY DỊU DÀNG");
    expect(form.get("published")).toBe("true");
    expect(form.get("access_token")).toBe(TOKEN);
  });

  it("falls back to octet-stream when the source reports no MIME type", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: "9001" }));
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);

    // 606 real files carry no extension (docs/05 1.3) — Drive reports no type.
    await publisher.publishImagePost({
      tenantId: testTenantId("t1"),
      channel: CHANNEL,
      caption: "x",
      media: [photo("d1", "no-extension", { mimeType: null })],
      idempotencyKey: "k",
    });

    expect(sourceOf(fetchImpl.mock.calls[0] as unknown[]).type).toBe("application/octet-stream");
  });

  it("uploads N unpublished photos and attaches them to one feed post", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "p1" }))
      .mockResolvedValueOnce(jsonResponse({ id: "p2" }))
      .mockResolvedValueOnce(jsonResponse({ id: "p3" }))
      .mockResolvedValueOnce(jsonResponse({ id: "555000111_9100" }));
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);
    const media = [photo("d1", "1.jpg"), photo("d2", "2.jpg"), photo("d3", "3.jpg")];

    const result = await publisher.publishImagePost({
      tenantId: testTenantId("t1"),
      channel: CHANNEL,
      caption: "Giannal – NẮNG THÁNG TÁM",
      media,
      idempotencyKey: "k",
    });

    expect(result.postId).toBe("555000111_9100");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    // One read per photo: no file is downloaded twice, none is skipped.
    expect(media.map((item) => item.readBytes.mock.calls.length)).toEqual([1, 1, 1]);

    const photoForm = bodyOf(fetchImpl.mock.calls[0] as unknown[]);
    expect(photoForm.get("published")).toBe("false");
    expect(photoForm.get("temporary")).toBe("true");
    expect(photoForm.get("message")).toBeNull();
    expect(sourceOf(fetchImpl.mock.calls[0] as unknown[]).name).toBe("1.jpg");

    expect(String(fetchImpl.mock.calls[3][0])).toBe(
      "https://graph.facebook.com/v23.0/555000111/feed",
    );
    // The feed call is a plain form POST — no bytes, so no multipart.
    const feedForm = bodyOf(fetchImpl.mock.calls[3] as unknown[]) as unknown as URLSearchParams;
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
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);

    await publisher.publishImagePost({
      tenantId: testTenantId("t1"),
      channel: CHANNEL,
      caption: "x",
      media: [photo("d25", "MR (25).jpg"), photo("d3", "MR (3).jpg")],
      idempotencyKey: "k",
    });

    expect(sourceOf(fetchImpl.mock.calls[0] as unknown[]).name).toBe("MR (25).jpg");
    expect(sourceOf(fetchImpl.mock.calls[1] as unknown[]).name).toBe("MR (3).jpg");
    const feedForm = bodyOf(fetchImpl.mock.calls[2] as unknown[]) as unknown as URLSearchParams;
    expect(feedForm.get("attached_media[0]")).toBe('{"media_fbid":"cover"}');
    expect(feedForm.get("attached_media[1]")).toBe('{"media_fbid":"second"}');
  });

  it("reads photo k only when photo k-1 has been uploaded (one buffer at a time)", async () => {
    const events: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      events.push(`upload:${String(url).endsWith("/photos") ? "photo" : "feed"}`);
      return jsonResponse({ id: `p${events.length}` });
    });
    const { publisher } = makePublisher(fetchImpl as unknown as typeof fetch);
    const media = [photo("d1", "1.jpg"), photo("d2", "2.jpg")];
    media.forEach((item, index) => {
      const original = item.readBytes.getMockImplementation();
      item.readBytes.mockImplementation(async () => {
        events.push(`read:${index}`);
        return original ? original() : { bytes: JPEG, mimeType: "image/jpeg" };
      });
    });

    await publisher.publishImagePost({
      tenantId: testTenantId("t1"),
      channel: CHANNEL,
      caption: "x",
      media,
      idempotencyKey: "k",
    });

    expect(events).toEqual(["read:0", "upload:photo", "read:1", "upload:photo", "upload:feed"]);
  });
});
