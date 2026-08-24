import { describe, expect, it } from "vitest";

import {
  DEFAULT_STOCK_POLICY_FORM,
  UNMAPPED_OPTION_VALUE,
  blockingIssues,
  columnOptions,
  issueForField,
  parseValueList,
  priceConfirmationKey,
  priceLikeCaptionAssignments,
  stockPolicyFormFromStored,
  toStockPolicy,
  validateFieldMapValues,
  warningIssues,
} from "@/ui/components/onboarding/field-map-form";
import type { CatalogFieldMap, StockPolicy } from "@/ui/schemas/catalog-mapping.schema";

const COLUMNS = ["Mã SP", "Tên hàng", "Diễn giải", "Tồn", "Ghi chú", "Màu"];

function values(overrides: Partial<CatalogFieldMap> = {}): CatalogFieldMap {
  return {
    code: "Mã SP",
    name: "Tên hàng",
    description: null,
    category: null,
    season: null,
    stock: "Tồn",
    note: null,
    colors: null,
    ...overrides,
  };
}

describe("columnOptions", () => {
  it("offers 'không có cột này' for optional fields only", () => {
    expect(columnOptions("description", COLUMNS, values())[0]?.value).toBe(UNMAPPED_OPTION_VALUE);
    expect(columnOptions("code", COLUMNS, values())[0]?.value).toBe("Mã SP");
  });

  it("shows a column taken by another field as disabled, naming the owner", () => {
    const option = columnOptions("note", COLUMNS, values()).find((entry) => entry.value === "Tồn");

    expect(option?.disabled).toBe(true);
    expect(option?.label).toContain("Tồn kho");
  });

  it("keeps a stored column the sheet no longer has, instead of showing 'chưa chọn'", () => {
    const option = columnOptions("code", COLUMNS, values({ code: "Mã cũ" })).find(
      (entry) => entry.value === "Mã cũ",
    );

    expect(option).toBeDefined();
    expect(option?.label).toContain("không còn trên bảng tính");
  });
});

describe("validateFieldMapValues", () => {
  it("accepts a usable map", () => {
    expect(validateFieldMapValues(values(), COLUMNS)).toEqual([]);
  });

  it("refuses a missing required field and points at it", () => {
    const issues = validateFieldMapValues(values({ name: null }), COLUMNS);

    expect(issueForField(issues, "name")?.severity).toBe("error");
    expect(issueForField(issues, "code")).toBeNull();
  });

  it("refuses one column used by two fields, and marks BOTH fields", () => {
    const issues = validateFieldMapValues(values({ note: "Tồn" }), COLUMNS);

    expect(issueForField(issues, "note")?.message).toContain("Tồn");
    expect(issueForField(issues, "stock")).not.toBeNull();
  });

  it("reports a column that disappeared from the sheet", () => {
    const issues = validateFieldMapValues(values({ colors: "Mau sac" }), COLUMNS);

    expect(issueForField(issues, "colors")?.message).toContain("Không còn cột");
  });

  it("stays quiet about missing columns when the header row could not be read", () => {
    // Eight "cột không tồn tại" would bury the one real problem: no header row.
    const issues = validateFieldMapValues(values(), []);

    expect(issues).toEqual([]);
  });
});

describe("parseValueList", () => {
  it("splits on commas, semicolons and newlines and drops blanks and duplicates", () => {
    expect(parseValueList("còn hàng, còn;\n còn hàng \n\n sẵn")).toEqual([
      "còn hàng",
      "còn",
      "sẵn",
    ]);
  });

  it("answers an empty list for empty input instead of throwing", () => {
    expect(parseValueList("   ")).toEqual([]);
  });
});

