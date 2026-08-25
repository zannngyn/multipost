import { describe, expect, it } from "vitest";

import {
  makeFixtureDriveSource,
  makeFixtureSheetSource,
} from "@/adapters/google/fixture-catalog-source";
import { makeFieldMap, type StockPolicy } from "@/core/domain/catalog-field-map";
import { AppError } from "@/core/domain/errors";
import { SHEET_COLUMNS } from "@/core/domain/product";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { DriveFile, DriveSource } from "@/core/ports/drive-source";
import type { LogContext, Logger } from "@/core/ports/infra";
import type { SheetSnapshot, SheetSource } from "@/core/ports/sheet-source";

import {
  makeProfileCatalogSource,
  PROFILE_DRIVE_SAMPLE_LIMIT,
} from "./profile-catalog-source";

const TENANT = testTenantId("00000000-0000-0000-0000-0000000000f1");
const SHEET_NAME = "Mẫu 2026";
const SPREADSHEET = "spreadsheet-1";

interface Recorded {
  level: string;
  message: string;
  context?: LogContext;
}

function makeLogger(sink: Recorded[] = []): Logger & { entries: Recorded[] } {
  const logger = {
    entries: sink,
    child: () => logger,
    debug: (message: string, context?: LogContext) =>
      void sink.push({ level: "debug", message, context }),
    info: (message: string, context?: LogContext) =>
      void sink.push({ level: "info", message, context }),
    warn: (message: string, context?: LogContext) =>
      void sink.push({ level: "warn", message, context }),
    error: (message: string, context?: LogContext) =>
      void sink.push({ level: "error", message, context }),
  } as Logger & { entries: Recorded[] };
  return logger;
}

function stubSheet(snapshot: SheetSnapshot | Error): SheetSource {
  return {
    readRows: async () => {
      if (snapshot instanceof Error) throw snapshot;
      return snapshot;
    },
  };
}

function stubDrive(names: string[] | Error): DriveSource {
  return {
    listFiles: async ({ maxFiles }) => {
      if (names instanceof Error) throw names;
      const files: DriveFile[] = names.map((name, index) => ({
        id: `file-${index}`,
        name,
        mimeType: "image/jpeg",
        sizeBytes: 1000,
        modifiedTime: "2026-08-01T00:00:00.000Z",
      }));
      return maxFiles && maxFiles > 0 ? files.slice(0, maxFiles) : files;
    },
    download: async () => {
      throw new Error("download must not be called by the profiler");
    },
  };
}

function snapshotOf(
  columns: string[],
  rows: Array<Record<string, string>>,
  duplicateColumns: string[] = [],
): SheetSnapshot {
  return {
    columns,
    duplicateColumns,
    rows: rows.map((values, index) => ({ rowNumber: index + 2, values })),
  };
}

const CUSTOMER_COLUMNS = ["SKU", "Product name", "Qty", "Ghi chú", "Giá bán"];
const CUSTOMER_MAP = makeFieldMap({
  code: "SKU",
  name: "Product name",
  stock: "Qty",
  note: "Ghi chú",
});

