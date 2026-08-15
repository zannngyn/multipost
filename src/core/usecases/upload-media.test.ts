import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { MediaAsset } from "@/core/domain/product";
import { MAX_UPLOAD_BYTES } from "@/core/domain/uploaded-media";
import type { Logger } from "@/core/ports/infra";
import type { MediaBlobStore, PutBlobInput } from "@/core/ports/media-blob-store";
import type { MediaRepo } from "@/core/ports/product-repo";

import { makeUploadMedia, type UploadedFile } from "./upload-media";

const TENANT = "00000000-0000-0000-0000-000000000001";

function makeLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function file(patch: Partial<UploadedFile> = {}): UploadedFile {
  return {
    fileName: "anh.jpg",
    mimeType: "image/jpeg",
    bytes: new Uint8Array([1, 2, 3]),
    ...patch,
  };
}

function harness(options: { putError?: unknown; registerError?: unknown } = {}) {
  const registered: MediaAsset[] = [];
  const put = vi.fn(async (input: PutBlobInput) => {
    if (options.putError) throw options.putError;
    return {
      storageKey: `${input.tenantId}/${input.assetId}`,
      sizeBytes: input.bytes.length,
    };
  });
  const remove = vi.fn(async () => true);
  const blobs: MediaBlobStore = { put, get: async () => null, delete: remove };

  const registerUpload = vi.fn(async (_tenantId: string, asset: MediaAsset) => {
    if (options.registerError) throw options.registerError;
    registered.push(asset);
  });
  const media: MediaRepo = {
    listByProductCode: async () => [],
    upsertMany: async () => 0,
    deleteStale: async () => 0,
    registerUpload,
    listOrphanedUploads: async () => [],
    deleteUploads: async () => 0,
  };

  let counter = 0;
  return {
    put,
    remove,
    registered,
    registerUpload,
    uploadMedia: makeUploadMedia({
      blobs,
      media,
      logger: makeLogger(),
      newAssetId: () => `upload_${(counter += 1).toString().padStart(4, "0")}`,
    }),
  };
}

describe("uploadMedia — malformed calls throw", () => {
  it("rejects a missing tenant or product code", async () => {
    const { uploadMedia } = harness();
    await expect(
      uploadMedia({ tenantId: "not-a-uuid", productCode: "MG1", files: [file()] }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      uploadMedia({ tenantId: TENANT, productCode: "  ", files: [file()] }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects an empty album", async () => {
    const { uploadMedia } = harness();
    await expect(
      uploadMedia({ tenantId: TENANT, productCode: "MG1", files: [] }),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe("uploadMedia — per-file rejection", () => {
  it("keeps the good files and reports the bad ones instead of failing the batch", async () => {
    // Business rule 5: an operator dragging 6 files must be told which one was
    // refused and why, not just "upload failed".
    const { uploadMedia, registered } = harness();

    const result = await uploadMedia({
      tenantId: TENANT,
      productCode: "MG1",
      files: [
        file({ fileName: "ok.jpg" }),
        file({ fileName: "tai-lieu.pdf", mimeType: "application/pdf" }),
        file({ fileName: "to.jpg", bytes: new Uint8Array(1), mimeType: "image/jpeg" }),
      ],
    });

    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({
      fileName: "tai-lieu.pdf",
      reason: "UNSUPPORTED_TYPE",
    });
    expect(registered).toHaveLength(2);
  });

  it("reports an oversized file without storing it", async () => {
    const { uploadMedia, put } = harness();
    const result = await uploadMedia({
      tenantId: TENANT,
      productCode: "MG1",
      files: [
        file({ fileName: "ok.jpg" }),
        file({ fileName: "huge.jpg", bytes: new Uint8Array(1) }),
      ],
      // Declared size is what the gate reads; the bytes are a stub here.
      declaredSizes: [10, MAX_UPLOAD_BYTES + 1],
    });

    expect(result.accepted.map((asset) => asset.fileName)).toEqual(["ok.jpg"]);
    expect(result.rejected[0]).toMatchObject({ fileName: "huge.jpg", reason: "TOO_LARGE" });
    // Only the good file reached the store.
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("throws when every file was refused — there is no post to compose", async () => {
    const { uploadMedia } = harness();
    await expect(
      uploadMedia({
        tenantId: TENANT,
        productCode: "MG1",
        files: [file({ fileName: "a.pdf", mimeType: "application/pdf" })],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("uploadMedia — album shape", () => {
  it("numbers the assets by the arranged order so the cover survives compose", async () => {
    // compose-post orders an album by `sequence`; writing the arrangement into
    // that field is what makes the operator's drag-and-drop stick without
    // touching the existing selection logic.
    const { uploadMedia } = harness();

    const result = await uploadMedia({
      tenantId: TENANT,
      productCode: "MG1",
      files: [file({ fileName: "a.jpg" }), file({ fileName: "b.jpg" }), file({ fileName: "c.jpg" })],
      order: [2, 0, 1],
    });

    expect(result.accepted.map((asset) => asset.fileName)).toEqual(["c.jpg", "a.jpg", "b.jpg"]);
    expect(result.accepted.map((asset) => asset.sequence)).toEqual([1, 2, 3]);
  });

  it("marks every asset as an upload carrying a storage key", async () => {
    const { uploadMedia } = harness();
    const result = await uploadMedia({
      tenantId: TENANT,
      productCode: "mg1",
      files: [file()],
    });

    expect(result.accepted[0]).toMatchObject({
      origin: "upload",
      // Codes are upper-cased the same way compose does it.
      productCode: "MG1",
      needsReview: false,
    });
    expect(result.accepted[0].storageKey).toBe(`${TENANT}/${result.accepted[0].driveFileId}`);
    expect(result.accepted[0].driveFileId).toMatch(/^upload_/);
  });

  it("refuses an album mixing photos and video", async () => {
    // A Facebook album and a video post are different endpoints; one post
    // cannot be both, and finding out at publish time would be too late.
    const { uploadMedia } = harness();
    await expect(
      uploadMedia({
        tenantId: TENANT,
        productCode: "MG1",
        files: [file(), file({ fileName: "clip.mp4", mimeType: "video/mp4" })],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses more than one video in a post", async () => {
    const { uploadMedia } = harness();
    await expect(
      uploadMedia({
        tenantId: TENANT,
        productCode: "MG1",
        files: [
          file({ fileName: "a.mp4", mimeType: "video/mp4" }),
          file({ fileName: "b.mp4", mimeType: "video/mp4" }),
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("uploadMedia — failure cleanup", () => {
  it("removes the stored bytes when the row cannot be written", async () => {
    // Otherwise the blob is unreachable forever: no row means no storage key,
    // and the cleanup sweep works off rows.
    const { uploadMedia, remove } = harness({ registerError: new Error("db down") });

    await expect(
      uploadMedia({ tenantId: TENANT, productCode: "MG1", files: [file()] }),
    ).rejects.toBeInstanceOf(AppError);

    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("surfaces a storage failure as an AppError", async () => {
    const { uploadMedia } = harness({ putError: new Error("disk full") });
    await expect(
      uploadMedia({ tenantId: TENANT, productCode: "MG1", files: [file()] }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
