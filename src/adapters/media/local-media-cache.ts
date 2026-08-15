import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { AppError } from "@/core/domain/errors";
import type { Logger } from "@/core/ports/infra";
import type {
  CachedMediaBytes,
  EvictCachedMediaInput,
  EvictCachedMediaResult,
  GetCachedMediaInput,
  MediaByteCache,
  PutCachedMediaInput,
} from "@/core/ports/media-byte-cache";

/**
 * `MediaByteCache` on the local filesystem — the same kind of Docker volume the
 * upload blob store uses (docs/02), and deliberately built to the same shape as
 * `local-blob-store.ts`: tenant as the first path segment, whitelist guard on
 * every segment, write-then-rename so no reader sees half a file.
 *
 * Layout: `<root>/<tenantId>/<assetId>`, ONE file per entry, made of
 *
 *     {"v":1,"mimeType":"image/jpeg"}\n<raw bytes>
 *
 * One file rather than bytes + a sidecar, because a two-file entry has states
 * this cache must never have to reason about: bytes without metadata, metadata
 * without bytes, a sweep that removed one of the two. The header is written and
 * renamed together with the bytes, so an entry either exists whole or not at all.
 *
 * Age comes from the file's mtime, which write-then-rename sets at write time.
 * That makes the TTL check a stat and the sweep a stat, with nothing to keep in
 * sync — and it is why the sweep can simply delete ANY file older than the TTL,
 * including a `.part` file some crashed write left behind.
 */

export interface LocalMediaCacheOptions {
  /** Absolute or process-relative directory the volume is mounted at. */
  readonly root: string;
  /** Entries older than this read as a miss. Comes from MEDIA_CACHE_TTL_HOURS. */
  readonly ttlMs: number;
  logger: Logger;
  /** Injectable clock — the tests move time instead of sleeping. */
  readonly now?: () => number;
}

/**
 * Same whitelist as the blob store. Drive file ids are `[A-Za-z0-9_-]` in
 * practice, and anything that is not plainly one safe path segment is refused
 * rather than sanitised, so no encoding trick has to be anticipated.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Header budget. Generous for a MIME type, small enough to bound a bad read. */
const MAX_HEADER_BYTES = 512;
const NEWLINE = 0x0a;
/** Longest MIME string kept; anything longer is not a MIME type. */
const MAX_MIME_LENGTH = 255;
/** Removals per sweep when the caller names none. */
const DEFAULT_EVICT_LIMIT = 5_000;

interface CacheHeader {
  readonly v: number;
  readonly mimeType: string | null;
}

