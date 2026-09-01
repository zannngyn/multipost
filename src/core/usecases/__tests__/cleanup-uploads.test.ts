import { describe, expect, it, vi } from "vitest";

import type { Clock, Logger } from "@/core/ports/infra";
import type { MediaBlobStore } from "@/core/ports/media-blob-store";
import type { MediaRepo, OrphanedUpload } from "@/core/ports/product-repo";
import type { UploadTicket, UploadTicketRepo } from "@/core/ports/upload-ticket-repo";

import { makeCleanupUploads } from "../cleanup-uploads";
import { testTenantId } from "@/core/domain/tenant-context.testing";

const TENANT_A = testTenantId("00000000-0000-0000-0000-000000000001");
const TENANT_B = testTenantId("00000000-0000-0000-0000-000000000002");
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

function ticket(patch: Partial<UploadTicket> = {}): UploadTicket {
  return {
    tenantId: TENANT_A,
    assetId: "t1",
    storageKey: `${TENANT_A}/t1`,
    fileName: "t1.png",
    declaredMime: "image/png",
    declaredSize: 10,
    productCode: "MG0AD6112",
    expiresAt: new Date(NOW - 10_000),
    ...patch,
  };
}

function harness(
  options: {
    orphans?: OrphanedUpload[];
    deleteBlobError?: unknown;
    deleteRowError?: unknown;
    expiredTickets?: UploadTicket[];
    listExpiredError?: unknown;
    deleteStagingError?: unknown;
    deleteTicketRowError?: unknown;
    ttlHours?: number;
  } = {},
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
    countDriveAssets: async () => 0,
    registerUpload: async () => {},
    listOrphanedUploads,
    listUnreferencedUploadsForCode: async () => [],
    deleteUploads,
  } satisfies MediaRepo;

  // Two SEPARATE sets of "what object exists where" — a mock that answers
  // `true` for every delete call (serving or staging alike) is exactly what
  // hid the delete-vs-deleteStaging bug in the previous task. Seeded from the
  // fixtures so the asset sweep (serving) and the ticket sweep (staging)
  // cannot pass by touching each other's area.
  const serving = new Set(
    (options.orphans ?? []).filter((o) => o.storageKey).map((o) => `${o.tenantId}/${o.storageKey}`),
  );
  const staging = new Set((options.expiredTickets ?? []).map((t) => `${t.tenantId}/${t.storageKey}`));

  const removeBlob = vi.fn(async (input: { tenantId: string; storageKey: string }) => {
    if (options.deleteBlobError) throw options.deleteBlobError;
    return serving.delete(`${input.tenantId}/${input.storageKey}`);
  });
  const removeStagingBlob = vi.fn(async (input: { tenantId: string; storageKey: string }) => {
    if (options.deleteStagingError) throw options.deleteStagingError;
    return staging.delete(`${input.tenantId}/${input.storageKey}`);
  });

  const blobs: MediaBlobStore = {
    put: async () => ({ storageKey: "", sizeBytes: 0 }),
    get: async () => null,
    delete: removeBlob,
    deleteStaging: removeStagingBlob,
    createUploadUrl: async () => {
      throw new Error("not used in this test");
    },
    stat: async () => null,
    statStaging: async () => null,
    readRange: async () => null,
    promote: async () => ({ storageKey: "", sizeBytes: 0 }),
    createDownloadUrl: async () => null,
  };

  const listExpired = vi.fn(async () => {
    if (options.listExpiredError) throw options.listExpiredError;
    return options.expiredTickets ?? [];
  });
  const deleteMany = vi.fn(async (_tenantId: string, assetIds: readonly string[]) => {
    if (options.deleteTicketRowError) throw options.deleteTicketRowError;
    return assetIds.length;
  });
  const tickets: UploadTicketRepo = {
    createMany: async () => 0,
    findMany: async () => [],
    deleteMany,
    listExpired,
  };

  const clock: Clock = { now: () => new Date(NOW), nowMs: () => NOW };

  return {
    listOrphanedUploads,
    deleteUploads,
    removeBlob,
    removeStagingBlob,
    listExpired,
    deleteMany,
    serving,
    staging,
    cleanupUploads: makeCleanupUploads({
      media,
      blobs,
      tickets,
      clock,
      logger: makeLogger(),
      ttlHours: options.ttlHours,
    }),
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

  it("I4: uses the constructor-configured ttlHours when no per-tick override is given", async () => {
    // Mirrors production: the worker's scheduled tick payload is always `{}`
    // (worker/index.ts), so the configured UPLOAD_ORPHAN_TTL_HOURS — passed
    // here as the constructor dep, exactly like container.ts wires it — is
    // the ONLY thing that can move `olderThan` off the 24h fallback.
    const { cleanupUploads, listOrphanedUploads } = harness({ ttlHours: 5 });

    await cleanupUploads({});

    const [input] = listOrphanedUploads.mock.calls[0] as unknown as [
      { olderThan: Date; limit: number },
    ];
    expect(input.olderThan.toISOString()).toBe("2026-08-15T05:00:00.000Z");
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

describe("cleanupUploads — expired presigned-upload tickets", () => {
  it("sweeps expired tickets: staged bytes first, row second", async () => {
    const order: string[] = [];
    const t = ticket();
    const { cleanupUploads, removeStagingBlob, deleteMany } = harness({ expiredTickets: [t] });
    removeStagingBlob.mockImplementation(async () => {
      order.push("blob");
      return true;
    });
    deleteMany.mockImplementation(async () => {
      order.push("ticket");
      return 1;
    });

    const result = await cleanupUploads();

    expect(result.ticketsScanned).toBe(1);
    expect(result.ticketsRemoved).toBe(1);
    expect(order).toEqual(["blob", "ticket"]);
  });

  it("removes ticket bytes from the STAGING area, never the serving one", async () => {
    // An expired ticket's bytes were never confirmed, so they were never
    // promoted — they only ever exist in staging. Seed the SAME key in
    // serving too: a wrong-method bug (calling `delete` instead of
    // `deleteStaging`) would find something to remove there and hide itself.
    const t = ticket();
    const key = `${t.tenantId}/${t.storageKey}`;
    const { cleanupUploads, removeBlob, removeStagingBlob, serving, staging } = harness({
      expiredTickets: [t],
    });
    serving.add(key);

    const result = await cleanupUploads();

    expect(result.ticketsRemoved).toBe(1);
    expect(removeStagingBlob).toHaveBeenCalledWith({ tenantId: t.tenantId, storageKey: t.storageKey });
    expect(removeBlob).not.toHaveBeenCalled();
    expect(staging.has(key)).toBe(false);
    // Untouched: proves the sweep never reached into the serving area.
    expect(serving.has(key)).toBe(true);
  });

  it("scans both an orphaned asset and an expired ticket in the same pass", async () => {
    const t = ticket();
    const { cleanupUploads } = harness({ orphans: [orphan()], expiredTickets: [t] });

    const result = await cleanupUploads();

    expect(result.rowsRemoved).toBe(1);
    expect(result.ticketsRemoved).toBe(1);
  });

  it("groups ticket row deletes per tenant", async () => {
    const { cleanupUploads, deleteMany } = harness({
      expiredTickets: [
        ticket({ tenantId: TENANT_A, assetId: "t1", storageKey: `${TENANT_A}/t1` }),
        ticket({ tenantId: TENANT_A, assetId: "t2", storageKey: `${TENANT_A}/t2` }),
        ticket({ tenantId: TENANT_B, assetId: "t3", storageKey: `${TENANT_B}/t3` }),
      ],
    });

    const result = await cleanupUploads();

    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(result.ticketsRemoved).toBe(3);
  });

  it("one failing ticket does not stop the sweep", async () => {
    const { cleanupUploads, removeStagingBlob } = harness({
      expiredTickets: [
        ticket({ tenantId: TENANT_A, assetId: "t1", storageKey: `${TENANT_A}/t1` }),
        ticket({ tenantId: TENANT_A, assetId: "t2", storageKey: `${TENANT_A}/t2` }),
      ],
      deleteStagingError: new Error("storage down"),
    });

    const result = await cleanupUploads();

    expect(result.ticketsScanned).toBe(2);
    expect(removeStagingBlob).toHaveBeenCalledTimes(2);
    expect(result.ticketsRemoved).toBe(0);
    expect(result.failed).toBe(2);
  });

  it("keeps the ticket row when its staged bytes could not be removed", async () => {
    const { cleanupUploads, deleteMany } = harness({
      expiredTickets: [ticket()],
      deleteStagingError: new Error("bucket unreachable"),
    });

    const result = await cleanupUploads();

    expect(result.ticketsRemoved).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("reports a failed ticket row delete without throwing", async () => {
    const { cleanupUploads } = harness({
      expiredTickets: [ticket()],
      deleteTicketRowError: new Error("db down"),
    });

    const result = await cleanupUploads();

    expect(result.ticketsRemoved).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("does not throw when listing expired tickets fails, and marks the pass as a failed listing, not a clean one", async () => {
    const { cleanupUploads, removeStagingBlob, deleteMany } = harness({
      listExpiredError: new Error("db down"),
    });

    const result = await cleanupUploads();

    expect(result.ticketsScanned).toBe(0);
    expect(result.ticketsRemoved).toBe(0);
    // I5 (small item): `ticketsScanned: 0` alone reads identically to "nothing
    // was expired this pass" — this flag is what tells the two apart.
    expect(result.ticketListFailed).toBe(true);
    expect(removeStagingBlob).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("reports ticketListFailed: false on an ordinary pass with nothing expired", async () => {
    const { cleanupUploads } = harness();

    const result = await cleanupUploads();

    expect(result.ticketsScanned).toBe(0);
    expect(result.ticketListFailed).toBe(false);
  });
});
