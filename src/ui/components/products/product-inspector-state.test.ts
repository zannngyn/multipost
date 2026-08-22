import { describe, expect, it } from "vitest";

import {
  isInspectorDrawerOpen,
  productInspectorState,
  type ProductInspectorState,
} from "@/ui/components/products/product-inspector-state";
import type { CatalogProduct } from "@/ui/schemas/catalog.schema";

function product(code: string): CatalogProduct {
  return {
    code,
    name: `Áo ${code}`,
    category: null,
    season: null,
    inventory: { status: "in_stock", stock: 10, reason: null, operatorMessage: null },
    mediaImageCount: 3,
    mediaVideoCount: 0,
    hasConflict: false,
    composable: true,
    blockedReason: null,
  };
}

const ITEMS = [product("MGKVX6310"), product("MGKVX6311")];

describe("productInspectorState", () => {
  // --- Edge cases first: everything that is NOT a normal row click ----------
  it("treats a missing param as nothing selected", () => {
    expect(productInspectorState(null, ITEMS)).toEqual({ kind: "none" });
  });

  it("treats ?chon= (empty) and whitespace as nothing selected", () => {
    expect(productInspectorState("", ITEMS)).toEqual({ kind: "none" });
    expect(productInspectorState("   ", ITEMS)).toEqual({ kind: "none" });
  });

  it("reports a code that is not among the loaded rows as missing, not as nothing", () => {
    // The bug this guards: a shared link to a code the current filter hides used
    // to render "Chưa chọn sản phẩm nào" — the app denying the ask.
    expect(productInspectorState("MGKVX9999", ITEMS)).toEqual({
      kind: "missing",
      code: "MGKVX9999",
    });
  });

  it("reports missing when nothing is in flight and no page has loaded", () => {
    expect(productInspectorState("MGKVX6310", [])).toEqual({
      kind: "missing",
      code: "MGKVX6310",
    });
  });

  it("says loading, not missing, while the first page is still in flight", () => {
    // The bug this guards: a shared link showed "Không thấy mã …" for the whole
    // first fetch, then swapped it for the product.
    expect(productInspectorState("MGKVX6310", [], { isLoading: true })).toEqual({
      kind: "loading",
      code: "MGKVX6310",
    });
  });

  it("says loading while a refetch has not brought the code back yet", () => {
    expect(productInspectorState("MGKVX9999", ITEMS, { isLoading: true })).toEqual({
      kind: "loading",
      code: "MGKVX9999",
    });
  });

  it("prefers a loaded product over the loading state", () => {
    // A background refetch must not blank an inspector that already has data.
    expect(productInspectorState("MGKVX6310", ITEMS, { isLoading: true })).toEqual({
      kind: "product",
      product: ITEMS[0],
    });
  });

  it("does not match a different casing", () => {
    // Codes are compared exactly everywhere else on this screen; a looser match
    // here would open a product the URL did not name.
    expect(productInspectorState("mgkvx6310", ITEMS)).toEqual({
      kind: "missing",
      code: "mgkvx6310",
    });
  });

  // --- Happy path ----------------------------------------------------------
  it("resolves a loaded code to its product", () => {
    expect(productInspectorState("MGKVX6311", ITEMS)).toEqual({
      kind: "product",
      product: ITEMS[1],
    });
  });

  it("ignores padding around the code", () => {
    expect(productInspectorState(" MGKVX6310 ", ITEMS)).toEqual({
      kind: "product",
      product: ITEMS[0],
    });
  });
});

describe("isInspectorDrawerOpen", () => {
  const none: ProductInspectorState = { kind: "none" };
  const loading: ProductInspectorState = { kind: "loading", code: "MGKVX6310" };
  const missing: ProductInspectorState = { kind: "missing", code: "MGKVX9999" };
  const found: ProductInspectorState = { kind: "product", product: ITEMS[0] };

  it("never opens on a wide viewport — the panel is already showing", () => {
    expect(isInspectorDrawerOpen(false, found)).toBe(false);
    expect(isInspectorDrawerOpen(false, missing)).toBe(false);
    expect(isInspectorDrawerOpen(false, loading)).toBe(false);
    expect(isInspectorDrawerOpen(false, none)).toBe(false);
  });

  it("does not open a modal nobody asked for", () => {
    expect(isInspectorDrawerOpen(true, none)).toBe(false);
  });

  it("opens for a selected code, including one still loading or not on screen", () => {
    expect(isInspectorDrawerOpen(true, found)).toBe(true);
    expect(isInspectorDrawerOpen(true, loading)).toBe(true);
    expect(isInspectorDrawerOpen(true, missing)).toBe(true);
  });
});
