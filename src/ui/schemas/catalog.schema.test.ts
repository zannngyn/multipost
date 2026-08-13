import { describe, expect, it } from "vitest";

import {
  CatalogProductsResponseSchema,
  CatalogSourceFormSchema,
  CatalogSourceResponseSchema,
  blockedReasonLabel,
  formatMediaCounts,
  isCatalogSourceField,
  parseProductFilter,
  productSearchParams,
  shortenId,
} from "./catalog.schema";

/**
 * Edge cases first (CLAUDE.md technical rule 1). These schemas mirror core
 * types the UI may not import (docs/07 §2); the tests exist so a drift shows up
 * here instead of as an empty table in the browser.
 */

const VALID_SOURCE = {
  state: "configured",
  tenantId: "00000000-0000-0000-0000-000000000001",
  source: {
    driveFolderId: "1bA48sjugz9BczcoR0-zOc-VNlIYikp4v",
    spreadsheetId: "1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs",
    sheetName: "Mẫu 2026",
    driveFolderUrl: "https://drive.google.com/drive/folders/1bA48sjugz9BczcoR0-zOc-VNlIYikp4v",
    spreadsheetUrl:
      "https://docs.google.com/spreadsheets/d/1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs",
  },
};

const VALID_PRODUCT = {
  code: "MGKVX6310",
  name: "Giannal",
  category: "Áo",
  season: "Hè",
  inventory: {
    status: "in_stock",
    stock: 104,
    reason: null,
    operatorMessage: null,
  },
  mediaImageCount: 12,
  mediaVideoCount: 0,
  hasConflict: false,
  composable: true,
  blockedReason: null,
};

describe("CatalogSourceResponseSchema", () => {
  it("treats 'not configured' as a valid answer, not an error", () => {
    const result = CatalogSourceResponseSchema.safeParse({
      state: "not_configured",
      tenantId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a configured source", () => {
    expect(CatalogSourceResponseSchema.safeParse(VALID_SOURCE).success).toBe(true);
  });

  it("refuses a source whose links are not URLs — a dead link is worse than none", () => {
    const result = CatalogSourceResponseSchema.safeParse({
      ...VALID_SOURCE,
      source: { ...VALID_SOURCE.source, driveFolderUrl: "javascript:alert(1)" },
    });
    expect(result.success).toBe(false);
  });

  it("refuses an unknown state instead of rendering nothing", () => {
    expect(CatalogSourceResponseSchema.safeParse({ state: "maybe" }).success).toBe(false);
  });
});

describe("CatalogSourceFormSchema", () => {
  it("rejects blank fields before a round trip", () => {
    const result = CatalogSourceFormSchema.safeParse({
      driveFolder: "   ",
      spreadsheet: "",
      sheetName: " ",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toHaveLength(3);
  });

  it("accepts a pasted browser link AND a bare id — the server parses both", () => {
    const pasted = CatalogSourceFormSchema.safeParse({
      driveFolder: "https://drive.google.com/drive/folders/1bA48sjugz9BczcoR0-zOc-VNlIYikp4v?usp=sharing",
      spreadsheet:
        "https://docs.google.com/spreadsheets/d/1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs/edit#gid=0",
      sheetName: "Mẫu 2026",
    });
    const bare = CatalogSourceFormSchema.safeParse({
      driveFolder: "1bA48sjugz9BczcoR0-zOc-VNlIYikp4v",
      spreadsheet: "1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs",
      sheetName: "Mẫu 2026",
    });
    expect(pasted.success).toBe(true);
    expect(bare.success).toBe(true);
  });

  it("trims what the operator pasted", () => {
    const result = CatalogSourceFormSchema.safeParse({
      driveFolder: "  abc  ",
      spreadsheet: " def ",
      sheetName: "  Mẫu 2026 ",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.sheetName).toBe("Mẫu 2026");
  });

  it("knows which paths the server may report field issues on", () => {
    expect(isCatalogSourceField("driveFolder")).toBe(true);
    expect(isCatalogSourceField("sheetName")).toBe(true);
    expect(isCatalogSourceField("tenantId")).toBe(false);
    expect(isCatalogSourceField("(root)")).toBe(false);
  });
});

describe("CatalogProductsResponseSchema", () => {
  it("accepts an empty catalog (a tenant that never synced)", () => {
    const result = CatalogProductsResponseSchema.safeParse({
      items: [],
      nextCursor: null,
      totals: { total: 0, ok: 0, blocked: 0 },
    });
    expect(result.success).toBe(true);
  });

  it("keeps a null stock as null — an empty cell is not zero", () => {
    const result = CatalogProductsResponseSchema.safeParse({
      items: [
        {
          ...VALID_PRODUCT,
          composable: false,
          inventory: {
            status: "blocked",
            stock: null,
            reason: "STOCK_NOT_A_NUMBER",
            operatorMessage: "Ô tồn trống — không đăng",
          },
          blockedReason: { code: "OUT_OF_STOCK", userMessage: "Mã MGKVX6310 đã hết hàng — không đăng" },
        },
      ],
      nextCursor: "cursor-2",
      totals: { total: 299, ok: 120, blocked: 179 },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.items[0].inventory.stock).toBeNull();
  });

  it("refuses an inventory status the UI has no label for", () => {
    const result = CatalogProductsResponseSchema.safeParse({
      items: [{ ...VALID_PRODUCT, inventory: { ...VALID_PRODUCT.inventory, status: "unknown" } }],
      nextCursor: null,
      totals: { total: 1, ok: 1, blocked: 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe("parseProductFilter / productSearchParams", () => {
  it("falls back to the default for a status nobody supports", () => {
    const filter = parseProductFilter(new URLSearchParams("status=maybe"));
    expect(filter.status).toBeNull();
  });

  it("treats a blank search as no search", () => {
    expect(parseProductFilter(new URLSearchParams("q=%20%20")).q).toBeNull();
  });

  it("reads a real filter", () => {
    const filter = parseProductFilter(new URLSearchParams("status=blocked&q=MGK"));
    expect(filter).toEqual({ status: "blocked", q: "MGK" });
  });

  it("keeps defaults out of the URL", () => {
    expect(productSearchParams({ status: null, q: null }).toString()).toBe("");
  });

  it("round-trips a filter through the URL", () => {
    const filter = { status: "ok", q: "áo dài" } as const;
    const parsed = parseProductFilter(new URLSearchParams(productSearchParams(filter).toString()));
    expect(parsed).toEqual(filter);
  });
});

describe("display helpers", () => {
  it("does not shorten an id that is already short", () => {
    expect(shortenId("abc")).toBe("abc");
  });

  it("keeps both ends of a long id so two ids can be told apart", () => {
    expect(shortenId("1bA48sjugz9BczcoR0-zOc-VNlIYikp4v")).toBe("1bA48s…Yikp4v");
  });

  it("says out loud when a code has no file at all", () => {
    expect(formatMediaCounts(0, 0)).toBe("chưa có file");
    expect(formatMediaCounts(12, 0)).toBe("12 ảnh");
    expect(formatMediaCounts(12, 2)).toBe("12 ảnh · 2 video");
    expect(formatMediaCounts(0, 1)).toBe("1 video");
  });

  it("shows an unknown block code instead of flattening it", () => {
    expect(blockedReasonLabel("OUT_OF_STOCK")).toBe("Hết hàng");
    expect(blockedReasonLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});
