import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STOCK_POLICY,
  makeFieldMap,
  MYSP_FIELD_MAP,
  type StockPolicy,
} from "@/core/domain/catalog-field-map";
import { AppError } from "@/core/domain/errors";
import type { MediaAsset, Product } from "@/core/domain/product";
import type {
  CatalogConfigRepo,
  CatalogSourceConfig,
  DriveFile,
  DriveSource,
} from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";
import type {
  FinishSyncRunInput,
  MediaRepo,
  ProductRepo,
  StartSyncRunInput,
  SyncRunRepo,
} from "@/core/ports/product-repo";
import type { SheetSnapshot, SheetSource } from "@/core/ports/sheet-source";

import { makeSyncCatalog, MAX_ISSUE_EXAMPLES, MAX_STORED_ISSUES } from "./sync-catalog";
import { testTenantId } from "@/core/domain/tenant-context.testing";

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

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

const clock: Clock = { now: () => new Date("2026-08-13T00:00:00.000Z"), nowMs: () => 0 };

function driveFile(name: string, overrides: Partial<DriveFile> = {}): DriveFile {
  return {
    id: `id-${name}`,
    name,
    mimeType: "image/jpeg",
    sizeBytes: 1000,
    modifiedTime: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function sheet(rows: Array<Record<string, string>>, columns?: string[]): SheetSnapshot {
  return {
    columns: columns ?? [
      "Mã sản phẩm",
      "Tên sản phẩm",
      "Mô tả sản phẩm",
      "Chủng loại",
      "Mùa vụ",
      "Tồn",
      "Lưu ý nhận sx 1c / sx hết tồn",
      "Màu sắc",
    ],
    duplicateColumns: [],
    rows: rows.map((values, index) => ({ rowNumber: index + 2, values })),
  };
}

const productRow = (overrides: Record<string, string> = {}) => ({
  "Mã sản phẩm": "MGKVX6310",
  "Tên sản phẩm": "Giannal",
  "Mô tả sản phẩm": "Váy dáng xoè",
  "Chủng loại": "Váy",
  "Mùa vụ": "Xuân hè 2026",
  Tồn: "104",
  "Lưu ý nhận sx 1c / sx hết tồn": "Không nhận sx 1c",
  "Màu sắc": "KEM, HỒNG",
  ...overrides,
});

interface Harness {
  run: ReturnType<typeof makeSyncCatalog>;
  writtenProducts: Product[];
  writtenMedia: MediaAsset[];
  finished: FinishSyncRunInput[];
  logger: Logger;
  /** Which repositories were asked to delete rows the run did not stamp. */
  deletedStale: string[];
}

function makeHarness(options: {
  files?: DriveFile[];
  snapshot?: SheetSnapshot;
  /** Widened to the port type so a test can pass a fieldMap / stockPolicy. */
  config?: CatalogSourceConfig | null;
  driveError?: unknown;
  sheetError?: unknown;
  /** Rows the tenant already has — what an empty source would delete. */
  existingProducts?: number;
  existingMedia?: number;
}): Harness {
  const writtenProducts: Product[] = [];
  const writtenMedia: MediaAsset[] = [];
  const finished: FinishSyncRunInput[] = [];
  const deletedStale: string[] = [];
  const logger = makeLogger();

  const drive: DriveSource = {
    listFiles: async () => {
      if (options.driveError) throw options.driveError;
      return options.files ?? [];
    },
    // sync-catalog never downloads; the port method exists for the media route.
    download: async () => {
      throw new Error("download must not be called by sync-catalog");
    },
  };
  const sheetSource: SheetSource = {
    readRows: async () => {
      if (options.sheetError) throw options.sheetError;
      return options.snapshot ?? sheet([]);
    },
  };
  const catalogConfig: CatalogConfigRepo = {
    findCatalogConfig: async () =>
      options.config === undefined
        ? { driveFolderId: "folder", spreadsheetId: "sheet", sheetName: "Mẫu 2026" }
        : options.config,
    // Not used by the sync; present because the port is one interface.
    findCatalogSource: async () => null,
    findStockPolicy: async () => options.config?.stockPolicy ?? DEFAULT_STOCK_POLICY,
    findFieldMap: async () => options.config?.fieldMap ?? MYSP_FIELD_MAP,
    saveCatalogSource: async () => ({ previous: null }),
  };
  const products: ProductRepo = {
    findByCode: async () => null,
    upsertMany: async (_tenant, items) => {
      writtenProducts.push(...items);
      return items.length;
    },
    // Recorded rather than stubbed to 0: "was it called at all" is the whole
    // question of the empty-source tests below.
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
    // E9 additions; syncing never calls them.
    registerUpload: async () => {},
    listOrphanedUploads: async () => [],
    listUnreferencedUploadsForCode: async () => [],
    deleteUploads: async () => 0,
  };
  const syncRuns: SyncRunRepo = {
    start: async (_input: StartSyncRunInput) => ({ id: "run-1" }),
    finish: async (input) => {
      finished.push(input);
    },
    findLatest: async () => null,
    // Same convention as `drive.download` above: a sync writes history, it never
    // reads it. Returning [] would hide a call that should not exist.
    listRecent: async () => {
      throw new Error("listRecent must not be called by sync-catalog");
    },
  };

  return {
    run: makeSyncCatalog({
      drive,
      sheet: sheetSource,
      catalogConfig,
      products,
      media,
      syncRuns,
      clock,
      logger,
    }),
    writtenProducts,
    writtenMedia,
    finished,
    logger,
    deletedStale,
  };
}

describe("syncCatalog — edge cases first", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed tenant id before touching any source", async () => {
    const harness = makeHarness({});
    await expect(harness.run({ tenantId: testTenantId("not-a-uuid") })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(harness.finished).toHaveLength(0);
  });

  it("fails with SYNC_FAILED when the tenant has no integration row", async () => {
    const harness = makeHarness({ config: null });
    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({
      code: "SYNC_FAILED",
    });
  });

  it("marks the run failed and rethrows when Drive is unreachable", async () => {
    const harness = makeHarness({
      driveError: new AppError("DRIVE_ERROR", { message: "permission denied" }),
      snapshot: sheet([productRow()]),
    });

    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({ code: "DRIVE_ERROR" });
    expect(harness.finished).toHaveLength(1);
    expect(harness.finished[0]).toMatchObject({ status: "failed", errorCode: "DRIVE_ERROR" });
  });

  it("fails when a required column was renamed, instead of guessing by position", async () => {
    const harness = makeHarness({
      snapshot: sheet([{ "Ma san pham": "MGKVX6310" }], ["Ma san pham", "Ten san pham"]),
    });
    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({ code: "SHEET_ERROR" });
    expect(harness.finished[0]).toMatchObject({ status: "failed", errorCode: "SHEET_ERROR" });
  });

  it("records optional schema drift but keeps syncing", async () => {
    const harness = makeHarness({
      snapshot: sheet(
        [{ "Mã sản phẩm": "MGKVX6310", "Tên sản phẩm": "Giannal", Tồn: "5" }],
        ["Mã sản phẩm", "Tên sản phẩm", "Tồn"],
      ),
      files: [driveFile("MGKVX6310-KEM (1).jpg")],
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(result.status).toBe("partial");
    expect(result.schemaDrift).toContain("Lưu ý nhận sx 1c / sx hết tồn");
    expect(result.issues.some((issue) => issue.reason === "COLUMN_MISSING")).toBe(true);
    expect(harness.writtenProducts).toHaveLength(1);
  });

  it("survives an empty sheet and an empty folder", async () => {
    const harness = makeHarness({ snapshot: sheet([]), files: [] });
    const result = await harness.run({ tenantId: TENANT });
    expect(result.status).toBe("succeeded");
    expect(result.counts).toMatchObject({ sheetRowsSeen: 0, driveFilesSeen: 0, productsParsed: 0 });
  });

  it("records a broken sheet row without dropping the good ones", async () => {
    const harness = makeHarness({
      snapshot: sheet([
        productRow(),
        productRow({ "Mã sản phẩm": "MG0VS6111", "Tên sản phẩm": "" }),
        productRow({ "Mã sản phẩm": "MGKAD6045", "Tên sản phẩm": "Claires" }),
      ]),
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(result.counts.sheetRowsRejected).toBe(1);
    expect(result.counts.productsParsed).toBe(2);
    expect(result.status).toBe("partial");
    expect(result.issues.some((issue) => issue.errorCode === "SHEET_ROW_INVALID")).toBe(true);
  });

  it("ignores a completely blank row instead of reporting it as broken", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow(), { "Mã sản phẩm": "", "Tên sản phẩm": "" }]),
    });
    const result = await harness.run({ tenantId: TENANT });
    expect(result.counts.sheetRowsRejected).toBe(0);
    expect(result.status).toBe("succeeded");
  });

  it("flags a code whose two sheet rows disagree", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow(), productRow({ "Tên sản phẩm": "Fioraé" })]),
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(result.counts.productsWithConflict).toBe(1);
    expect(harness.writtenProducts[0].hasConflict).toBe(true);
    expect(result.issues.some((issue) => issue.reason === "DUPLICATE_CODE_CONFLICT")).toBe(true);
  });

  it("records unparseable file names and keeps the rest", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      files: [driveFile("MGKVX6310-KEM (1).jpg"), driveFile("IMG_1664.JPG"), driveFile("1.jpg")],
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(result.counts.mediaRejected).toBe(2);
    expect(result.counts.mediaParsed).toBe(1);
    expect(result.issues.filter((issue) => issue.errorCode === "FILE_NAME_INVALID")).toHaveLength(2);
  });

  it("keeps only the newest file when two ids share a name", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      files: [
        driveFile("MGKVX6310-KEM (1).jpg", { id: "old", modifiedTime: "2026-01-01T00:00:00Z" }),
        driveFile("MGKVX6310-KEM (1).jpg", { id: "new", modifiedTime: "2026-08-01T00:00:00Z" }),
      ],
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(result.counts.mediaDuplicatesDropped).toBe(1);
    expect(harness.writtenMedia.map((asset) => asset.driveFileId)).toEqual(["new"]);
    // Its own code: nothing here needs fixing, so it must not sit next to the
    // files that were dropped for a bad name.
    const duplicates = result.issues.filter((issue) => issue.errorCode === "FILE_DUPLICATE");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].reason).toBe("DUPLICATE_FILE_NAME");
    expect(result.issues.some((issue) => issue.errorCode === "FILE_NAME_INVALID")).toBe(false);
  });

  it("reports codes present on only one side", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow(), productRow({ "Mã sản phẩm": "MR0AC6080" })]),
      files: [driveFile("MGKVX6310-KEM (1).jpg"), driveFile("MGKAD6045-XANH (1).jpg")],
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(result.counts.productsWithoutMedia).toBe(1);
    expect(result.counts.mediaWithoutProduct).toBe(1);
    expect(result.issues.some((issue) => issue.reason === "MEDIA_WITHOUT_SHEET_ROW")).toBe(true);
    expect(result.issues.some((issue) => issue.reason === "SHEET_ROW_WITHOUT_MEDIA")).toBe(true);
  });

  it("keeps an outfit-set photo but lists it for review", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow({ "Mã sản phẩm": "MG0AD6051" })]),
      files: [driveFile("MG0AD6051-MR0CV6068-AI (1).png")],
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(harness.writtenMedia).toHaveLength(1);
    expect(harness.writtenMedia[0].productCode).toBe("MG0AD6051");
    expect(harness.writtenMedia[0].needsReview).toBe(true);
    // The file WAS imported, so it is a review note, not a rejection.
    const review = result.issues.filter((issue) => issue.errorCode === "FILE_NEEDS_REVIEW");
    expect(review).toHaveLength(1);
    expect(review[0].reason).toBe("MULTIPLE_PRODUCT_CODES");
    expect(result.counts.mediaRejected).toBe(0);
  });

  it("caps the stored issues but still counts every one of them", async () => {
    // 250 unparseable names + the sheet row left with no media = 251 issues.
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      files: Array.from({ length: 250 }, (_, index) => driveFile(`IMG_${index}.JPG`)),
    });

    const result = await harness.run({ tenantId: TENANT });

    expect(result.issues).toHaveLength(MAX_STORED_ISSUES);
    expect(result.counts.mediaRejected).toBe(250);
    expect(result.counts.issuesTotal).toBe(251);
    expect(result.counts.issuesTruncated).toBe(true);
    expect(harness.finished[0].counts).toMatchObject({ issuesTotal: 251, issuesTruncated: true });
  });

  it("does not flag truncation when every issue fits", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      files: [driveFile("MGKVX6310-KEM (1).jpg"), driveFile("IMG_1664.JPG")],
    });

    const result = await harness.run({ tenantId: TENANT });

    expect(result.counts.issuesTotal).toBe(result.issues.length);
    expect(result.counts.issuesTruncated).toBe(false);
  });

  it("keeps the issue counters on a failed run", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow({ "Tên sản phẩm": "" })]),
      driveError: new AppError("DRIVE_ERROR", { message: "permission denied" }),
    });

    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({ code: "DRIVE_ERROR" });
    expect(harness.finished[0].counts).toMatchObject({
      issuesTotal: 1,
      issuesTruncated: false,
      driveFilesSeen: 0,
    });
  });
});

