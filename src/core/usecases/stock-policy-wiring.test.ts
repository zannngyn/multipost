import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STOCK_POLICY,
  makeFieldMap,
  MYSP_FIELD_MAP,
  type StockPolicy,
} from "@/core/domain/catalog-field-map";
import { AppError } from "@/core/domain/errors";
import type { MediaAsset, Product } from "@/core/domain/product";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { CatalogConfigRepo } from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";
import type {
  CatalogProductRow,
  CatalogReadRepo,
  CatalogSignalGroup,
  MediaRepo,
  ProductRepo,
} from "@/core/ports/product-repo";

import { makeComposePost } from "./compose-post";
import { makeListCatalogProducts } from "./list-catalog-products";

/**
 * The tenant stock policy reaching the two usecases that decide what an
 * operator may post (onboarding phase 1). Without this wiring the `textual` and
 * `disabled` modes exist in the domain and change nothing in the product.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-0000000000a1");
const CHANNEL = "fb-page-1";

const TEXTUAL: StockPolicy = {
  mode: "textual",
  inStockValues: ["Còn hàng"],
  outOfStockValues: ["Hết hàng"],
};
const DISABLED: StockPolicy = {
  mode: "disabled",
  reason: "Khách quản lý tồn kho trên phần mềm riêng",
};

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

/** Config repo that only answers the two hot-path reads. */
function configRepo(policy: StockPolicy | Error): CatalogConfigRepo {
  return {
    findCatalogConfig: async () => null,
    findCatalogSource: async () => null,
    findFieldMap: async () => MYSP_FIELD_MAP,
    findStockPolicy: async () => {
      if (policy instanceof Error) throw policy;
      return policy;
    },
    saveCatalogSource: async () => ({ previous: null }),
  };
}

// --- composePost ------------------------------------------------------------

function product(stockRaw: string, noteRaw = ""): Product {
  return {
    content: {
      code: "MGKVX6310",
      name: "Giannal",
      description: "Váy dáng xoè",
      category: "Váy",
      season: "Xuân hè 2026",
    },
    operational: { stockRaw, noteRaw, colorsRaw: "KEM" },
    hasConflict: false,
    sourceRows: [2],
  };
}

function asset(): MediaAsset {
  return {
    driveFileId: "id-1",
    origin: "drive",
    storageKey: null,
    fileName: "MGKVX6310-KEM (1).jpg",
    productCode: "MGKVX6310",
    color: "KEM",
    colorRaw: "KEM",
    sequence: 1,
    kind: "image",
    variants: { aiGenerated: false, realPhoto: false, backView: false },
    mimeType: "image/jpeg",
    sizeBytes: 1000,
    modifiedTime: "2026-08-01T00:00:00.000Z",
    warnings: [],
    needsReview: false,
  };
}

function composeHarness(row: Product, policy?: StockPolicy | Error) {
  const products: ProductRepo = {
    findByCode: async () => row,
    upsertMany: async () => 0,
    deleteStale: async () => 0,
    countAll: async () => 0,
  };
  const media: MediaRepo = {
    listByProductCode: async () => Array.from({ length: 6 }, asset),
    upsertMany: async () => 0,
    deleteStale: async () => 0,
    countDriveAssets: async () => 0,
    registerUpload: async () => {},
    listOrphanedUploads: async () => [],
    listUnreferencedUploadsForCode: async () => [],
    deleteUploads: async () => 0,
  };
  const logger = makeLogger();
  return {
    logger,
    compose: makeComposePost({
      products,
      media,
      logger,
      ...(policy === undefined ? {} : { catalogConfig: configRepo(policy) }),
    }),
  };
}

describe("composePost — stock policy (edge cases first)", () => {
  const input = { tenantId: TENANT, productCode: "MGKVX6310", channel: CHANNEL };

  it("keeps the numeric behaviour when no config repo is wired", async () => {
    const { compose } = composeHarness(product("0"));
    const result = await compose(input);
    expect(result.blocked).toMatchObject({ code: "OUT_OF_STOCK" });
    expect(result.inventory?.policyMode).toBe("numeric");
  });

  it("stops the compose when the stored policy cannot be read", async () => {
    // Never degraded into "compose anyway": a broken config must be visible.
    const { compose, logger } = composeHarness(
      product("104"),
      new AppError("SYNC_FAILED", { message: "broken policy" }),
    );
    await expect(compose(input)).rejects.toMatchObject({ code: "SYNC_FAILED" });
    expect(logger.error).toHaveBeenCalled();
  });

  it("blocks an undeclared wording under the textual policy", async () => {
    const { compose } = composeHarness(product("sắp về"), TEXTUAL);
    const result = await compose(input);
    expect(result.blocked).toMatchObject({ code: "OUT_OF_STOCK" });
    expect(result.inventory).toMatchObject({ reason: "STOCK_TEXT_UNKNOWN", policyMode: "textual" });
  });

  it("composes on a declared in-stock wording", async () => {
    const { compose } = composeHarness(product("Còn hàng"), TEXTUAL);
    const result = await compose(input);
    expect(result.blocked).toBeNull();
    expect(result.inventory).toMatchObject({ blocked: false, policyMode: "textual" });
  });

  it("composes an empty stock cell under the disabled policy — and says nobody checked", async () => {
    const { compose } = composeHarness(product(""), DISABLED);
    const result = await compose(input);

    expect(result.blocked).toBeNull();
    expect(result.inventory).toMatchObject({
      stockCheckSkipped: true,
      stockCheckSkippedReason: "Khách quản lý tồn kho trên phần mềm riêng",
      policyMode: "disabled",
    });
    // The operator sees it on the compose screen, not only in a log.
    expect(result.warnings.join(" ")).toContain("tắt kiểm tồn kho");
  });

  it("keeps 'HẾT HÀNG' blocking even with the check disabled", async () => {
    const { compose } = composeHarness(product("50", "HẾT HÀNG"), DISABLED);
    const result = await compose(input);
    expect(result.blocked).toMatchObject({ code: "OUT_OF_STOCK" });
    expect(result.inventory?.stockCheckSkipped).toBe(false);
  });
});

