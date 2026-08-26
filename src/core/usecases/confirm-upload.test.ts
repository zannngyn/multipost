import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import { makeConfirmUpload, type ConfirmUploadDeps } from "@/core/usecases/confirm-upload";
import type { TenantId } from "@/core/domain/tenant-context";
import type { Clock, Logger } from "@/core/ports/infra";
import type { BlobStat, MediaBlobStore } from "@/core/ports/media-blob-store";
import type { MediaRepo, OrphanedUpload } from "@/core/ports/product-repo";
import type { UploadTicket, UploadTicketRepo } from "@/core/ports/upload-ticket-repo";

const TENANT = "11111111-1111-4111-8111-111111111111" as TenantId;
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222" as TenantId;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);

function ticket(assetId: string, over: Partial<UploadTicket> = {}): UploadTicket {
  return {
    tenantId: TENANT,
    assetId,
    storageKey: `${TENANT}/${assetId}`,
    fileName: `${assetId}.png`,
    declaredMime: "image/png",
    declaredSize: 8,
    productCode: "MG0AD6112",
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  };
}

function makeLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function makeClock(nowMs = Date.now()): Clock {
  return { now: () => new Date(nowMs), nowMs: () => nowMs };
}

function makeTickets(rows: readonly UploadTicket[] = [ticket("a1")]) {
  // Mirrors the port's documented contract (upload-ticket-repo.ts): findMany
  // never returns a row belonging to a different tenant than the one asked.
  const findMany = vi.fn(async (tenantId: TenantId, assetIds: readonly string[]) =>
    rows.filter((row) => row.tenantId === tenantId && assetIds.includes(row.assetId)),
  );
  const deleteMany = vi.fn(async (_tenantId: TenantId, assetIds: readonly string[]) => assetIds.length);
  const repo: UploadTicketRepo = {
    createMany: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
    findMany,
    deleteMany,
    listExpired: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
  };
  return { repo, findMany, deleteMany };
}

/**
 * A blob store fake with SEPARATE staging/serving maps — the whole point of
 * this fixture. A mock that answers the same thing for both prefixes is
 * exactly what hid the staging-leak bug: it cannot fail the assertion that
 * cleanup hit the staging side and never touched (or needed) serving.
 */
function makeBlobs(
  config: {
    staging?: Record<string, { sizeBytes: number; mimeType?: string | null }>;
    content?: Record<string, Uint8Array | null>;
  } = {},
) {
  const stagingEntries = config.staging ?? { [`${TENANT}/a1`]: { sizeBytes: 8 } };
  const stagingStore = new Map<string, BlobStat>(
    Object.entries(stagingEntries).map(([key, value]) => [
      key,
      { sizeBytes: value.sizeBytes, mimeType: value.mimeType ?? "image/png" },
    ]),
  );
  const servingStore = new Map<string, BlobStat>();
  const content = config.content ?? {};

  const stat = vi.fn(async (input: { tenantId: TenantId; storageKey: string }) => servingStore.get(input.storageKey) ?? null);
  const statStaging = vi.fn(async (input: { tenantId: TenantId; storageKey: string }) => stagingStore.get(input.storageKey) ?? null);
  const readRange = vi.fn(async (input: { tenantId: TenantId; storageKey: string; length: number }) =>
    input.storageKey in content ? content[input.storageKey] : PNG,
  );
  const deleteStaging = vi.fn(async (input: { tenantId: TenantId; storageKey: string }) => stagingStore.delete(input.storageKey));
  const del = vi.fn(async (input: { tenantId: TenantId; storageKey: string }) => servingStore.delete(input.storageKey));
  const promote = vi.fn(async (input: { tenantId: TenantId; assetId: string }) => {
    const key = `${input.tenantId}/${input.assetId}`;
    const staged = stagingStore.get(key);
    if (!staged) {
      throw new AppError("INVALID_INPUT", {
        message: "Nothing to promote for this asset",
        context: { reason: "UPLOAD_OBJECT_MISSING", asset_id: input.assetId },
      });
    }
    stagingStore.delete(key);
    servingStore.set(key, staged);
    return { storageKey: key, sizeBytes: staged.sizeBytes };
  });

  const store: MediaBlobStore = {
    put: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
    get: vi.fn(async () => null),
    delete: del,
    createUploadUrl: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
    stat,
    statStaging,
    deleteStaging,
    readRange,
    promote,
    createDownloadUrl: vi.fn(async () => null),
  };

  return { store, stat, statStaging, readRange, deleteStaging, delete: del, promote, stagingStore, servingStore };
}

