import { describe, expect, it } from "vitest";

import type { CatalogProduct } from "@/ui/schemas/catalog.schema";

import { nextHighlight, outOfStockMessage, toProductSuggestion } from "./product-suggestions";

function product(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    code: "MGKVX6310",
    name: "Váy xoè hoa nhí",
    category: "Váy",
    season: "Hè",
    inventory: { status: "in_stock", stock: 62, reason: null, operatorMessage: null },
    mediaImageCount: 8,
    mediaVideoCount: 0,
    hasConflict: false,
    composable: true,
    blockedReason: null,
    ...overrides,
  };
}

describe("toProductSuggestion — refusals first", () => {
  it("blocks an out-of-stock code with the mandated sentence", () => {
    const suggestion = toProductSuggestion(
      product({
        inventory: { status: "blocked", stock: 0, reason: "OUT_OF_STOCK", operatorMessage: null },
        composable: false,
        blockedReason: { code: "OUT_OF_STOCK", userMessage: "Tồn kho bằng 0" },
      }),
    );

    expect(suggestion.disabled).toBe(true);
    expect(suggestion.blockedMessage).toBe("Mã MGKVX6310 đã hết hàng — không đăng");
    expect(suggestion.meta).toContain("hết hàng");
  });

  it("says hết hàng even when the server forgot to fill blockedReason", () => {
    const suggestion = toProductSuggestion(
      product({
        inventory: { status: "blocked", stock: null, reason: null, operatorMessage: null },
        composable: false,
        blockedReason: null,
      }),
    );

    expect(suggestion.blockedMessage).toBe(outOfStockMessage("MGKVX6310"));
  });

  it("keeps the server's own reason for a non-stock refusal", () => {
    const suggestion = toProductSuggestion(
      product({
        composable: false,
        blockedReason: { code: "MEDIA_NOT_FOUND", userMessage: "Mã này chưa có ảnh trên Drive" },
      }),
    );

    expect(suggestion.disabled).toBe(true);
    expect(suggestion.blockedMessage).toBe("Mã này chưa có ảnh trên Drive");
  });

  it("still refuses a non-composable code that came back with no reason at all", () => {
    const suggestion = toProductSuggestion(product({ composable: false, blockedReason: null }));

    expect(suggestion.disabled).toBe(true);
    expect(suggestion.blockedMessage).not.toBeNull();
    expect(suggestion.blockedMessage).not.toBe("");
  });

  it("does not present an empty name as a blank row", () => {
    expect(toProductSuggestion(product({ name: "   " })).name).toBe("(chưa có tên trên Sheet)");
  });

  it("distinguishes 'no stock figure' from 'zero'", () => {
    expect(toProductSuggestion(product({ inventory: { status: "low_stock", stock: null, reason: null, operatorMessage: null } })).meta).toContain(
      "chưa có số tồn",
    );
    expect(toProductSuggestion(product({ inventory: { status: "low_stock", stock: 0, reason: null, operatorMessage: null } })).meta).toContain(
      "tồn 0",
    );
  });

  it("names a code with no files at all", () => {
    expect(toProductSuggestion(product({ mediaImageCount: 0, mediaVideoCount: 0 })).meta).toContain(
      "chưa có file",
    );
  });

  it("lets a healthy code through", () => {
    const suggestion = toProductSuggestion(product());

    expect(suggestion.disabled).toBe(false);
    expect(suggestion.blockedMessage).toBeNull();
    expect(suggestion.meta).toBe("tồn 62 · 8 file");
  });
});

describe("nextHighlight", () => {
  it("answers -1 on an empty list, whichever way the arrow points", () => {
    expect(nextHighlight(-1, 1, 0)).toBe(-1);
    expect(nextHighlight(2, -1, 0)).toBe(-1);
  });

  it("enters the list from the right end", () => {
    expect(nextHighlight(-1, 1, 3)).toBe(0);
    expect(nextHighlight(-1, -1, 3)).toBe(2);
  });

  it("wraps at both ends", () => {
    expect(nextHighlight(2, 1, 3)).toBe(0);
    expect(nextHighlight(0, -1, 3)).toBe(2);
  });

  it("moves one step in the middle", () => {
    expect(nextHighlight(0, 1, 3)).toBe(1);
    expect(nextHighlight(2, -1, 3)).toBe(1);
  });
});