// --- listCatalogProducts ----------------------------------------------------

function catalogRow(overrides: Partial<CatalogProductRow> = {}): CatalogProductRow {
  return {
    code: "MGKVX6310",
    name: "Giannal",
    category: "Váy",
    season: "Xuân hè 2026",
    stockRaw: "104",
    noteRaw: "",
    hasConflict: false,
    mediaImageCount: 6,
    mediaVideoCount: 0,
    ...overrides,
  };
}

function listHarness(rows: CatalogProductRow[], policy?: StockPolicy | Error) {
  const groups: CatalogSignalGroup[] = rows.map((row) => ({
    stockRaw: row.stockRaw,
    noteRaw: row.noteRaw,
    hasConflict: row.hasConflict,
    hasMedia: row.mediaImageCount + row.mediaVideoCount > 0,
    count: 1,
  }));
  const catalog: CatalogReadRepo = {
    listCatalog: async () => ({ items: rows, nextAfterCode: null }),
    aggregateCatalog: async () => groups,
  };
  return makeListCatalogProducts({
    catalog,
    logger: makeLogger(),
    ...(policy === undefined ? {} : { catalogConfig: configRepo(policy) }),
  });
}

describe("listCatalogProducts — stock policy", () => {
  it("exposes the skip flags as false under the numeric default", async () => {
    const list = listHarness([catalogRow()]);
    const result = await list({ tenantId: TENANT });
    expect(result.items[0]?.inventory).toMatchObject({
      stockCheckSkipped: false,
      stockCheckSkippedReason: null,
    });
  });

  it("marks a row as composable-but-unchecked under the disabled policy", async () => {
    const list = listHarness([catalogRow({ stockRaw: "0" })], DISABLED);
    const result = await list({ tenantId: TENANT });

    expect(result.items[0]).toMatchObject({ composable: true, blockedReason: null });
    expect(result.items[0]?.inventory).toMatchObject({
      stockCheckSkipped: true,
      stockCheckSkippedReason: "Khách quản lý tồn kho trên phần mềm riêng",
    });
  });

  it("counts the totals with the SAME policy as the rows", async () => {
    const rows = [catalogRow({ code: "A", stockRaw: "0" }), catalogRow({ code: "B", stockRaw: "0" })];
    const numeric = await listHarness(rows)({ tenantId: TENANT });
    const disabled = await listHarness(rows, DISABLED)({ tenantId: TENANT });

    expect(numeric.totals).toMatchObject({ total: 2, ok: 0, blocked: 2 });
    expect(disabled.totals).toMatchObject({ total: 2, ok: 2, blocked: 0 });
  });

  it("blocks an undeclared wording under the textual policy", async () => {
    const list = listHarness([catalogRow({ stockRaw: "còn ít" })], TEXTUAL);
    const result = await list({ tenantId: TENANT });
    expect(result.items[0]).toMatchObject({ composable: false });
    expect(result.items[0]?.inventory.reason).toBe("STOCK_TEXT_UNKNOWN");
  });

  it("fails loudly instead of listing a whole catalog as 'còn hàng'", async () => {
    const list = listHarness(
      [catalogRow()],
      new AppError("SYNC_FAILED", { message: "broken policy" }),
    );
    await expect(list({ tenantId: TENANT })).rejects.toMatchObject({ code: "SYNC_FAILED" });
  });

  it("keeps working for a tenant whose repo answers the default", async () => {
    const list = listHarness([catalogRow()], DEFAULT_STOCK_POLICY);
    const result = await list({ tenantId: TENANT });
    expect(result.items[0]?.inventory).toMatchObject({ status: "in_stock", stock: 104 });
  });
});

describe("configRepo contract used above", () => {
  it("is a full CatalogConfigRepo — the fake cannot drift from the port", () => {
    const repo = configRepo(DEFAULT_STOCK_POLICY);
    expect(typeof repo.findStockPolicy).toBe("function");
    expect(typeof repo.findFieldMap).toBe("function");
    expect(makeFieldMap(MYSP_FIELD_MAP).code).toBe("Mã sản phẩm");
  });
});
