import { describe, expect, it, vi } from "vitest";

import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import type {
  ChannelConfig,
  PublishMediaBytes,
  PublishMediaItem,
  PublishProgressEvent,
} from "@/core/ports/publisher";

import { makeFacebookPublisher } from "../facebook-publisher";
import { makeFakeChannelPublisher } from "../fake-publisher";
import { makeGraphClient } from "../graph-client";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * E7.5 — what a publisher tells the caller WHILE it works (design §5.5).
 *
 * The assertion that matters most is not the count of events: it is WHERE
 * `creating_post` sits. It must be the last thing the caller hears before the
 * request that can put a post on the Page, because the screen uses it to stop
 * saying "đang tải ảnh" and the operator uses it to know the point of no return
 * has been passed (business rule 4).
 */

const TOKEN = "EAAsecret-token";

interface LogLine {
  level: string;
  message: string;
  context?: LogContext;
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

function photo(index: number): PublishMediaItem {
  return {
    driveFileId: `drive-${index}`,
    fileName: `IMG_${2040 + index}.jpg`,
    readBytes: async (): Promise<PublishMediaBytes> => ({ bytes: JPEG, mimeType: "image/jpeg" }),
  };
}

/** Records events AND the outbound calls, so their INTERLEAVING is provable. */
function tracer() {
  const trace: string[] = [];
  const onProgress = (event: PublishProgressEvent): void => {
    trace.push(
      event.kind === "media_upload_started" || event.kind === "media_upload_finished"
        ? `${event.kind}:${event.index}/${event.total}:${event.fileName}`
        : event.kind,
    );
  };
  return { trace, onProgress };
}

function graphFetch(trace: string[]): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/photos")) {
      trace.push("CALL:/photos");
      return jsonResponse({ id: `photo-${trace.length}`, post_id: "555000111_1" });
    }
    if (url.includes("/feed")) {
      trace.push("CALL:/feed");
      return jsonResponse({ id: "555000111_9" });
    }
    throw new Error(`unexpected call ${url}`);
  }) as unknown as typeof fetch;
}

// --- Edge cases first -------------------------------------------------------

describe("a listener that misbehaves", () => {
  it("publishes the album anyway when onProgress throws on every event", async () => {
    const trace: string[] = [];
    const logger = recordingLogger();
    const publisher = makeFacebookPublisher({
      graph: makeGraphClient({ logger, fetchImpl: graphFetch(trace), version: "v23.0" }),
      logger,
    });

    const result = await publisher.publishImagePost({
      tenantId: testTenantId("t1"),
      channel: CHANNEL,
      caption: "x",
      media: [photo(1), photo(2)],
      idempotencyKey: "k",
      onProgress: () => {
        throw new Error("the screen exploded");
      },
    });

    expect(result.postId).toBe("555000111_9");
    // Visible, not silent: a broken listener leaves a warn behind.
    expect(logger.lines.filter((line) => line.level === "warn").length).toBeGreaterThan(0);
    expect(logger.lines.some((line) => line.context?.progress_kind === "creating_post")).toBe(true);
  });

  it("publishes with no listener at all (the pre-E7.5 behaviour)", async () => {
    const trace: string[] = [];
    const logger = recordingLogger();
    const publisher = makeFacebookPublisher({
      graph: makeGraphClient({ logger, fetchImpl: graphFetch(trace), version: "v23.0" }),
      logger,
    });

    const result = await publisher.publishImagePost({
      tenantId: testTenantId("t1"),
      channel: CHANNEL,
      caption: "x",
      media: [photo(1)],
      idempotencyKey: "k",
    });

    expect(result.postId).toBe("555000111_1");
  });

  it("says nothing when the call is refused before anything is sent", async () => {
    const logger = recordingLogger();
    const fetchImpl = vi.fn<typeof fetch>();
    const publisher = makeFacebookPublisher({
      graph: makeGraphClient({ logger, fetchImpl: fetchImpl as unknown as typeof fetch, version: "v23.0" }),
      logger,
    });
    const { trace, onProgress } = tracer();

    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "   ",
        media: [photo(1)],
        idempotencyKey: "k",
        onProgress,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // No `creating_post` for a post that was never sent: the screen must not
    // show "đang gửi lên kênh" for a job stopped by a pre-flight guard.
    expect(trace).toEqual([]);
  });
});

// --- Facebook -----------------------------------------------------------------

describe("facebook-publisher — album of 10", () => {
  it("reports each photo around its upload, then creating_post before /feed", async () => {
    const logger = recordingLogger();
    const { trace, onProgress } = tracer();
    const publisher = makeFacebookPublisher({
      graph: makeGraphClient({ logger, fetchImpl: graphFetch(trace), version: "v23.0" }),
      logger,
    });
    const media = Array.from({ length: 10 }, (_, index) => photo(index + 1));

    await publisher.publishImagePost({
      tenantId: testTenantId("t1"),
      channel: CHANNEL,
      caption: "x",
      media,
      idempotencyKey: "k",
      onProgress,
    });

    expect(trace.slice(0, 6)).toEqual([
      "media_upload_started:0/10:IMG_2041.jpg",
      "CALL:/photos",
      "media_upload_finished:0/10:IMG_2041.jpg",
      "media_upload_started:1/10:IMG_2042.jpg",
      "CALL:/photos",
      "media_upload_finished:1/10:IMG_2042.jpg",
    ]);
    expect(trace.slice(-2)).toEqual(["creating_post", "CALL:/feed"]);
    expect(trace.filter((entry) => entry === "creating_post")).toHaveLength(1);
  });

  it("stops reporting where the upload failed, and never says creating_post", async () => {
    const logger = recordingLogger();
    const trace: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      trace.push(`CALL:${String(input).includes("/feed") ? "/feed" : "/photos"}`);
      if (trace.filter((entry) => entry === "CALL:/photos").length === 2) {
        return jsonResponse({ error: { code: 1, message: "boom" } }, 500);
      }
      return jsonResponse({ id: "photo-1" });
    }) as unknown as typeof fetch;
    const publisher = makeFacebookPublisher({
      graph: makeGraphClient({ logger, fetchImpl, version: "v23.0" }),
      logger,
    });
    const { onProgress } = tracer();
    const events: PublishProgressEvent[] = [];

    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "x",
        media: [photo(1), photo(2), photo(3)],
        idempotencyKey: "k",
        onProgress: (event) => {
          events.push(event);
          onProgress(event);
        },
      }),
    ).rejects.toMatchObject({ code: "META_ERROR" });

    expect(events.some((event) => event.kind === "creating_post")).toBe(false);
    // The second photo started and never finished — which is exactly what the
    // operator needs to see in the last progress the job had.
    const last = events.at(-1);
    expect(last).toMatchObject({ kind: "media_upload_started", index: 1, total: 3 });
  });
});

