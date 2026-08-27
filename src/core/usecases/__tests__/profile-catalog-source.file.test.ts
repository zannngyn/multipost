import { describe, expect, it } from "vitest";

import { makeCsvCatalogTextSource } from "@/adapters/catalog/csv-text-source";
import type { CatalogTextConfig } from "@/core/domain/catalog-text-config";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { CatalogFileStore } from "@/core/ports/catalog-file-store";
import type { Logger } from "@/core/ports/infra";
import type { SheetSource } from "@/core/ports/sheet-source";

import { makeProfileCatalogSource } from "../profile-catalog-source";

/**
 * Onboarding step 2 (the compatibility report) for a tenant with no Google
 * Workspace: the numbers must come from the CSV they uploaded, read by the SAME
 * adapter the later sync uses.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-0000000000d1");
const encoder = new TextEncoder();

const CSV = encoder.encode(
  "Mã hàng;Tên hàng;Số lượng tồn;Ghi chú\r\n" +
    "MGKVX6310;Váy Giannal;104;\r\n" +
    "MGKSQ6031;Áo Sonata;0;\r\n" +
    ";Thiếu mã;5;\r\n",
);

const FILE_CONFIG: CatalogTextConfig = {
  kind: "file",
  storageKey: `${TENANT}/catalog_abc`,
  fileName: "bang-gia.csv",
  uploadedAt: "2026-08-24T10:00:00.000Z",
};

function makeLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}

function deps(options: { bytes?: Uint8Array | null } = {}) {
  const catalogFiles: CatalogFileStore = {
    put: async () => ({ storageKey: "k", sizeBytes: 0 }),
    get: async () => {
      if (options.bytes === null) return null;
      const bytes = options.bytes ?? CSV;
      return { bytes, sizeBytes: bytes.length };
    },
    delete: async () => true,
  };
  const sheet: SheetSource = {
    readRows: async () => {
      throw new Error("the sheet port must not be used for a file source");
    },
  };
  return {
    sheet,
    catalogFiles,
    catalogSources: [makeCsvCatalogTextSource({ logger: makeLogger() })],
    logger: makeLogger(),
  };
}

/** Edge cases first (CLAUDE.md technical rule 1). */

describe("profileCatalogSource — uploaded file", () => {
  it("no longer demands a spreadsheet id from a tenant who has none", async () => {
    const report = await makeProfileCatalogSource(deps())({
      tenantId: TENANT,
      textConfig: FILE_CONFIG,
    });

    expect(report.spreadsheetId).toBe("");
    expect(report.textSource).toEqual(FILE_CONFIG);
  });

  it("still demands one for a Google source", async () => {
    await expect(
      makeProfileCatalogSource(deps())({ tenantId: TENANT, sheetName: "Mẫu 2026" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "spreadsheetId" } });
  });

  it("fails with a named reason when the uploaded file is gone", async () => {
    await expect(
      makeProfileCatalogSource(deps({ bytes: null }))({
        tenantId: TENANT,
        textConfig: FILE_CONFIG,
      }),
    ).rejects.toMatchObject({ context: { reason: "CATALOG_FILE_MISSING" } });
  });

  it("profiles the CSV: columns, suggested map, rejected rows", async () => {
    const report = await makeProfileCatalogSource(deps())({
      tenantId: TENANT,
      textConfig: FILE_CONFIG,
    });

    expect(report.sheet.columns).toEqual(["Mã hàng", "Tên hàng", "Số lượng tồn", "Ghi chú"]);
    expect(report.sheet.productsParsed).toBe(2);
    // The row without a code is reported, not silently dropped.
    expect(report.sheet.rowsRejected).toBe(1);
    expect(report.sheet.rejectionGroups[0]?.reason).toBe("MISSING_CODE");
    // The tenant's own headers are recognised without anybody typing them.
    expect(report.fieldMap.fieldMap).toMatchObject({
      code: "Mã hàng",
      name: "Tên hàng",
      stock: "Số lượng tồn",
      note: "Ghi chú",
    });
  });

  it("tells the operator how the file was understood", async () => {
    const report = await makeProfileCatalogSource(deps())({
      tenantId: TENANT,
      textConfig: FILE_CONFIG,
    });

    expect(report.warnings.some((line) => line.includes("chấm phẩy"))).toBe(true);
  });

  it("counts what is postable today from the file, stock gate included", async () => {
    const report = await makeProfileCatalogSource(deps())({
      tenantId: TENANT,
      textConfig: FILE_CONFIG,
      fieldMap: {
        code: "Mã hàng",
        name: "Tên hàng",
        description: null,
        category: null,
        season: null,
        stock: "Số lượng tồn",
        note: "Ghi chú",
        colors: null,
        mediaLink: null,
      },
    });

    // No Drive folder was given, so there is no media/cross-check section —
    // the sheet half still stands on its own.
    expect(report.media).toBeNull();
    expect(report.crossCheck).toBeNull();
    expect(report.sheet.productsParsed).toBe(2);
  });
});
