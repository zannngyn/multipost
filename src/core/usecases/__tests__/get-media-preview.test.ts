import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { MediaAsset } from "@/core/domain/product";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type {
  DownloadDriveFileInput,
  DriveFileContent,
  DriveSource,
  MediaAssetLookup,
} from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";
import type { BlobContent, GetBlobInput, MediaBlobStore } from "@/core/ports/media-blob-store";
import type {
  CachedMediaBytes,
  GetCachedMediaInput,
  MediaByteCache,
  PutCachedMediaInput,
} from "@/core/ports/media-byte-cache";

import { makeGetMediaPreview } from "../get-media-preview";

/**
 * E3.6b — the preview door. Authorisation happened in `requireTenant()` before
 * this usecase ran, so what it still owns is:
 *   1. the tenant-scoped lookup (the Service Account can read every tenant's
 *      folder — the row is the isolation gate, not the credential);
 *   2. images only, decided BEFORE any byte is downloaded;
 *   3. the same cache-then-Drive path the signed route uses, so a photo the
 *      operator just looked at is free when Meta comes for it.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = testTenantId("00000000-0000-0000-0000-000000000002");
const ASSET = "drive-file-1";
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    driveFileId: ASSET,
    origin: "drive",
    storageKey: null,
    fileName: "MGKVX6310-KEM (1).jpg",
    productCode: "MGKVX6310",
    color: "KEM",
    colorRaw: "KEM",
    sequence: 1,
    kind: "image",
    variants: { aiGenerated: false, realPhoto: false, backView: false },
    mimeType: "image/jpeg",
    sizeBytes: BYTES.length,
    modifiedTime: "2026-08-01T10:00:00.000Z",
    warnings: [],
    needsReview: false,
    ...overrides,
  };
}

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

function harness(options: { assets?: Record<string, MediaAsset | undefined>; cached?: CachedMediaBytes } = {}) {
  const logger = makeLogger();
  const download = vi.fn(async (input: DownloadDriveFileInput): Promise<DriveFileContent> => ({
    fileId: input.fileId,
    bytes: BYTES,
    mimeType: "image/jpeg",
    sizeBytes: BYTES.length,
  }));
  const drive: DriveSource = { listFiles: async () => [], download };

  const store = options.assets ?? { [`${TENANT}:${ASSET}`]: asset() };
  const findByDriveFileId = vi.fn(
    async (tenantId: string, driveFileId: string) => store[`${tenantId}:${driveFileId}`] ?? null,
  );
  const mediaAssets: MediaAssetLookup = { findByDriveFileId };

  const getBlob = vi.fn(async (_input: GetBlobInput): Promise<BlobContent | null> => ({
    bytes: BYTES,
    mimeType: null,
  }));
  const blobs: MediaBlobStore = {
    put: async () => {
      throw new Error("not used");
    },
    get: getBlob,
    delete: async () => false,
    // Not exercised by this usecase — it never calls deleteStaging.
    deleteStaging: async () => false,
    createUploadUrl: async () => {
      throw new Error("not used in this test");
    },
    stat: async () => null,
    statStaging: async () => null,
    readRange: async () => null,
    promote: async () => ({ storageKey: "", sizeBytes: 0 }),
    createDownloadUrl: async () => null,
  };

  const getCached = vi.fn(
    async (_input: GetCachedMediaInput): Promise<CachedMediaBytes | null> => options.cached ?? null,
  );
  const putCached = vi.fn(async (_input: PutCachedMediaInput): Promise<void> => {});
  const cache: MediaByteCache = {
    get: getCached,
    put: putCached,
    evictOlderThan: async () => ({ scanned: 0, removed: 0, failed: 0 }),
  };

  return {
    logger,
    download,
    getCached,
    putCached,
    findByDriveFileId,
    getMediaPreview: makeGetMediaPreview({ drive, blobs, cache, mediaAssets, logger }),
  };
}

// --- Edge cases first ---------------------------------------------------------

describe("getMediaPreview — refusals", () => {
  it("rejects an empty asset id without touching the database", async () => {
    const h = harness();

    await expect(h.getMediaPreview({ tenantId: TENANT, mediaAssetId: "  " })).rejects.toMatchObject(
      { code: "INVALID_INPUT" },
    );
    expect(h.findByDriveFileId).not.toHaveBeenCalled();
  });

  it("MEDIA_NOT_FOUND for an asset that belongs to ANOTHER tenant", async () => {
    // The row exists — under the other tenant. The lookup is scoped, so this
    // request cannot see it, and the answer is identical to "no such asset".
    const h = harness({ assets: { [`${OTHER_TENANT}:${ASSET}`]: asset() } });

    await expect(
      h.getMediaPreview({ tenantId: TENANT, mediaAssetId: ASSET }),
    ).rejects.toMatchObject({ code: "MEDIA_NOT_FOUND" });
    expect(h.findByDriveFileId).toHaveBeenCalledWith(TENANT, ASSET);
    expect(h.download).not.toHaveBeenCalled();
  });

  it("MEDIA_NOT_FOUND for an unknown asset id", async () => {
    const h = harness();

    await expect(
      h.getMediaPreview({ tenantId: TENANT, mediaAssetId: "never-synced" }),
    ).rejects.toBeInstanceOf(AppError);
    expect(h.download).not.toHaveBeenCalled();
  });

  it("refuses a VIDEO before downloading it, and says why in the log", async () => {
    const h = harness({
      assets: { [`${TENANT}:${ASSET}`]: asset({ kind: "video", mimeType: "video/mp4" }) },
    });

    await expect(h.getMediaPreview({ tenantId: TENANT, mediaAssetId: ASSET })).rejects.toMatchObject(
      { code: "MEDIA_NOT_FOUND" },
    );
    // The point of the pre-download guard: no 90-second transfer is thrown away.
    expect(h.download).not.toHaveBeenCalled();
    expect(h.getCached).not.toHaveBeenCalled();

    const refusal = h.logger.lines.find((line) => line.message.includes("not an image"));
    expect(refusal?.context).toMatchObject({ reason: "PREVIEW_KIND_UNSUPPORTED", kind: "video" });
  });
});

describe("getMediaPreview — serving", () => {
  it("returns the bytes, the mime type and a 300s private cache hint", async () => {
    const h = harness();

    const result = await h.getMediaPreview({ tenantId: TENANT, mediaAssetId: ASSET });

    expect(result.bytes).toEqual(BYTES);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.sizeBytes).toBe(BYTES.length);
    expect(result.cacheSeconds).toBe(300);
    expect(result.fileName).toBe("MGKVX6310-KEM (1).jpg");
  });

  it("reads through the shared cache and fills it on a miss", async () => {
    const h = harness();

    await h.getMediaPreview({ tenantId: TENANT, mediaAssetId: ASSET });

    expect(h.getCached).toHaveBeenCalledOnce();
    expect(h.download).toHaveBeenCalledOnce();
    // Warming the same cache the signed route reads: previewing a photo makes
    // Meta's later fetch free instead of paying Drive twice.
    expect(h.putCached).toHaveBeenCalledOnce();
  });

  it("serves a cache hit without calling Drive at all", async () => {
    const h = harness({ cached: { bytes: BYTES, mimeType: "image/jpeg" } });

    const result = await h.getMediaPreview({ tenantId: TENANT, mediaAssetId: ASSET });

    expect(result.bytes).toEqual(BYTES);
    expect(h.download).not.toHaveBeenCalled();
    expect(h.putCached).not.toHaveBeenCalled();
  });

  it("logs the asset it served, never a token", async () => {
    const h = harness();

    await h.getMediaPreview({ tenantId: TENANT, mediaAssetId: ASSET });

    const served = h.logger.lines.find((line) => line.message === "Media preview served");
    expect(served?.context).toMatchObject({
      drive_file_id: ASSET,
      product_code: "MGKVX6310",
      mime_type: "image/jpeg",
    });
    expect(JSON.stringify(h.logger.lines)).not.toContain("sig");
  });
});