describe("facebook-publisher — album of 1", () => {
  it("reports the single photo, then creating_post before the publishing call", async () => {
    const logger = recordingLogger();
    const { trace, onProgress } = tracer();
    const publisher = makeFacebookPublisher({
      graph: makeGraphClient({ logger, fetchImpl: graphFetch(trace), version: "v23.0" }),
      logger,
    });

    await publisher.publishImagePost({
      tenantId: testTenantId("t1"),
      channel: CHANNEL,
      caption: "x",
      media: [photo(1)],
      idempotencyKey: "k",
      onProgress,
    });

    // No `media_upload_finished`: on this path the upload IS the post, so the
    // last word before the call is `creating_post`.
    expect(trace).toEqual([
      "media_upload_started:0/1:IMG_2041.jpg",
      "creating_post",
      "CALL:/photos",
    ]);
  });
});

describe("facebook-publisher — schedulePost (E8.6)", () => {
  it("uploads the album, then creating_post before the scheduled /feed", async () => {
    const logger = recordingLogger();
    const { trace, onProgress } = tracer();
    const publisher = makeFacebookPublisher({
      graph: makeGraphClient({ logger, fetchImpl: graphFetch(trace), version: "v23.0" }),
      logger,
    });

    await publisher.scheduled!.schedulePost({
      tenantId: testTenantId("t1"),
      channel: CHANNEL,
      caption: "x",
      media: [photo(1), photo(2)],
      idempotencyKey: "k",
      publishAt: new Date(Date.now() + 20 * 60_000),
      onProgress,
    });

    expect(trace).toEqual([
      "media_upload_started:0/2:IMG_2041.jpg",
      "CALL:/photos",
      "media_upload_finished:0/2:IMG_2041.jpg",
      "media_upload_started:1/2:IMG_2042.jpg",
      "CALL:/photos",
      "media_upload_finished:1/2:IMG_2042.jpg",
      "creating_post",
      "CALL:/feed",
    ]);
  });
});

// --- Fake publisher ----------------------------------------------------------

describe("fake-publisher — the same events in the same places", () => {
  it("reports every photo of a 10-photo album and one creating_post", async () => {
    const publisher = makeFakeChannelPublisher();
    const { trace, onProgress } = tracer();
    const media = Array.from({ length: 10 }, (_, index) => photo(index + 1));

    await publisher.publishImagePost({
      tenantId: testTenantId("t1"),
      channel: CHANNEL,
      caption: "x",
      media,
      idempotencyKey: "k",
      onProgress,
    });

    expect(trace).toHaveLength(21);
    expect(trace[0]).toBe("media_upload_started:0/10:IMG_2041.jpg");
    expect(trace[19]).toBe("media_upload_finished:9/10:IMG_2050.jpg");
    expect(trace[20]).toBe("creating_post");
  });

  it("reports the single photo of a 1-photo album", async () => {
    const publisher = makeFakeChannelPublisher();
    const { trace, onProgress } = tracer();

    await publisher.publishImagePost({
      tenantId: testTenantId("t1"),
      channel: CHANNEL,
      caption: "x",
      media: [photo(1)],
      idempotencyKey: "k",
      onProgress,
    });

    expect(trace).toEqual([
      "media_upload_started:0/1:IMG_2041.jpg",
      "media_upload_finished:0/1:IMG_2041.jpg",
      "creating_post",
    ]);
  });

  it("never says creating_post for a scripted failure that created nothing", async () => {
    const publisher = makeFakeChannelPublisher({
      scenarios: { [CHANNEL.channelId]: { graphError: { code: 190 } } },
    });
    const { trace, onProgress } = tracer();

    await expect(
      publisher.publishImagePost({
        tenantId: testTenantId("t1"),
        channel: CHANNEL,
        caption: "x",
        media: [photo(1)],
        idempotencyKey: "k",
        onProgress,
      }),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });

    expect(trace).not.toContain("creating_post");
  });

  it("keeps publishing when the listener throws, and records the failure", async () => {
    const publisher = makeFakeChannelPublisher();

    const result = await publisher.publishImagePost({
      tenantId: testTenantId("t1"),
      channel: CHANNEL,
      caption: "x",
      media: [photo(1)],
      idempotencyKey: "k",
      onProgress: () => {
        throw new Error("the screen exploded");
      },
    });

    expect(result.postId).toContain("555000111_");
    expect(publisher.progressListenerErrors).toHaveLength(3);
  });
});
