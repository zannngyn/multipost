import { describe, expect, it } from "vitest";

import { DEFAULT_STOCK_POLICY, MYSP_FIELD_MAP } from "@/core/domain/catalog-field-map";
import { AppError } from "@/core/domain/errors";
import type { MediaAsset, Product } from "@/core/domain/product";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { CatalogFileStore } from "@/core/ports/catalog-file-store";
import type { CatalogSourceRef, CatalogTextSource } from "@/core/ports/catalog-text-source";
import type { CatalogConfigRepo, CatalogSourceConfig, DriveSource } from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";
import type {
  FinishSyncRunInput,
  MediaRepo,
  ProductRepo,
  SyncRunRepo,
} from "@/core/ports/product-repo";
import type { SheetSource } from "@/core/ports/sheet-source";

import { makeSyncCatalog } from "../sync-catalog";

/**
 * Onboarding phase 3 — a tenant whose product table is an uploaded CSV.
 *
 * The point of these tests is that NOTHING below the read changes: the same
 * field map, the same row parser, the same stock column, the same persist path.
 * What is new is only "where did the table come from", plus the failure modes
 * that come with a file (bytes gone, no reader wired, no photo folder).
 */

const TENANT = testTenantId("00000000-0000-0000-0000-0000000000f1");

/** The real thing a Vietnamese Excel export looks like: `;` and a BOM. */
const CSV_BYTES = new TextEncoder().encode(
  "﻿Mã sản phẩm;Tên sản phẩm;Mô tả sản phẩm;Chủng loại;Mùa vụ;Tồn;Lưu ý nhận sx 1c / sx hết tồn;Màu sắc\r\n" +
    'MGKVX6310;Giannal;"Váy dáng xoè, tay lỡ";Váy;Xuân hè 2026;104;Không nhận sx 1c;"KEM, HỒNG"\r\n' +
    "MGKSQ6031;Sonata;Áo sơ mi;Áo;Xuân hè 2026;0;;TRẮNG\r\n",
);

const FILE_CONFIG: CatalogSourceConfig = {
  driveFolderId: "folder-1",
  spreadsheetId: "",
  sheetName: "",
  textSource: {
    kind: "file",
    storageKey: `${TENANT}/catalog_abc`,
    fileName: "bang-gia.csv",
    contentType: "text/csv",
    uploadedAt: "2026-08-24T10:00:00.000Z",
  },
};

function makeLogger(lines: { level: string; message: string; context?: unknown }[] = []): Logger {
  const make = (): Logger => ({
    child: () => make(),
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  });
  return make();
}

interface HarnessOptions {
  config?: CatalogSourceConfig;
  /** Absent = the store answers with CSV_BYTES; null = the file is gone. */
  storedBytes?: Uint8Array | null;
  /** false = this process has no CSV reader wired. */
  withCsvSource?: boolean;
  driveFiles?: { id: string; name: string }[];
  existingProducts?: number;
  existingMedia?: number;
}

