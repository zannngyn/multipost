import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { Clock, Logger } from "@/core/ports/infra";
import type {
  EvictCachedMediaInput,
  EvictCachedMediaResult,
  MediaByteCache,
} from "@/core/ports/media-byte-cache";

import {
  DEFAULT_MEDIA_CACHE_TTL_HOURS,
  makeCleanupMediaCache,
} from "./cleanup-media-cache";

const NOW = Date.UTC(2026, 7, 15, 9, 0, 0);
const HOUR = 60 * 60 * 1000;

function makeLogger(): Logger & { lines: Array<{ message: string; context?: unknown }> } {
  const lines: Array<{ message: string; context?: unknown }> = [];
  const record = (message: string, context?: unknown) => {
    lines.push({ message, context });
  };
  const logger = {
    lines,
    child: () => logger,
    debug: record,
    info: record,
    warn: record,
    error: record,
  } as Logger & { lines: typeof lines };
  return logger;
}

function harness(options: { result?: EvictCachedMediaResult; evictError?: unknown } = {}) {
  const logger = makeLogger();
  const clock: Clock = { now: () => new Date(NOW), nowMs: () => NOW };
  const evictOlderThan = vi.fn(
    async (_input: EvictCachedMediaInput): Promise<EvictCachedMediaResult> => {
      if (options.evictError) throw options.evictError;
      return options.result ?? { scanned: 10, removed: 3, failed: 0 };
    },
  );
  const cache: MediaByteCache = {
    get: async () => null,
    put: async () => undefined,
    evictOlderThan,
  };
  return {
    logger,
    evictOlderThan,
    cleanupMediaCache: makeCleanupMediaCache({ cache, clock, logger }),
  };
}

describe("cleanupMediaCache — edge cases first", () => {
  it("falls back to the default TTL for a missing or nonsensical one", async () => {
    const { cleanupMediaCache, evictOlderThan } = harness();

    for (const input of [undefined, {}, { ttlHours: 0 }, { ttlHours: -5 }, { ttlHours: NaN }]) {
      await cleanupMediaCache(input);
    }

    const expected = new Date(NOW - DEFAULT_MEDIA_CACHE_TTL_HOURS * HOUR);
    for (const call of evictOlderThan.mock.calls) {
      expect(call[0].olderThan).toEqual(expected);
    }
  });

  it("ignores a limit that is not a positive integer", async () => {
    const { cleanupMediaCache, evictOlderThan } = harness();
    await cleanupMediaCache({ limit: 2.5 });
    expect(evictOlderThan.mock.calls[0][0].limit).toBeGreaterThan(0);
    expect(Number.isInteger(evictOlderThan.mock.calls[0][0].limit)).toBe(true);
  });

  it("reports a broken store instead of pretending the sweep ran", async () => {
    const { cleanupMediaCache, logger } = harness({
      evictError: new Error("EACCES: permission denied"),
    });

    await expect(cleanupMediaCache()).rejects.toMatchObject({
      code: "INTERNAL",
      context: { reason: "MEDIA_CACHE_SWEEP_FAILED" },
    });
    // Failure is logged with the reason before it is rethrown, never swallowed.
    expect(logger.lines.some((line) => line.message === "Media cache sweep failed")).toBe(true);
  });

  it("keeps an AppError from the store as it is", async () => {
    const { cleanupMediaCache } = harness({
      evictError: new AppError("INVALID_INPUT", { context: { reason: "INVALID_OLDER_THAN" } }),
    });
    await expect(cleanupMediaCache()).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("cleanupMediaCache — happy path", () => {
  it("evicts everything older than the configured TTL and reports the counts", async () => {
    const { cleanupMediaCache, evictOlderThan, logger } = harness({
      result: { scanned: 42, removed: 7, failed: 1 },
    });

    const result = await cleanupMediaCache({ ttlHours: 12, limit: 100 });

    expect(result).toEqual({ scanned: 42, removed: 7, failed: 1 });
    expect(evictOlderThan).toHaveBeenCalledWith({
      olderThan: new Date(NOW - 12 * HOUR),
      limit: 100,
    });
    expect(
      logger.lines.find((line) => line.message === "Media cache sweep finished")?.context,
    ).toMatchObject({ scanned: 42, removed: 7, failed: 1, ttl_hours: 12 });
  });
});
