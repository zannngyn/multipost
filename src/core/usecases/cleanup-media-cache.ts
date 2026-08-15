import { AppError } from "@/core/domain/errors";
import type { Clock, Logger } from "@/core/ports/infra";
import type { MediaByteCache } from "@/core/ports/media-byte-cache";

/**
 * Sweep of the Drive byte cache (see core/ports/media-byte-cache).
 *
 * Without it the cache is a disk leak: every asset any post ever served stays on
 * the volume forever, and the 5,500-file catalog is several gigabytes. With it
 * the volume settles at "whatever was posted in the last MEDIA_CACHE_TTL_HOURS".
 *
 * Deliberately separate from the E9 upload sweep even though both delete files:
 * the upload sweep is driven BY ROW (`origin = 'upload'`) and deleting the wrong
 * one loses an operator's file, while this one is driven by mtime and deleting
 * too much only costs a re-download. One sweep doing both would inherit the
 * stricter rules of the more dangerous half.
 */

/** Matches MEDIA_CACHE_TTL_HOURS; the caller normally passes the configured one. */
export const DEFAULT_MEDIA_CACHE_TTL_HOURS = 72;
/** Removals per pass. A backlog drains across the hourly ticks. */
export const DEFAULT_MEDIA_CACHE_EVICT_LIMIT = 5_000;

export interface CleanupMediaCacheInput {
  /** How long an entry may live after it was written. */
  readonly ttlHours?: number;
  readonly limit?: number;
}

export interface CleanupMediaCacheResult {
  readonly scanned: number;
  readonly removed: number;
  /** Entries left for the next pass because removing them failed. */
  readonly failed: number;
}

export interface CleanupMediaCacheDeps {
  cache: MediaByteCache;
  clock: Clock;
  logger: Logger;
}

export function makeCleanupMediaCache(deps: CleanupMediaCacheDeps) {
  return async function cleanupMediaCache(
    input: CleanupMediaCacheInput = {},
  ): Promise<CleanupMediaCacheResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const ttlHours = positive(input?.ttlHours) ?? DEFAULT_MEDIA_CACHE_TTL_HOURS;
    const limit = positiveInt(input?.limit) ?? DEFAULT_MEDIA_CACHE_EVICT_LIMIT;

    const log = deps.logger.child({ component: "media-cache-cleanup" });
    const olderThan = new Date(deps.clock.nowMs() - ttlHours * 60 * 60 * 1000);

    let result: CleanupMediaCacheResult;
    try {
      result = await deps.cache.evictOlderThan({ olderThan, limit });
    } catch (error) {
      // The store itself is broken (volume gone, permissions). Nothing here can
      // repair it, so name it and let the job handler fail the tick — the next
      // hour retries, and the log says which volume to look at.
      const appError = AppError.from(error, "INTERNAL", {
        reason: "MEDIA_CACHE_SWEEP_FAILED",
        ttl_hours: ttlHours,
      });
      log.error("Media cache sweep failed", appError.toLogObject());
      throw appError;
    }

    log.info("Media cache sweep finished", {
      scanned: result.scanned,
      removed: result.removed,
      failed: result.failed,
      ttl_hours: ttlHours,
      older_than: olderThan.toISOString(),
    });

    return result;
  };
}

export type CleanupMediaCache = ReturnType<typeof makeCleanupMediaCache>;

// --- helpers ----------------------------------------------------------------

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