function harness(options: HarnessOptions = {}) {
  const writtenProducts: Product[] = [];
  const writtenMedia: MediaAsset[] = [];
  const finished: FinishSyncRunInput[] = [];
  const deletedStale: string[] = [];
  const lines: { level: string; message: string; context?: unknown }[] = [];
  const sheetCalls: number[] = [];
  const fileStoreReads: string[] = [];

  const drive: DriveSource = {
    listFiles: async () =>
      (options.driveFiles ?? []).map((file) => ({
        id: file.id,
        name: file.name,
        mimeType: "image/jpeg",
        sizeBytes: 1000,
        modifiedTime: "2026-08-01T00:00:00.000Z",
      })),
    download: async () => {
      throw new Error("download must not be called by sync-catalog");
    },
  };

  const sheet: SheetSource = {
    readRows: async () => {
      sheetCalls.push(1);
      // A real tab with its headers and no data rows — an EMPTY snapshot would
      // trip the "missing required columns" gate and prove nothing.
      return {
        columns: ["Mã sản phẩm", "Tên sản phẩm", "Tồn"],
        duplicateColumns: [],
        rows: [],
      };
    },
  };

  const catalogFiles: CatalogFileStore = {
    put: async () => ({ storageKey: "k", sizeBytes: 0 }),
    get: async ({ storageKey }) => {
      fileStoreReads.push(storageKey);
      if (options.storedBytes === null) return null;
      const bytes = options.storedBytes ?? CSV_BYTES;
      // Mirrors the real store: a key of another tenant simply is not there.
      return storageKey.startsWith(`${TENANT}/`) ? { bytes, sizeBytes: bytes.length } : null;
    },
    delete: async () => true,
  };

  // The REAL CSV adapter would be wired here in production; the test uses a
  // stand-in that parses with the same shared reader, so the assertions are
  // about sync-catalog's plumbing, not about the parser (covered elsewhere).
  const csvSource: CatalogTextSource = {
    id: "csv-file",
    canRead: (ref: CatalogSourceRef) => ref.kind === "file",
    readCatalog: async ({ ref }) => {
      if (ref.kind !== "file") throw new Error("wrong ref");
      const { decodeCsvText, parseCsv } = await import("@/shared/csv");
      const { buildCatalogSnapshot } = await import("@/core/domain/catalog-snapshot");
      const decoded = decodeCsvText(ref.bytes);
      const parsed = parseCsv(decoded.text);
      return {
        snapshot: buildCatalogSnapshot(parsed.rows, { firstRowNumber: parsed.firstRowNumber }),
        format: {
          source: "csv-file",
          delimiter: parsed.delimiter,
          encoding: decoded.encoding,
          detected: parsed.delimiterDetected,
        },
        notices: [
          {
            code: "DELIMITER_DETECTED" as const,
            count: 1,
            examples: [parsed.delimiter],
            detail: `Hệ thống đang hiểu file này ngăn cách các cột bằng "${parsed.delimiter}".`,
          },
        ],
      };
    },
  };

  const config = options.config ?? FILE_CONFIG;
  const catalogConfig: CatalogConfigRepo = {
    findCatalogConfig: async () => config,
    findCatalogSource: async () => config,
    findStockPolicy: async () => config.stockPolicy ?? DEFAULT_STOCK_POLICY,
    findFieldMap: async () => config.fieldMap ?? MYSP_FIELD_MAP,
    saveCatalogSource: async () => ({ previous: null }),
  };

  const products: ProductRepo = {
    findByCode: async () => null,
    upsertMany: async (_tenant, items) => {
      writtenProducts.push(...items);
      return items.length;
    },
    deleteStale: async () => {
      deletedStale.push("products");
      return 0;
    },
    countAll: async () => options.existingProducts ?? 0,
  };

  const media: MediaRepo = {
    listByProductCode: async () => [],
    upsertMany: async (_tenant, assets) => {
      writtenMedia.push(...assets);
      return assets.length;
    },
    deleteStale: async () => {
      deletedStale.push("media");
      return 0;
    },
    countDriveAssets: async () => options.existingMedia ?? 0,
    registerUpload: async () => {},
    listOrphanedUploads: async () => [],
    listUnreferencedUploadsForCode: async () => [],
    deleteUploads: async () => 0,
  };

  const syncRuns: SyncRunRepo = {
    start: async () => ({ id: "run-csv" }),
    finish: async (input) => {
      finished.push(input);
    },
    findLatest: async () => null,
    listRecent: async () => {
      throw new Error("listRecent must not be called by sync-catalog");
    },
  };

  const clock: Clock = { now: () => new Date("2026-08-24T12:00:00.000Z"), nowMs: () => 0 };

  return {
    writtenProducts,
    writtenMedia,
    finished,
    deletedStale,
    lines,
    sheetCalls,
    fileStoreReads,
    run: makeSyncCatalog({
      drive,
      sheet,
      catalogSources: options.withCsvSource === false ? [] : [csvSource],
      catalogFiles,
      catalogConfig,
      products,
      media,
      syncRuns,
      clock,
      logger: makeLogger(lines),
    }),
  };
}

/** Edge cases first (CLAUDE.md technical rule 1). */

describe("syncCatalog — uploaded CSV: refusals", () => {
  it("stops with a named reason when the stored file is gone", async () => {
    const h = harness({ storedBytes: null });

    await expect(h.run({ tenantId: TENANT })).rejects.toMatchObject({
      code: "SYNC_FAILED",
      context: { reason: "CATALOG_FILE_MISSING" },
    });
    // Nothing was written and nothing was swept: a missing file is not an
    // empty catalog.
    expect(h.writtenProducts).toEqual([]);
    expect(h.deletedStale).toEqual([]);
  });

  it("names the file in the operator message so they know what to re-upload", async () => {
    const h = harness({ storedBytes: null });
    const error = await h.run({ tenantId: TENANT }).catch((e: unknown) => e as AppError);
    expect((error as AppError).userMessage).toContain("bang-gia.csv");
  });

  it("stops when this process has no reader for a file source", async () => {
    const h = harness({ withCsvSource: false });

    await expect(h.run({ tenantId: TENANT })).rejects.toMatchObject({
      code: "SYNC_FAILED",
      context: { reason: "TEXT_SOURCE_NOT_SUPPORTED" },
    });
    // It must NOT quietly fall back to the Google tab of a tenant that has none.
    expect(h.sheetCalls).toEqual([]);
  });

  it("stops when the stored file config has no storage key", async () => {
    const h = harness({
      config: {
        ...FILE_CONFIG,
        textSource: { kind: "file", storageKey: "  ", fileName: "bang-gia.csv" },
      },
    });

    await expect(h.run({ tenantId: TENANT })).rejects.toMatchObject({
      code: "SYNC_FAILED",
      context: { reason: "TEXT_SOURCE_INVALID" },
    });
  });

  it("keeps the empty-source safety net for a file that parses to nothing", async () => {
    const h = harness({
      storedBytes: new TextEncoder().encode("Mã sản phẩm;Tên sản phẩm\r\n"),
      existingProducts: 120,
    });

    await expect(h.run({ tenantId: TENANT })).rejects.toMatchObject({
      code: "SYNC_SOURCE_EMPTY",
    });
    expect(h.deletedStale).toEqual([]);
  });
});

