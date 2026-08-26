import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { MediaAsset } from "@/core/domain/product";
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

import { makeReadMediaBytes } from "./read-media-bytes";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * The publish path uploads photo bytes itself now, so this is where those bytes
 * come from. Two questions run through every test: was Drive spared when the
 * cache already had the file, and does a failure arrive with enough context
 * (code + reason + retryable) for publish-post to decide retry vs block?
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
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

interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

function makeLogger(): Logger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const record =
    (level: LogLine["level"]) =>
    (message: string, context?: Record<string, unknown>) => {
      lines.push({ level, message, context });
    };
  const logger = {
    lines,
    child: () => logger,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  } as Logger & { lines: LogLine[] };
  return logger;
}

interface HarnessOptions {
  assets?: Record<string, MediaAsset | undefined>;
  cached?: CachedMediaBytes | null;
  cacheGetError?: unknown;
  cachePutError?: unknown;
  content?: DriveFileContent;
  downloadError?: unknown;
  blobContent?: BlobContent | null;
  maxBytes?: number;
}

function harness(options: HarnessOptions = {}) {
  const logger = makeLogger();
  const store = options.assets ?? { [`${TENANT}:${ASSET}`]: asset() };

  const findByDriveFileId = vi.fn(
    async (tenantId: string, driveFileId: string) => store[`${tenantId}:${driveFileId}`] ?? null,
  );
  const mediaAssets: MediaAssetLookup = { findByDriveFileId };

  const download = vi.fn(async (input: DownloadDriveFileInput): Promise<DriveFileContent> => {
    if (options.downloadError) throw options.downloadError;
    return (
      options.content ?? {
        fileId: input.fileId,
        bytes: BYTES,
        mimeType: "image/jpeg",
        sizeBytes: BYTES.length,
      }
    );
  });
  const drive: DriveSource = { listFiles: async () => [], download };

  const getBlob = vi.fn(async (_input: GetBlobInput): Promise<BlobContent | null> =>
    options.blobContent === undefined ? { bytes: BYTES, mimeType: "image/png" } : options.blobContent,
  );
  const blobs: MediaBlobStore = {
    put: async () => {
      throw new Error("not used in this test");
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

  const get = vi.fn(async (_input: GetCachedMediaInput): Promise<CachedMediaBytes | null> => {
    if (options.cacheGetError) throw options.cacheGetError;
    return options.cached ?? null;
  });
  const put = vi.fn(async (_input: PutCachedMediaInput): Promise<void> => {
    if (options.cachePutError) throw options.cachePutError;
  });
  const cache: MediaByteCache = {
    get,
    put,
    evictOlderThan: async () => ({ scanned: 0, removed: 0, failed: 0 }),
  };

  return {
    logger,
    download,
    getBlob,
    get,
    put,
    findByDriveFileId,
    readMediaBytes: makeReadMediaBytes({
      cache,
      drive,
      blobs,
      mediaAssets,
      logger,
      maxBytes: options.maxBytes,
    }),
  };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(() => null).catch((e: unknown) => e);
  expect(AppError.is(error)).toBe(true);
  return error as AppError;
}

// --- Edge cases first -------------------------------------------------------

describe("readMediaBytes — refused calls", () => {
  it("rejects a malformed tenant id or asset id without touching any source", async () => {
    const { readMediaBytes, download, get, findByDriveFileId } = harness();

    await expect(readMediaBytes({ tenantId: testTenantId("nope"), assetId: ASSET })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "INVALID_MEDIA_REQUEST", retryable: false },
    });
    await expect(readMediaBytes({ tenantId: TENANT, assetId: "  " })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(findByDriveFileId).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses an asset this tenant does not have, and says a retry will not help", async () => {
    const { readMediaBytes, download, logger } = harness({ assets: {} });

    const error = await failure(readMediaBytes({ tenantId: TENANT, assetId: ASSET }));

    expect(error.code).toBe("MEDIA_NOT_FOUND");
    expect(error.context).toMatchObject({
      tenant_id: TENANT,
      drive_file_id: ASSET,
      reason: "ASSET_NOT_IN_SNAPSHOT",
      retryable: false,
    });
    expect(download).not.toHaveBeenCalled();
    expect(logger.lines.some((line) => line.level === "error")).toBe(true);
  });

  it("refuses an asset the snapshot already knows is too big", async () => {
    const { readMediaBytes, download } = harness({
      assets: { [`${TENANT}:${ASSET}`]: asset({ sizeBytes: 40 * 1024 * 1024 }) },
    });

    const error = await failure(readMediaBytes({ tenantId: TENANT, assetId: ASSET }));

    expect(error.code).toBe("DRIVE_ERROR");
    expect(error.context).toMatchObject({ reason: "CONTENT_TOO_LARGE", retryable: false });
    expect(download).not.toHaveBeenCalled();
  });

  it("refuses a body that grew past the budget during the download", async () => {
    const { readMediaBytes, put } = harness({
      assets: { [`${TENANT}:${ASSET}`]: asset({ sizeBytes: 8 }) },
      maxBytes: 16,
      content: { fileId: ASSET, bytes: new Uint8Array(64), mimeType: "image/jpeg", sizeBytes: 64 },
    });

    const error = await failure(readMediaBytes({ tenantId: TENANT, assetId: ASSET }));

    expect(error.context).toMatchObject({ reason: "CONTENT_TOO_LARGE" });
    // Never cache bytes this code would refuse to hand over.
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses an empty body instead of uploading zero bytes", async () => {
    const { readMediaBytes, put } = harness({
      content: { fileId: ASSET, bytes: new Uint8Array(0), mimeType: "image/jpeg", sizeBytes: 0 },
    });

    const error = await failure(readMediaBytes({ tenantId: TENANT, assetId: ASSET }));

    expect(error.code).toBe("DRIVE_ERROR");
    expect(error.context).toMatchObject({ reason: "EMPTY_CONTENT" });
    expect(put).not.toHaveBeenCalled();
  });

  it("lets a Drive outage through with its own code (the caller may retry)", async () => {
    const { readMediaBytes } = harness({
      downloadError: new AppError("DRIVE_ERROR", { message: "backend error" }),
    });

    const error = await failure(readMediaBytes({ tenantId: TENANT, assetId: ASSET }));

    expect(error.code).toBe("DRIVE_ERROR");
    // No `retryable: false` here: a transient Drive failure MAY be retried, and
    // publish-post reads exactly this field.
    expect(error.context.retryable).toBeUndefined();
  });
});

describe("readMediaBytes — a broken cache never fails a post", () => {
  it("falls back to Drive when the cache read throws", async () => {
    const { readMediaBytes, download, logger } = harness({
      cacheGetError: new Error("EACCES: permission denied"),
    });

    const content = await readMediaBytes({ tenantId: TENANT, assetId: ASSET });

    expect(content.bytes).toEqual(BYTES);
    expect(download).toHaveBeenCalledTimes(1);
    expect(
      logger.lines.some(
        (line) => line.level === "warn" && line.context?.reason === "CACHE_READ_FAILED",
      ),
    ).toBe(true);
  });

  it("still returns the bytes when the cache write throws", async () => {
    const { readMediaBytes, logger } = harness({ cachePutError: new Error("ENOSPC") });

    const content = await readMediaBytes({ tenantId: TENANT, assetId: ASSET });

    expect(content.bytes).toEqual(BYTES);
    expect(
      logger.lines.some(
        (line) => line.level === "warn" && line.context?.reason === "CACHE_WRITE_FAILED",
      ),
    ).toBe(true);
  });

  it("treats an empty cache entry as a miss instead of uploading nothing", async () => {
    const { readMediaBytes, download } = harness({
      cached: { bytes: new Uint8Array(0), mimeType: "image/jpeg" },
    });

    const content = await readMediaBytes({ tenantId: TENANT, assetId: ASSET });

    expect(content.bytes).toEqual(BYTES);
    expect(download).toHaveBeenCalledTimes(1);
  });
});

describe("readMediaBytes — uploaded assets (E9 mode B)", () => {
  const UPLOAD = "upload_abc";
  const uploaded = (overrides: Partial<MediaAsset> = {}) =>
    asset({
      driveFileId: UPLOAD,
      origin: "upload",
      storageKey: "tenant/upload_abc.jpg",
      ...overrides,
    });

  it("reads the blob store and never Drive, and does not cache it", async () => {
    const { readMediaBytes, download, getBlob, get, put } = harness({
      assets: { [`${TENANT}:${UPLOAD}`]: uploaded() },
    });

    const content = await readMediaBytes({ tenantId: TENANT, assetId: UPLOAD });

    expect(content).toEqual({ bytes: BYTES, mimeType: "image/png" });
    expect(getBlob).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, storageKey: "tenant/upload_abc.jpg" }),
    );
    expect(download).not.toHaveBeenCalled();
    // The bytes are already local: a cache copy would only waste the volume.
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses a mode B row with no storage key instead of asking Drive", async () => {
    const { readMediaBytes, download } = harness({
      assets: { [`${TENANT}:${UPLOAD}`]: uploaded({ storageKey: null }) },
    });

    const error = await failure(readMediaBytes({ tenantId: TENANT, assetId: UPLOAD }));

    expect(error.code).toBe("MEDIA_NOT_FOUND");
    expect(error.context).toMatchObject({ reason: "MISSING_STORAGE_KEY", retryable: false });
    expect(download).not.toHaveBeenCalled();
  });

  it("says plainly when the row outlived its bytes", async () => {
    const { readMediaBytes } = harness({
      assets: { [`${TENANT}:${UPLOAD}`]: uploaded() },
      blobContent: null,
    });

    const error = await failure(readMediaBytes({ tenantId: TENANT, assetId: UPLOAD }));

    expect(error.code).toBe("MEDIA_NOT_FOUND");
    expect(error.context).toMatchObject({ reason: "BLOB_MISSING", retryable: false });
    expect(error.userMessage).toContain("tải lại");
  });
});