function makeMedia(
  config: {
    registerError?: unknown;
    previous?: readonly OrphanedUpload[];
  } = {},
) {
  const registerUpload = vi.fn(async () => {
    if (config.registerError) throw config.registerError;
  });
  const listUnreferencedUploadsForCode = vi.fn(async () => config.previous ?? []);
  const deleteUploads = vi.fn(async (_tenantId: TenantId, assetIds: readonly string[]) => assetIds.length);
  const repo: MediaRepo = {
    listByProductCode: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
    upsertMany: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
    deleteStale: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
    countDriveAssets: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
    registerUpload,
    listOrphanedUploads: vi.fn(async () => {
      throw new Error("not used in this test");
    }),
    listUnreferencedUploadsForCode,
    deleteUploads,
  };
  return { repo, registerUpload, listUnreferencedUploadsForCode, deleteUploads };
}

function makeHarness(
  overrides: {
    tickets?: readonly UploadTicket[];
    blobs?: Parameters<typeof makeBlobs>[0];
    media?: Parameters<typeof makeMedia>[0];
    nowMs?: number;
  } = {},
) {
  const tickets = makeTickets(overrides.tickets);
  const blobs = makeBlobs(overrides.blobs);
  const media = makeMedia(overrides.media);
  const logger = makeLogger();
  const clock = makeClock(overrides.nowMs);

  const deps: ConfirmUploadDeps = {
    tickets: tickets.repo,
    blobs: blobs.store,
    media: media.repo,
    clock,
    logger,
  };

  return { deps, tickets, blobs, media, logger };
}

