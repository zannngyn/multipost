import { describe, expect, it, vi } from "vitest";

import { makeIssueUploadTickets } from "@/core/usecases/issue-upload-tickets";
import type { TenantId } from "@/core/domain/tenant-context";

const TENANT = "11111111-1111-4111-8111-111111111111" as TenantId;
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child() {
    return logger;
  },
};

function deps(overrides: Record<string, unknown> = {}) {
  let n = 0;
  return {
    blobs: {
      createUploadUrl: vi.fn(async ({ assetId }: { assetId: string }) => ({
        postUrl: "https://media.vannt.asia/mysp-media",
        formFields: { key: `staging/${TENANT}/${assetId}` },
        storageKey: `${TENANT}/${assetId}`,
        expiresAt: new Date("2026-08-26T10:30:00Z"),
      })),
    },
    tickets: { createMany: vi.fn(async () => 1) },
    logger,
    newAssetId: () => `upload_${(n += 1)}`,
    ticketTtlSeconds: 1800,
    ...overrides,
  } as never;
}

const png = { fileName: "a.png", mimeType: "image/png", sizeBytes: 100 };

describe("issueUploadTickets — edge cases first", () => {
  it("throws INVALID_INPUT without a product code", async () => {
    await expect(
      makeIssueUploadTickets(deps())({ tenantId: TENANT, productCode: "  ", files: [png] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("throws on an empty file list", async () => {
    await expect(
      makeIssueUploadTickets(deps())({ tenantId: TENANT, productCode: "MG0AD6112", files: [] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses the WHOLE batch above ten files", async () => {
    const files = Array.from({ length: 11 }, (_, i) => ({ ...png, fileName: `${i}.png` }));
    await expect(
      makeIssueUploadTickets(deps())({ tenantId: TENANT, productCode: "MG0AD6112", files }),
    ).rejects.toMatchObject({ context: { reason: "TOO_MANY_FILES" } });
  });

  it("refuses an unknown mime on its own, the other files still get tickets", async () => {
    const result = await makeIssueUploadTickets(deps())({
      tenantId: TENANT,
      productCode: "MG0AD6112",
      files: [png, { fileName: "x.exe", mimeType: "application/x-msdownload", sizeBytes: 10 }],
    });
    expect(result.issued).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({ fileName: "x.exe" });
  });

  // NOTE: the brief's draft version of this test expected the call to
  // RESOLVE with issued=0/rejected=1 for a single, wholly-oversized file.
  // That contradicts its sibling "throws without writing tickets when no
  // file is usable" test (also a single wholly-refused file, same
  // usable.length === 0 path) and the brief's OWN Step-4 usecase code, which
  // unconditionally throws once nothing is usable. Verified: running the
  // brief's implementation verbatim fails the brief's own test. Fixed here to
  // match the sibling test and the stated global rule ("a call where nothing
  // is usable throws") rather than silently diverging behaviour by rejection
  // reason.
  it("refuses an oversized file on its own and never signs it", async () => {
    const d = deps();
    await expect(
      makeIssueUploadTickets(d)({
        tenantId: TENANT,
        productCode: "MG0AD6112",
        files: [{ fileName: "big.png", mimeType: "image/png", sizeBytes: 26 * 1024 * 1024 }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(
      (d as never as { blobs: { createUploadUrl: { mock: { calls: unknown[] } } } }).blobs
        .createUploadUrl.mock.calls,
    ).toHaveLength(0);
  });

  it("throws MIXED_ALBUM_KIND when photos and video are mixed", async () => {
    await expect(
      makeIssueUploadTickets(deps())({
        tenantId: TENANT,
        productCode: "MG0AD6112",
        files: [png, { fileName: "v.mp4", mimeType: "video/mp4", sizeBytes: 100 }],
      }),
    ).rejects.toMatchObject({ context: { reason: "MIXED_ALBUM_KIND" } });
  });

  it("throws without writing tickets when no file is usable", async () => {
    const d = deps();
    await expect(
      makeIssueUploadTickets(d)({
        tenantId: TENANT,
        productCode: "MG0AD6112",
        files: [{ fileName: "x.exe", mimeType: "application/x-msdownload", sizeBytes: 10 }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(
      (d as never as { tickets: { createMany: { mock: { calls: unknown[] } } } }).tickets.createMany
        .mock.calls,
    ).toHaveLength(0);
  });

  it("sourceIndex still points at the right file after an earlier one is refused", async () => {
    const result = await makeIssueUploadTickets(deps())({
      tenantId: TENANT,
      productCode: "MG0AD6112",
      files: [{ fileName: "x.exe", mimeType: "application/x-msdownload", sizeBytes: 10 }, png],
    });
    expect(result.issued).toHaveLength(1);
    expect(result.issued[0].sourceIndex).toBe(1);
  });

  it("two files sharing a name each get their own ticket", async () => {
    const result = await makeIssueUploadTickets(deps())({
      tenantId: TENANT,
      productCode: "MG0AD6112",
      files: [png, { ...png }],
    });
    expect(result.issued.map((t) => t.sourceIndex)).toEqual([0, 1]);
    expect(new Set(result.issued.map((t) => t.assetId)).size).toBe(2);
  });

  it("happy path: writes one ticket per file and returns a postUrl", async () => {
    const d = deps();
    const result = await makeIssueUploadTickets(d)({
      tenantId: TENANT,
      productCode: "mg0ad6112",
      files: [png],
    });
    expect(result.issued[0].postUrl).toBe("https://media.vannt.asia/mysp-media");
    expect(result.issued[0].assetId).toBe("upload_1");
    const call = (
      d as never as { tickets: { createMany: { mock: { calls: unknown[][] } } } }
    ).tickets.createMany.mock.calls[0];
    expect((call[1] as { productCode: string }[])[0].productCode).toBe("MG0AD6112");
  });
});