export function makeLocalMediaCache(options: LocalMediaCacheOptions): MediaByteCache {
  const root = resolve(options.root);
  const ttlMs = positive(options?.ttlMs);
  const now = typeof options?.now === "function" ? options.now : () => Date.now();
  const log = options.logger.child({ component: "media-byte-cache" });

  if (ttlMs === null) {
    // Config error at wiring time, not at the first request: a cache with no TTL
    // would keep serving a file that was replaced on Drive, forever.
    throw new AppError("INVALID_INPUT", {
      message: "Media cache ttlMs must be a positive number",
      context: { reason: "INVALID_CACHE_TTL" },
    });
  }

  return {
    async get(input: GetCachedMediaInput): Promise<CachedMediaBytes | null> {
      // --- Edge cases first: every one of them is a MISS, never a throw ------
      const path = resolvePath(root, input?.tenantId, input?.assetId);
      if (!path) return null;

      const maxBytes = positive(input?.maxBytes);
      if (maxBytes === null) {
        // A caller with no byte budget is a programming error, not a cache miss:
        // silently serving unbounded bytes is how a process runs out of memory.
        throw new AppError("INVALID_INPUT", {
          message: "maxBytes must be a positive number",
          context: { reason: "INVALID_MAX_BYTES" },
        });
      }

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        // turbopackIgnore: the root is a runtime-configured mount point, so it
        // cannot be statically traced (same reason as local-blob-store).
        info = await stat(/* turbopackIgnore: true */ path);
      } catch (error) {
        if (isMissing(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "CACHE_STAT_FAILED" });
      }

      if (!info.isFile()) return null;
      if (now() - info.mtimeMs >= ttlMs) return null; // expired == miss
      if (info.size === 0) return null;
      // The header adds a few dozen bytes on top of the payload, so the cap is
      // compared against the file with its header allowance.
      if (info.size > maxBytes + MAX_HEADER_BYTES) return null;

      let buffer: Buffer;
      try {
        buffer = await readFile(/* turbopackIgnore: true */ path);
      } catch (error) {
        if (isMissing(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "CACHE_READ_FAILED" });
      }

      const split = buffer.indexOf(NEWLINE);
      const header = split >= 0 && split <= MAX_HEADER_BYTES
        ? parseHeader(buffer.subarray(0, split))
        : null;
      if (!header) {
        // Truncated, foreign or corrupt entry. Not thrown: the origin still has
        // the bytes and re-fetching is the repair. Logged because a corrupt file
        // on the volume is worth knowing about.
        log.warn("Ignoring an unreadable media cache entry", {
          tenant_id: input.tenantId,
          drive_file_id: input.assetId,
          size_bytes: info.size,
          reason: "CACHE_ENTRY_CORRUPT",
        });
        return null;
      }

      const payload = buffer.subarray(split + 1);
      if (payload.length === 0 || payload.length > maxBytes) return null;

      return { bytes: new Uint8Array(payload), mimeType: header.mimeType };
    },

    async put(input: PutCachedMediaInput): Promise<void> {
      const tenantId = requireSafeSegment(input?.tenantId, "tenant_id");
      const assetId = requireSafeSegment(input?.assetId, "asset_id");
      const bytes = input?.bytes;

      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Refusing to cache an empty body",
          context: { tenant_id: tenantId, asset_id: assetId, reason: "EMPTY_BODY" },
        });
      }

      const header: CacheHeader = { v: 1, mimeType: cleanMime(input?.mimeType) };
      const headerLine = `${JSON.stringify(header)}\n`;
      if (Buffer.byteLength(headerLine) > MAX_HEADER_BYTES) {
        throw new AppError("INVALID_INPUT", {
          message: "Cache header exceeds its budget",
          context: { tenant_id: tenantId, asset_id: assetId, reason: "HEADER_TOO_LARGE" },
        });
      }

      const dir = join(root, tenantId);
      const target = join(dir, assetId);
      // `.part` is unreachable as an asset id (SAFE_ID forbids '.'), so a temp
      // file can never shadow a real entry — and the sweep removes stale ones.
      const temp = `${target}.${process.pid}.${now().toString(36)}.part`;

      try {
        await mkdir(dir, { recursive: true });
        // Header and bytes are appended, not concatenated in memory: a 25 MiB
        // image would otherwise be copied a second time on every miss.
        await writeFile(temp, headerLine, { mode: 0o600 });
        await appendFile(temp, bytes);
        await rename(temp, target);
      } catch (error) {
        // Leave nothing behind for the sweep to guess about; a failed cleanup of
        // the temp file is logged but must not replace the real write error.
        await rm(temp, { force: true }).catch((cleanupError: unknown) => {
          log.warn(
            "Could not remove a partial media cache file",
            AppError.from(cleanupError, "INTERNAL", {
              tenant_id: tenantId,
              drive_file_id: assetId,
              reason: "CACHE_TEMP_CLEANUP_FAILED",
            }).toLogObject(),
          );
        });
        throw AppError.from(error, "INTERNAL", {
          tenant_id: tenantId,
          asset_id: assetId,
          reason: "CACHE_WRITE_FAILED",
        });
      }
    },

    async evictOlderThan(input: EvictCachedMediaInput): Promise<EvictCachedMediaResult> {
      const olderThanMs = input?.olderThan instanceof Date ? input.olderThan.getTime() : NaN;
      if (!Number.isFinite(olderThanMs)) {
        throw new AppError("INVALID_INPUT", {
          message: "evictOlderThan needs a valid Date",
          context: { reason: "INVALID_OLDER_THAN" },
        });
      }
      const limit = positiveInt(input?.limit) ?? DEFAULT_EVICT_LIMIT;

      let tenants: string[];
      try {
        const entries = await readdir(/* turbopackIgnore: true */ root, { withFileTypes: true });
        tenants = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch (error) {
        // Nothing was ever cached in this deployment yet — not a failure.
        if (isMissing(error)) return { scanned: 0, removed: 0, failed: 0 };
        throw AppError.from(error, "INTERNAL", { reason: "CACHE_SCAN_FAILED" });
      }

      let scanned = 0;
      let removed = 0;
      let failed = 0;

      for (const tenantId of tenants) {
        // The cap counts REMOVALS, not inspections: capping inspections would
        // re-walk the same fresh head of the directory every hour and never
        // reach the expired tail.
        if (removed >= limit) break;

        const dir = join(root, tenantId);
        let names: string[];
        try {
          names = await readdir(/* turbopackIgnore: true */ dir);
        } catch (error) {
          if (isMissing(error)) continue;
          // One unreadable tenant directory is not a reason to abandon the rest.
          failed += 1;
          log.error(
            "Media cache sweep could not list a tenant directory",
            AppError.from(error, "INTERNAL", {
              tenant_id: tenantId,
              reason: "CACHE_LIST_FAILED",
            }).toLogObject(),
          );
          continue;
        }

        for (const name of names) {
          if (removed >= limit) break;
          const path = join(dir, name);

          let mtimeMs: number;
          try {
            const info = await stat(/* turbopackIgnore: true */ path);
            if (!info.isFile()) continue;
            mtimeMs = info.mtimeMs;
          } catch (error) {
            if (isMissing(error)) continue; // gone already: nothing to do
            failed += 1;
            log.error(
              "Media cache sweep could not stat an entry",
              AppError.from(error, "INTERNAL", {
                tenant_id: tenantId,
                reason: "CACHE_STAT_FAILED",
              }).toLogObject(),
            );
            continue;
          }

          scanned += 1;
          if (mtimeMs >= olderThanMs) continue;

          try {
            await rm(path, { force: false });
            removed += 1;
          } catch (error) {
            if (isMissing(error)) continue;
            failed += 1;
            log.error(
              "Media cache sweep could not remove an entry",
              AppError.from(error, "INTERNAL", {
                tenant_id: tenantId,
                reason: "CACHE_EVICT_FAILED",
              }).toLogObject(),
            );
          }
        }
      }

      return { scanned, removed, failed };
    },
  };
}