describe("syncCatalog — issue codes carry the severity", () => {
  /**
   * Three different situations used to share FILE_NAME_INVALID, which told the
   * operator that a duplicate (nothing to do) was as bad as a dropped file.
   */
  it("splits dropped / duplicate / imported-but-odd into three codes", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow({ "Mã sản phẩm": "MG0AD6051" })]),
      files: [
        driveFile("IMG_1664.JPG"),
        driveFile("MG0AD6051-KEM (1).jpg", { id: "old", modifiedTime: "2026-01-01T00:00:00Z" }),
        driveFile("MG0AD6051-KEM (1).jpg", { id: "new", modifiedTime: "2026-08-01T00:00:00Z" }),
        driveFile("MG0AD6051-MR0CV6068-AI (1).png"),
      ],
    });

    const result = await harness.run({ tenantId: TENANT });
    const codes = new Map(result.issueGroups.map((group) => [group.errorCode, group.count]));

    expect(codes.get("FILE_NAME_INVALID")).toBe(1);
    expect(codes.get("FILE_DUPLICATE")).toBe(1);
    expect(codes.get("FILE_NEEDS_REVIEW")).toBe(1);
  });

  it("counts FILE_DUPLICATE exactly as many times as mediaDuplicatesDropped", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      files: [
        driveFile("MGKVX6310-KEM (1).jpg", { id: "a1", modifiedTime: "2026-01-01T00:00:00Z" }),
        driveFile("MGKVX6310-KEM (1).jpg", { id: "a2", modifiedTime: "2026-02-01T00:00:00Z" }),
        driveFile("MGKVX6310-KEM (1).jpg", { id: "a3", modifiedTime: "2026-03-01T00:00:00Z" }),
        driveFile("MGKVX6310-HỒNG (2).jpg", { id: "b1", modifiedTime: "2026-01-01T00:00:00Z" }),
        driveFile("MGKVX6310-HỒNG (2).jpg", { id: "b2", modifiedTime: "2026-02-01T00:00:00Z" }),
      ],
    });

    const result = await harness.run({ tenantId: TENANT });
    const group = result.issueGroups.find((item) => item.errorCode === "FILE_DUPLICATE");

    expect(result.counts.mediaDuplicatesDropped).toBe(3);
    expect(group?.count).toBe(result.counts.mediaDuplicatesDropped);
  });

  /**
   * KNOWN GAP, pinned rather than papered over: `mediaNeedingReview` counts every
   * kept asset whose name is not strictly compliant (missing sequence, unknown
   * colour, no extension...), while FILE_NEEDS_REVIEW is only raised for names
   * carrying several product codes. The two numbers are therefore NOT equal, and
   * the screen must not present them as the same thing.
   */
  it("does NOT equate mediaNeedingReview with the FILE_NEEDS_REVIEW group", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow({ "Mã sản phẩm": "MG0AD6051" })]),
      files: [
        // Non-strict (no sequence number) but perfectly attributable.
        driveFile("MG0AD6051-KEM.jpg"),
        // Non-strict AND ambiguous -> the only one that raises an issue.
        driveFile("MG0AD6051-MR0CV6068-AI (1).png"),
      ],
    });

    const result = await harness.run({ tenantId: TENANT });
    const group = result.issueGroups.find((item) => item.errorCode === "FILE_NEEDS_REVIEW");

    expect(result.counts.mediaNeedingReview).toBe(2);
    expect(group?.count).toBe(1);
  });
});

