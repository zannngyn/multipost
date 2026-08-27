import { describe, expect, it } from "vitest";

import { legendEntries } from "@/ui/components/products/product-status-legend";
import type { CatalogProduct } from "@/ui/schemas/catalog.schema";

function product(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    code: "MGKVX6310",
    name: "Áo sơ mi",
    category: null,
    season: null,
    inventory: { status: "in_stock", stock: 10, reason: null, operatorMessage: null , stockCheckSkipped: false, stockCheckSkippedReason: null},
    mediaImageCount: 3,
    mediaVideoCount: 0,
    hasConflict: false,
    composable: true,
    blockedReason: null,
    ...overrides,
  };
}

const OK = product();
const LOW = product({
  code: "MGKVX6311",
  inventory: { status: "low_stock", stock: 2, reason: null, operatorMessage: null , stockCheckSkipped: false, stockCheckSkippedReason: null},
});
const BLOCKED = product({
  code: "MGKVX6312",
  composable: false,
  inventory: { status: "blocked", stock: 0, reason: "OUT_OF_STOCK", operatorMessage: null , stockCheckSkipped: false, stockCheckSkippedReason: null},
  blockedReason: { code: "OUT_OF_STOCK", userMessage: "Mã này đã hết hàng — không đăng." },
});

describe("legendEntries", () => {
  // --- Edge cases first ----------------------------------------------------
  it("returns nothing for an empty list — the empty state speaks, not a key", () => {
    expect(legendEntries([])).toEqual([]);
  });

  it("explains only the colours that are on screen", () => {
    // Filter = "Đăng được": naming madder here would describe rows that are not
    // in the table.
    expect(legendEntries([OK, OK]).map((entry) => entry.variant)).toEqual(["success"]);
    expect(legendEntries([BLOCKED]).map((entry) => entry.variant)).toEqual(["error"]);
  });

  it("does not repeat a colour that many rows share", () => {
    expect(legendEntries([BLOCKED, BLOCKED, BLOCKED])).toHaveLength(1);
  });

  // --- Happy path ----------------------------------------------------------
  it("keeps a fixed order regardless of the row order", () => {
    expect(legendEntries([BLOCKED, LOW, OK]).map((entry) => entry.variant)).toEqual([
      "success",
      "warning",
      "error",
    ]);
  });

  it("gives every dot a word", () => {
    for (const entry of legendEntries([OK, LOW, BLOCKED])) {
      expect(entry.label.trim().length).toBeGreaterThan(0);
    }
  });
});