// --- helpers ----------------------------------------------------------------

/**
 * Turns (tenantId, assetId) into an absolute path, or null when either is not a
 * safe single segment. Null rather than throw: to a cache, "you may not read
 * that" and "it is not here" are the same answer — a miss.
 */
function resolvePath(root: string, tenantId: unknown, assetId: unknown): string | null {
  if (typeof tenantId !== "string" || !SAFE_ID.test(tenantId)) return null;
  if (typeof assetId !== "string" || !SAFE_ID.test(assetId)) return null;

  const path = join(root, tenantId, assetId);

  // Belt and braces: even with the whitelist above, never hand back a path that
  // is not inside the root.
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(prefix) ? path : null;
}

function requireSafeSegment(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new AppError("INVALID_INPUT", {
      message: `${field} is not a safe path segment`,
      context: { field, reason: "UNSAFE_PATH_SEGMENT" },
    });
  }
  return value;
}

function parseHeader(raw: Buffer): CacheHeader | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { v, mimeType } = parsed as { v?: unknown; mimeType?: unknown };
    if (v !== 1) return null; // a future/foreign format is a miss, not a guess
    return { v: 1, mimeType: typeof mimeType === "string" ? mimeType : null };
  } catch {
    // Corrupt header == corrupt entry. Returned as "no header" so the ONE caller
    // logs it with the tenant/asset it belongs to (it has the context, this
    // helper does not) and re-fetches from the origin, which is the repair.
    return null;
  }
}

function cleanMime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const mime = value.trim();
  return mime.length > 0 && mime.length <= MAX_MIME_LENGTH ? mime : null;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
