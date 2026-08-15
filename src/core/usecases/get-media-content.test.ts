import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import { signMediaUrl, type SignatureFn } from "@/core/domain/media-url";
import type { MediaAsset } from "@/core/domain/product";
import type {
  DownloadDriveFileInput,
  DriveFileContent,
  DriveSource,
  MediaAssetLookup,
} from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";
import type { BlobContent, GetBlobInput, MediaBlobStore } from "@/core/ports/media-blob-store";

import { makeGetMediaContent } from "./get-media-content";

/**
 * The media route is the only UNAUTHENTICATED door in the app (Meta's fetcher
 * has no session), so the tests lead with the ways in can be abused: forged MAC,
 * expired link, a valid link of ANOTHER tenant, an asset that is not synced.
 */

const TENANT = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT = "00000000-0000-0000-0000-000000000002";
const ASSET = "drive-file-1";
const NOW = Date.UTC(2026, 7, 12, 9, 0, 0);
const SECRET = "media-signing-secret-at-least-32-chars";
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const sign: SignatureFn = (payload) => createHmac("sha256", SECRET).update(payload).digest("hex");

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

interface HarnessOptions {
  assets?: Record<string, MediaAsset | undefined>;
  content?: DriveFileContent;
  downloadError?: unknown;
  maxBytes?: number;
  /** Bytes the blob store returns; null makes it answer "not there". */
  blobContent?: BlobContent | null;
  blobError?: unknown;
}

function harness(options: HarnessOptions = {}) {
  const logger = makeLogger();
  const clock: Clock = { now: () => new Date(NOW), nowMs: () => NOW };
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
  const drive: DriveSource = {
    listFiles: async () => [],
    download,
  };
  const store = options.assets ?? { [`${TENANT}:${ASSET}`]: asset() };
  const findByDriveFileId = vi.fn(
    async (tenantId: string, driveFileId: string) => store[`${tenantId}:${driveFileId}`] ?? null,
  );
  const mediaAssets: MediaAssetLookup = { findByDriveFileId };

  const getBlob = vi.fn(async (_input: GetBlobInput): Promise<BlobContent | null> => {
    if (options.blobError) throw options.blobError;
    if (options.blobContent === null) return null;
    return options.blobContent ?? { bytes: BYTES, mimeType: null };
  });
  const blobs: MediaBlobStore = {
    put: async () => {
      throw new Error("not used");
    },
    get: getBlob,
    delete: async () => false,
  };

  return {
    logger,
    download,
    getBlob,
    findByDriveFileId,
    getMediaContent: makeGetMediaContent({
      drive,
      blobs,
      mediaAssets,
      sign,
      clock,
      logger,
      maxBytes: options.maxBytes,
    }),
  };
}

function link(overrides: { tenantId?: string; assetId?: string; ttlMs?: number } = {}) {
  const result = signMediaUrl({
    tenantId: overrides.tenantId ?? TENANT,
    assetId: overrides.assetId ?? ASSET,
    baseUrl: "https://mysp.example.com",
    nowMs: NOW,
    ttlMs: overrides.ttlMs,
    sign,
  });
  return {
    tenantId: overrides.tenantId ?? TENANT,
    mediaAssetId: overrides.assetId ?? ASSET,
    expiresAt: result.expiresAtMs,
    signature: result.signature,
  };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
    throw new Error("expected the call to reject");
  } catch (error) {
    if (!AppError.is(error)) throw error;
    return error as AppError;
  }
}

