import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { AppError } from "@/core/domain/errors";
import type {
  BlobContent,
  GetBlobInput,
  MediaBlobStore,
  PutBlobInput,
  StoredBlob,
} from "@/core/ports/media-blob-store";

/**
 * E9 — `MediaBlobStore` on the local filesystem, meant for a Docker volume on
 * the single VPS (docs/02). Object storage would be a sibling adapter; nothing
 * in core or the usecases knows which one is wired.
 *
 * Layout: `<root>/<tenantId>/<assetId>`. The tenant id is the FIRST path
 * segment on purpose — it makes "does this key belong to this caller?" a string
 * comparison rather than a database lookup, and it makes a whole tenant's
 * uploads removable with one directory delete.
 *
 * The blob is bytes only. The MIME type is NOT stored beside it: the asset row
 * already carries it, `getMediaContent` already falls back to that row, and a
 * second copy would be one more thing to keep in sync.
 */

export interface LocalBlobStoreOptions {
  /** Absolute or process-relative directory the volume is mounted at. */
  readonly root: string;
}

/**
 * Asset ids we generate are `upload_<hex>`. The guard is a whitelist rather than
 * a "reject ../" blacklist: anything that is not plainly a safe single path
 * segment is refused, so no encoding trick has to be anticipated.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function makeLocalBlobStore(options: LocalBlobStoreOptions): MediaBlobStore {
  const root = resolve(options.root);

  return {
    async put(input: PutBlobInput): Promise<StoredBlob> {
      const tenantId = requireSafeSegment(input?.tenantId, "tenant_id");
      const assetId = requireSafeSegment(input?.assetId, "asset_id");
      const bytes = input?.bytes;

      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Refusing to store an empty blob",
          userMessage: "File rỗng — không lưu được.",
          context: { tenant_id: tenantId, asset_id: assetId, reason: "EMPTY_BLOB" },
        });
      }

      const dir = join(root, tenantId);
      const target = join(dir, assetId);

      try {
        await mkdir(dir, { recursive: true });
        // Write-then-rename: a reader (or Meta's fetcher) must never observe a
        // half-written file under the real name.
        const temp = `${target}.${process.pid}.part`;
        await writeFile(temp, bytes, { mode: 0o600 });
        await rename(temp, target);
      } catch (error) {
        throw AppError.from(error, "INTERNAL", {
          tenant_id: tenantId,
          asset_id: assetId,
          reason: "BLOB_WRITE_FAILED",
        });
      }

      return { storageKey: `${tenantId}/${assetId}`, sizeBytes: bytes.length };
    },

    async get(input: GetBlobInput): Promise<BlobContent | null> {
      const path = resolveKey(root, input?.tenantId, input?.storageKey);
      if (!path) return null;

      const maxBytes = input?.maxBytes;
      if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) {
        throw new AppError("INVALID_INPUT", {
          message: "maxBytes must be a positive number",
          context: { reason: "INVALID_MAX_BYTES" },
        });
      }

      let sizeBytes: number;
      try {
        const info = await stat(path);
        if (!info.isFile()) return null;
        sizeBytes = info.size;
      } catch (error) {
        if (isMissing(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_STAT_FAILED" });
      }

      // Checked before reading, not after: the point of the cap is to not pull
      // the bytes into memory in the first place.
      if (sizeBytes > maxBytes) {
        throw new AppError("INVALID_INPUT", {
          message: "Stored blob exceeds the caller's byte cap",
          userMessage: "File đã lưu lớn hơn mức phục vụ được — cần tải lại file nhẹ hơn.",
          context: { size_bytes: sizeBytes, max_bytes: maxBytes, reason: "BLOB_TOO_LARGE" },
        });
      }

      try {
        const buffer = await readFile(path);
        return { bytes: new Uint8Array(buffer), mimeType: null };
      } catch (error) {
        if (isMissing(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_READ_FAILED" });
      }
    },

    async delete(input: { tenantId: string; storageKey: string }): Promise<boolean> {
      const path = resolveKey(root, input?.tenantId, input?.storageKey);
      if (!path) return false;

      try {
        await rm(path, { force: false });
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw AppError.from(error, "INTERNAL", { reason: "BLOB_DELETE_FAILED" });
      }
    },
  };
}

// --- helpers ----------------------------------------------------------------

/**
 * Turns a caller-supplied key into an absolute path, or null when it is not
 * this tenant's to touch. Null rather than throw: to the caller a key it may not
 * use and a key that does not exist are the same answer, which keeps the media
 * route from becoming an oracle (same reasoning as getMediaContent's single
 * UNAUTHORIZED code).
 */
function resolveKey(root: string, tenantId: unknown, storageKey: unknown): string | null {
  if (typeof tenantId !== "string" || !SAFE_ID.test(tenantId)) return null;
  if (typeof storageKey !== "string") return null;

  const parts = storageKey.split("/");
  if (parts.length !== 2) return null;

  const [keyTenant, assetId] = parts;
  if (keyTenant !== tenantId) return null;
  if (!SAFE_ID.test(assetId)) return null;

  const path = join(root, keyTenant, assetId);

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

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
