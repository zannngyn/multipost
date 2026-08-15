import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { MediaAsset, Product } from "@/core/domain/product";
import type { CatalogConfigRepo, DriveFile, DriveSource } from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";
import type {
  FinishSyncRunInput,
  MediaRepo,
  ProductRepo,
  StartSyncRunInput,
  SyncRunRepo,
} from "@/core/ports/product-repo";
import type { SheetSnapshot, SheetSource } from "@/core/ports/sheet-source";

import { makeSyncCatalog, MAX_STORED_ISSUES } from "./sync-catalog";

const TENANT = "00000000-0000-0000-0000-000000000001";

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
}

function makeHarness(options: {
  files?: DriveFile[];
  snapshot?: SheetSnapshot;
  config?: { driveFolderId: string; spreadsheetId: string; sheetName: string } | null;
  driveError?: unknown;
  sheetError?: unknown;
}): Harness {
  const writtenProducts: Product[] = [];
  const writtenMedia: MediaAsset[] = [];
  const finished: FinishSyncRunInput[] = [];
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
    saveCatalogSource: async () => ({ previous: null }),
  };
  const products: ProductRepo = {
    findByCode: async () => null,
    upsertMany: async (_tenant, items) => {
      writtenProducts.push(...items);
      return items.length;
    },
    deleteStale: async () => 0,
  };
  const media: MediaRepo = {
    listByProductCode: async () => [],
    upsertMany: async (_tenant, assets) => {
      writtenMedia.push(...assets);
      return assets.length;
    },
    deleteStale: async () => 0,
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
  };
}

describe("syncCatalog — edge cases first", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed tenant id before touching any source", async () => {
    const harness = makeHarness({});
    await expect(harness.run({ tenantId: "not-a-uuid" })).rejects.toMatchObject({
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
    expect(result.issues.some((issue) => issue.reason === "MULTIPLE_PRODUCT_CODES")).toBe(true);
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