// --- Happy path -------------------------------------------------------------

describe("readMediaBytes — cache first, origin second", () => {
  it("serves a cached asset WITHOUT touching Drive", async () => {
    const { readMediaBytes, download, get, put } = harness({
      cached: { bytes: BYTES, mimeType: "image/jpeg" },
    });

    const content = await readMediaBytes({ tenantId: TENANT, assetId: ASSET, jobId: "job-1" });

    expect(content).toEqual({ bytes: BYTES, mimeType: "image/jpeg" });
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, assetId: ASSET }),
    );
    expect(download).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("downloads a cold asset and stores it for the retry / the next channel", async () => {
    const { readMediaBytes, download, put } = harness();

    const content = await readMediaBytes({ tenantId: TENANT, assetId: ASSET });

    expect(content).toEqual({ bytes: BYTES, mimeType: "image/jpeg" });
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, fileId: ASSET }),
    );
    expect(put).toHaveBeenCalledWith({
      tenantId: TENANT,
      assetId: ASSET,
      bytes: BYTES,
      mimeType: "image/jpeg",
    });
  });

  it("falls back to the synced MIME type when the origin reports none", async () => {
    const { readMediaBytes } = harness({
      content: { fileId: ASSET, bytes: BYTES, mimeType: null, sizeBytes: BYTES.length },
    });

    const content = await readMediaBytes({ tenantId: TENANT, assetId: ASSET });

    expect(content.mimeType).toBe("image/jpeg");
  });

  it("returns null rather than a junk MIME type when neither side has one", async () => {
    const { readMediaBytes } = harness({
      assets: { [`${TENANT}:${ASSET}`]: asset({ mimeType: null }) },
      content: { fileId: ASSET, bytes: BYTES, mimeType: "not a mime", sizeBytes: BYTES.length },
    });

    const content = await readMediaBytes({ tenantId: TENANT, assetId: ASSET });

    expect(content.mimeType).toBeNull();
  });
});
