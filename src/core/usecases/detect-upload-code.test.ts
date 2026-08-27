import { describe, expect, it, vi } from "vitest";

import { testTenantId } from "@/core/domain/tenant-context.testing";

import { makeDetectUploadCode } from "./detect-upload-code";

const TENANT = testTenantId("11111111-1111-4111-8111-111111111111");

function makeDeps(overrides: Partial<Parameters<typeof makeDetectUploadCode>[0]> = {}) {
  const logger = {
    child: vi.fn(() => logger),
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  } as unknown as Parameters<typeof makeDetectUploadCode>[0]["logger"];
  return {
    products: { findByCode: vi.fn(async () => null) } as never,
    catalogConfig: { findCatalogSource: vi.fn(async () => null) } as never,
    logger,
    ...overrides,
  };
}

describe("detectUploadCode", () => {
  it("matches when every file parses to the same code and the catalog has it", async () => {
    const products = {
      findByCode: vi.fn(async () => ({ content: { code: "BG0SQ6083" } })),
      listCodes: vi.fn(async () => ["BG0SQ6083"]),
    } as never;
    const detect = makeDetectUploadCode(makeDeps({ products }));

    const result = await detect({
      tenantId: TENANT,
      files: [{ fileName: "BG0SQ6083-AI (1).png" }, { fileName: "BG0SQ6083-AI (2).png" }],
    });

    expect(result.verdict).toEqual({ status: "matched", productCode: "BG0SQ6083" });
  });

  it("reports not_found without ever creating a product (spec 8)", async () => {
    const findByCode = vi.fn(async () => null);
    const detect = makeDetectUploadCode(makeDeps({ products: { findByCode } as never }));

    const result = await detect({ tenantId: TENANT, files: [{ fileName: "BG0SQ6083-AI (1).png" }] });

    expect(result.verdict).toEqual({ status: "not_found", productCode: "BG0SQ6083" });
    expect(findByCode).toHaveBeenCalledTimes(1);
  });

  it("offers a candidate the parser refused, so the screen can prefill it", async () => {
    const detect = makeDetectUploadCode(makeDeps());
    const result = await detect({ tenantId: TENANT, files: [{ fileName: "XYZ9999-AI.png" }] });
    expect(result.verdict).toEqual({ status: "not_found", productCode: "XYZ9999" });
  });

  it("says out loud that an unmatched candidate code was GUESSED from the file name", async () => {
    const detect = makeDetectUploadCode(makeDeps());
    const result = await detect({ tenantId: TENANT, files: [{ fileName: "XYZ9999-AI.png" }] });
    expect(result.warnings.join(" ")).toMatch(/đoán/i);
  });

  it("does not call a PARSED code a guess", async () => {
    const detect = makeDetectUploadCode(makeDeps());
    // The parser reads this one confidently; it simply is not in the catalog.
    const result = await detect({ tenantId: TENANT, files: [{ fileName: "BG0SQ6083-AI (1).png" }] });
    expect(result.verdict).toEqual({ status: "not_found", productCode: "BG0SQ6083" });
    expect(result.warnings.join(" ")).not.toMatch(/đoán/i);
  });

  it("answers no_code when nothing usable is in any name", async () => {
    const detect = makeDetectUploadCode(makeDeps());
    const result = await detect({ tenantId: TENANT, files: [{ fileName: "  .png" }] });
    expect(result.verdict).toEqual({ status: "no_code" });
  });

  it("never picks one of two different codes on its own (business rule 5)", async () => {
    const detect = makeDetectUploadCode(makeDeps());
    const result = await detect({
      tenantId: TENANT,
      files: [{ fileName: "BG0SQ6083-AI (1).png" }, { fileName: "BG0SQ6084-AI (1).png" }],
    });
    expect(result.verdict).toEqual({ status: "conflict", codes: ["BG0SQ6083", "BG0SQ6084"] });
  });

  it("prefers a parsed code over a candidate one", async () => {
    const products = { findByCode: vi.fn(async () => ({ content: { code: "BG0SQ6083" } })) } as never;
    const detect = makeDetectUploadCode(makeDeps({ products }));
    const result = await detect({
      tenantId: TENANT,
      files: [{ fileName: "BG0SQ6083-AI (1).png" }, { fileName: "IMG_8821.png" }],
    });
    expect(result.verdict).toEqual({ status: "matched", productCode: "BG0SQ6083" });
  });

  it("refuses a malformed call instead of guessing", async () => {
    const detect = makeDetectUploadCode(makeDeps());
    await expect(
      detect({ tenantId: testTenantId("not-a-uuid"), files: [] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("keeps working when the catalog config cannot be read", async () => {
    const catalogConfig = {
      findCatalogSource: vi.fn(async () => { throw new Error("boom"); }),
    } as never;
    const detect = makeDetectUploadCode(makeDeps({ catalogConfig }));
    const result = await detect({ tenantId: TENANT, files: [{ fileName: "BG0SQ6083-AI (1).png" }] });
    expect(result.verdict.status).toBe("not_found");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
