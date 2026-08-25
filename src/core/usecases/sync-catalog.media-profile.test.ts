import { describe, expect, it, vi } from "vitest";

import { DEFAULT_STOCK_POLICY, makeFieldMap, MYSP_FIELD_MAP } from "@/core/domain/catalog-field-map";
import type { MediaProfile } from "@/core/domain/media-profile";
import type { MediaAsset, Product } from "@/core/domain/product";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type {
  CatalogConfigRepo,
  CatalogSourceConfig,
  DriveFile,
  DriveListing,
  DriveSource,
  ListDriveFilesDeepInput,
} from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";
import type {
  FinishSyncRunInput,
  MediaRepo,
  ProductRepo,
  SyncIssue,
  SyncRunRepo,
} from "@/core/ports/product-repo";
import type { SheetSnapshot, SheetSource } from "@/core/ports/sheet-source";

import { makeSyncCatalog } from "./sync-catalog";

/**
 * Phase 2 wiring of `syncCatalog`: the tenant's media profile decides HOW the
 * folder is listed and how a file finds its product code. The default profile
 * is covered by sync-catalog.test.ts and must not move.
 */

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

const COLUMNS = [
  "Mã sản phẩm",
  "Tên sản phẩm",
  "Mô tả sản phẩm",
  "Chủng loại",
  "Mùa vụ",
  "Tồn",
  "Lưu ý nhận sx 1c / sx hết tồn",
  "Màu sắc",
  "Link ảnh",
];

function sheetOf(rows: Array<Record<string, string>>): SheetSnapshot {
  return {
    columns: COLUMNS,
    duplicateColumns: [],
    rows: rows.map((values, index) => ({ rowNumber: index + 2, values })),
  };
}

const row = (code: string, extra: Record<string, string> = {}) => ({
  "Mã sản phẩm": code,
  "Tên sản phẩm": "Giannal",
  "Mô tả sản phẩm": "Váy dáng xoè",
  "Chủng loại": "Váy",
  "Mùa vụ": "Xuân hè 2026",
  Tồn: "104",
  "Lưu ý nhận sx 1c / sx hết tồn": "Không nhận sx 1c",
  "Màu sắc": "KEM",
  ...extra,
});

