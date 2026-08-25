import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";

import { AppError } from "@/core/domain/errors";
import type {
  CatalogFileContent,
  CatalogFileStore,
  GetCatalogFileInput,
  PutCatalogFileInput,
  StoredCatalogFile,
} from "@/core/ports/catalog-file-store";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * `CatalogFileStore` on the local filesystem — a Docker volume on the single
 * VPS (docs/02), same deployment shape as the media blob store. Object storage
 * later is a sibling adapter and nothing in core changes.
 *
 * Layout: `<root>/<tenantId>/<fileId>`. Tenant first, like the media store, so
 * "is this key this caller's?" is a string comparison and a whole tenant's data
 * is one directory.
 *
 * The path logic is written out here instead of shared with the media store on
 * purpose: adapters do not import each other (docs/07 section 2), and the two
 * stores have different lifecycles — the media one is swept by the E9.4 orphan
 * cleanup, this one must survive it.
 *
 * The ORIGINAL file name is not part of the key: it comes from a browser upload
 * and would drag encoding and traversal problems onto the disk. It is stored in
 * `tenant_integration.config` instead, which is also what the sync screen reads.
 */

export interface LocalCatalogFileStoreOptions {
  /** Absolute or process-relative directory the volume is mounted at. */
  readonly root: string;
}

/** Whitelist, not a "reject ../" blacklist — no encoding trick to anticipate. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Generated ids look like `catalog_9f8e...` so a log line says what they are. */
const ID_PREFIX = "catalog_";

export function makeLocalCatalogFileStore(
  options: LocalCatalogFileStoreOptions,
): CatalogFileStore {
  const root = resolve(options.root);

  return {
    async put(input: PutCatalogFileInput): Promise<StoredCatalogFile> {
      const tenantId = requireSafeSegment(input?.tenantId, "tenant_id");
      const bytes = input?.bytes;

      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        throw new AppError("INVALID_INPUT", {
          message: "Refusing to store an empty catalog file",
          userMessage: "File rỗng — không lưu được.",
          context: { tenant_id: tenantId, reason: "EMPTY_CATALOG_FILE" },
        });
      }

      // A fresh id per upload: the previous file stays readable until the
      // config points at the new one, so a failed save cannot leave a tenant
      // with a config pointing at bytes that were already overwritten.
      const fileId = `${ID_PREFIX}${randomBytes(12).toString("hex")}`;
      const dir = join(root, tenantId);
      const target = join(dir, fileId);

      try {
        await mkdir(dir, { recursive: true });
        // Write-then-rename: a sync running right now must never read a
        // half-written table.
        const temp = `${target}.${process.pid}.part`;
        await writeFile(temp, bytes, { mode: 0o600 });
        await rename(temp, target);
      } catch (error) {
        throw AppError.from(error, "INTERNAL", {
          tenant_id: tenantId,
          reason: "CATALOG_FILE_WRITE_FAILED",
        });
      }

      return { storageKey: `${tenantId}/${fileId}`, sizeBytes: bytes.length };
    },

    async get(input: GetCatalogFileInput): Promise<CatalogFileContent | null> {
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
        // turbopackIgnore: the root is a runtime-configured mount point, so it
        // cannot be statically scoped by the bundler.
        const info = await stat(/* turbopackIgnore: true */ path);
        if (!info.isFile()) return null;
        sizeBytes = info.size;
      } catch (error) {
        if (isMissing(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "CATALOG_FILE_STAT_FAILED" });
      }

      // Checked before reading: the point of the cap is to not pull a 900 MB
      // "CSV" into the memory of the worker in the first place.
      if (sizeBytes > maxBytes) {
        throw new AppError("INVALID_INPUT", {
          message: "Stored catalog file exceeds the caller's byte cap",
          userMessage:
            "File bảng dữ liệu đã lưu lớn hơn mức đọc được — xoá bớt cột/dòng không cần rồi tải lên lại.",
          context: { size_bytes: sizeBytes, max_bytes: maxBytes, reason: "CATALOG_FILE_TOO_LARGE" },
        });
      }

      try {
        const buffer = await readFile(/* turbopackIgnore: true */ path);
        return { bytes: new Uint8Array(buffer), sizeBytes };
      } catch (error) {
        if (isMissing(error)) return null;
        throw AppError.from(error, "INTERNAL", { reason: "CATALOG_FILE_READ_FAILED" });
      }
    },

    async delete(input: { tenantId: TenantId; storageKey: string }): Promise<boolean> {
      const path = resolveKey(root, input?.tenantId, input?.storageKey);
      if (!path) return false;

      try {
        await rm(path, { force: false });
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw AppError.from(error, "INTERNAL", { reason: "CATALOG_FILE_DELETE_FAILED" });
      }
    },
  };
}

// --- helpers ----------------------------------------------------------------

/**
 * Absolute path, or null when the key is not this tenant's to touch. Null
 * rather than throw: "not yours" and "not there" must look identical from
 * outside, or the store becomes an oracle for other tenants' keys.
 */
function resolveKey(root: string, tenantId: unknown, storageKey: unknown): string | null {
  if (typeof tenantId !== "string" || !SAFE_ID.test(tenantId)) return null;
  if (typeof storageKey !== "string") return null;

  const parts = storageKey.split("/");
  if (parts.length !== 2) return null;

  const [keyTenant, fileId] = parts;
  if (keyTenant !== tenantId) return null;
  if (!SAFE_ID.test(fileId)) return null;

  const path = join(root, keyTenant, fileId);

  // Belt and braces: never hand back a path outside the root, whatever the
  // whitelist above let through.
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
