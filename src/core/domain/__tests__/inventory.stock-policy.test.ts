import { describe, expect, it } from "vitest";

import type { StockPolicy, TextualStockPolicy } from "../catalog-field-map";
import { evaluateInventory, evaluateProductInventory } from "../inventory";
import type { Product } from "../product";

/**
 * Decision table under the three stock policies (onboarding phase 1).
 * The numeric branch keeps its own suite in inventory.test.ts — this file only
 * covers what the policies added, blocking branches first.
 */

const base = { productCode: "MG0VS6111", stockRaw: "3", noteRaw: "" };

const textual: TextualStockPolicy = {
  mode: "textual",
  inStockValues: ["Còn hàng", "Sẵn hàng"],
  outOfStockValues: ["Hết hàng", "Ngừng bán"],
};

const disabled: StockPolicy = {
  mode: "disabled",
  reason: "Khách quản lý tồn kho trên phần mềm riêng, không ghi trên Sheet",
};

function product(overrides: Partial<Product["operational"]> = {}): Product {
  return {
    content: { code: "MG0VS6111", name: "Pavly", description: null, category: null, season: null },
    operational: { stockRaw: "3", noteRaw: "", colorsRaw: "KEM, NÂU", ...overrides },
    hasConflict: false,
    sourceRows: [12],
  };
}

describe("stock policy — an unusable policy blocks", () => {
  it.each([
    { mode: "disabled" } as unknown as StockPolicy,
    { mode: "disabled", reason: "  " } as StockPolicy,
    { mode: "textual", inStockValues: [], outOfStockValues: [] } as StockPolicy,
    { mode: "khong-kiem" } as unknown as StockPolicy,
  ])("refuses to post under %o", (policy) => {
    const decision = evaluateInventory({ ...base, stockRaw: "50" }, policy);
    expect(decision).toMatchObject({ blocked: true, reason: "STOCK_POLICY_INVALID" });
    expect(decision.stockCheckSkipped).toBe(false);
  });

  it("blocks even when the policy claims stock is not tracked", () => {
    // The whole point: a `disabled` policy without a reason is NOT a licence.
    const decision = evaluateInventory(base, { mode: "disabled", reason: "" } as StockPolicy);
    expect(decision.blocked).toBe(true);
  });
});

describe("stock policy — textual (edge cases first)", () => {
  it("blocks an empty cell", () => {
    for (const stockRaw of ["", "   "]) {
      expect(evaluateInventory({ ...base, stockRaw }, textual)).toMatchObject({
        blocked: true,
        reason: "STOCK_EMPTY",
        policyMode: "textual",
      });
    }
  });

  it.each(["sắp về", "10", "?", "còn ít"])("blocks the undeclared value '%s'", (stockRaw) => {
    const decision = evaluateInventory({ ...base, stockRaw }, textual);
    expect(decision).toMatchObject({ blocked: true, reason: "STOCK_TEXT_UNKNOWN" });
    expect(decision.operatorMessage).toContain(stockRaw);
  });

  it.each(["Hết hàng", "HET HANG", " hết  hàng ", "Ngừng bán"])(
    "blocks the out-of-stock wording '%s'",
    (stockRaw) => {
      expect(evaluateInventory({ ...base, stockRaw }, textual)).toMatchObject({
        blocked: true,
        reason: "STOCK_TEXT_OUT_OF_STOCK",
      });
    },
  );

  it("still blocks on the sold-out note whatever the cell says", () => {
    expect(
      evaluateInventory({ ...base, stockRaw: "Còn hàng", noteRaw: "HẾT HÀNG" }, textual),
    ).toMatchObject({ blocked: true, reason: "NOTE_SOLD_OUT" });
  });

  it("still blocks a conflicting sheet row", () => {
    expect(
      evaluateInventory({ ...base, stockRaw: "Còn hàng", hasConflict: true }, textual),
    ).toMatchObject({ blocked: true, reason: "SHEET_ROW_CONFLICT" });
  });

  it.each(["Còn hàng", "con hang", "SẴN HÀNG"])("allows the in-stock wording '%s'", (stockRaw) => {
    const decision = evaluateInventory({ ...base, stockRaw }, textual);
    expect(decision).toMatchObject({
      blocked: false,
      status: "in_stock",
      policyMode: "textual",
      stock: null,
      stockCheckSkipped: false,
    });
  });

  it("does not invent a low-stock tier when there is no number", () => {
    expect(evaluateInventory({ ...base, stockRaw: "Còn hàng" }, textual).status).not.toBe(
      "low_stock",
    );
  });
});

describe("stock policy — disabled", () => {
  it("allows posting but never claims the item is in stock silently", () => {
    const decision = evaluateInventory({ ...base, stockRaw: "" }, disabled);
    expect(decision).toMatchObject({
      blocked: false,
      policyMode: "disabled",
      stockCheckSkipped: true,
    });
    expect(decision.stockCheckSkippedReason).toBe(
      "Khách quản lý tồn kho trên phần mềm riêng, không ghi trên Sheet",
    );
    expect(decision.operatorMessage).toContain("tắt kiểm tồn kho");
  });

  it("keeps the sold-out note as a block (out of stock always wins)", () => {
    expect(evaluateInventory({ ...base, noteRaw: "HẾT HÀNG" }, disabled)).toMatchObject({
      blocked: true,
      reason: "NOTE_SOLD_OUT",
      stockCheckSkipped: false,
    });
  });

  it("keeps a sheet-row conflict as a block", () => {
    expect(evaluateInventory({ ...base, hasConflict: true }, disabled)).toMatchObject({
      blocked: true,
      reason: "SHEET_ROW_CONFLICT",
    });
  });

  it("ignores a number that happens to be there — nobody checked it", () => {
    const decision = evaluateInventory({ ...base, stockRaw: "0" }, disabled);
    expect(decision.blocked).toBe(false);
    expect(decision.stock).toBeNull();
  });
});

describe("backward compatibility", () => {
  it("defaults to numeric when no policy is passed", () => {
    expect(evaluateInventory({ ...base, stockRaw: "0" })).toMatchObject({
      blocked: true,
      reason: "STOCK_ZERO",
      policyMode: "numeric",
    });
    expect(evaluateInventory({ ...base, stockRaw: "104" })).toMatchObject({
      blocked: false,
      status: "in_stock",
      stock: 104,
      stockCheckSkipped: false,
    });
  });

  it("keeps the low-stock warning of the numeric table (MG0VS6111, Tồn 3)", () => {
    expect(evaluateProductInventory(product())).toMatchObject({
      status: "low_stock",
      stock: 3,
      policyMode: "numeric",
    });
  });

  it("passes a policy through evaluateProductInventory", () => {
    expect(evaluateProductInventory(product({ stockRaw: "Còn hàng" }), textual)).toMatchObject({
      blocked: false,
      policyMode: "textual",
    });
    expect(evaluateProductInventory(product({ stockRaw: "" }), disabled)).toMatchObject({
      blocked: false,
      stockCheckSkipped: true,
    });
  });
});
