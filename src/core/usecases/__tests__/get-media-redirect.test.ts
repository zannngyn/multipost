import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import { signMediaUrl, type SignatureFn } from "@/core/domain/media-url";
import type { MediaAsset } from "@/core/domain/product";
import type { DriveFileContent, DriveSource, MediaAssetLookup } from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";
import type { BlobContent, GetBlobInput, MediaBlobStore } from "@/core/ports/media-blob-store";
import type { CachedMediaBytes, MediaByteCache } from "@/core/ports/media-byte-cache";

import { makeGetMediaContent, MEDIA_REDIRECT_TTL_SECONDS } from "../get-media-content";
import type { TenantId } from "@/core/domain/tenant-context";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * E9 — the media bridge answers 302 to a signed download URL for an uploaded
 * asset, instead of streaming, whenever the blob store can sign one.
 *
 * Fixtures mirror get-media-content.test.ts (same names, same shape) rather
 * than inventing a new harness — see that file for the full picture, this one
 * only adds what the redirect branch needs.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const ASSET = "drive-file-1";
const UPLOAD_ID = "upload_ab12cd34";
const UPLOAD_KEY = `${TENANT}/${UPLOAD_ID}`;
const NOW = Date.UTC(2026, 7, 12, 9, 0, 0);
const SECRET = "media-signing-secret-at-least-32-chars";
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const SIGNED_URL = "https://media.vannt.asia/signed";

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

function uploaded(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return asset({
    driveFileId: UPLOAD_ID,
    origin: "upload",
    storageKey: UPLOAD_KEY,
    fileName: "anh-tu-tai-len.jpg",
    ...overrides,
  });
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
  /** `null` = "cannot sign" (local store); a string = the signed URL. */
  createDownloadUrl?: string | null;
  createDownloadUrlError?: unknown;
  blobContent?: BlobContent | null;
  /** Proves the redirect path never reads bytes: `get` throws if called at all. */
  blobGetThrows?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const logger = makeLogger();
  const clock: Clock = { now: () => new Date(NOW), nowMs: () => NOW };
  const download = vi.fn(
    async (input: { fileId: string }): Promise<DriveFileContent> => ({
      fileId: input.fileId,
      bytes: BYTES,
      mimeType: "image/jpeg",
      sizeBytes: BYTES.length,
    }),
  );
  const drive: DriveSource = { listFiles: async () => [], download };

  const store = options.assets ?? { [`${TENANT}:${UPLOAD_ID}`]: uploaded() };
  const findByDriveFileId = vi.fn(
    async (tenantId: string, driveFileId: string) => store[`${tenantId}:${driveFileId}`] ?? null,
  );
  const mediaAssets: MediaAssetLookup = { findByDriveFileId };

  const getBlob = vi.fn(async (_input: GetBlobInput): Promise<BlobContent | null> => {
    if (options.blobGetThrows) throw new Error("must not read bytes on the redirect path");
    if (options.blobContent === null) return null;
    return options.blobContent ?? { bytes: BYTES, mimeType: "image/jpeg" };
  });
  const createDownloadUrl = vi.fn(async () => {
    if (options.createDownloadUrlError) throw options.createDownloadUrlError;
    if (options.createDownloadUrl === null) return null;
    return options.createDownloadUrl ?? SIGNED_URL;
  });
  const blobs: MediaBlobStore = {
    put: async () => {
      throw new Error("not used");
    },
    get: getBlob,
    delete: async () => false,
    deleteStaging: async () => false,
    createUploadUrl: async () => {
      throw new Error("not used in this test");
    },
    stat: async () => null,
    statStaging: async () => null,
    readRange: async () => null,
    promote: async () => ({ storageKey: "", sizeBytes: 0 }),
    createDownloadUrl,
  };

  const getCached = vi.fn(async (): Promise<CachedMediaBytes | null> => null);
  const putCached = vi.fn(async (): Promise<void> => {});
  const cache: MediaByteCache = {
    get: getCached,
    put: putCached,
    evictOlderThan: async () => ({ scanned: 0, removed: 0, failed: 0 }),
  };

  return {
    logger,
    download,
    getBlob,
    createDownloadUrl,
    findByDriveFileId,
    getMediaContent: makeGetMediaContent({
      drive,
      blobs,
      cache,
      mediaAssets,
      sign,
      clock,
      logger,
    }),
  };
}

function link(overrides: { tenantId?: TenantId; assetId?: string } = {}) {
  const result = signMediaUrl({
    tenantId: overrides.tenantId ?? TENANT,
    assetId: overrides.assetId ?? UPLOAD_ID,
    baseUrl: "https://mysp.example.com",
    nowMs: NOW,
    sign,
  });
  return {
    tenantId: overrides.tenantId ?? TENANT,
    mediaAssetId: overrides.assetId ?? UPLOAD_ID,
    expiresAt: result.expiresAtMs,
    signature: result.signature,
  };
}

describe("getMediaContent — 302 for uploaded assets", () => {
  it("returns a redirectUrl when the store can sign, and reads no bytes", async () => {
    // blobGetThrows: proof by construction — if the redirect path read bytes
    // first, this test would fail with the thrown error, not a soft assertion.
    const { getMediaContent, getBlob, createDownloadUrl } = harness({ blobGetThrows: true });

    const result = await getMediaContent(link());

    expect(result.redirectUrl).toBe(SIGNED_URL);
    expect(getBlob).not.toHaveBeenCalled();
    expect(createDownloadUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        storageKey: UPLOAD_KEY,
        expiresInSeconds: MEDIA_REDIRECT_TTL_SECONDS,
      }),
    );
  });

  it("falls back to streaming when the store returns null", async () => {
    const { getMediaContent, getBlob } = harness({ createDownloadUrl: null });

    const result = await getMediaContent(link());

    expect(result.redirectUrl ?? null).toBeNull();
    expect(result.bytes).toEqual(BYTES);
    expect(getBlob).toHaveBeenCalledTimes(1);
  });

  it("never redirects a Drive asset, and never even asks the store to sign one", async () => {
    const { getMediaContent, createDownloadUrl, download } = harness({
      assets: { [`${TENANT}:${ASSET}`]: asset() },
    });

    const result = await getMediaContent(link({ assetId: ASSET }));

    expect(result.redirectUrl ?? null).toBeNull();
    expect(createDownloadUrl).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("never signs a URL for a request that failed signature verification", async () => {
    const { getMediaContent, createDownloadUrl } = harness();

    await expect(
      getMediaContent({ ...link(), signature: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(createDownloadUrl).not.toHaveBeenCalled();
  });

  it("never logs the signed URL — it is a bearer token", async () => {
    const { getMediaContent, logger } = harness();

    await getMediaContent(link());

    expect(JSON.stringify(logger.lines)).not.toContain(SIGNED_URL);
  });

  it("propagates a real signing failure instead of swallowing it", async () => {
    const { getMediaContent } = harness({
      createDownloadUrlError: new AppError("INTERNAL", { context: { reason: "MINIO_DOWN" } }),
    });

    await expect(getMediaContent(link())).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
