import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ProductInspectorDrawer } from "@/ui/components/products/ProductInspectorDrawer";
import type { ProductInspectorState } from "@/ui/components/products/product-inspector-state";
import type { CatalogProduct } from "@/ui/schemas/catalog.schema";

/**
 * The drawer's promises, asserted on real markup.
 *
 * WHY `renderToStaticMarkup` AND NOT A DOM TEST: `vitest.config.ts` runs
 * `environment: "node"` and the repo has no jsdom or testing-library — adding
 * either is a dependency decision this ticket does not authorise (same reasoning
 * as `calendar-render.test.tsx`). Server rendering still catches the regression
 * that matters: the drawer losing the ONE action a narrow viewport has no other
 * route to.
 *
 * What this cannot cover, and what covers it instead: the geometry (is the body
 * scrollable, is "Soạn bài" inside the viewport) needs a layout engine, so it is
 * measured in a real browser at 390×844 and 195×422 — see the task report.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

function product(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    code: "MGKVX6310",
    name: "Giannal",
    category: "Áo cộc tay",
    season: "Xuân hè 2026",
    inventory: { status: "in_stock", stock: 12, reason: null, operatorMessage: null },
    mediaImageCount: 8,
    mediaVideoCount: 0,
    hasConflict: false,
    composable: true,
    blockedReason: null,
    ...overrides,
  };
}

function render(state: ProductInspectorState, recovery: Parameters<typeof ProductInspectorDrawer>[0]["recovery"] = null): string {
  return renderToStaticMarkup(
    <ProductInspectorDrawer state={state} isOpen onClose={() => {}} recovery={recovery} />,
  );
}

describe("ProductInspectorDrawer", () => {
  it("renders nothing when closed", () => {
    expect(
      renderToStaticMarkup(
        <ProductInspectorDrawer
          state={{ kind: "product", product: product() }}
          isOpen={false}
          onClose={() => {}}
          recovery={null}
        />,
      ),
    ).toBe("");
  });

  it("puts the composable product's one action inside the dialog", () => {
    // The wave-1 P1 bug: below 1024px the inspector was dropped entirely, so
    // "Soạn bài" — the only route from this screen into the wizard — did not
    // exist on a phone. It must be in the markup, and inside the <dialog>.
    const markup = render({ kind: "product", product: product() });

    expect(markup).toContain("<dialog");
    expect(markup).toContain("Soạn bài");
    expect(markup.indexOf("Soạn bài")).toBeGreaterThan(markup.indexOf("<dialog"));
  });

  it("names the product and its code in the dialog header", () => {
    const markup = render({ kind: "product", product: product() });

    expect(markup).toContain("Chi tiết sản phẩm");
    expect(markup).toContain("MGKVX6310");
  });

  it("does not offer to compose a blocked product, and says why instead", () => {
    const markup = render({
      kind: "product",
      product: product({
        composable: false,
        inventory: { status: "blocked", stock: 0, reason: "NOTE_SOLD_OUT", operatorMessage: null },
        blockedReason: {
          code: "OUT_OF_STOCK",
          userMessage: "Mã MGKVX6310 đã hết hàng — không đăng",
        },
      }),
    });

    expect(markup).not.toContain("Soạn bài");
    expect(markup).toContain("đã hết hàng — không đăng");
  });

  it("keeps the code's heading below the dialog title's h2", () => {
    // DialogHeader owns h2; a second h2 here would announce two peer sections.
    const markup = render({ kind: "product", product: product() });

    expect(markup).toContain("<h3");
  });

  it("gives the missing state a button inside the modal, not an instruction about the page behind", () => {
    const markup = render(
      { kind: "missing", code: "MGKVX9999" },
      { kind: "clear-filter", label: "Bỏ bộ lọc và tìm lại", onPress: () => {} },
    );

    expect(markup).toContain("Không thấy mã MGKVX9999");
    expect(markup).toContain("Bỏ bộ lọc và tìm lại");
    expect(markup).toContain("Bộ lọc đang bật");
    // The old copy pointed at controls the dialog had just made inert.
    expect(markup).not.toContain("rồi bấm");
  });

  it("blames the unfetched pages, not a filter, when there is no filter", () => {
    const markup = render(
      { kind: "missing", code: "MGKVX9999" },
      { kind: "load-more", label: "Tải thêm sản phẩm", onPress: () => {} },
    );

    expect(markup).toContain("Tải thêm sản phẩm");
    expect(markup).not.toContain("Bộ lọc đang bật");
  });

  it("says the code is simply not there when no action would help", () => {
    const markup = render({ kind: "missing", code: "MGKVX9999" }, null);

    expect(markup).toContain("Danh sách đã tải hết");
    expect(markup).not.toContain("Bỏ bộ lọc và tìm lại");
  });

  it("shows a loading answer rather than a false miss", () => {
    const markup = render({ kind: "loading", code: "MGKVX6310" });

    expect(markup).toContain("Đang mở mã MGKVX6310");
    expect(markup).not.toContain("Không thấy mã");
  });
});