describe("syncCatalog — issue groups survive the cap", () => {
  it("counts every issue per code even when only 200 rows are stored", async () => {
    // 250 unparseable names + the sheet row left with no media = 251 issues.
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      files: Array.from({ length: 250 }, (_, index) => driveFile(`IMG_${index}.JPG`)),
    });

    const result = await harness.run({ tenantId: TENANT });
    const groups = new Map(result.issueGroups.map((group) => [group.errorCode, group]));

    expect(result.issues).toHaveLength(MAX_STORED_ISSUES);
    expect(groups.get("FILE_NAME_INVALID")?.count).toBe(250);
    expect(groups.get("MEDIA_NOT_FOUND")?.count).toBe(1);
    // The sum is the exact total, not the stored one.
    expect(result.issueGroups.reduce((sum, group) => sum + group.count, 0)).toBe(
      result.counts.issuesTotal,
    );
    // ...and the groups are what gets persisted, not a derivative of `issues`.
    expect(harness.finished[0].issueGroups).toEqual(result.issueGroups);
  });

  it("keeps at most three examples per code", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      files: Array.from({ length: 10 }, (_, index) => driveFile(`IMG_${index}.JPG`)),
    });

    const result = await harness.run({ tenantId: TENANT });
    const group = result.issueGroups.find((item) => item.errorCode === "FILE_NAME_INVALID");

    expect(group?.count).toBe(10);
    expect(group?.examples).toHaveLength(MAX_ISSUE_EXAMPLES);
    expect(group?.examples[0].ref).toBe("IMG_0.JPG");
  });

  it("puts the biggest group first so the most valuable fix is on top", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow(), productRow({ "Mã sản phẩm": "MR0AC6080" })]),
      files: [driveFile("IMG_1.JPG"), driveFile("IMG_2.JPG"), driveFile("IMG_3.JPG")],
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(result.issueGroups[0]).toMatchObject({ errorCode: "FILE_NAME_INVALID", count: 3 });
  });

  it("returns no groups at all for a clean run", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      files: [driveFile("MGKVX6310-KEM (1).jpg")],
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(result.issueGroups).toEqual([]);
    expect(harness.finished[0].issueGroups).toEqual([]);
  });

  it("still writes the groups it had when the run fails", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow({ "Tên sản phẩm": "" })]),
      driveError: new AppError("DRIVE_ERROR", { message: "permission denied" }),
    });

    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({ code: "DRIVE_ERROR" });
    expect(harness.finished[0].issueGroups).toEqual([
      expect.objectContaining({ errorCode: "SHEET_ROW_INVALID", count: 1 }),
    ]);
  });
});