function deepFile(partial: Partial<DriveFile> & { id: string; name: string }): DriveFile {
  return {
    mimeType: "image/jpeg",
    sizeBytes: 1000,
    modifiedTime: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

interface Harness {
  run: ReturnType<typeof makeSyncCatalog>;
  writtenMedia: MediaAsset[];
  finished: FinishSyncRunInput[];
  deletedStale: string[];
  deepCalls: ListDriveFilesDeepInput[];
  flatCalls: number;
}

function makeHarness(options: {
  snapshot: SheetSnapshot;
  mediaProfile?: MediaProfile;
  fieldMap?: CatalogSourceConfig["fieldMap"];
  /** Answer of `listFilesDeep`. Absent = the source has no deep listing. */
  listing?: DriveListing;
  flatFiles?: DriveFile[];
}): Harness {
  const writtenMedia: MediaAsset[] = [];
  const writtenProducts: Product[] = [];
  const finished: FinishSyncRunInput[] = [];
  const deletedStale: string[] = [];
  const deepCalls: ListDriveFilesDeepInput[] = [];
  const harness = { flatCalls: 0 };

  const drive: DriveSource = {
    listFiles: async () => {
      harness.flatCalls += 1;
      return options.flatFiles ?? [];
    },
    download: async () => {
      throw new Error("download must not be called by sync-catalog");
    },
    ...(options.listing
      ? {
          listFilesDeep: async (input: ListDriveFilesDeepInput) => {
            deepCalls.push(input);
            return options.listing as DriveListing;
          },
        }
      : {}),
  };

  const config: CatalogSourceConfig = {
    driveFolderId: "folder",
    spreadsheetId: "sheet",
    sheetName: "Mẫu 2026",
    ...(options.fieldMap ? { fieldMap: options.fieldMap } : {}),
    ...(options.mediaProfile ? { mediaProfile: options.mediaProfile } : {}),
  };

  const catalogConfig: CatalogConfigRepo = {
    findCatalogConfig: async () => config,
    findCatalogSource: async () => config,
    findStockPolicy: async () => DEFAULT_STOCK_POLICY,
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
    countAll: async () => 0,
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
    countDriveAssets: async () => 0,
    registerUpload: async () => {},
    listOrphanedUploads: async () => [],
    listUnreferencedUploadsForCode: async () => [],
    deleteUploads: async () => 0,
  };

  const syncRuns: SyncRunRepo = {
    start: async () => ({ id: "run-1" }),
    finish: async (input) => {
      finished.push(input);
    },
    findLatest: async () => null,
    listRecent: async () => {
      throw new Error("listRecent must not be called by sync-catalog");
    },
  };

  const sheetSource: SheetSource = { readRows: async () => options.snapshot };

  return {
    run: makeSyncCatalog({
      drive,
      sheet: sheetSource,
      catalogConfig,
      products,
      media,
      syncRuns,
      clock,
      logger: makeLogger(),
    }),
    writtenMedia,
    finished,
    deletedStale,
    deepCalls,
    get flatCalls() {
      return harness.flatCalls;
    },
  };
}

function issuesOf(harness: Harness): readonly SyncIssue[] {
  return harness.finished[0]?.issues ?? [];
}

describe("syncCatalog — folder-per-code", () => {
  it("lists Drive recursively and takes the code from the folder name", async () => {
    const harness = makeHarness({
      snapshot: sheetOf([row("MGKVX6310")]),
      mediaProfile: { kind: "folder-per-code" },
      listing: {
        files: [
          deepFile({ id: "f1", name: "IMG_1664.JPG", folderPath: ["MGKVX6310"], parentFolderId: "d1" }),
          deepFile({ id: "f2", name: "KEM (2).png", folderPath: ["MGKVX6310"], parentFolderId: "d1" }),
        ],
        foldersVisited: 1,
        depthReached: 1,
        limitsHit: [],
      },
    });

    const result = await harness.run({ tenantId: TENANT });

    expect(harness.deepCalls).toHaveLength(1);
    expect(harness.flatCalls).toBe(0);
    expect(harness.writtenMedia.map((asset) => asset.productCode)).toEqual([
      "MGKVX6310",
      "MGKVX6310",
    ]);
    // A file name that says nothing is still imported — just without a colour.
    expect(harness.writtenMedia[0].color).toBeNull();
    expect(harness.writtenMedia[1].color).toBe("KEM");
    expect(result.counts.mediaParsed).toBe(2);
    expect(result.counts.mediaRejected).toBe(0);
  });

  it("says so, loudly, when the Drive source cannot list recursively", async () => {
    const harness = makeHarness({
      snapshot: sheetOf([row("MGKVX6310")]),
      mediaProfile: { kind: "folder-per-code" },
      flatFiles: [deepFile({ id: "f1", name: "MGKVX6310-KEM (1).jpg" })],
    });

    await harness.run({ tenantId: TENANT });

    expect(harness.flatCalls).toBe(1);
    expect(issuesOf(harness).map((issue) => issue.reason)).toContain(
      "RECURSIVE_LISTING_UNSUPPORTED",
    );
  });

  it("keeps the catalog when the listing was truncated — no deleteStale on media", async () => {
    const harness = makeHarness({
      snapshot: sheetOf([row("MGKVX6310")]),
      mediaProfile: { kind: "folder-per-code" },
      listing: {
        files: [deepFile({ id: "f1", name: "a.jpg", folderPath: ["MGKVX6310"] })],
        foldersVisited: 1,
        depthReached: 1,
        limitsHit: ["MAX_FILES"],
      },
    });

    const result = await harness.run({ tenantId: TENANT });

    const truncated = issuesOf(harness).find(
      (issue) => issue.errorCode === "DRIVE_LISTING_TRUNCATED",
    );
    expect(truncated?.reason).toBe("MAX_FILES");
    expect(truncated?.detail).toContain("chưa dọn ảnh cũ");
    // Products may still be reconciled; media must NOT be deleted.
    expect(harness.deletedStale).toEqual(["products"]);
    expect(result.counts.mediaDeleted).toBe(0);
  });
});

describe("syncCatalog — sheet-column", () => {
  const fieldMap = makeFieldMap({ ...MYSP_FIELD_MAP, mediaLink: "Link ảnh" });

  it("attaches the file a sheet cell links to", async () => {
    const harness = makeHarness({
      snapshot: sheetOf([
        row("MGKVX6310", {
          "Link ảnh": "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view",
        }),
      ]),
      fieldMap,
      mediaProfile: { kind: "sheet-column" },
      listing: {
        files: [deepFile({ id: "1AbCdEfGhIjKlMnOp", name: "IMG_1664.JPG", parentFolderId: "root" })],
        foldersVisited: 0,
        depthReached: 0,
        limitsHit: [],
      },
    });

    const result = await harness.run({ tenantId: TENANT });

    expect(harness.writtenMedia).toHaveLength(1);
    expect(harness.writtenMedia[0]).toMatchObject({
      productCode: "MGKVX6310",
      driveFileId: "1AbCdEfGhIjKlMnOp",
      color: null,
    });
    expect(result.counts.mediaParsed).toBe(1);
  });

  it("refuses to run when the link column is not mapped, instead of guessing one", async () => {
    const harness = makeHarness({
      snapshot: sheetOf([row("MGKVX6310")]),
      mediaProfile: { kind: "sheet-column" },
      listing: { files: [], foldersVisited: 0, depthReached: 0, limitsHit: [] },
    });

    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({
      code: "SHEET_ERROR",
      userMessage: expect.stringContaining("cột chứa link ảnh"),
    });
    expect(harness.finished[0]?.status).toBe("failed");
  });
});

describe("syncCatalog — the profile itself", () => {
  it("stops the run on an unusable media profile instead of importing nothing", async () => {
    const harness = makeHarness({
      snapshot: sheetOf([row("MGKVX6310")]),
      mediaProfile: { kind: "drive-magic" } as unknown as MediaProfile,
      flatFiles: [deepFile({ id: "f1", name: "MGKVX6310-KEM (1).jpg" })],
    });

    await expect(harness.run({ tenantId: TENANT })).rejects.toMatchObject({ code: "SYNC_FAILED" });
    expect(harness.finished[0]?.status).toBe("failed");
  });

  it("records a colour-vocabulary warning without stopping the run", async () => {
    const harness = makeHarness({
      snapshot: sheetOf([row("MGKVX6310")]),
      mediaProfile: {
        kind: "code-color-seq",
        colors: { aliases: { XT: "màu không có thật" } },
      },
      flatFiles: [deepFile({ id: "f1", name: "MGKVX6310-KEM (1).jpg" })],
    });

    const result = await harness.run({ tenantId: TENANT });

    expect(result.counts.mediaParsed).toBe(1);
    expect(issuesOf(harness).map((issue) => issue.errorCode)).toContain("MEDIA_PROFILE_WARNING");
  });

  it("code-in-name uses the sheet's own codes and stays on a flat listing", async () => {
    const harness = makeHarness({
      snapshot: sheetOf([row("SP-001")]),
      mediaProfile: { kind: "code-in-name" },
      flatFiles: [
        deepFile({ id: "f1", name: "anh chup SP-001 ngay 12.8.jpg" }),
        deepFile({ id: "f2", name: "IMG_1664.JPG" }),
      ],
    });

    const result = await harness.run({ tenantId: TENANT });

    expect(harness.flatCalls).toBe(1);
    expect(harness.deepCalls).toHaveLength(0);
    expect(harness.writtenMedia.map((asset) => asset.productCode)).toEqual(["SP-001"]);
    expect(result.counts.mediaRejected).toBe(1);
    expect(issuesOf(harness).map((issue) => issue.reason)).toContain("NO_PRODUCT_CODE");
  });
});
