import { describe, expect, it } from "vitest";

import type { CatalogProduct } from "@/ui/schemas/catalog.schema";

import {
  nextHighlight,
  outOfStockMessage,
  selectableSuggestions,
  suggestionEmptyState,
  suggestionFooterText,
  toProductSuggestion,
} from "../product-suggestions";

function product(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    code: "MGKVX6310",
    name: "Váy xoè hoa nhí",
    category: "Váy",
    season: "Hè",
    inventory: { status: "in_stock", stock: 62, reason: null, operatorMessage: null , stockCheckSkipped: false, stockCheckSkippedReason: null},
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
        inventory: { status: "blocked", stock: 0, reason: "OUT_OF_STOCK", operatorMessage: null , stockCheckSkipped: false, stockCheckSkippedReason: null},
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
        inventory: { status: "blocked", stock: null, reason: null, operatorMessage: null , stockCheckSkipped: false, stockCheckSkippedReason: null},
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
    // Source-neutral since onboarding phase 3: the row behind a suggestion may
    // be a Google tab, an uploaded CSV, or a product typed on the compose screen.
    expect(toProductSuggestion(product({ name: "   " })).name).toBe("(chưa có tên trong dữ liệu)");
  });

  it("distinguishes 'no stock figure' from 'zero'", () => {
    expect(toProductSuggestion(product({ inventory: { status: "low_stock", stock: null, reason: null, operatorMessage: null , stockCheckSkipped: false, stockCheckSkippedReason: null} })).meta).toContain(
      "chưa có số tồn",
    );
    expect(toProductSuggestion(product({ inventory: { status: "low_stock", stock: 0, reason: null, operatorMessage: null , stockCheckSkipped: false, stockCheckSkippedReason: null} })).meta).toContain(
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

/*
 * This module was the last place in the UI that read `inventory.status` to
 * describe stock. With the gate off every row printed "chưa có số tồn" — not a
 * lie, but it hid the fact that nobody counted, and it disagreed with the
 * catalog table, the inspector and the compose line, which all say "không kiểm
 * tồn". One vocabulary, from `stock-check.ts`.
 */
describe("tenant with the stock gate off", () => {
  function skipped(overrides: Partial<CatalogProduct["inventory"]> = {}) {
    return product({
      inventory: {
        status: "in_stock",
        stock: 62,
        reason: null,
        operatorMessage: null,
        stockCheckSkipped: true,
        stockCheckSkippedReason: "Tồn kho ở phần mềm khác",
        ...overrides,
      },
    });
  }

  it("says 'không kiểm tồn' instead of a count nobody made", () => {
    const suggestion = toProductSuggestion(skipped());

    expect(suggestion.meta).toContain("không kiểm tồn");
    expect(suggestion.meta).not.toContain("tồn 62");
    expect(suggestion.meta).not.toContain("chưa có số tồn");
  });

  it("does not blame the stock count for a row blocked by another rule", () => {
    // `blocked` while the gate is off means the sold-out note or two sheet rows
    // disagreeing — never a number. "đã hết hàng" would point at the wrong cell.
    const suggestion = toProductSuggestion(
      skipped({ status: "blocked", stock: null, reason: "NOTE_SOLD_OUT" }),
    );

    expect(suggestion.disabled).toBe(true);
    expect(suggestion.blockedMessage).not.toContain("đã hết hàng");
  });
});

/**
 * What the picker may OFFER, and what it says when it can offer nothing.
 *
 * The rule is business rule 1 read forwards: a code that cannot be posted is
 * not shown greyed out, it is absent — and the count of what was left out is
 * still stated, so "ẩn" never reads as "không tồn tại".
 */
describe("selectableSuggestions", () => {
  // --- Edge cases first ------------------------------------------------------
  it("answers an empty list for no products at all", () => {
    expect(selectableSuggestions([])).toEqual([]);
  });

  it("drops a blocked row even when the server called it composable", () => {
    // The two verdicts come from different code. They must not be able to put an
    // un-postable code back into the picker by disagreeing.
    const rows = selectableSuggestions([
      product({
        composable: true,
        inventory: {
          status: "blocked",
          stock: 0,
          reason: "STOCK_ZERO",
          operatorMessage: null,
          stockCheckSkipped: false,
          stockCheckSkippedReason: null,
        },
      }),
    ]);

    expect(rows).toEqual([]);
  });

  it("drops a code the server refused for any other reason", () => {
    expect(
      selectableSuggestions([
        product({
          code: "MGKVX0001",
          composable: false,
          blockedReason: { code: "NO_MEDIA", userMessage: "Chưa có ảnh nào trên Drive." },
        }),
      ]),
    ).toEqual([]);
  });

  // --- The happy path --------------------------------------------------------
  it("keeps postable codes, in the order the catalog answered", () => {
    const rows = selectableSuggestions([
      product({ code: "MGKVX0001" }),
      product({
        code: "MGKVX0002",
        composable: false,
        blockedReason: { code: "NO_MEDIA", userMessage: "Chưa có ảnh." },
      }),
      product({ code: "MGKVX0003" }),
    ]);

    expect(rows.map((row) => row.code)).toEqual(["MGKVX0001", "MGKVX0003"]);
    // Nothing that survives may carry a refusal — the row has no place to show it.
    expect(rows.every((row) => row.blockedMessage === null)).toBe(true);
  });
});

describe("suggestionEmptyState", () => {
  it("blames the blocked codes BEFORE the search — the one branch a match can reach", () => {
    const state = suggestionEmptyState("MGKVX", 4);

    expect(state.title).toBe("Không có mã nào đăng được");
    expect(state.hint).toContain("4 mã đang vướng");
    expect(state.hint).toContain("màn Sản phẩm");
    // Saying "không có mã nào khớp" here is the lie the product screen contradicts.
    expect(state.title).not.toContain("khớp");
  });

  it("sends an unsynced tenant to the sync, not to a search that cannot help", () => {
    const state = suggestionEmptyState("   ", 0);

    expect(state.title).toBe("Danh mục đang trống");
    expect(state.hint).toContain("đồng bộ");
  });

  it("names the search back when nothing matched it", () => {
    const state = suggestionEmptyState("  MGKVX  ", 0);

    expect(state.title).toContain("MGKVX");
    // A code typed in full is still the way out of an empty list.
    expect(state.hint).toContain("gõ thẳng");
  });
});

describe("suggestionFooterText", () => {
  it("says the list is capped, so a big match count is not read as a long list", () => {
    const text = suggestionFooterText(120, 0, 8);

    expect(text).toContain("tối đa 8 mã");
    expect(text).toContain("Khớp 120 mã đăng được");
    expect(text).toContain("gõ thẳng");
  });

  it("counts what it hid, and where to go read why", () => {
    expect(suggestionFooterText(3, 5, 8)).toContain("ẩn 5 mã đang vướng");
  });

  it("stays silent about hidden codes when none were hidden", () => {
    expect(suggestionFooterText(3, 0, 8)).not.toContain("ẩn");
  });
});
