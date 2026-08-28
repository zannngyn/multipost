import { describe, expect, it } from "vitest";

import { evaluateProductInventory } from "../inventory";
import { buildManualProduct } from "../manual-product";
import { toPromptInput } from "../product";

/** Edge cases first (CLAUDE.md technical rule 1). */

const VALID = { name: "Váy Giannal", stockRaw: "12" };

describe("buildManualProduct — refusals", () => {
  it.each([
    ["empty", ""],
    ["too short", "AB"],
    ["lower case with spaces", "ma san pham"],
    ["not a string", 42],
  ])("refuses a code that is %s", (_label, code) => {
    expect(() => buildManualProduct(code as string, VALID)).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("refuses a product without a name — the caption opens with it", () => {
    expect(() => buildManualProduct("MGKVX6310", { name: "   " })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("refuses an unknown field instead of stripping it (whitelist, rule 2)", () => {
    let thrown: unknown;
    try {
      buildManualProduct("MGKVX6310", { ...VALID, price: "1.450.000" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "MANUAL_PRODUCT_INVALID" },
    });
  });

  it.each([
    ["name", "x".repeat(201)],
    ["description", "x".repeat(2001)],
    ["season", "x".repeat(101)],
  ])("refuses an over-long %s", (field, value) => {
    expect(() => buildManualProduct("MGKVX6310", { ...VALID, [field]: value })).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });
});

describe("buildManualProduct — what it produces", () => {
  it("carries origin 'manual' and no sheet rows", () => {
    const product = buildManualProduct("mgkvx6310", VALID);
    expect(product.origin).toBe("manual");
    expect(product.sourceRows).toEqual([]);
    expect(product.hasConflict).toBe(false);
    expect(product.content.code).toBe("MGKVX6310");
  });

  it("puts exactly the four whitelisted fields into the prompt input", () => {
    const product = buildManualProduct("MGKVX6310", {
      name: "Váy Giannal",
      description: "Váy dáng xoè",
      category: "Váy",
      season: "Xuân hè 2026",
      stockRaw: "12",
      noteRaw: "Không nhận sx 1c",
    });

    expect(toPromptInput(product)).toEqual({
      code: "MGKVX6310",
      name: "Váy Giannal",
      description: "Váy dáng xoè",
      category: "Váy",
      season: "Xuân hè 2026",
    });
    // The operational half stays out of the prompt object entirely.
    expect(Object.keys(toPromptInput(product))).not.toContain("stockRaw");
    expect(product.operational).toEqual({
      stockRaw: "12",
      noteRaw: "Không nhận sx 1c",
      colorsRaw: "",
    });
  });

  it("turns blank optional fields into null, never into empty strings", () => {
    const product = buildManualProduct("MGKVX6310", {
      ...VALID,
      description: "  ",
      category: null,
    });
    expect(product.content.description).toBeNull();
    expect(product.content.category).toBeNull();
    expect(product.content.season).toBeNull();
  });
});

describe("buildManualProduct — the stock gate judges it like any other product", () => {
  it("blocks when the operator typed no stock at all", () => {
    const decision = evaluateProductInventory(buildManualProduct("MGKVX6310", { name: "Váy" }));
    expect(decision).toMatchObject({ blocked: true, reason: "STOCK_EMPTY" });
  });

  it.each([
    ["0", "STOCK_ZERO"],
    ["còn ít", "STOCK_NOT_A_NUMBER"],
    ["-4", "STOCK_ZERO"],
  ])("blocks a typed stock of '%s'", (stockRaw, reason) => {
    const decision = evaluateProductInventory(buildManualProduct("MGKVX6310", { name: "V", stockRaw }));
    expect(decision).toMatchObject({ blocked: true, reason });
  });

  it("blocks when the typed note says HẾT HÀNG, whatever the number says", () => {
    const decision = evaluateProductInventory(
      buildManualProduct("MGKVX6310", { name: "V", stockRaw: "50", noteRaw: "hết hàng" }),
    );
    expect(decision).toMatchObject({ blocked: true, reason: "NOTE_SOLD_OUT" });
  });

  it("warns on a typed low stock, exactly like a sheet row", () => {
    const decision = evaluateProductInventory(
      buildManualProduct("MGKVX6310", { name: "V", stockRaw: "2" }),
    );
    expect(decision).toMatchObject({ blocked: false, status: "low_stock", stock: 2 });
  });

  it("allows a typed stock above the threshold", () => {
    const decision = evaluateProductInventory(
      buildManualProduct("MGKVX6310", { name: "V", stockRaw: "12" }),
    );
    expect(decision).toMatchObject({ blocked: false, status: "in_stock", stock: 12 });
  });

  it("blocks a word the tenant never declared under a textual policy", () => {
    const product = buildManualProduct("MGKVX6310", { name: "V", stockRaw: "sắp về" });
    const decision = evaluateProductInventory(product, {
      mode: "textual",
      inStockValues: ["còn hàng"],
      outOfStockValues: ["hết hàng"],
    });
    expect(decision).toMatchObject({ blocked: true, reason: "STOCK_TEXT_UNKNOWN" });
  });
});
