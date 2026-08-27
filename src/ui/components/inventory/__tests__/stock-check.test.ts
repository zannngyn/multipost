import { describe, expect, it } from "vitest";

import {
  STOCK_CHECK_SKIPPED_LABEL,
  STOCK_CHECK_SKIPPED_TITLE,
  firstSkippedReason,
  hasSkippedStockCheck,
  stockCellText,
  stockCheckSkippedDescription,
  stockLabel,
  type StockDecisionView,
} from "@/ui/components/inventory/stock-check";

/**
 * Edge cases first (CLAUDE.md technical rule 1). The one that matters most is
 * the pair `status: "in_stock"` + `stockCheckSkipped: true`: that combination is
 * legal, it is what a `disabled` policy produces, and printing "Còn hàng" for it
 * is the business-rule failure this module was written to make impossible.
 */

function decision(overrides: Partial<StockDecisionView> = {}): StockDecisionView {
  return {
    status: "in_stock",
    stock: 104,
    stockCheckSkipped: false,
    stockCheckSkippedReason: null,
    ...overrides,
  };
}

describe("stockLabel", () => {
  it("never says 'Còn hàng' when the check was skipped, even though status is in_stock", () => {
    const view = stockLabel(decision({ stockCheckSkipped: true, stockCheckSkippedReason: "Kho ngoài hệ thống" }));

    expect(view.isSkipped).toBe(true);
    expect(view.tone).toBe("danger");
    expect(view.label).toBe(STOCK_CHECK_SKIPPED_LABEL);
    expect(view.label).not.toContain("Còn hàng");
  });

  it("keeps the skipped wording even for a blocked row (conflict / HẾT HÀNG note)", () => {
    const view = stockLabel(decision({ status: "blocked", stock: null, stockCheckSkipped: true }));

    expect(view.label).toBe(STOCK_CHECK_SKIPPED_LABEL);
    expect(view.tone).toBe("danger");
  });

  it("answers 'chưa đọc được' for a missing decision instead of guessing", () => {
    const view = stockLabel(null);

    expect(view.isSkipped).toBe(false);
    expect(view.label).toBe("Chưa đọc được tồn");
    expect(view.tone).toBe("warning");
  });

  it.each([
    ["in_stock", "Còn hàng", "success"],
    ["low_stock", "Tồn thấp", "warning"],
    ["blocked", "Bị chặn", "danger"],
  ] as const)("names %s as %s when the check really ran", (status, label, tone) => {
    const view = stockLabel(decision({ status }));

    expect(view.label).toBe(label);
    expect(view.tone).toBe(tone);
    expect(view.isSkipped).toBe(false);
  });
});

describe("stockCellText", () => {
  it("replaces the number with the skipped wording — a raw count would read as counted", () => {
    expect(stockCellText(decision({ stock: 62, stockCheckSkipped: true }))).toBe(
      STOCK_CHECK_SKIPPED_LABEL,
    );
  });

  it("shows a dash, never 0, for an empty or non-numeric Sheet cell", () => {
    expect(stockCellText(decision({ stock: null }))).toBe("—");
    expect(stockCellText(null)).toBe("—");
  });

  it("formats a real count", () => {
    expect(stockCellText(decision({ stock: 1042 }))).toBe(
      new Intl.NumberFormat("vi-VN").format(1042),
    );
  });
});

describe("stockCheckSkippedDescription", () => {
  it("quotes the declared reason", () => {
    const text = stockCheckSkippedDescription("Tồn kho quản lý ở phần mềm khác");

    expect(text).toContain("Tồn kho quản lý ở phần mềm khác");
    expect(text).toContain("Kết nối dữ liệu");
  });

  it("still warns when no reason was stored, without printing empty quotes", () => {
    const text = stockCheckSkippedDescription("   ");

    expect(text).not.toContain("“”");
    expect(text).toContain("KHÔNG");
  });

  /*
   * Regression, found by looking at a real screen: the banner used to say the
   * system "KHÔNG chặn mã đã hết hàng — mọi mã đều đăng được", on a catalog that
   * was at that moment showing a code blocked by the sold-out note. The note
   * rule and the row-conflict rule run in all three policy modes, so the claim
   * was false exactly where it was loudest, and an operator could not use it to
   * answer "vì sao mã này không lên" (CLAUDE.md technical rule 6).
   */
  it("does not claim every code can be posted — the note and conflict rules still block", () => {
    const text = stockCheckSkippedDescription("Tồn kho ở phần mềm khác");

    expect(text).not.toContain("mọi mã đều đăng được");
    expect(text).not.toContain("KHÔNG chặn mã đã hết hàng");
  });

  it("names what stopped being checked and what still blocks", () => {
    const text = stockCheckSkippedDescription(null);

    // What stopped: the NUMBER on the sheet.
    expect(text).toContain("ô tồn trống");
    expect(text).toContain("bằng 0");
    // What remains, in all three modes.
    expect(text).toContain("HẾT HÀNG");
    expect(text).toContain("nhiều dòng dữ liệu khác nhau");
  });

  it("keeps the title inside the same narrow claim", () => {
    expect(STOCK_CHECK_SKIPPED_TITLE).toContain("số tồn");
    expect(STOCK_CHECK_SKIPPED_TITLE).not.toContain("mọi mã");
  });

  /**
   * Onboarding phase 3: the catalog behind these words may be a Google tab, an
   * uploaded CSV, or a product typed on the compose screen. Naming one of the
   * three sends the other two looking for a spreadsheet they do not have.
   */
  it("does not send the operator to a Google Sheet that may not exist", () => {
    expect(STOCK_CHECK_SKIPPED_TITLE).not.toMatch(/Sheet/i);
    expect(stockCheckSkippedDescription(null)).not.toMatch(/Sheet/i);
    expect(stockCheckSkippedDescription("Bán theo đơn đặt")).not.toMatch(/Sheet/i);
  });
});

describe("screen-level helpers", () => {
  const rows = [
    { inventory: decision({ stockCheckSkipped: true, stockCheckSkippedReason: null }) },
    { inventory: decision({ stockCheckSkipped: true, stockCheckSkippedReason: "Bán theo đơn đặt" }) },
  ];

  it("detects a skipped check anywhere on screen", () => {
    expect(hasSkippedStockCheck(rows)).toBe(true);
    expect(hasSkippedStockCheck([{ inventory: decision() }])).toBe(false);
    expect(hasSkippedStockCheck([])).toBe(false);
  });

  it("takes the first reason that was actually written, not the first row", () => {
    expect(firstSkippedReason(rows)).toBe("Bán theo đơn đặt");
    expect(firstSkippedReason([{ inventory: decision() }])).toBeNull();
  });
});
