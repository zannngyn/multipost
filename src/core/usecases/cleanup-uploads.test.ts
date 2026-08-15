import { describe, expect, it, vi } from "vitest";

import type { Clock, Logger } from "@/core/ports/infra";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";
import type { MediaRepo, OrphanedUpload } from "@/core/ports/product-repo";

import { makeCleanupUploads } from "./cleanup-uploads";

const TENANT_A = "00000000-0000-0000-0000-000000000001";
const TENANT_B = "00000000-0000-0000-0000-000000000002";
const NOW = Date.parse("2026-08-15T10:00:00.000Z");

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

function orphan(patch: Partial<OrphanedUpload> = {}): OrphanedUpload {
  return {
    tenantId: TENANT_A,
    assetId: "upload_a1",
    storageKey: `${TENANT_A}/upload_a1`,
    fileName: "a.jpg",
    sizeBytes: 100,
    ...patch,
  };
}

function harness(
  options: { orphans?: OrphanedUpload[]; deleteBlobError?: unknown; deleteRowError?: unknown } = {},
) {
  const listOrphanedUploads = vi.fn(async () => options.orphans ?? []);
  const deleteUploads = vi.fn(async (_tenantId: string, ids: readonly string[]) => {
    if (options.deleteRowError) throw options.deleteRowError;
    return ids.length;
  });
  const media = {
    listByProductCode: async () => [],
    upsertMany: async () => 0,
    deleteStale: async () => 0,
    registerUpload: async () => {},
    listOrphanedUploads,
    listUnreferencedUploadsForCode: async () => [],
    deleteUploads,
  } satisfies MediaRepo;

  const removeBlob = vi.fn(async () => {
    if (options.deleteBlobError) throw options.deleteBlobError;
    return true;
  });
  const blobs: MediaBlobStore = {
    put: async () => ({ storageKey: "", sizeBytes: 0 }),
    get: async () => null,
    delete: removeBlob,
  };

  const clock: Clock = { now: () => new Date(NOW), nowMs: () => NOW };

  return {
    listOrphanedUploads,
    deleteUploads,
    removeBlob,
    cleanupUploads: makeCleanupUploads({ media, blobs, clock, logger: makeLogger() }),
  };
}

describe("cleanupUploads — nothing to do", () => {
  it("reports zero without touching the store", async () => {
    const { cleanupUploads, removeBlob, deleteUploads } = harness({ orphans: [] });

    const result = await cleanupUploads();

    expect(result).toMatchObject({ scanned: 0, blobsRemoved: 0, rowsRemoved: 0 });
    expect(removeBlob).not.toHaveBeenCalled();
    expect(deleteUploads).not.toHaveBeenCalled();
  });

  it("asks only for rows older than the TTL", async () => {
    const { cleanupUploads, listOrphanedUploads } = harness();

    await cleanupUploads({ ttlHours: 24 });

    const [input] = listOrphanedUploads.mock.calls[0] as unknown as [
      { olderThan: Date; limit: number },
    ];
    expect(input.olderThan.toISOString()).toBe("2026-08-14T10:00:00.000Z");
  });
});

describe("cleanupUploads — removal order", () => {
  it("deletes the bytes before the row", async () => {
    // Row first would lose the storage key and strand the file forever: the
    // sweep finds orphans through rows.
    const order: string[] = [];
    const { cleanupUploads, removeBlob, deleteUploads } = harness({ orphans: [orphan()] });
    removeBlob.mockImplementation(async () => {
      order.push("blob");
      return true;
    });
    deleteUploads.mockImplementation(async () => {
      order.push("row");
      return 1;
    });

    await cleanupUploads();

    expect(order).toEqual(["blob", "row"]);
  });

  it("groups the row deletes per tenant", async () => {
    const { cleanupUploads, deleteUploads } = harness({
      orphans: [
        orphan({ tenantId: TENANT_A, assetId: "upload_a1" }),
        orphan({ tenantId: TENANT_A, assetId: "upload_a2" }),
        orphan({ tenantId: TENANT_B, assetId: "upload_b1", storageKey: `${TENANT_B}/upload_b1` }),
      ],
    });

    const result = await cleanupUploads();

    expect(deleteUploads).toHaveBeenCalledTimes(2);
    expect(result.rowsRemoved).toBe(3);
  });

  it("still deletes the row when the blob is already gone", async () => {
    const { cleanupUploads, deleteUploads } = harness({ orphans: [orphan({ storageKey: "" })] });

    const result = await cleanupUploads();

    expect(result.blobsRemoved).toBe(0);
    expect(deleteUploads).toHaveBeenCalledTimes(1);
    expect(result.rowsRemoved).toBe(1);
  });
});

describe("cleanupUploads — failures do not stop the sweep", () => {
  it("keeps the row when its bytes could not be removed", async () => {
    // Deleting the row would orphan the file with no way left to find it, so a
    // failed blob delete must leave the pair intact for the next sweep.
    const { cleanupUploads, deleteUploads } = harness({
      orphans: [orphan()],
      deleteBlobError: new Error("disk busy"),
    });

    const result = await cleanupUploads();

    expect(result.failed).toBe(1);
    expect(result.rowsRemoved).toBe(0);
    expect(deleteUploads).not.toHaveBeenCalled();
  });

  it("reports a failed row delete without throwing", async () => {
    const { cleanupUploads } = harness({
      orphans: [orphan()],
      deleteRowError: new Error("db down"),
    });

    const result = await cleanupUploads();

    expect(result.failed).toBe(1);
    expect(result.rowsRemoved).toBe(0);
  });
});