describe("profileCatalogSource — edge cases first", () => {
  it.each(["", "   ", "not-a-uuid"])("rejects tenantId '%s'", async (tenantId) => {
    const profile = makeProfileCatalogSource({
      sheet: stubSheet(snapshotOf([], [])),
      logger: makeLogger(),
    });
    await expect(
      profile({ tenantId: tenantId as never, spreadsheetId: SPREADSHEET, sheetName: SHEET_NAME }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a missing spreadsheet id", async () => {
    const profile = makeProfileCatalogSource({
      sheet: stubSheet(snapshotOf([], [])),
      logger: makeLogger(),
    });
    await expect(
      profile({ tenantId: TENANT, spreadsheetId: "  ", sheetName: SHEET_NAME }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a missing sheet name", async () => {
    const profile = makeProfileCatalogSource({
      sheet: stubSheet(snapshotOf([], [])),
      logger: makeLogger(),
    });
    await expect(
      profile({ tenantId: TENANT, spreadsheetId: SPREADSHEET, sheetName: "" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("propagates a sheet failure — there is no report without the sheet", async () => {
    const entries: Recorded[] = [];
    const profile = makeProfileCatalogSource({
      sheet: stubSheet(
        new AppError("SHEET_ERROR", { message: "boom", userMessage: "Không đọc được Sheet." }),
      ),
      logger: makeLogger(entries),
    });

    await expect(
      profile({ tenantId: TENANT, spreadsheetId: SPREADSHEET, sheetName: SHEET_NAME }),
    ).rejects.toMatchObject({ code: "SHEET_ERROR" });
    expect(entries.some((entry) => entry.level === "error")).toBe(true);
  });

  it("reports an empty header row as a warning instead of throwing", async () => {
    const profile = makeProfileCatalogSource({
      sheet: stubSheet(snapshotOf([], [])),
      logger: makeLogger(),
    });
    const report = await profile({
      tenantId: TENANT,
      spreadsheetId: SPREADSHEET,
      sheetName: SHEET_NAME,
    });

    expect(report.sheet.columns).toEqual([]);
    expect(report.sheet.productsParsed).toBe(0);
    expect(report.warnings.join(" ")).toContain(SHEET_NAME);
    expect(report.media).toBeNull();
    expect(report.crossCheck).toBeNull();
  });

  it("warns about a duplicated header", async () => {
    const profile = makeProfileCatalogSource({
      sheet: stubSheet(snapshotOf(CUSTOMER_COLUMNS, [], ["SKU"])),
      logger: makeLogger(),
    });
    const report = await profile({
      tenantId: TENANT,
      spreadsheetId: SPREADSHEET,
      sheetName: SHEET_NAME,
    });
    expect(report.warnings.join(" ")).toContain("'SKU'");
  });

  it("keeps the sheet half when Drive cannot be read", async () => {
    const entries: Recorded[] = [];
    const profile = makeProfileCatalogSource({
      sheet: stubSheet(
        snapshotOf(CUSTOMER_COLUMNS, [
          { SKU: "MGKVX6310", "Product name": "Giannal", Qty: "104", "Giá bán": "890.000" },
        ]),
      ),
      drive: stubDrive(new AppError("DRIVE_ERROR", { message: "no access" })),
      logger: makeLogger(entries),
    });

    const report = await profile({
      tenantId: TENANT,
      spreadsheetId: SPREADSHEET,
      sheetName: SHEET_NAME,
      driveFolderId: "folder-1",
      fieldMap: CUSTOMER_MAP,
    });

    expect(report.sheet.productsParsed).toBe(1);
    expect(report.media).toBeNull();
    expect(report.crossCheck).toBeNull();
    expect(report.warnings.join(" ")).toContain("Drive");
    // Not swallowed: the failure is logged with its error code.
    expect(
      entries.some((entry) => entry.level === "warn" && entry.context?.error_code === "DRIVE_ERROR"),
    ).toBe(true);
  });

  it("skips the media section when no folder is given", async () => {
    const profile = makeProfileCatalogSource({
      sheet: stubSheet(snapshotOf(CUSTOMER_COLUMNS, [])),
      drive: stubDrive([]),
      logger: makeLogger(),
    });
    const report = await profile({
      tenantId: TENANT,
      spreadsheetId: SPREADSHEET,
      sheetName: SHEET_NAME,
    });
    expect(report.media).toBeNull();
    expect(report.crossCheck).toBeNull();
  });
});

describe("profileCatalogSource — the mapping it proposes", () => {
  it("suggests a map for a sheet nobody has configured yet", async () => {
    const profile = makeProfileCatalogSource({
      sheet: stubSheet(snapshotOf(CUSTOMER_COLUMNS, [])),
      logger: makeLogger(),
    });
    const report = await profile({
      tenantId: TENANT,
      spreadsheetId: SPREADSHEET,
      sheetName: SHEET_NAME,
    });

    expect(report.fieldMap.source).toBe("suggested");
    expect(report.fieldMap.fieldMap).toMatchObject({ code: "SKU", name: "Product name", stock: "Qty" });
    expect(report.fieldMap.priceLikeColumns).toContain("Giá bán");
    expect(report.fieldMap.issues).toEqual([]);
  });

  it("uses the caller's map when one is supplied, and validates it", async () => {
    const profile = makeProfileCatalogSource({
      sheet: stubSheet(snapshotOf(CUSTOMER_COLUMNS, [])),
      logger: makeLogger(),
    });
    const report = await profile({
      tenantId: TENANT,
      spreadsheetId: SPREADSHEET,
      sheetName: SHEET_NAME,
      fieldMap: makeFieldMap({ code: "SKU", name: "Product name", stock: "Kho" }),
    });

    expect(report.fieldMap.source).toBe("tenant");
    expect(report.fieldMap.issues.map((issue) => issue.code)).toContain(
      "FIELD_MAP_COLUMN_NOT_FOUND",
    );
  });

  it("groups rejected rows with examples instead of listing them all", async () => {
    const rows = [
      { SKU: "", "Product name": "A", Qty: "1" },
      { SKU: "??", "Product name": "B", Qty: "1" },
      { SKU: "MGKVX6310", "Product name": "", Qty: "1" },
      { SKU: "", "Product name": "", Qty: "" },
    ];
    const profile = makeProfileCatalogSource({
      sheet: stubSheet(snapshotOf(CUSTOMER_COLUMNS, rows)),
      logger: makeLogger(),
    });
    const report = await profile({
      tenantId: TENANT,
      spreadsheetId: SPREADSHEET,
      sheetName: SHEET_NAME,
      fieldMap: CUSTOMER_MAP,
    });

    expect(report.sheet.totalRows).toBe(4);
    expect(report.sheet.emptyRows).toBe(1);
    expect(report.sheet.rowsRejected).toBe(3);
    expect(report.sheet.rejectionGroups.map((group) => group.reason).sort()).toEqual([
      "MALFORMED_CODE",
      "MISSING_CODE",
      "MISSING_NAME",
    ]);
    expect(report.topIssues[0]?.detail.length).toBeGreaterThan(0);
  });
});

describe("profileCatalogSource — cross-check and 'đăng được ngay'", () => {
  const rows = [
    { SKU: "MGKVX6310", "Product name": "Giannal", Qty: "104", "Ghi chú": "Không cần cọc" },
    { SKU: "MGKAD6045", "Product name": "Claires", Qty: "157", "Ghi chú": "Không nhận sx 1c" },
    { SKU: "MG0VS6111", "Product name": "Pavly", Qty: "3", "Ghi chú": "Không nhận sx 1c" },
    { SKU: "MG0AC6017", "Product name": "Maelis", Qty: "0", "Ghi chú": "HẾT HÀNG" },
    { SKU: "MR0AC6080", "Product name": "Penny", Qty: "0", "Ghi chú": "HẾT HÀNG" },
    { SKU: "MG0SQ6026", "Product name": "Không ảnh", Qty: "10", "Ghi chú": "" },
  ];
  const files = [
    "MGKVX6310-KEM (1).png",
    "MGKAD6045-XANH (2).jpg",
    "MG0VS6111-KEM (3).jpg",
    "MG0AC6017-ĐỎ (1).jpg",
    "MR0AC6080-TRẮNG (1).jpg",
    "MRKVX9999-KEM (1).jpg",
    "IMG_1664.JPG",
  ];

  async function run(stockPolicy?: StockPolicy) {
    const profile = makeProfileCatalogSource({
      sheet: stubSheet(snapshotOf(CUSTOMER_COLUMNS, rows)),
      drive: stubDrive(files),
      logger: makeLogger(),
    });
    return profile({
      tenantId: TENANT,
      spreadsheetId: SPREADSHEET,
      sheetName: SHEET_NAME,
      driveFolderId: "folder-1",
      fieldMap: CUSTOMER_MAP,
      stockPolicy: stockPolicy ?? null,
    });
  }

  it("counts codes on both sides, and only the postable ones as postable", async () => {
    const report = await run();
    expect(report.crossCheck).toMatchObject({
      codesInSheet: 6,
      codesInDrive: 6,
      codesInBoth: 5,
      codesOnlyInSheet: 1,
      codesOnlyInDrive: 1,
      blockedByInventory: 2,
      postableNow: 3,
      stockCheckSkipped: false,
    });
    expect(report.crossCheck?.postableSample).toEqual(["MG0VS6111", "MGKAD6045", "MGKVX6310"]);
  });

  it("keeps 'HẾT HÀNG' blocked even when the tenant turned the stock check off", async () => {
    const report = await run({
      mode: "disabled",
      reason: "Khách quản lý tồn trên phần mềm riêng",
    });
    expect(report.stockPolicyMode).toBe("disabled");
    expect(report.crossCheck).toMatchObject({
      blockedByInventory: 2,
      postableNow: 3,
      stockCheckSkipped: true,
    });
  });

  it("reports media parsing without rejecting the folder", async () => {
    const report = await run();
    expect(report.media).toMatchObject({
      sampled: 7,
      nameParsed: 6,
      nameRejected: 1,
      capped: false,
      distinctCodes: 6,
    });
    expect(report.media?.parseRate).toBeCloseTo(0.857, 3);
    expect(report.media?.issueGroups[0]).toMatchObject({ reason: "NO_PRODUCT_CODE", count: 1 });
    expect(report.media?.issueGroups[0]?.examples).toContain("IMG_1664.JPG");
  });
});

describe("profileCatalogSource — real sample data (docs/05)", () => {
  const deps = () => ({
    sheet: makeFixtureSheetSource(),
    drive: makeFixtureDriveSource(),
    logger: makeLogger(),
  });

  it("profiles the real sheet with the map it infers from the real headers", async () => {
    const profile = makeProfileCatalogSource(deps());
    const report = await profile({
      tenantId: TENANT,
      spreadsheetId: SPREADSHEET,
      sheetName: SHEET_NAME,
    });

    expect(report.fieldMap.source).toBe("suggested");
    expect(report.fieldMap.fieldMap.code).toBe(SHEET_COLUMNS.code);
    expect(report.fieldMap.fieldMap.stock).toBe(SHEET_COLUMNS.stock);
    // docs/05 section 2.1: 301 rows carry a code, 299 codes are unique.
    expect(report.sheet.productsParsed).toBe(299);
    expect(report.sheet.duplicateCodes).toBe(2);
    // docs/05 section 2.5 lists MGKSQ6031 as the only conflict and calls
    // MRKSQ6066 "hai dòng giống hệt nhau". The real export disagrees: the two
    // MRKSQ6066 rows carry different `Mô tả sản phẩm`, so the parser blocks it
    // too. Asserted as measured, not as documented.
    expect(report.sheet.conflictingCodes).toEqual(["MGKSQ6031", "MRKSQ6066"]);
    expect(report.fieldMap.priceLikeColumns).toContain("Giá TMĐT");
  });

  it("caps the Drive sample and says so", async () => {
    const profile = makeProfileCatalogSource(deps());
    const report = await profile({
      tenantId: TENANT,
      spreadsheetId: SPREADSHEET,
      sheetName: SHEET_NAME,
      driveFolderId: "folder-1",
    });

    expect(report.media?.sampled).toBe(PROFILE_DRIVE_SAMPLE_LIMIT);
    expect(report.media?.capped).toBe(true);
    expect(report.warnings.join(" ")).toContain(String(PROFILE_DRIVE_SAMPLE_LIMIT));
    // The off-standard names of docs/05 section 1.2 stay usable, not rejected:
    // 827 of the first 1,000 listed files still yield a product code.
    expect(report.media?.nameParsed ?? 0).toBeGreaterThan(700);
    expect(report.media?.parseRate ?? 0).toBeGreaterThan(0.7);
    expect(report.media?.strictNames ?? 0).toBeGreaterThan(0);
    expect(report.crossCheck?.postableNow ?? -1).toBeGreaterThanOrEqual(0);
  });
});