describe("toStockPolicy", () => {
  it("passes numeric straight through", () => {
    expect(toStockPolicy({ ...DEFAULT_STOCK_POLICY_FORM, mode: "numeric" })).toEqual({
      ok: true,
      policy: { mode: "numeric" },
    });
  });

  it("REFUSES disabled without a written reason — this is the whole point", () => {
    const result = toStockPolicy({
      ...DEFAULT_STOCK_POLICY_FORM,
      mode: "disabled",
      disabledReason: "vì thế",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toContain("lý do");
  });

  it("accepts disabled with a real reason and trims it", () => {
    const result = toStockPolicy({
      ...DEFAULT_STOCK_POLICY_FORM,
      mode: "disabled",
      disabledReason: "  Tồn kho quản lý ở phần mềm bán hàng khác  ",
    });

    expect(result).toEqual({
      ok: true,
      policy: { mode: "disabled", reason: "Tồn kho quản lý ở phần mềm bán hàng khác" },
    });
  });

  it("refuses a textual policy with an empty list", () => {
    const result = toStockPolicy({
      ...DEFAULT_STOCK_POLICY_FORM,
      mode: "textual",
      outOfStockText: "  ",
    });

    expect(result.ok).toBe(false);
  });

  it("refuses a value declared both in and out of stock, ignoring accents and case", () => {
    const result = toStockPolicy({
      ...DEFAULT_STOCK_POLICY_FORM,
      mode: "textual",
      inStockText: "Còn hàng",
      outOfStockText: "CON HANG",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toContain("vừa được khai");
  });

  it("builds the two lists when they are unambiguous", () => {
    const result = toStockPolicy({
      ...DEFAULT_STOCK_POLICY_FORM,
      mode: "textual",
      inStockText: "còn hàng, sẵn",
      outOfStockText: "hết hàng",
    });

    expect(result).toEqual({
      ok: true,
      policy: { mode: "textual", inStockValues: ["còn hàng", "sẵn"], outOfStockValues: ["hết hàng"] },
    });
  });
});

describe("stockPolicyFormFromStored", () => {
  it("treats null as 'chưa khai' — the defaults, not a declared numeric policy", () => {
    expect(stockPolicyFormFromStored(null)).toEqual(DEFAULT_STOCK_POLICY_FORM);
    expect(stockPolicyFormFromStored(undefined)).toEqual(DEFAULT_STOCK_POLICY_FORM);
  });

  it("restores the tenant's own wording instead of the example values", () => {
    const form = stockPolicyFormFromStored({
      mode: "textual",
      inStockValues: ["sẵn kho", "đặt được"],
      outOfStockValues: ["ngưng"],
    });

    expect(form.mode).toBe("textual");
    expect(form.inStockText).toBe("sẵn kho, đặt được");
    expect(form.outOfStockText).toBe("ngưng");
  });

  it("restores the reason a customer wrote for turning the stock gate off", () => {
    const form = stockPolicyFormFromStored({
      mode: "disabled",
      reason: "Tồn kho quản lý ở phần mềm bán hàng khác",
    });

    expect(form.mode).toBe("disabled");
    expect(form.disabledReason).toBe("Tồn kho quản lý ở phần mềm bán hàng khác");
  });

  it("round-trips: what it restores is what toStockPolicy sends back", () => {
    const stored: StockPolicy = {
      mode: "textual",
      inStockValues: ["sẵn kho"],
      outOfStockValues: ["ngưng"],
    };

    expect(toStockPolicy(stockPolicyFormFromStored(stored))).toEqual({ ok: true, policy: stored });
  });
});

/*
 * The last fence of business rule 2. Onboarding removed the price BLACKLIST — a
 * column now reaches a caption only because a human mapped it there — so the
 * moment of mapping is the last place a mistake can be caught before it is
 * stored. The server warns too, but inside a compatibility report the operator
 * may never open.
 */
describe("price-looking column mapped onto a caption field", () => {
  const PRICEY = [...COLUMNS, "Giá bán buôn", "Giao hàng"];

  it("warns when a price column lands on a caption field", () => {
    const issues = validateFieldMapValues(
      values({ description: "Giá bán buôn" }),
      PRICEY,
    );
    const issue = issueForField(issues, "description");

    expect(issue?.severity).toBe("warning");
    expect(issue?.message).toContain("caption");
  });

  it("NEVER blocks the save — the match is a guess about a header", () => {
    const issues = validateFieldMapValues(values({ description: "Giá bán buôn" }), PRICEY);

    expect(blockingIssues(issues)).toEqual([]);
    expect(warningIssues(issues)).toHaveLength(1);
  });

  it("stays quiet for a non-caption field: stock and note never reach a prompt", () => {
    const issues = validateFieldMapValues(values({ note: "Giá bán buôn" }), PRICEY);

    expect(issues).toEqual([]);
  });

  it("matches whole words only — 'Giao hàng' is not a price column", () => {
    const issues = validateFieldMapValues(values({ description: "Giao hàng" }), PRICEY);

    expect(issues).toEqual([]);
  });

  it("splits blockers from warnings so a real error is not diluted", () => {
    const issues = validateFieldMapValues(
      values({ name: null, description: "Giá bán buôn" }),
      PRICEY,
    );

    expect(blockingIssues(issues).map((issue) => issue.field)).toEqual(["name"]);
    expect(warningIssues(issues).map((issue) => issue.field)).toEqual(["description"]);
  });
});

/**
 * F6 — the price speed bump (business rule 2, PM decision 24/08/2026).
 *
 * Edge cases first, and they are all one worry: a confirmation must never travel
 * somewhere it was not given. Ticking for "Giá bán" must not keep vouching after
 * the field is repointed at "Giá vốn".
 */
describe("priceLikeCaptionAssignments", () => {
  it("finds a money-looking column pointed at a CAPTION field", () => {
    expect(priceLikeCaptionAssignments(values({ description: "Giá bán" }))).toEqual([
      { field: "description", column: "Giá bán" },
    ]);
  });

  /**
   * `stock` and `note` never reach a caption, so a money-looking header there is
   * not a rule-2 risk and must not raise a gate the operator cannot dismiss.
   */
  it("ignores money-looking columns on fields that never reach a caption", () => {
    expect(priceLikeCaptionAssignments(values({ stock: "Giá vốn", note: "Chiết khấu" }))).toEqual(
      [],
    );
  });

  it("finds nothing when no caption field points at money", () => {
    expect(priceLikeCaptionAssignments(values({ description: "Diễn giải" }))).toEqual([]);
  });

  it("does not fire on a word that merely CONTAINS a hint", () => {
    // "giao" contains "gia"; whole-word matching is what keeps this usable.
    expect(priceLikeCaptionAssignments(values({ description: "Ghi chú giao hàng" }))).toEqual([]);
  });
});

describe("priceConfirmationKey", () => {
  it("is empty when there is nothing to confirm", () => {
    expect(priceConfirmationKey([])).toBe("");
  });

  it("CHANGES when the same field is repointed at another money column", () => {
    const before = priceConfirmationKey(
      priceLikeCaptionAssignments(values({ description: "Giá bán" })),
    );
    const after = priceConfirmationKey(
      priceLikeCaptionAssignments(values({ description: "Giá vốn" })),
    );
    expect(before).not.toBe(after);
  });

  it("CHANGES when a second money column joins", () => {
    const one = priceConfirmationKey(
      priceLikeCaptionAssignments(values({ description: "Giá bán" })),
    );
    const two = priceConfirmationKey(
      priceLikeCaptionAssignments(values({ description: "Giá bán", season: "Giá KM" })),
    );
    expect(one).not.toBe(two);
  });

  it("is stable for the same set, so nothing re-prompts for free", () => {
    const a = priceConfirmationKey([
      { field: "description", column: "Giá bán" },
      { field: "season", column: "Giá KM" },
    ]);
    const b = priceConfirmationKey([
      { field: "season", column: "Giá KM" },
      { field: "description", column: "Giá bán" },
    ]);
    expect(a).toBe(b);
  });

  it("cannot be forged by shifting characters between field and column", () => {
    expect(priceConfirmationKey([{ field: "description", column: "Giá bán" }])).not.toBe(
      priceConfirmationKey([{ field: "description", column: "Giá bá n" }]),
    );
  });
});

