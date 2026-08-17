import { describe, expect, it, vi } from "vitest";

import { HANDOFF_MIN_LEAD_MS } from "@/core/domain/post-job";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type { ChannelConfig, PublishMediaBytes, PublishMediaItem } from "@/core/ports/publisher";

import { makeFacebookPublisher } from "./facebook-publisher";
import { makeGraphClient } from "./graph-client";

/**
 * E8.6 — handing a post to Facebook's own scheduler, against a MOCKED Graph API.
 *
 * What every test here watches:
 *   - the photos still travel as multipart `source` BYTES (the 324 fix), so the
 *     scheduled path and the immediate path upload identically;
 *   - the /feed call carries `published=false` + `scheduled_publish_time` in
 *     UNIX SECONDS — the two fields that make Facebook, not our queue, the one
 *     that waits;
 *   - the reconciliation read never invents a verdict.
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

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makePublisher(fetchImpl: typeof fetch) {
  const logger = recordingLogger();
  const publisher = makeFacebookPublisher({
    graph: makeGraphClient({ logger, fetchImpl, version: "v23.0" }),
    logger,
  });
  const scheduled = publisher.scheduled;
  if (!scheduled) throw new Error("the Facebook publisher must expose its scheduled half");
  return { logger, publisher, scheduled };
}

function photo(
  driveFileId: string,
  fileName: string,
): PublishMediaItem & { readBytes: ReturnType<typeof vi.fn> } {
  const readBytes = vi.fn(
    async (): Promise<PublishMediaBytes> => ({ bytes: JPEG, mimeType: "image/jpeg" }),
  );
  return { driveFileId, fileName, readBytes };
}

/** Form body of a `graph.post` (urlencoded) call. */
function formOf(call: unknown[]): URLSearchParams {
  return (call[1] as RequestInit).body as URLSearchParams;
}

const IN_20_MINUTES = (): Date => new Date(Date.now() + 20 * 60_000);

// --- Edge cases first -------------------------------------------------------

