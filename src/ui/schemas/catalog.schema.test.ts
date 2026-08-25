import { describe, expect, it } from "vitest";

import {
  CATALOG_FILE_ACCEPT,
  CatalogProductsResponseSchema,
  CatalogSourceFormSchema,
  CatalogSourceResponseSchema,
  blockedReasonLabel,
  formatFileBytes,
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
    // `null` = the tenant never declared a mapping and runs on the MYSP preset.
    // It is a required key with a nullable value on purpose: a MISSING key would
    // be a server that does not answer the question at all.
    fieldMap: null,
    stockPolicy: null,
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
    stockCheckSkipped: false,
    stockCheckSkippedReason: null,
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
            stockCheckSkipped: false,
            stockCheckSkippedReason: null,
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

  /**
   * Onboarding phase 3: the catalog may be a Google tab, an uploaded CSV, or a
   * product typed by hand. A label naming one of the three is wrong for the
   * other two.
   */
  it("names the missing product without naming Google Sheet", () => {
    expect(blockedReasonLabel("PRODUCT_NOT_FOUND")).toBe("Không có trong dữ liệu sản phẩm");
    expect(blockedReasonLabel("PRODUCT_NOT_FOUND")).not.toMatch(/Sheet/i);
  });
});

describe("CatalogSourceSchema — declared mapping", () => {
  it("keeps a declared map and policy, and does not collapse them into null", () => {
    const result = CatalogSourceResponseSchema.safeParse({
      ...VALID_SOURCE,
      source: {
        ...VALID_SOURCE.source,
        fieldMap: {
          code: "Mã SP",
          name: "Tên hàng",
          description: null,
          category: null,
          season: null,
          stock: "Tồn",
          note: null,
          colors: null,
        },
        stockPolicy: { mode: "disabled", reason: "Tồn kho ở phần mềm khác" },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success || result.data.state !== "configured") return;
    expect(result.data.source.fieldMap?.code).toBe("Mã SP");
    expect(result.data.source.stockPolicy).toEqual({
      mode: "disabled",
      reason: "Tồn kho ở phần mềm khác",
    });
  });

  it("refuses a disabled policy whose reason is too short to be a reason", () => {
    const result = CatalogSourceResponseSchema.safeParse({
      ...VALID_SOURCE,
      source: { ...VALID_SOURCE.source, stockPolicy: { mode: "disabled", reason: "vì thế" } },
    });

    expect(result.success).toBe(false);
  });
});

/**
 * Onboarding phase 3 — the CSV branch. The mirror is where this feature dies
 * silently if it is wrong: the server answers 200 with a perfectly good payload
 * and a too-strict schema turns it into an error state nobody can act on.
 */
describe("CatalogSourceSchema — a tenant reading an uploaded CSV", () => {
  const fileSource = {
    ...VALID_SOURCE.source,
    driveFolderId: "",
    spreadsheetId: "",
    sheetName: "",
    textSource: {
      kind: "file",
      storageKey: "catalog/t1/abc",
      fileName: "bang-gia-2026.csv",
      contentType: "text/csv",
      sizeBytes: 248_000,
      uploadedAt: "2026-08-24T07:32:07.000Z",
    },
  };

  it("accepts a source with NO Google coordinates at all", () => {
    // This is the whole customer this phase exists for. A `.min(1)` on the three
    // ids would take their "Nguồn dữ liệu" card down completely.
    const result = CatalogSourceResponseSchema.safeParse({
      ...VALID_SOURCE,
      source: fileSource,
    });
    expect(result.success).toBe(true);
  });

  it("keeps the file name and upload time — the two facts the screen prints", () => {
    const result = CatalogSourceResponseSchema.safeParse({ ...VALID_SOURCE, source: fileSource });
    expect(result.success).toBe(true);
    if (result.success && result.data.state === "configured") {
      const stored = result.data.source.textSource;
      expect(stored?.kind).toBe("file");
      if (stored?.kind === "file") {
        expect(stored.fileName).toBe("bang-gia-2026.csv");
        expect(stored.uploadedAt).toBe("2026-08-24T07:32:07.000Z");
      }
    }
  });

  it("reads an absent textSource as 'chưa khai', not as a broken response", () => {
    const result = CatalogSourceResponseSchema.safeParse(VALID_SOURCE);
    expect(result.success).toBe(true);
    if (result.success && result.data.state === "configured") {
      expect(result.data.source.textSource ?? null).toBeNull();
    }
  });

  it("refuses a file source with no storage key — that config reads nothing", () => {
    const result = CatalogSourceResponseSchema.safeParse({
      ...VALID_SOURCE,
      source: { ...fileSource, textSource: { kind: "file", fileName: "x.csv", storageKey: "" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("formatFileBytes", () => {
  it("reads like a file manager, and never invents a size", () => {
    expect(formatFileBytes(248_000)).toBe("248 KB");
    expect(formatFileBytes(2_400_000)).toBe("2,4 MB");
    expect(formatFileBytes(512)).toBe("512 byte");
    expect(formatFileBytes(null)).toBe("—");
    expect(formatFileBytes(Number.NaN)).toBe("—");
    expect(formatFileBytes(-1)).toBe("—");
  });
});

describe("CATALOG_FILE_ACCEPT", () => {
  it("offers the extensions Excel and Sheets actually write, and no workbook", () => {
    expect(CATALOG_FILE_ACCEPT).toContain(".csv");
    // A locale export lands as .tsv/.txt; refusing them in the picker would hide
    // the file the operator was just told to make.
    expect(CATALOG_FILE_ACCEPT).toContain(".tsv");
    expect(CATALOG_FILE_ACCEPT).toContain(".txt");
    // The one thing this system cannot read must not be offered by the picker.
    expect(CATALOG_FILE_ACCEPT).not.toContain(".xlsx");
    expect(CATALOG_FILE_ACCEPT).not.toContain("spreadsheetml");
  });
});
