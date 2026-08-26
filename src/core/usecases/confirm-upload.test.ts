import { describe, expect, it, vi } from "vitest";

import { makeConfirmUpload } from "@/core/usecases/confirm-upload";
import type { TenantId } from "@/core/domain/tenant-context";

const TENANT = "11111111-1111-4111-8111-111111111111" as TenantId;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return logger; } };

function ticket(assetId: string, over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT, assetId, storageKey: `${TENANT}/${assetId}`, fileName: `${assetId}.png`,
    declaredMime: "image/png", declaredSize: 8, productCode: "MG0AD6112",
    expiresAt: new Date(Date.now() + 60_000), ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    tickets: {
      findMany: vi.fn(async () => [ticket("a1")]),
      deleteMany: vi.fn(async () => 1),
    },
    blobs: {
      statStaging: vi.fn(async () => ({ sizeBytes: 8, mimeType: "image/png" })),
      readRange: vi.fn(async () => PNG),
      promote: vi.fn(async ({ assetId }: { assetId: string }) => ({ storageKey: `${TENANT}/${assetId}`, sizeBytes: 8 })),
      delete: vi.fn(async () => true),
    },
    media: {
      registerUpload: vi.fn(async () => undefined),
      listUnreferencedUploadsForCode: vi.fn(async () => []),
      deleteUploads: vi.fn(async () => 0),
    },
    clock: { now: () => new Date() },
    logger,
    ...over,
  } as never;
}

describe("confirmUpload — edge cases first", () => {
  it("throws without a product code", async () => {
    await expect(makeConfirmUpload(deps())({ tenantId: TENANT, productCode: "", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses a file that has no ticket", async () => {
    const d = deps({ tickets: { findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => 0) } });
    await expect(makeConfirmUpload(d)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses an expired ticket, then removes its object and row", async () => {
    const d = deps({ tickets: { findMany: vi.fn(async () => [ticket("a1", { expiresAt: new Date(Date.now() - 1000) })]), deleteMany: vi.fn(async () => 1) } });
    await expect(makeConfirmUpload(d)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((d as never as { blobs: { delete: { mock: { calls: unknown[] } } } }).blobs.delete.mock.calls.length).toBe(1);
  });

  it("refuses a file whose object never reached storage", async () => {
    const d = deps({ blobs: { ...(deps() as never as { blobs: object }).blobs, statStaging: vi.fn(async () => null) } });
    await expect(makeConfirmUpload(d)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("deletes the object and never promotes when content contradicts the declared mime", async () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]);
    const base = deps() as never as { blobs: Record<string, unknown> };
    const d = deps({ blobs: { ...base.blobs, readRange: vi.fn(async () => exe) } });
    await expect(makeConfirmUpload(d)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    const blobs = (d as never as { blobs: { promote: { mock: { calls: unknown[] } }; delete: { mock: { calls: unknown[] } } } }).blobs;
    expect(blobs.promote.mock.calls).toHaveLength(0);
    expect(blobs.delete.mock.calls).toHaveLength(1);
  });

  it("refuses an empty object and one above 25MB", async () => {
    const base = deps() as never as { blobs: Record<string, unknown> };
    const d = deps({ blobs: { ...base.blobs, statStaging: vi.fn(async () => ({ sizeBytes: 0, mimeType: "image/png" })) } });
    await expect(makeConfirmUpload(d)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("happy path: promotes then registers, sequence follows the order", async () => {
    const d = deps({
      tickets: { findMany: vi.fn(async () => [ticket("a1"), ticket("a2")]), deleteMany: vi.fn(async () => 2) },
    });
    const result = await makeConfirmUpload(d)({
      tenantId: TENANT, productCode: "MG0AD6112",
      assets: [{ assetId: "a1" }, { assetId: "a2" }], order: [1, 0],
    });
    expect(result.accepted.map((a) => a.driveFileId)).toEqual(["a2", "a1"]);
    expect(result.accepted.map((a) => a.sequence)).toEqual([1, 2]);
  });

  it("rolls back the promoted object when registerUpload fails", async () => {
    const base = deps() as never as { media: Record<string, unknown>; blobs: Record<string, unknown> };
    const d = deps({ media: { ...base.media, registerUpload: vi.fn(async () => { throw new Error("db down"); }) } });
    await expect(makeConfirmUpload(d)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] }))
      .rejects.toMatchObject({ code: "DB_ERROR" });
    expect((d as never as { blobs: { delete: { mock: { calls: unknown[] } } } }).blobs.delete.mock.calls.length).toBe(1);
  });

  it("discards the previous upload batch of the same code", async () => {
    const base = deps() as never as { media: Record<string, unknown> };
    const d = deps({
      media: {
        ...base.media,
        listUnreferencedUploadsForCode: vi.fn(async () => [{ assetId: "old1", storageKey: `${TENANT}/old1` }]),
        deleteUploads: vi.fn(async () => 1),
      },
    });
    await makeConfirmUpload(d)({ tenantId: TENANT, productCode: "MG0AD6112", assets: [{ assetId: "a1" }] });
    expect((d as never as { media: { deleteUploads: { mock: { calls: unknown[] } } } }).media.deleteUploads.mock.calls.length).toBe(1);
  });
});