describe("syncCatalog — uploaded CSV: the happy path is the same path", () => {
  it("parses the tenant's CSV into products with the ordinary field map", async () => {
    const h = harness();

    const result = await h.run({ tenantId: TENANT });

    expect(h.writtenProducts.map((product) => product.content.code)).toEqual([
      "MGKVX6310",
      "MGKSQ6031",
    ]);
    // The quoted comma survived, and the operational half stayed operational.
    expect(h.writtenProducts[0]).toMatchObject({
      content: { name: "Giannal", description: "Váy dáng xoè, tay lỡ", season: "Xuân hè 2026" },
      operational: { stockRaw: "104", colorsRaw: "KEM, HỒNG" },
    });
    // Row numbers point at the line the operator will open in Excel.
    expect(h.writtenProducts[0]?.sourceRows).toEqual([2]);
    expect(result.status === "succeeded" || result.status === "partial").toBe(true);
    // The legacy sheet path was never touched.
    expect(h.sheetCalls).toEqual([]);
  });

  it("shows how the file was read as a visible issue, not as a silent guess", async () => {
    const h = harness();

    const result = await h.run({ tenantId: TENANT });

    const notice = result.issues.find((issue) => issue.errorCode === "CATALOG_FILE_NOTICE");
    expect(notice?.reason).toBe("DELIMITER_DETECTED");
    expect(notice?.detail).toContain(";");
  });

  it("still runs the stock column through the ordinary decision table", async () => {
    const h = harness();
    await h.run({ tenantId: TENANT });

    // `Tồn = 0` is not the sync's business — it is stored verbatim and the
    // stock gate blocks at compose/publish time.
    expect(h.writtenProducts[1]?.operational.stockRaw).toBe("0");
  });

  it("syncs product text only, and says so, when no photo folder is configured", async () => {
    const h = harness({ config: { ...FILE_CONFIG, driveFolderId: "" } });

    const result = await h.run({ tenantId: TENANT });

    const notice = result.issues.find((issue) => issue.errorCode === "MEDIA_SOURCE_ABSENT");
    expect(notice?.reason).toBe("NO_DRIVE_FOLDER");
    expect(h.writtenProducts).toHaveLength(2);
    // Media rows are neither written nor swept by a run that saw no photos.
    expect(h.writtenMedia).toEqual([]);
    expect(h.deletedStale).toEqual(["products"]);
    // And no "Sheet có mã này nhưng Drive chưa có ảnh" for every single product.
    expect(result.issues.filter((issue) => issue.errorCode === "MEDIA_NOT_FOUND")).toEqual([]);
  });

  it("logs which source the run read from", async () => {
    const h = harness();
    await h.run({ tenantId: TENANT });

    const started = h.lines.find((line) => line.message === "Catalog sync started");
    expect(started?.context).toMatchObject({
      text_source_kind: "file",
      text_source: 'file "bang-gia.csv" (tải lên lúc 2026-08-24T10:00:00.000Z)',
    });
  });
});

describe("syncCatalog — a Google tenant is untouched by all of this", () => {
  it("uses the legacy sheet port when nothing else can read a sheet ref", async () => {
    const h = harness({
      config: { driveFolderId: "folder-1", spreadsheetId: "sheet-1", sheetName: "Mẫu 2026" },
      existingProducts: 0,
    });

    const result = await h.run({ tenantId: TENANT });

    expect(h.sheetCalls).toEqual([1]);
    expect(result.counts.productsParsed).toBe(0);
  });

  it("never reads the file store for a sheet tenant", async () => {
    const h = harness({
      config: { driveFolderId: "f", spreadsheetId: "s", sheetName: "Mẫu 2026" },
    });

    await h.run({ tenantId: TENANT });

    expect(h.fileStoreReads).toEqual([]);
  });
});
