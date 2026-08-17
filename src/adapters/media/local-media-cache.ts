import { randomUUID } from "node:crypto";
import {
  appendFile,
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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
 *     {"v":2,"n":10432,"mimeType":"image/jpeg"}\n<raw bytes>
 *
 * One file rather than bytes + a sidecar, because a two-file entry has states
 * this cache must never have to reason about: bytes without metadata, metadata
 * without bytes, a sweep that removed one of the two. The header is written and
 * renamed together with the bytes, so an entry either exists whole or not at all.
 *
 * `n` is the payload length and is CHECKED on every read. Two things need it:
 * a write cut short by a crash or a full disk (rename never ran, but the target
 * could still be a leftover half-file from an older format), and any future way
 * two writers could reach the same bytes. A body whose length disagrees with its
 * header is served to nobody — it is a miss, and the entry is dropped so the next
 * fetch re-fills it from the origin.
 *
 * Temp files are named with a UUID, never with the clock: two `put` calls for the
 * same asset in the same millisecond would otherwise share one temp path, and
 * write-then-rename is only atomic between DIFFERENT temp names — with the same
 * name the two writers interleave into one corrupt file that rename then
 * publishes. Meta fetches an album's photos in parallel and every retry refetches
 * them, so "the same asset twice at once" is a normal event here, not a rare one.
 *
 * Age comes from the file's mtime, which write-then-rename sets at write time.
 * That makes the TTL check a stat and the sweep a stat, with nothing to keep in
 * sync — and it is why the sweep can simply delete ANY file older than the TTL,
 * including a `.part` file some crashed write left behind.
 *
 * Every stat is an `lstat` and every read opens with `O_NOFOLLOW` where the
 * platform has it: this cache backs an UNAUTHENTICATED route, so a symlink
 * planted on the volume must never turn it into a reader of arbitrary files.
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
/** Bumped when the entry layout changes; an older entry then reads as a miss. */
const CACHE_FORMAT_VERSION = 2;
/**
 * Refuse to follow a symlink at open time, not only at stat time, so nothing can
 * be swapped in between the two. Windows has no O_NOFOLLOW; there the `lstat`
 * gate is the whole defence.
 */
const READ_FLAGS =
  typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    : fsConstants.O_RDONLY;

interface CacheHeader {
  readonly v: number;
  /** Payload length in bytes, verified against what was actually read. */
  readonly n: number;
  readonly mimeType: string | null;
}

type HeaderResult =
  | { readonly ok: true; readonly header: CacheHeader }
  | { readonly ok: false; readonly reason: "MALFORMED_HEADER" | "UNSUPPORTED_VERSION" };

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

  /**
   * Names an entry that may not be served, then removes it best-effort.
   *
   * Removing on read rather than waiting for the sweep: a corrupt entry is
   * otherwise re-read, re-logged and re-rejected on every single fetch until its
   * TTL expires. Racing a `put` that just replaced it costs one extra miss, which
   * is the cheapest failure this file has. A failed removal is logged, never
   * swallowed, and never turned into a failed request.
   */
  async function dropEntry(
    path: string,
    meta: {
      tenantId: string;
      assetId: string;
      sizeBytes: number;
      reason: string;
      loud: boolean;
      extra?: Record<string, unknown>;
    },
  ): Promise<void> {
    const context = {
      tenant_id: meta.tenantId,
      drive_file_id: meta.assetId,
      size_bytes: meta.sizeBytes,
      reason: meta.reason,
      ...meta.extra,
    };
    if (meta.loud) log.warn("Dropping an unreadable media cache entry", context);
    else log.debug("Dropping a media cache entry this version cannot read", context);

    await rm(path, { force: true }).catch((error: unknown) => {
      log.warn(
        "Could not remove an unreadable media cache entry",
        AppError.from(error, "INTERNAL", {
          ...context,
          reason: "CACHE_DROP_FAILED",
        }).toLogObject(),
      );
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

      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        // lstat, not stat: a symlink here is not an entry this cache wrote, and
        // following one would let anyone who can write to the volume aim an
        // unauthenticated route at a file outside the root.
        // turbopackIgnore: the root is a runtime-configured mount point, so it
        // cannot be statically traced (same reason as local-blob-store).
        info = await lstat(/* turbopackIgnore: true */ path);
      } catch (error) {
        if (isMissing(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "CACHE_STAT_FAILED" });
      }

      if (!info.isFile()) {
        // Symlink, directory, socket: not something `put` can have produced.
        if (info.isSymbolicLink()) {
          log.warn("Ignoring a symlink where a media cache entry should be", {
            tenant_id: input.tenantId,
            drive_file_id: input.assetId,
            reason: "CACHE_ENTRY_NOT_A_FILE",
          });
        }
        return null;
      }
      if (now() - info.mtimeMs >= ttlMs) return null; // expired == miss
      if (info.size === 0) return null;
      // The header adds a few dozen bytes on top of the payload, so the cap is
      // compared against the file with its header allowance.
      if (info.size > maxBytes + MAX_HEADER_BYTES) return null;

      let buffer: Buffer;
      try {
        buffer = await readEntry(path, log);
      } catch (error) {
        // ELOOP: the path became a symlink between the lstat and the open.
        if (isMissing(error) || isSymlinkRefusal(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "CACHE_READ_FAILED" });
      }

      const split = buffer.indexOf(NEWLINE);
      const parsed = split >= 0 && split <= MAX_HEADER_BYTES
        ? parseHeader(buffer.subarray(0, split))
        : ({ ok: false, reason: "MALFORMED_HEADER" } as const);

      if (!parsed.ok) {
        // Truncated, foreign or corrupt entry. Not thrown: the origin still has
        // the bytes and re-fetching is the repair.
        await dropEntry(path, {
          tenantId: input.tenantId,
          assetId: input.assetId,
          sizeBytes: info.size,
          reason: parsed.reason,
          // A leftover from an older format is expected once after a deploy; a
          // header that is corrupt on the current format is not.
          loud: parsed.reason === "MALFORMED_HEADER",
        });
        return null;
      }

      const payload = buffer.subarray(split + 1);
      if (payload.length !== parsed.header.n) {
        // The one check that catches a body cut short (crash, full disk) or one
        // written by two writers at once. Serving it would hand Facebook bytes
        // that are not the picture.
        await dropEntry(path, {
          tenantId: input.tenantId,
          assetId: input.assetId,
          sizeBytes: info.size,
          reason: "PAYLOAD_LENGTH_MISMATCH",
          loud: true,
          extra: { expected_bytes: parsed.header.n, actual_bytes: payload.length },
        });
        return null;
      }
      if (payload.length === 0 || payload.length > maxBytes) return null;

      return { bytes: new Uint8Array(payload), mimeType: parsed.header.mimeType };
    },

    async put(input: PutCachedMediaInput): Promise<void> {
      // The tenant id reaches here from a verified signature and is always a
      // UUID, so an unsafe one is a wiring bug and must be loud.
      const tenantId = requireSafeSegment(input?.tenantId, "tenant_id");

      const assetId = input?.assetId;
      if (typeof assetId !== "string" || assetId.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "asset_id is not a string",
          context: { field: "asset_id", tenant_id: tenantId, reason: "UNSAFE_PATH_SEGMENT" },
        });
      }
      if (!SAFE_ID.test(assetId)) {
        // Not an error: the signed-URL rules (core/domain/media-url) accept ids
        // this store deliberately will not hold — dots, and up to 255 chars.
        // Throwing made every fetch of such an asset log a full AppError from
        // the caller's fallback. It stays uncacheable (the whitelist is what
        // keeps traversal impossible), but it is now a measurable no-op.
        log.debug("Skipping a media cache write for an id this store cannot hold", {
          tenant_id: tenantId,
          drive_file_id: assetId,
          reason: "ASSET_ID_NOT_CACHEABLE",
        });
        return;
      }

      const bytes = input?.bytes;
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Refusing to cache an empty body",
          context: { tenant_id: tenantId, asset_id: assetId, reason: "EMPTY_BODY" },
        });
      }

      const header: CacheHeader = {
        v: CACHE_FORMAT_VERSION,
        n: bytes.length,
        mimeType: cleanMime(input?.mimeType),
      };
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
      // The UUID is what makes concurrent writes of the SAME asset safe: with a
      // clock-derived name two of them share a path, interleave their bytes and
      // rename the result into place. Never reintroduce a time-based name here.
      const temp = `${target}.${randomUUID()}.part`;

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

      let scanned = 0;
      let removed = 0;
      let failed = 0;

      let tenants: string[];
      try {
        const entries = await readdir(/* turbopackIgnore: true */ root, { withFileTypes: true });
        tenants = [];
        for (const entry of entries) {
          if (entry.isDirectory()) {
            tenants.push(entry.name);
            continue;
          }
          if (!entry.isSymbolicLink()) continue;
          // A symlinked tenant directory is refused, not followed: deleting
          // through it would remove files outside the volume. It is counted and
          // named so the disk it keeps filling is visible, never skipped in
          // silence (business rule 5).
          failed += 1;
          log.warn("Media cache sweep refused a symlinked tenant directory", {
            tenant_id: entry.name,
            reason: "CACHE_TENANT_DIR_SYMLINK",
          });
        }
      } catch (error) {
        // Nothing was ever cached in this deployment yet — not a failure.
        if (isMissing(error)) return { scanned: 0, removed: 0, failed: 0 };
        throw AppError.from(error, "INTERNAL", { reason: "CACHE_SCAN_FAILED" });
      }

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
            // lstat again: a symlink is aged and removed by its OWN mtime, and
            // `rm` unlinks the link rather than its target, so a planted link
            // leaves the volume without anything outside the root being touched.
            const info = await lstat(/* turbopackIgnore: true */ path);
            if (!info.isFile() && !info.isSymbolicLink()) continue;
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