describe("confirmUpload — edge cases first", () => {
  it("throws without a product code", async () => {
    const h = makeHarness();
    await expect(makeConfirmUpload(h.deps)({ tenantId: TENANT, productCode: "", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a request with a duplicate asset id before any ticket lookup", async () => {
    const h = makeHarness();
    await expect(
      makeConfirmUpload(h.deps)({
        tenantId: TENANT,
        productCode: "MG0AD6112",
        assets: [{ assetId: "a1" }, { assetId: "a1" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "DUPLICATE_ASSET_ID" } });
    expect(h.tickets.findMany).not.toHaveBeenCalled();
  });

  it("refuses a file that has no ticket", async () => {
    const h = makeHarness({ tickets: [] });
    await expect(makeConfirmUpload(h.deps)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("treats a ticket belonging to another tenant as absent", async () => {
    const h = makeHarness({ tickets: [ticket("a1", { tenantId: OTHER_TENANT })] });
    await expect(makeConfirmUpload(h.deps)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    // No ticket was ever found for THIS tenant, so there is no storageKey to
    // clean up — the wrong-tenant row must never be touched.
    expect(h.blobs.deleteStaging).not.toHaveBeenCalled();
  });

  it("refuses an expired ticket, then removes its staged object and ticket row", async () => {
    const h = makeHarness({ tickets: [ticket("a1", { expiresAt: new Date(Date.now() - 1000) })] });
    await expect(makeConfirmUpload(h.deps)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(h.blobs.deleteStaging).toHaveBeenCalledTimes(1);
    expect(h.blobs.deleteStaging).toHaveBeenCalledWith({ tenantId: TENANT, storageKey: `${TENANT}/a1` });
    // Critical regression guard: a refused file lives ONLY in staging.
    // `delete` (serving-only) must never be called for it — calling it would
    // silently no-op and leak the object forever.
    expect(h.blobs.delete).not.toHaveBeenCalled();
  });

  it("refuses a file whose object never reached storage", async () => {
    const h = makeHarness({ blobs: { staging: {} } });
    await expect(makeConfirmUpload(h.deps)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses an empty staged object", async () => {
    const h = makeHarness({ blobs: { staging: { [`${TENANT}/a1`]: { sizeBytes: 0 } } } });
    await expect(makeConfirmUpload(h.deps)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses a staged object above the 25MB cap", async () => {
    const h = makeHarness({ blobs: { staging: { [`${TENANT}/a1`]: { sizeBytes: 26 * 1024 * 1024 } } } });
    await expect(makeConfirmUpload(h.deps)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("deletes the staged object and never promotes when content contradicts the declared mime", async () => {
    const h = makeHarness({ blobs: { content: { [`${TENANT}/a1`]: EXE } } });
    await expect(makeConfirmUpload(h.deps)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(h.blobs.promote).not.toHaveBeenCalled();
    expect(h.blobs.deleteStaging).toHaveBeenCalledTimes(1);
    expect(h.blobs.deleteStaging).toHaveBeenCalledWith({ tenantId: TENANT, storageKey: `${TENANT}/a1` });
    // The proof that matters: the byte is actually gone from staging, not
    // just that some `delete`-shaped function was invoked once.
    expect(h.blobs.stagingStore.has(`${TENANT}/a1`)).toBe(false);
  });

  it("uses statStaging rather than stat — the object is never in the serving area yet", async () => {
    const h = makeHarness();
    const result = await makeConfirmUpload(h.deps)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] });
    expect(result.accepted).toHaveLength(1);
    expect(h.blobs.statStaging).toHaveBeenCalled();
    expect(h.blobs.stat).not.toHaveBeenCalled();
  });

  it("logs and surfaces a warning when the order is malformed, keeping the original arrangement", async () => {
    const h = makeHarness({
      tickets: [ticket("a1"), ticket("a2")],
      blobs: {
        staging: {
          [`${TENANT}/a1`]: { sizeBytes: 8 },
          [`${TENANT}/a2`]: { sizeBytes: 8 },
        },
      },
    });
    const result = await makeConfirmUpload(h.deps)({
      tenantId: TENANT,
      productCode: "MG0AD6112",
      assets: [{ assetId: "a1" }, { assetId: "a2" }],
      // Duplicate index: not a permutation, so the fallback must trigger.
      order: [0, 0],
    });
    expect(result.accepted.map((a) => a.driveFileId)).toEqual(["a1", "a2"]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(h.logger.warn).toHaveBeenCalledWith(
      "Confirm ignored a malformed upload order and kept the original arrangement",
      expect.objectContaining({ reason: "UPLOAD_ORDER_INVALID" }),
    );
  });

  it("a batch with one good file and one bad file reports the bad one and accepts the good one", async () => {
    const h = makeHarness({
      tickets: [ticket("a1"), ticket("a2")],
      // Only a1 ever reached staging; a2's object never arrived.
      blobs: { staging: { [`${TENANT}/a1`]: { sizeBytes: 8 } } },
    });
    const result = await makeConfirmUpload(h.deps)({
      tenantId: TENANT,
      productCode: "MG0AD6112",
      assets: [{ assetId: "a1" }, { assetId: "a2" }],
    });
    expect(result.accepted.map((a) => a.driveFileId)).toEqual(["a1"]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ fileName: "a2.png", reason: "UNSUPPORTED_TYPE" }),
    ]);
    expect(h.blobs.promote).toHaveBeenCalledTimes(1);
    expect(h.blobs.promote).toHaveBeenCalledWith({ tenantId: TENANT, assetId: "a1" });
    expect(h.blobs.deleteStaging).toHaveBeenCalledTimes(1);
    expect(h.blobs.deleteStaging).toHaveBeenCalledWith({ tenantId: TENANT, storageKey: `${TENANT}/a2` });
  });

  it("happy path: promotes then registers, sequence follows the order", async () => {
    const h = makeHarness({
      tickets: [ticket("a1"), ticket("a2")],
      blobs: {
        staging: {
          [`${TENANT}/a1`]: { sizeBytes: 8 },
          [`${TENANT}/a2`]: { sizeBytes: 8 },
        },
      },
    });
    const result = await makeConfirmUpload(h.deps)({
      tenantId: TENANT, productCode: "MG0AD6112",
      assets: [{ assetId: "a1" }, { assetId: "a2" }], order: [1, 0],
    });
    expect(result.accepted.map((a) => a.driveFileId)).toEqual(["a2", "a1"]);
    expect(result.accepted.map((a) => a.sequence)).toEqual([1, 2]);
    expect(result.warnings).toEqual([]);
  });

  it("rolls back the promoted object when registerUpload fails", async () => {
    const h = makeHarness({ media: { registerError: new Error("db down") } });
    await expect(makeConfirmUpload(h.deps)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "DB_ERROR" });
    // Post-promote rollback is `delete` (serving), never `deleteStaging` — by
    // this point the object really is in the serving prefix.
    expect(h.blobs.delete).toHaveBeenCalledTimes(1);
    expect(h.blobs.delete).toHaveBeenCalledWith({ tenantId: TENANT, storageKey: `${TENANT}/a1` });
    expect(h.blobs.servingStore.has(`${TENANT}/a1`)).toBe(false);
  });

  it("logs the rollback's own failure instead of silently reporting blob_rolled_back: false", async () => {
    const h = makeHarness({ media: { registerError: new Error("db down") } });
    h.blobs.delete.mockRejectedValueOnce(new Error("minio said 403"));
    await expect(makeConfirmUpload(h.deps)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "DB_ERROR", context: expect.objectContaining({ blob_rolled_back: false }) });
    expect(h.logger.error).toHaveBeenCalledWith(
      "Could not roll back a promoted object after its row failed to register",
      expect.objectContaining({ context: expect.objectContaining({ reason: "PROMOTE_ROLLBACK_FAILED" }) }),
    );
  });

  it("discards the previous upload batch of the same code", async () => {
    const previous: OrphanedUpload[] = [
      { tenantId: TENANT, assetId: "old1", storageKey: `${TENANT}/old1`, fileName: "old1.png", sizeBytes: 8 },
    ];
    const h = makeHarness({ media: { previous } });
    await makeConfirmUpload(h.deps)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] });
    expect(h.media.deleteUploads).toHaveBeenCalledTimes(1);
    // A previously-registered upload's bytes are already in the SERVING
    // area, so this cleanup must use `delete`, not `deleteStaging`.
    expect(h.blobs.delete).toHaveBeenCalledWith({ tenantId: TENANT, storageKey: `${TENANT}/old1` });
  });
});
