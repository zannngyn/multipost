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

/** Real signature bytes: the usecase sniffs content, not the declared type. */
function jpegBytes(): Uint8Array {
  const buffer = new Uint8Array(16);
  buffer.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return buffer;
}

function mp4Bytes(): Uint8Array {
  const buffer = new Uint8Array(16);
  buffer.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
  buffer.set(new TextEncoder().encode("isom"), 8);
  return buffer;
}

function file(patch: Partial<UploadedFile> = {}): UploadedFile {
  const mimeType = patch.mimeType ?? "image/jpeg";
  return {
    fileName: "anh.jpg",
    mimeType,
    bytes: mimeType.startsWith("video/") ? mp4Bytes() : jpegBytes(),
    ...patch,
  };
}

function harness(
  options: {
    putError?: unknown;
    registerError?: unknown;
    previous?: Array<{ tenantId: string; assetId: string; storageKey: string; fileName: string; sizeBytes: number | null }>;
    listPreviousError?: unknown;
  } = {},
) {
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
  const listUnreferencedUploadsForCode = vi.fn(async () => {
    if (options.listPreviousError) throw options.listPreviousError;
    return options.previous ?? [];
  });
  const deleteUploads = vi.fn(async (_tenantId: string, ids: readonly string[]) => ids.length);

  const media: MediaRepo = {
    listByProductCode: async () => [],
    upsertMany: async () => 0,
    deleteStale: async () => 0,
    countDriveAssets: async () => 0,
    registerUpload,
    listOrphanedUploads: async () => [],
    listUnreferencedUploadsForCode,
    deleteUploads,
  };

  let counter = 0;
  return {
    put,
    remove,
    registered,
    registerUpload,
    deleteUploads,
    listUnreferencedUploadsForCode,
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
        file({ fileName: "ok-2.jpg" }),
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

  it("refuses a file whose content does not match its declared type", async () => {
    // The whole point of sniffing: a browser's File.type and the extension are
    // both attacker-controlled, and these bytes end up behind a public URL.
    const { uploadMedia, put } = harness();

    const result = await uploadMedia({
      tenantId: TENANT,
      productCode: "MG1",
      files: [
        file({ fileName: "ok.jpg" }),
        // Claims to be a photo; the bytes are an ELF binary.
        file({
          fileName: "malware.jpg",
          mimeType: "image/jpeg",
          bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4, 5, 6, 7, 8]),
        }),
      ],
    });

    expect(result.accepted.map((asset) => asset.fileName)).toEqual(["ok.jpg"]);
    expect(result.rejected[0]).toMatchObject({ fileName: "malware.jpg" });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("refuses an mp4 renamed to .jpg and declared as a photo", async () => {
    const { uploadMedia } = harness();
    await expect(
      uploadMedia({
        tenantId: TENANT,
        productCode: "MG1",
        files: [file({ fileName: "clip.jpg", mimeType: "image/jpeg", bytes: mp4Bytes() })],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
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

describe("uploadMedia — a second upload replaces the first", () => {
  const previous = [
    {
      tenantId: TENANT,
      assetId: "upload_old1",
      storageKey: `${TENANT}/upload_old1`,
      fileName: "cu-1.jpg",
      sizeBytes: 10,
    },
  ];

  it("removes the abandoned attempt before storing the new album", async () => {
    // Without this, both attempts sit under the same product code with
    // overlapping sequence numbers and compose returns one jumbled album.
    const { uploadMedia, remove, deleteUploads } = harness({ previous });

    const result = await uploadMedia({
      tenantId: TENANT,
      productCode: "MG1",
      files: [file({ fileName: "moi.jpg" })],
    });

    expect(remove).toHaveBeenCalledWith({ tenantId: TENANT, storageKey: `${TENANT}/upload_old1` });
    expect(deleteUploads).toHaveBeenCalledWith(TENANT, ["upload_old1"]);
    expect(result.accepted.map((asset) => asset.sequence)).toEqual([1]);
  });

  it("still uploads when the previous attempt cannot be listed", async () => {
    // The operator asked to upload; stale bytes are the sweep's problem.
    const { uploadMedia } = harness({ listPreviousError: new Error("db down") });

    const result = await uploadMedia({
      tenantId: TENANT,
      productCode: "MG1",
      files: [file()],
    });

    expect(result.accepted).toHaveLength(1);
  });

  it("does not look for a previous attempt when every file was refused", async () => {
    const { uploadMedia, listUnreferencedUploadsForCode } = harness({ previous });

    await expect(
      uploadMedia({
        tenantId: TENANT,
        productCode: "MG1",
        files: [file({ fileName: "a.pdf", mimeType: "application/pdf" })],
      }),
    ).rejects.toBeInstanceOf(AppError);

    // Nothing is replacing anything: the old album is still the good one.
    expect(listUnreferencedUploadsForCode).not.toHaveBeenCalled();
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