describe("syncCatalog — details are written for the operator", () => {
  /** CLAUDE.md rule 6: logs are English, what the operator reads is Vietnamese. */
  const hasVietnamese = (value: string) => /[ăâđêôơưàáảãạèéẻẽẹìíỉĩịòóỏõọùúủũụỳýỷỹỵ]/i.test(value);

  it("writes every detail in Vietnamese while codes stay machine-readable", async () => {
    const harness = makeHarness({
      snapshot: sheet(
        [
          productRow(),
          productRow({ "Mã sản phẩm": "MG0VS6111", "Tên sản phẩm": "" }),
          productRow({ "Mã sản phẩm": "??" }),
          productRow({ "Mã sản phẩm": "MR0AC6080" }),
          productRow({ "Mã sản phẩm": "" }),
        ],
        [
          "Mã sản phẩm",
          "Tên sản phẩm",
          "Mô tả sản phẩm",
          "Chủng loại",
          "Mùa vụ",
          "Tồn",
          "Màu sắc",
        ],
      ),
      files: [
        driveFile("IMG_1664.JPG"),
        driveFile("DV Huyền Thạch MGAC513 MMQD554.jpg"),
        driveFile("MG0AD6051-MR0CV6068-AI (1).png"),
        driveFile("MGKVX6310-KEM (1).jpg", { id: "old", modifiedTime: "2026-01-01T00:00:00Z" }),
        driveFile("MGKVX6310-KEM (1).jpg", { id: "new", modifiedTime: "2026-08-01T00:00:00Z" }),
      ],
    });

    const result = await harness.run({ tenantId: TENANT });

    expect(result.issues.length).toBeGreaterThan(5);
    for (const issue of result.issues) {
      expect(hasVietnamese(issue.detail), `${issue.errorCode}/${issue.reason}: ${issue.detail}`).toBe(
        true,
      );
      // The machine side stays ASCII upper-case English.
      expect(issue.errorCode).toMatch(/^[A-Z_]+$/);
      expect(issue.reason).toMatch(/^[A-Z_]+$/);
    }
  });

  it("keeps the parameters an operator needs to find the row or the file", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow(), productRow({ "Tên sản phẩm": "Fioraé" })]),
      files: [driveFile("MG0AD6051-MR0CV6068-AI (1).png")],
    });

    const result = await harness.run({ tenantId: TENANT });
    const byReason = new Map(result.issues.map((issue) => [issue.reason, issue.detail]));

    // Conflicting rows: the row numbers are the whole point of the message.
    expect(byReason.get("DUPLICATE_CODE_CONFLICT")).toContain("2");
    expect(byReason.get("DUPLICATE_CODE_CONFLICT")).toContain("3");
    // Outfit set: both codes must appear, or the operator cannot judge it.
    expect(byReason.get("MULTIPLE_PRODUCT_CODES")).toContain("MG0AD6051");
    expect(byReason.get("MULTIPLE_PRODUCT_CODES")).toContain("MR0CV6068");
  });

  it("names the missing column in the detail of a schema drift", async () => {
    const harness = makeHarness({
      snapshot: sheet(
        [{ "Mã sản phẩm": "MGKVX6310", "Tên sản phẩm": "Giannal", Tồn: "5" }],
        ["Mã sản phẩm", "Tên sản phẩm", "Tồn"],
      ),
    });

    const result = await harness.run({ tenantId: TENANT });
    const drift = result.issues.find((issue) => issue.reason === "COLUMN_MISSING");

    expect(drift?.detail).toContain("Mẫu 2026");
    expect(drift?.detail).toContain(drift?.ref ?? "");
  });
});

