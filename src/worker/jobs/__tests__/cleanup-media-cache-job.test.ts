import { describe, expect, it, vi } from "vitest";

import type { Logger, Usecases } from "@/composition/worker-container";
import { AppError } from "@/core/domain/errors";

import {
  CLEANUP_MEDIA_CACHE_JOB_NAME,
  makeCleanupMediaCacheHandler,
  parseCleanupMediaCachePayload,
} from "../cleanup-media-cache-job";

/**
 * Edge cases first: the payload comes off Redis, so it is external input like
 * any other, and a failing sweep must not take the worker down with it.
 */

function fakeLogger() {
  const logger = {
    child: vi.fn(() => logger as unknown as Logger),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function envelope(payload: unknown, attempt = 1) {
  return {
    jobId: "media-cache-tick-1",
    jobName: CLEANUP_MEDIA_CACHE_JOB_NAME,
    payload,
    attempt,
    maxAttempts: 1,
  };
}

const EMPTY_RESULT = { scanned: 0, removed: 0, failed: 0 };

describe("parseCleanupMediaCachePayload", () => {
  it.each([undefined, null, {}])("accepts the empty tick %p (use the wired TTL)", (raw) => {
    expect(parseCleanupMediaCachePayload(raw)).toEqual({});
  });

  it("accepts the two overrides an operator may send by hand", () => {
    expect(parseCleanupMediaCachePayload({ ttlHours: 24, limit: 10 })).toEqual({
      ttlHours: 24,
      limit: 10,
    });
  });

  it.each([
    ["a zero TTL", { ttlHours: 0 }],
    ["a TTL above the 720h cap", { ttlHours: 721 }],
    ["a fractional TTL", { ttlHours: 1.5 }],
    ["a zero limit", { limit: 0 }],
    ["a limit above the cap", { limit: 200_000 }],
    ["an unknown key (producer and worker disagree)", { everyMs: 1_000 }],
    ["a string payload", "now"],
    ["an array", []],
  ])("rejects %s with JOB_PAYLOAD_INVALID", (_label, raw) => {
    try {
      parseCleanupMediaCachePayload(raw, { queue_job_id: "tick" });
      throw new Error("expected parseCleanupMediaCachePayload to throw");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).code).toBe("JOB_PAYLOAD_INVALID");
      expect((error as AppError).context).toMatchObject({
        job_name: CLEANUP_MEDIA_CACHE_JOB_NAME,
        queue_job_id: "tick",
      });
    }
  });
});

describe("makeCleanupMediaCacheHandler", () => {
  it("rejects a malformed payload BEFORE touching the volume", async () => {
    const cleanupMediaCache = vi.fn(async () => EMPTY_RESULT);
    const handler = makeCleanupMediaCacheHandler({
      logger: fakeLogger() as unknown as Logger,
      cleanupMediaCache: cleanupMediaCache as unknown as Usecases["cleanupMediaCache"],
    });

    await expect(handler(envelope({ ttlHours: -1 }))).rejects.toMatchObject({
      code: "JOB_PAYLOAD_INVALID",
    });
    expect(cleanupMediaCache).not.toHaveBeenCalled();
  });

  it("passes an empty tick through untouched and logs the counts", async () => {
    const cleanupMediaCache = vi.fn(async () => ({ scanned: 42, removed: 7, failed: 1 }));
    const logger = fakeLogger();
    const handler = makeCleanupMediaCacheHandler({
      logger: logger as unknown as Logger,
      cleanupMediaCache: cleanupMediaCache as unknown as Usecases["cleanupMediaCache"],
    });

    await handler(envelope({}));

    // Empty, so the usecase uses the TTL the composition wired in (M1).
    expect(cleanupMediaCache).toHaveBeenCalledWith({});
    expect(logger.info).toHaveBeenCalledWith(
      "media-cache-cleanup tick done",
      expect.objectContaining({ scanned: 42, removed: 7, failed: 1 }),
    );
  });

  it("logs with an alert and rethrows when the sweep itself fails", async () => {
    const logger = fakeLogger();
    const handler = makeCleanupMediaCacheHandler({
      logger: logger as unknown as Logger,
      cleanupMediaCache: (async () => {
        throw new AppError("INTERNAL", {
          message: "volume gone",
          context: { reason: "MEDIA_CACHE_SWEEP_FAILED" },
        });
      }) as unknown as Usecases["cleanupMediaCache"],
    });

    await expect(handler(envelope({}))).rejects.toMatchObject({
      code: "INTERNAL",
      context: { reason: "MEDIA_CACHE_SWEEP_FAILED" },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "media-cache-cleanup tick failed",
      expect.objectContaining({ error_code: "INTERNAL", alert: "OPERATOR_ATTENTION" }),
    );
  });
});