describe("schedulePost — refusals (nothing is uploaded)", () => {
  it("refuses an hour Facebook would reject, BEFORE the album is uploaded", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);
    const item = photo("d1", "1.jpg");

    await expect(
      scheduled.schedulePost({
        tenantId: "t1",
        channel: CHANNEL,
        caption: "x",
        media: [item],
        idempotencyKey: "k",
        // 5 minutes: measured as refused by Graph (#100).
        publishAt: new Date(Date.now() + 5 * 60_000),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: {
        reason: "PUBLISH_AT_TOO_SOON",
        min_lead_ms: HANDOFF_MIN_LEAD_MS,
        // Nothing reached Facebook, so the caller may publish at the hour
        // instead of failing the job (see ScheduledPublisher's contract).
        platform_created_nothing: true,
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    // Minutes of upload saved for a call that could not have worked.
    expect(item.readBytes).not.toHaveBeenCalled();
  });

  it("refuses a missing or invalid hour", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      scheduled.schedulePost({
        tenantId: "t1",
        channel: CHANNEL,
        caption: "x",
        media: [photo("d1", "1.jpg")],
        idempotencyKey: "k",
        publishAt: new Date("not a date"),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "PUBLISH_AT_NOT_A_DATE" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("applies the same channel/album/caption gate as an immediate post", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      scheduled.schedulePost({
        tenantId: "t1",
        channel: { ...CHANNEL, platform: "tiktok" },
        caption: "x",
        media: [photo("d1", "1.jpg")],
        idempotencyKey: "k",
        publishAt: IN_20_MINUTES(),
      }),
    ).rejects.toMatchObject({ code: "CHANNEL_NOT_CONFIGURED" });

    await expect(
      scheduled.schedulePost({
        tenantId: "t1",
        channel: CHANNEL,
        caption: "   ",
        media: [photo("d1", "1.jpg")],
        idempotencyKey: "k",
        publishAt: IN_20_MINUTES(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * REGRESSION (the reason `platform_created_nothing` left this branch): a Graph
   * error body proves nothing about the JOB, only about this request. #506
   * DUPLICATE_POST is the proof: Facebook answers it when a post like this one
   * ALREADY EXISTS — which is exactly what a retry after a lost /feed answer
   * hits. Marking it would send the job to the publish-at-the-hour path on top
   * of a scheduled post nobody can see.
   */
  it("never marks a refused /feed as 'nothing was created' — not even #506", async () => {
    for (const graphCode of [100, 506, 200, 368]) {
      const fetchImpl = vi.fn<typeof fetch>(async (url) =>
        String(url).endsWith("/photos")
          ? jsonResponse({ id: "photo-1" })
          : jsonResponse({ error: { code: graphCode, message: "refused" } }, 400),
      );
      const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

      const error = await scheduled
        .schedulePost({
          tenantId: "t1",
          channel: CHANNEL,
          caption: "x",
          media: [photo("d1", "1.jpg")],
          idempotencyKey: "k",
          publishAt: IN_20_MINUTES(),
        })
        .then(() => null)
        .catch((thrown: unknown) => thrown as { context: Record<string, unknown> });

      expect(error?.context.graph_code).toBe(graphCode);
      expect(error?.context.platform_created_nothing).toBeUndefined();
      // The one thing the caller may rely on: the creating call went out.
      expect(error?.context.feed_dispatched).toBe(true);
    }
  });

  /**
   * What the #100-after-a-slow-upload case became: the lead is re-measured
   * BEFORE the dispatch, so the refusal happens here — where "no post exists" is
   * a fact about this adapter, not a reading of Facebook's answer.
   */
  it("refuses AFTER the upload when the album ate the lead, before /feed", async () => {
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const fetchImpl = vi.fn<typeof fetch>(async (url) => {
        if (!String(url).endsWith("/photos")) throw new Error("/feed must not be called");
        // Each photo takes four minutes: two photos eat more than the lead.
        now += 4 * 60_000;
        return jsonResponse({ id: "photo-1" });
      });
      const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

      await expect(
        scheduled.schedulePost({
          tenantId: "t1",
          channel: CHANNEL,
          caption: "x",
          media: [photo("d1", "1.jpg"), photo("d2", "2.jpg")],
          idempotencyKey: "k",
          publishAt: new Date(now + 15 * 60_000),
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        context: {
          reason: "PUBLISH_AT_TOO_SOON_AFTER_UPLOAD",
          retryable: false,
          platform_created_nothing: true,
        },
      });
      // Two photo uploads and NO /feed call.
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("marks an upload failure as 'nothing was created' — photos are not posts", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/photos")
        ? jsonResponse({ error: { code: 100, message: "Missing or invalid image file" } }, 400)
        : jsonResponse({ id: "555000111_777" }),
    );
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      scheduled.schedulePost({
        tenantId: "t1",
        channel: CHANNEL,
        caption: "x",
        media: [photo("d1", "1.jpg")],
        idempotencyKey: "k",
        publishAt: IN_20_MINUTES(),
      }),
    ).rejects.toMatchObject({
      code: "META_ERROR",
      context: { step: "photos.album", platform_created_nothing: true },
    });
    // /feed was never reached: only the photo call went out.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does NOT mark a transport failure — after a timeout the post may exist", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/photos")) return jsonResponse({ id: "photo-1" });
      throw new TypeError("socket hang up");
    });
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    const error = await scheduled
      .schedulePost({
        tenantId: "t1",
        channel: CHANNEL,
        caption: "x",
        media: [photo("d1", "1.jpg")],
        idempotencyKey: "k",
        publishAt: IN_20_MINUTES(),
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as { context: Record<string, unknown> });

    expect(error?.context.platform_created_nothing).toBeUndefined();
    expect(error?.context.feed_dispatched).toBe(true);
  });

  it("refuses a /feed answer without an id instead of claiming a schedule", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/photos") ? jsonResponse({ id: "photo-1" }) : jsonResponse({ ok: true }),
    );
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      scheduled.schedulePost({
        tenantId: "t1",
        channel: CHANNEL,
        caption: "x",
        media: [photo("d1", "1.jpg")],
        idempotencyKey: "k",
        publishAt: IN_20_MINUTES(),
      }),
    ).rejects.toMatchObject({
      code: "META_ERROR",
      context: { step: "feed.scheduled", retryable: false },
    });
    // A 200 we cannot read may hide a created post: it must NOT be marked as
    // "nothing was created", or the caller would publish at the hour on top of
    // a scheduled post nobody can see.
    const error = await scheduled
      .schedulePost({
        tenantId: "t1",
        channel: CHANNEL,
        caption: "x",
        media: [photo("d2", "2.jpg")],
        idempotencyKey: "k",
        publishAt: IN_20_MINUTES(),
      })
      .then(() => null)
      .catch((thrown: unknown) => thrown as { context: Record<string, unknown> });
    expect(error?.context.platform_created_nothing).toBeUndefined();
  });
});

// --- Happy path -------------------------------------------------------------

describe("schedulePost — the handoff call", () => {
  it("uploads the bytes, then asks /feed to publish at the hour", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      calls.push(path.endsWith("/photos") ? "photos" : "feed");
      return path.endsWith("/photos")
        ? jsonResponse({ id: `photo-${calls.length}` })
        : jsonResponse({ id: "555000111_777" });
    });
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);
    const publishAt = IN_20_MINUTES();
    const media = [photo("d1", "1.jpg"), photo("d2", "2.jpg")];

    const result = await scheduled.schedulePost({
      tenantId: "t1",
      channel: CHANNEL,
      caption: "Giannal – MỘT NGÀY DỊU DÀNG",
      media,
      idempotencyKey: "k",
      publishAt,
    });

    expect(result.scheduledPostId).toBe("555000111_777");
    expect(calls).toEqual(["photos", "photos", "feed"]);
    // The bytes were read and uploaded, exactly like the immediate path.
    expect(media.every((item) => item.readBytes.mock.calls.length === 1)).toBe(true);

    const photoForm = (fetchImpl.mock.calls[0][1] as RequestInit).body as FormData;
    expect(photoForm.get("published")).toBe("false");
    expect(photoForm.get("source")).toBeInstanceOf(Blob);

    const feed = formOf(fetchImpl.mock.calls[2]);
    expect(feed.get("published")).toBe("false");
    // Unix SECONDS, floored — Meta rejects anything else.
    expect(feed.get("scheduled_publish_time")).toBe(String(Math.floor(publishAt.getTime() / 1000)));
    expect(feed.get("attached_media[0]")).toBe('{"media_fbid":"photo-1"}');
    expect(feed.get("attached_media[1]")).toBe('{"media_fbid":"photo-2"}');
    expect(feed.get("message")).toBe("Giannal – MỘT NGÀY DỊU DÀNG");
  });

  it("uses the SAME album flow for a single photo — never the published=true one", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/photos")
        ? jsonResponse({ id: "photo-1" })
        : jsonResponse({ id: "555000111_777" }),
    );
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    await scheduled.schedulePost({
      tenantId: "t1",
      channel: CHANNEL,
      caption: "x",
      media: [photo("d1", "1.jpg")],
      idempotencyKey: "k",
      publishAt: IN_20_MINUTES(),
    });

    const photoForm = (fetchImpl.mock.calls[0][1] as RequestInit).body as FormData;
    expect(photoForm.get("published")).toBe("false");
    expect(fetchImpl.mock.calls).toHaveLength(2);
  });
});