describe("syncCatalog — happy path", () => {
  it("persists products and media, then closes the run", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      files: [
        driveFile("MGKVX6310-KEM (1).jpg"),
        driveFile("MGKVX6310-Hồng (50).jpeg"),
        driveFile("MGKVX6310-KEM-AI.mp4", { mimeType: "video/mp4" }),
      ],
    });

    const result = await harness.run({ tenantId: TENANT });

    expect(result.status).toBe("succeeded");
    expect(result.counts).toMatchObject({
      driveFilesSeen: 3,
      mediaParsed: 3,
      mediaRejected: 0,
      productsParsed: 1,
      productsWritten: 1,
      mediaWritten: 3,
    });
    expect(harness.writtenMedia.map((asset) => asset.kind)).toEqual(["image", "image", "video"]);
    expect(harness.writtenMedia[1]).toMatchObject({ color: "HỒNG", sequence: 50 });
    expect(harness.finished[0]).toMatchObject({ status: "succeeded", syncRunId: "run-1" });
  });

  it("uses the Drive mime type when the name has no extension", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      files: [driveFile("MGKVX6310-KEM-AI", { mimeType: "video/quicktime" })],
    });

    await harness.run({ tenantId: TENANT });
    expect(harness.writtenMedia[0]).toMatchObject({ kind: "video", needsReview: true });
  });
});


