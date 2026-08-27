import { describe, expect, it } from "vitest";

import { evaluateInventory, evaluateProductInventory, LOW_STOCK_THRESHOLD } from "../inventory";
import type { Product } from "../product";

const base = { productCode: "MR0AC6080", stockRaw: "10", noteRaw: "" };

describe("evaluateInventory — blocking branches first (brief section 3)", () => {
  it("blocks when the sheet rows for one code conflict", () => {
    const decision = evaluateInventory({ ...base, hasConflict: true });
    expect(decision).toMatchObject({ blocked: true, reason: "SHEET_ROW_CONFLICT" });
    expect(decision.operatorMessage).toContain("MR0AC6080");
  });

  it("blocks on note 'HẾT HÀNG' whatever the stock says", () => {
    for (const stockRaw of ["0", "50", "", "abc"]) {
      const decision = evaluateInventory({ ...base, stockRaw, noteRaw: "HẾT HÀNG" });
      expect(decision).toMatchObject({ blocked: true, reason: "NOTE_SOLD_OUT", status: "blocked" });
    }
  });

  it.each(["hết hàng", "Hết Hàng", "HET HANG", " HẾT HÀNG "])(
    "matches the sold-out note written as '%s'",
    (noteRaw) => {
      expect(evaluateInventory({ ...base, noteRaw }).reason).toBe("NOTE_SOLD_OUT");
    },
  );

  it("blocks an empty stock cell (5 real rows, docs/05 section 2.2)", () => {
    for (const stockRaw of ["", "   "]) {
      const decision = evaluateInventory({ ...base, stockRaw });
      expect(decision).toMatchObject({ blocked: true, reason: "STOCK_EMPTY", stock: null });
    }
  });

  it.each(["abc", "3 cái", "còn ít", "-", "N/A", "1e3", "3.5"])(
    "blocks a non-numeric stock cell '%s'",
    (stockRaw) => {
      const decision = evaluateInventory({ ...base, stockRaw });
      expect(decision).toMatchObject({ blocked: true, reason: "STOCK_NOT_A_NUMBER" });
    },
  );

  it("blocks stock 0 even when the note says production is possible", () => {
    const decision = evaluateInventory({
      productCode: "MG0SQ6042",
      stockRaw: "0",
      noteRaw: "Không nhận sx 1c",
    });
    expect(decision).toMatchObject({ blocked: true, reason: "STOCK_ZERO", stock: 0 });
    expect(decision.operatorMessage).toBe("Mã MG0SQ6042 đã hết hàng — không đăng");
  });

  it("blocks negative stock", () => {
    expect(evaluateInventory({ ...base, stockRaw: "-2" })).toMatchObject({
      blocked: true,
      reason: "STOCK_ZERO",
    });
  });

  it("survives malformed input objects", () => {
    const decision = evaluateInventory({
      productCode: undefined as unknown as string,
      stockRaw: undefined as unknown as string,
      noteRaw: undefined as unknown as string,
    });
    expect(decision).toMatchObject({ blocked: true, reason: "STOCK_EMPTY" });
  });
});

describe("evaluateInventory — allowed branches", () => {
  it.each([1, 2, 3])("posts stock %i with an internal low-stock warning", (stock) => {
    const decision = evaluateInventory({
      productCode: "MG0VS6111",
      stockRaw: String(stock),
      noteRaw: "Không nhận sx 1c",
    });
    expect(decision).toMatchObject({ blocked: false, status: "low_stock", stock });
    expect(decision.operatorMessage).toBe(`Tồn thấp ${stock}c — Không nhận sx 1c`);
  });

  it("posts stock above the threshold with no warning", () => {
    const decision = evaluateInventory({ ...base, stockRaw: "39", noteRaw: "Không nhận sx 1c" });
    expect(decision).toMatchObject({
      blocked: false,
      status: "in_stock",
      stock: 39,
      operatorMessage: null,
    });
  });

  it("treats the unknown note 'Không cần cọc' as non-blocking", () => {
    // PENDING(docs/05 section 7 question 4): meaning not confirmed yet; it must
    // not silently block, and it must not silently leak into a caption either.
    const decision = evaluateInventory({ ...base, stockRaw: "5", noteRaw: "Không cần cọc" });
    expect(decision.blocked).toBe(false);
  });

  it("accepts thousand separators in the stock cell", () => {
    expect(evaluateInventory({ ...base, stockRaw: "1.234" }).stock).toBe(1234);
    expect(evaluateInventory({ ...base, stockRaw: " 371 " }).stock).toBe(371);
  });

  it("keeps the documented low-stock threshold", () => {
    expect(LOW_STOCK_THRESHOLD).toBe(3);
    expect(evaluateInventory({ ...base, stockRaw: "4" }).status).toBe("in_stock");
  });
});

describe("evaluateProductInventory", () => {
  const product: Product = {
    content: { code: "MR0AC6080", name: "Penny", description: null, category: null, season: null },
    operational: { stockRaw: "0", noteRaw: "HẾT HÀNG", colorsRaw: "TRẮNG TIÊU" },
    hasConflict: false,
    sourceRows: [2],
  };

  it("reads stock straight from the operational half of the product", () => {
    expect(evaluateProductInventory(product)).toMatchObject({
      blocked: true,
      reason: "NOTE_SOLD_OUT",
    });
  });

  it("propagates the conflict flag", () => {
    expect(evaluateProductInventory({ ...product, hasConflict: true }).reason).toBe(
      "SHEET_ROW_CONFLICT",
    );
  });
});