describe("getMediaContent — rejections come first", () => {
  it("rejects a request with no signature at all", async () => {
    const { getMediaContent, findByDriveFileId } = harness();
    const error = await failure(
      getMediaContent({ tenantId: TENANT, mediaAssetId: ASSET, expiresAt: NOW + 1000, signature: "" }),
    );

    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.context).toMatchObject({ reason: "MISSING_SIGNATURE" });
    // Nothing was read: the gate is BEFORE the database.
    expect(findByDriveFileId).not.toHaveBeenCalled();
  });

  it("rejects a forged signature", async () => {
    const { getMediaContent, download } = harness();
    const error = await failure(
      getMediaContent({ ...link(), signature: "a".repeat(64) }),
    );

    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.context).toMatchObject({ reason: "BAD_SIGNATURE" });
    expect(download).not.toHaveBeenCalled();
  });

  it("rejects an expired link", async () => {
    const { getMediaContent } = harness();
    const expired = signMediaUrl({
      tenantId: TENANT,
      assetId: ASSET,
      baseUrl: "https://mysp.example.com",
      nowMs: NOW - 7 * 60 * 60 * 1000,
      sign,
    });

    const error = await failure(
      getMediaContent({
        tenantId: TENANT,
        mediaAssetId: ASSET,
        expiresAt: expired.expiresAtMs,
        signature: expired.signature,
      }),
    );

    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.context).toMatchObject({ reason: "EXPIRED" });
  });

  it("rejects a link signed for another tenant, with the SAME code as a forgery", async () => {
    const { getMediaContent } = harness();
    const other = link({ tenantId: OTHER_TENANT });

    const error = await failure(
      getMediaContent({ ...other, tenantId: TENANT }),
    );

    expect(error.code).toBe("UNAUTHORIZED");
    expect(error.context).toMatchObject({ reason: "BAD_SIGNATURE" });
  });

  it("refuses to reach another tenant's asset even with that tenant's valid link", async () => {
    // Signature is valid for OTHER_TENANT, but that tenant has no such row:
    // the lookup is tenant-scoped, so the Service Account never gets asked.
    const { getMediaContent, download } = harness();
    const error = await failure(getMediaContent(link({ tenantId: OTHER_TENANT })));

    expect(error.code).toBe("MEDIA_NOT_FOUND");
    expect(download).not.toHaveBeenCalled();
  });

  it("returns MEDIA_NOT_FOUND for an asset id that was never synced", async () => {
    const { getMediaContent } = harness();
    const error = await failure(getMediaContent(link({ assetId: "unknown-file" })));
    expect(error.code).toBe("MEDIA_NOT_FOUND");
    expect(error.context).toMatchObject({ tenant_id: TENANT, drive_file_id: "unknown-file" });
  });

  it("never puts the signature or the secret into an error context or a log line", async () => {
    const { getMediaContent, logger } = harness();
    const request = link();
    const error = await failure(getMediaContent({ ...request, signature: "b".repeat(64) }));

    const serialisedError = JSON.stringify(error.toLogObject());
    const serialisedLogs = JSON.stringify(logger.lines);
    for (const secret of [SECRET, request.signature, "b".repeat(64)]) {
      expect(serialisedError).not.toContain(secret);
      expect(serialisedLogs).not.toContain(secret);
    }
  });

  it("propagates a Drive failure instead of swallowing it", async () => {
    const { getMediaContent } = harness({
      downloadError: new AppError("DRIVE_ERROR", { context: { drive_file_id: ASSET } }),
    });
    const error = await failure(getMediaContent(link()));
    expect(error.code).toBe("DRIVE_ERROR");
  });

  it("refuses an empty body — Facebook would fail on it with an opaque error", async () => {
    const { getMediaContent } = harness({
      content: { fileId: ASSET, bytes: new Uint8Array(), mimeType: "image/jpeg", sizeBytes: 0 },
    });
    const error = await failure(getMediaContent(link()));
    expect(error.code).toBe("DRIVE_ERROR");
    expect(error.context).toMatchObject({ reason: "EMPTY_CONTENT" });
  });

  it("refuses an asset the sync already measured as too large, before downloading", async () => {
    const { getMediaContent, download } = harness({
      assets: { [`${TENANT}:${ASSET}`]: asset({ sizeBytes: 50 * 1024 * 1024 }) },
      maxBytes: 1024,
    });

    const error = await failure(getMediaContent(link()));
    expect(error.code).toBe("DRIVE_ERROR");
    expect(error.context).toMatchObject({ reason: "CONTENT_TOO_LARGE" });
    expect(download).not.toHaveBeenCalled();
  });

  it("refuses a body larger than the budget even when the row said otherwise", async () => {
    const { getMediaContent } = harness({
      assets: { [`${TENANT}:${ASSET}`]: asset({ sizeBytes: null }) },
      content: {
        fileId: ASSET,
        bytes: new Uint8Array(4096),
        mimeType: "image/jpeg",
        sizeBytes: 4096,
      },
      maxBytes: 1024,
    });

    const error = await failure(getMediaContent(link()));
    expect(error.context).toMatchObject({ reason: "CONTENT_TOO_LARGE" });
  });
});