/**
 * The most expensive bug this file guards against: a source that answers
 * "nothing" while the catalog is full, and a `deleteStale` that takes it
 * literally.
 *
 * Drive is the realistic case — `files.list` answers HTTP 200 with `files: []`
 * for a folder the current identity cannot SEE (it does not 403 like
 * `files.get`), so an un-shared folder, or a Google account connected without
 * re-picking the source, reads exactly like "every photo was deleted". The
 * Sheet half is the same story with a renamed/lost tab.
 */
describe("syncCatalog — an empty source must never delete a full catalog", () => {
  it("stops before deleteStale when Drive returns nothing and the tenant has media", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      files: [],
      existingMedia: 5500,
      existingProducts: 40,
    });

    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({
      code: "SYNC_SOURCE_EMPTY",
      context: { empty_sources: ["drive"], drive_files_seen: 0 },
    });

    // The whole point: nothing was deleted, and nothing was written either.
    expect(harness.deletedStale).toEqual([]);
    expect(harness.finished[0]).toMatchObject({
      status: "failed",
      errorCode: "SYNC_SOURCE_EMPTY",
    });
    // Visible on the sync screen, with the numbers that justify the stop.
    const issue = harness.finished[0]?.issues.find((item) => item.errorCode === "SOURCE_EMPTY");
    expect(issue).toMatchObject({ reason: "DRIVE_EMPTY" });
    expect(issue?.detail).toContain("5500");
  });

  it("stops the same way when the Sheet parses to zero products and the tenant has some", async () => {
    const harness = makeHarness({
      snapshot: sheet([]),
      files: [driveFile("MGKVX6310-KEM (1).jpg")],
      existingProducts: 40,
      existingMedia: 5500,
    });

    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({
      code: "SYNC_SOURCE_EMPTY",
      context: { empty_sources: ["sheet"], products_parsed: 0 },
    });
    expect(harness.deletedStale).toEqual([]);
    expect(harness.finished[0]).toMatchObject({
      status: "failed",
      errorCode: "SYNC_SOURCE_EMPTY",
    });
  });

  it("reports BOTH sources when both went empty", async () => {
    const harness = makeHarness({
      snapshot: sheet([]),
      files: [],
      existingProducts: 40,
      existingMedia: 5500,
    });

    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({
      code: "SYNC_SOURCE_EMPTY",
      context: { empty_sources: ["drive", "sheet"] },
    });
    expect(harness.deletedStale).toEqual([]);
  });

  it("does NOT block a brand-new tenant: empty source + empty database is a normal first run", async () => {
    const harness = makeHarness({
      snapshot: sheet([]),
      files: [],
      existingProducts: 0,
      existingMedia: 0,
    });

    const result = await harness.run({ tenantId: TENANT });

    expect(result.status).toBe("succeeded");
    expect(harness.deletedStale).toEqual(["products", "media"]);
  });

  it("still deletes stale rows on a normal run — the guard must not freeze the catalog", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      files: [driveFile("MGKVX6310-KEM (1).jpg")],
      existingProducts: 40,
      existingMedia: 5500,
    });

    const result = await harness.run({ tenantId: TENANT });

    expect(result.status).toBe("succeeded");
    expect(harness.deletedStale).toEqual(["products", "media"]);
  });

  it("deletes nothing when the connection died mid-run (GOOGLE_AUTH_EXPIRED)", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      driveError: new AppError("GOOGLE_AUTH_EXPIRED", { message: "refresh token revoked" }),
      existingProducts: 40,
      existingMedia: 5500,
    });

    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({
      code: "GOOGLE_AUTH_EXPIRED",
    });
    // Locked by a test on purpose: today this holds because the listing throws
    // before the persist block, and that ordering must not be refactored away.
    expect(harness.deletedStale).toEqual([]);
    expect(harness.finished[0]).toMatchObject({
      status: "failed",
      errorCode: "GOOGLE_AUTH_EXPIRED",
    });
  });
});

