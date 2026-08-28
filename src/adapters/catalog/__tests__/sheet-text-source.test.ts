import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { CatalogSourceRef } from "@/core/ports/catalog-text-source";
import type { Logger } from "@/core/ports/infra";
import type { SheetSnapshot, SheetSource } from "@/core/ports/sheet-source";

import { makeSheetCatalogTextSource } from "../sheet-text-source";

const TENANT = testTenantId("00000000-0000-0000-0000-0000000000c6");

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

function build(snapshot: SheetSnapshot | Error) {
  const sheet: SheetSource = {
    readRows: async () => {
      if (snapshot instanceof Error) throw snapshot;
      return snapshot;
    },
  };
  return makeSheetCatalogTextSource({ sheet, logger: makeLogger() });
}

const SNAPSHOT: SheetSnapshot = {
  columns: ["Mã sản phẩm", "Tên sản phẩm"],
  duplicateColumns: [],
  rows: [{ rowNumber: 2, values: { "Mã sản phẩm": "MGKVX6310", "Tên sản phẩm": "Giannal" } }],
};

const SHEET_REF: CatalogSourceRef = {
  kind: "google_sheet",
  spreadsheetId: "1abc",
  sheetName: "Mẫu 2026",
};

/** Edge cases first (CLAUDE.md technical rule 1). */

describe("makeSheetCatalogTextSource", () => {
  it("claims sheet refs only", () => {
    const source = build(SNAPSHOT);
    expect(source.canRead(SHEET_REF)).toBe(true);
    expect(
      source.canRead({
        kind: "file",
        fileName: "a.csv",
        contentType: "text/csv",
        bytes: new Uint8Array([1]),
      }),
    ).toBe(false);
  });

  it("refuses a ref of the wrong kind with a coded error", async () => {
    await expect(
      build(SNAPSHOT).readCatalog({
        tenantId: TENANT,
        ref: {
          kind: "file",
          fileName: "a.csv",
          contentType: null,
          bytes: new Uint8Array([1]),
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "REF_KIND_MISMATCH" } });
  });

  it("refuses an incomplete sheet ref before calling the sheet", async () => {
    await expect(
      build(SNAPSHOT).readCatalog({
        tenantId: TENANT,
        ref: { kind: "google_sheet", spreadsheetId: " ", sheetName: "Mẫu 2026" },
      }),
    ).rejects.toMatchObject({ context: { reason: "SHEET_REF_INCOMPLETE" } });
  });

  it("lets a SheetSource failure through unchanged — one error shape for the caller", async () => {
    const boom = new AppError("SHEET_ERROR", { message: "sheets.values.get failed" });
    await expect(
      build(boom).readCatalog({ tenantId: TENANT, ref: SHEET_REF }),
    ).rejects.toMatchObject({ code: "SHEET_ERROR" });
  });

  it("returns the snapshot untouched, so a sheet and a CSV are interchangeable", async () => {
    const result = await build(SNAPSHOT).readCatalog({ tenantId: TENANT, ref: SHEET_REF });
    expect(result.snapshot).toEqual(SNAPSHOT);
    expect(result.format).toMatchObject({ source: "google-sheet", delimiter: null });
    expect(result.notices).toEqual([]);
  });

  it("reports a duplicated header and an unreadable header row as notices", async () => {
    const duplicated = await build({
      columns: ["Mã"],
      duplicateColumns: ["Mã"],
      rows: [],
    }).readCatalog({ tenantId: TENANT, ref: SHEET_REF });
    expect(duplicated.notices[0]).toMatchObject({ code: "DUPLICATE_COLUMN", examples: ["Mã"] });

    const headerless = await build({ columns: [], duplicateColumns: [], rows: [] }).readCatalog({
      tenantId: TENANT,
      ref: SHEET_REF,
    });
    expect(headerless.notices.map((notice) => notice.code)).toEqual(["NO_HEADER_ROW"]);
  });
});