describe("getPostState — the reconciliation read", () => {
  it("reports `published` only on is_published=true, with Facebook's permalink", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        id: "555000111_777",
        is_published: true,
        permalink_url: "https://www.facebook.com/555000111/posts/777",
        created_time: "2026-08-13T09:00:00+0000",
      }),
    );
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    const state = await scheduled.getPostState({
      tenantId: "t1",
      channel: CHANNEL,
      postId: "555000111_777",
    });

    expect(state).toEqual({
      state: "published",
      postId: "555000111_777",
      url: "https://www.facebook.com/555000111/posts/777",
      publishedAt: new Date("2026-08-13T09:00:00+0000"),
    });
  });

  it("reports `scheduled` while Facebook still holds it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ id: "555000111_777", is_published: false, scheduled_publish_time: 1786604400 }),
    );
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    const state = await scheduled.getPostState({
      tenantId: "t1",
      channel: CHANNEL,
      postId: "555000111_777",
    });

    expect(state).toEqual({
      state: "scheduled",
      postId: "555000111_777",
      publishAt: new Date(1786604400 * 1000),
    });
  });

  it("says `unknown` — never `published` — when the answer has no verdict in it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ id: "555000111_777" }));
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    const state = await scheduled.getPostState({
      tenantId: "t1",
      channel: CHANNEL,
      postId: "555000111_777",
    });

    expect(state).toEqual({ state: "unknown", reason: "NO_IS_PUBLISHED_FIELD" });
  });

  /**
   * BEHAVIOUR CHANGE (was: "says `gone`"). Meta's own text for 100/33 is
   * "Object with ID X does not exist, cannot be loaded due to missing
   * permissions, or does not support this operation" — a wrong token and a
   * revoked permission produce it too, so it can never mean "đã bị xoá".
   */
  it("says `unknown` — not `gone` — for Graph's 100/33 answer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        { error: { code: 100, error_subcode: 33, message: "Object does not exist" } },
        400,
      ),
    );
    const { scheduled, logger } = makePublisher(fetchImpl as unknown as typeof fetch);

    const state = await scheduled.getPostState({
      tenantId: "t1",
      channel: CHANNEL,
      postId: "555000111_777",
    });

    expect(state).toEqual({ state: "unknown", reason: "OBJECT_NOT_READABLE_100_33" });
    expect(
      logger.lines.some(
        (line) =>
          line.level === "warn" &&
          (line.context as { alert?: string } | undefined)?.alert === "OPERATOR_ATTENTION",
      ),
    ).toBe(true);
  });

  it("rethrows anything else — a dead token is not a verdict on the post", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: { code: 190, message: "token expired" } }, 401),
    );
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      scheduled.getPostState({ tenantId: "t1", channel: CHANNEL, postId: "555000111_777" }),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
  });

  it("refuses to ask without a post id", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      scheduled.getPostState({ tenantId: "t1", channel: CHANNEL, postId: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("deleteScheduledPost — taking the post back", () => {
  it("DELETEs the post and reports success", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ success: true }));
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    const deleted = await scheduled.deleteScheduledPost({
      tenantId: "t1",
      channel: CHANNEL,
      postId: "555000111_777",
    });

    expect(deleted).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("/v23.0/555000111_777");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  /**
   * BEHAVIOUR CHANGE (was: "returns false when the post was already gone").
   * 100/33 does not prove the post is gone, and a cancel that reports success
   * on it would tell the operator "Facebook sẽ không đăng nữa" about a post a
   * wrong token simply could not see.
   */
  it("THROWS on 100/33 — 'I cannot read it' is not 'it is gone'", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: { code: 100, error_subcode: 33, message: "does not exist" } }, 400),
    );
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      scheduled.deleteScheduledPost({
        tenantId: "t1",
        channel: CHANNEL,
        postId: "555000111_777",
      }),
    ).rejects.toMatchObject({
      code: "META_ERROR",
      userMessage: expect.stringContaining("KHÔNG xác nhận được"),
      context: { reason: "OBJECT_NOT_READABLE_100_33", retryable: false },
    });
  });

  it("throws when Graph refuses — the caller must not report a cancel that did nothing", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: { code: 200, message: "no permission" } }, 403),
    );
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      scheduled.deleteScheduledPost({
        tenantId: "t1",
        channel: CHANNEL,
        postId: "555000111_777",
      }),
    ).rejects.toMatchObject({ code: "META_ERROR" });
  });

  it("throws on an explicit success=false", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ success: false }));
    const { scheduled } = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      scheduled.deleteScheduledPost({
        tenantId: "t1",
        channel: CHANNEL,
        postId: "555000111_777",
      }),
    ).rejects.toMatchObject({
      code: "META_ERROR",
      context: { reason: "DELETE_REFUSED", retryable: false },
    });
  });

  /**
   * REGRESSION: a 200 body without a confirmation used to fall through to
   * `return true`. The port contract is explicit — "an answer the implementer
   * cannot interpret" throws, because "we could not confirm" must never reach
   * the caller as "it is gone".
   */
  it.each([
    ["a 200 with no `success` key at all", {}],
    ["a 200 carrying an error shape this client cannot read", { error: ["weird"] }],
    ["a 200 whose success is not a boolean", { success: "true" }],
  ])("THROWS on %s", async (_name, body) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(body));
    const { scheduled, logger } = makePublisher(fetchImpl as unknown as typeof fetch);

    await expect(
      scheduled.deleteScheduledPost({
        tenantId: "t1",
        channel: CHANNEL,
        postId: "555000111_777",
      }),
    ).rejects.toMatchObject({
      code: "META_ERROR",
      // The operator must be told the post may still be on the Page.
      userMessage: expect.stringContaining("VẪN có thể còn trên Trang"),
      context: { reason: "UNCONFIRMED_DELETE_RESPONSE", retryable: false },
    });
    expect(
      logger.lines.some(
        (line) =>
          line.level === "error" &&
          (line.context as { alert?: string } | undefined)?.alert === "OPERATOR_ATTENTION",
      ),
    ).toBe(true);
  });
});