describe("getMediaContent — happy path", () => {
  it("serves the bytes of a valid link with the right mime type", async () => {
    const { getMediaContent, download } = harness();
    const result = await getMediaContent(link());

    expect(result).toMatchObject({
      driveFileId: ASSET,
      fileName: "MGKVX6310-KEM (1).jpg",
      productCode: "MGKVX6310",
      kind: "image",
      mimeType: "image/jpeg",
      sizeBytes: BYTES.length,
    });
    expect(result.bytes).toEqual(BYTES);
    expect(result.cacheSeconds).toBeGreaterThan(0);
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, fileId: ASSET }),
    );
  });

  it("accepts the expiry as a query string value", async () => {
    const { getMediaContent } = harness();
    const request = link();
    const result = await getMediaContent({ ...request, expiresAt: String(request.expiresAt) });
    expect(result.driveFileId).toBe(ASSET);
  });

  it("falls back to the synced mime type, then to octet-stream", async () => {
    const withoutHeader = harness({
      content: { fileId: ASSET, bytes: BYTES, mimeType: null, sizeBytes: BYTES.length },
    });
    expect((await withoutHeader.getMediaContent(link())).mimeType).toBe("image/jpeg");

    // 606 real files carry no extension (docs/05 1.3): no header, no row mime.
    const unknown = harness({
      assets: { [`${TENANT}:${ASSET}`]: asset({ mimeType: null, needsReview: true }) },
      content: { fileId: ASSET, bytes: BYTES, mimeType: "  ", sizeBytes: BYTES.length },
    });
    expect((await unknown.getMediaContent(link())).mimeType).toBe("application/octet-stream");
  });
});

// --- E9: uploaded assets are served from the blob store, not Drive ----------

describe("getMediaContent — mode B (uploaded assets)", () => {
  const UPLOAD_ID = "upload_ab12cd34";
  const UPLOAD_KEY = `${TENANT}/${UPLOAD_ID}`;

  function uploaded(overrides: Partial<MediaAsset> = {}): MediaAsset {
    return asset({
      driveFileId: UPLOAD_ID,
      origin: "upload",
      storageKey: UPLOAD_KEY,
      fileName: "anh-tu-tai-len.jpg",
      ...overrides,
    });
  }

  function uploadHarness(options: HarnessOptions = {}) {
    return harness({ assets: { [`${TENANT}:${UPLOAD_ID}`]: uploaded() }, ...options });
  }

  it("reads an uploaded asset from the blob store and never touches Drive", async () => {
    const { getMediaContent, getBlob, download } = uploadHarness();

    const result = await getMediaContent(link({ assetId: UPLOAD_ID }));

    expect(result.driveFileId).toBe(UPLOAD_ID);
    expect(result.sizeBytes).toBe(BYTES.length);
    expect(getBlob).toHaveBeenCalledTimes(1);
    expect(getBlob.mock.calls[0][0]).toMatchObject({ tenantId: TENANT, storageKey: UPLOAD_KEY });
    // The whole point: a mode B post must not depend on Drive being reachable.
    expect(download).not.toHaveBeenCalled();
  });

  it("still serves a Drive asset from Drive", async () => {
    const { getMediaContent, getBlob, download } = harness();
    await getMediaContent(link());
    expect(download).toHaveBeenCalledTimes(1);
    expect(getBlob).not.toHaveBeenCalled();
  });

  it("takes the mime type from the asset row, which the blob store does not keep", async () => {
    const { getMediaContent } = uploadHarness();
    expect((await getMediaContent(link({ assetId: UPLOAD_ID }))).mimeType).toBe("image/jpeg");
  });

  it("reports a missing blob as MEDIA_NOT_FOUND rather than an empty body", async () => {
    // The row survived but the bytes are gone (cleanup raced, volume lost).
    // Facebook would otherwise receive a 0-byte body and fail opaquely.
    const { getMediaContent } = uploadHarness({ blobContent: null });
    await expect(getMediaContent(link({ assetId: UPLOAD_ID }))).rejects.toMatchObject({
      code: "MEDIA_NOT_FOUND",
    });
  });

  it("rejects an upload row whose storage key was never written", async () => {
    const { getMediaContent, getBlob } = harness({
      assets: { [`${TENANT}:${UPLOAD_ID}`]: uploaded({ storageKey: null }) },
    });
    await expect(getMediaContent(link({ assetId: UPLOAD_ID }))).rejects.toMatchObject({
      code: "MEDIA_NOT_FOUND",
    });
    expect(getBlob).not.toHaveBeenCalled();
  });

  it("treats an empty blob as a failure, like an empty Drive download", async () => {
    const { getMediaContent } = uploadHarness({
      blobContent: { bytes: new Uint8Array(0), mimeType: null },
    });
    await expect(getMediaContent(link({ assetId: UPLOAD_ID }))).rejects.toBeInstanceOf(AppError);
  });
});