/**
 * Reads a whole entry without ever following a symlink.
 *
 * The handle is closed in a `finally`, and a failing close is logged instead of
 * replacing the read's own error — losing the reason a read failed is worse than
 * leaking one descriptor.
 */
async function readEntry(path: string, log: Logger): Promise<Buffer> {
  // turbopackIgnore: runtime-configured mount point, same as the lstat above.
  const handle: FileHandle = await open(/* turbopackIgnore: true */ path, READ_FLAGS);
  try {
    return await handle.readFile();
  } finally {
    await handle.close().catch((error: unknown) => {
      log.warn(
        "Could not close a media cache entry",
        AppError.from(error, "INTERNAL", { reason: "CACHE_CLOSE_FAILED" }).toLogObject(),
      );
    });
  }
}

/**
 * Header or the reason there is none. A reason rather than null, because the
 * caller answers the two cases differently: an entry from an older format is
 * expected once after a deploy, a corrupt one is worth a warn.
 */
function parseHeader(raw: Buffer): HeaderResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    // Corrupt header == corrupt entry. Reported, not thrown: the origin still
    // has the bytes and re-fetching is the repair.
    return { ok: false, reason: "MALFORMED_HEADER" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "MALFORMED_HEADER" };
  }
  const { v, n, mimeType } = parsed as { v?: unknown; n?: unknown; mimeType?: unknown };
  // A future/foreign format is a miss, not a guess.
  if (v !== CACHE_FORMAT_VERSION) return { ok: false, reason: "UNSUPPORTED_VERSION" };
  // Without a usable length there is nothing to verify the body against, so the
  // entry cannot be trusted — treat it exactly like a corrupt one.
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) {
    return { ok: false, reason: "MALFORMED_HEADER" };
  }

  return {
    ok: true,
    header: {
      v: CACHE_FORMAT_VERSION,
      n,
      mimeType: typeof mimeType === "string" ? mimeType : null,
    },
  };
}

function cleanMime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const mime = value.trim();
  return mime.length > 0 && mime.length <= MAX_MIME_LENGTH ? mime : null;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** What O_NOFOLLOW answers when the path turned out to be a symlink. */
function isSymlinkRefusal(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ELOOP" || code === "EMLINK";
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