/**
 * Onboarding phase 1: the same sync driven by a TENANT field map instead of the
 * internal preset. The sheet below shares no column name with ours.
 */
describe("syncCatalog — tenant field map", () => {
  const CUSTOMER_MAP = makeFieldMap({
    code: "SKU",
    name: "Product name",
    description: "Chi tiết",
    stock: "Qty",
    note: "Ghi chú",
    colors: "Color",
  });

  const customerSnapshot = (rows: Array<Record<string, string>>): SheetSnapshot => ({
    columns: ["SKU", "Product name", "Chi tiết", "Qty", "Ghi chú", "Color", "Giá bán"],
    duplicateColumns: [],
    rows: rows.map((values, index) => ({ rowNumber: index + 2, values })),
  });

  const customerRow = (overrides: Record<string, string> = {}) => ({
    SKU: "MGKVX6310",
    "Product name": "Giannal",
    "Chi tiết": "Váy dáng xoè",
    Qty: "104",
    "Ghi chú": "Không nhận sx 1c",
    Color: "KEM, HỒNG",
    "Giá bán": "890.000",
    ...overrides,
  });

  const customerConfig = (extra: Partial<CatalogSourceConfig> = {}): CatalogSourceConfig => ({
    driveFolderId: "folder",
    spreadsheetId: "sheet",
    sheetName: "Danh mục",
    fieldMap: CUSTOMER_MAP,
    ...extra,
  });

  it("stops the run when the map has no code column (never an empty catalog)", async () => {
    const harness = makeHarness({
      config: customerConfig({ fieldMap: makeFieldMap({ name: "Product name" }) }),
      snapshot: customerSnapshot([customerRow()]),
      files: [driveFile("MGKVX6310-KEM (1).png")],
      existingProducts: 40,
    });

    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({ code: "SHEET_ERROR" });
    expect(harness.deletedStale).toEqual([]);
    expect(harness.finished[0]).toMatchObject({ status: "failed", errorCode: "SHEET_ERROR" });
  });

  it("stops the run when two fields claim the same column", async () => {
    const harness = makeHarness({
      config: customerConfig({ fieldMap: makeFieldMap({ code: "SKU", name: "SKU" }) }),
      snapshot: customerSnapshot([customerRow()]),
    });
    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({ code: "SHEET_ERROR" });
  });

  it("stops the run when the stock policy is unusable", async () => {
    const harness = makeHarness({
      config: customerConfig({ stockPolicy: { mode: "disabled", reason: "" } as StockPolicy }),
      snapshot: customerSnapshot([customerRow()]),
    });
    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({ code: "SHEET_ERROR" });
  });

  it("reports drift against the TENANT's columns, not ours", async () => {
    const harness = makeHarness({
      config: customerConfig(),
      snapshot: {
        columns: ["SKU", "Product name", "Qty"],
        duplicateColumns: [],
        rows: [{ rowNumber: 2, values: customerRow() }],
      },
      files: [driveFile("MGKVX6310-KEM (1).png")],
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(result.schemaDrift).toContain("Chi tiết");
    expect(result.schemaDrift).not.toContain("Mã sản phẩm");
    const drift = result.issues.find((issue) => issue.reason === "COLUMN_MISSING");
    expect(drift?.detail).toContain("Danh mục");
  });

  it("fails with the tenant's column name when a required column is gone", async () => {
    const harness = makeHarness({
      config: customerConfig(),
      snapshot: {
        columns: ["SKU", "Qty"],
        duplicateColumns: [],
        rows: [{ rowNumber: 2, values: customerRow() }],
      },
    });

    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({ code: "SHEET_ERROR" });
    expect(harness.finished[0]?.errorMessage).toContain("Product name");
  });

  it("warns when a caption field points at a price-looking column, without stopping", async () => {
    const harness = makeHarness({
      config: customerConfig({
        fieldMap: makeFieldMap({ code: "SKU", name: "Product name", description: "Giá bán" }),
      }),
      snapshot: customerSnapshot([customerRow()]),
      files: [driveFile("MGKVX6310-KEM (1).png")],
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(
      result.issues.find((issue) => issue.errorCode === "FIELD_MAP_WARNING"),
    ).toMatchObject({ reason: "FIELD_MAP_PRICE_LIKE_COLUMN" });
    expect(harness.writtenProducts).toHaveLength(1);
  });

  it("persists products read through the tenant's columns and leaves prices out", async () => {
    const harness = makeHarness({
      config: customerConfig(),
      snapshot: customerSnapshot([customerRow()]),
      files: [driveFile("MGKVX6310-KEM (1).png")],
    });

    const result = await harness.run({ tenantId: TENANT });
    expect(result.status).toBe("succeeded");
    expect(harness.writtenProducts[0]).toMatchObject({
      content: { code: "MGKVX6310", name: "Giannal", description: "Váy dáng xoè" },
      operational: { stockRaw: "104", noteRaw: "Không nhận sx 1c", colorsRaw: "KEM, HỒNG" },
    });
    expect(JSON.stringify(harness.writtenProducts[0])).not.toContain("890.000");
  });

  it("logs that the stock check is disabled for this tenant", async () => {
    const harness = makeHarness({
      config: customerConfig({
        stockPolicy: { mode: "disabled", reason: "Khách quản lý tồn ở phần mềm khác" },
      }),
      snapshot: customerSnapshot([customerRow()]),
      files: [driveFile("MGKVX6310-KEM (1).png")],
    });

    await harness.run({ tenantId: TENANT });
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Stock check is DISABLED"),
      expect.objectContaining({ error_code: "STOCK_CHECK_DISABLED" }),
    );
  });

  it("still syncs the internal sheet when no field map is configured", async () => {
    const harness = makeHarness({
      snapshot: sheet([productRow()]),
      files: [driveFile("MGKVX6310-KEM (1).png")],
    });
    const result = await harness.run({ tenantId: TENANT });
    expect(result.status).toBe("succeeded");
    expect(harness.writtenProducts[0]?.content.name).toBe("Giannal");
  });
});
