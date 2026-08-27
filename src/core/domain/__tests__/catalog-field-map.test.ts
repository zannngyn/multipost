import { describe, expect, it } from "vitest";

import { readFixtureSheetSnapshot } from "@/adapters/google/fixture-catalog-source";

import {
  comparisonKey,
  isPriceLikeColumn,
  makeFieldMap,
  mappedColumns,
  matchStockText,
  MYSP_FIELD_MAP,
  MYSP_PRICE_COLUMNS,
  normalizeColumnName,
  suggestFieldMap,
  validateFieldMap,
  validateFieldMapStructure,
  validateStockPolicy,
  type CatalogFieldMap,
  type TextualStockPolicy,
} from "../catalog-field-map";

/** The real header row of tab "Mẫu 2026" (sample-data snapshot, docs/05 2.1). */
const REAL_COLUMNS = readFixtureSheetSnapshot().columns;

describe("normalizeColumnName / comparisonKey — edge cases first", () => {
  it.each([null, undefined, 42, {}, []])("returns an empty key for %s", (value) => {
    expect(normalizeColumnName(value)).toBe("");
    expect(comparisonKey(value)).toBe("");
  });

  it("strips accents, case and punctuation but keeps word boundaries", () => {
    expect(normalizeColumnName("  Mã   SẢN-phẩm ")).toBe("ma san pham");
    expect(normalizeColumnName("Đơn giá (VNĐ)")).toBe("don gia vnd");
    expect(comparisonKey(" Hết  Hàng ")).toBe(comparisonKey("HET HANG"));
  });

  it("does not let a short token match inside a longer word", () => {
    // "ma" (mã) must not match "màu" — the whole reason the key keeps spaces.
    expect(normalizeColumnName("Màu sắc").split(" ")).toEqual(["mau", "sac"]);
  });
});

describe("makeFieldMap", () => {
  it("fills missing fields with null instead of inheriting the MYSP preset", () => {
    const map = makeFieldMap({ code: "SKU" });
    expect(map.code).toBe("SKU");
    expect(map.name).toBeNull();
    expect(map.stock).toBeNull();
    expect(map.mediaLink ?? null).toBeNull();
  });

  it.each([null, undefined, {} as Partial<CatalogFieldMap>])(
    "turns %s into an all-null map",
    (input) => {
      expect(mappedColumns(makeFieldMap(input))).toEqual([]);
    },
  );

  it("treats a whitespace-only column name as unmapped", () => {
    expect(makeFieldMap({ code: "   " }).code).toBeNull();
  });
});

describe("suggestFieldMap — edge cases first", () => {
  it.each([[[]], [null], [undefined]])("returns an empty suggestion for %s", (columns) => {
    const suggestion = suggestFieldMap(columns as string[]);
    expect(suggestion.fieldMap.code).toBeNull();
    expect(suggestion.fields.every((field) => field.column === null)).toBe(true);
    expect(suggestion.unmappedColumns).toEqual([]);
  });

  it("counts blank headers instead of mapping them", () => {
    const suggestion = suggestFieldMap(["", "   ", "\t"]);
    expect(suggestion.blankColumnCount).toBe(3);
    expect(suggestion.unmappedColumns).toEqual([]);
  });

  it("reports a repeated header once and maps it once", () => {
    const suggestion = suggestFieldMap(["Mã SP", "Mã SP", "Tên SP"]);
    expect(suggestion.duplicateColumns).toEqual(["Mã SP"]);
    expect(suggestion.fieldMap.code).toBe("Mã SP");
  });

  it("leaves a field unmapped rather than guessing on an unknown header", () => {
    const suggestion = suggestFieldMap(["Cột A", "Ngày cập nhật", "Biển"]);
    expect(suggestion.fieldMap.code).toBeNull();
    expect(suggestion.fieldMap.name).toBeNull();
    expect(suggestion.unmappedColumns).toEqual(["Cột A", "Ngày cập nhật", "Biển"]);
  });

  it("never gives one column to two fields", () => {
    const suggestion = suggestFieldMap(["Mã", "Mã"]);
    const used = suggestion.fields.filter((field) => field.column === "Mã");
    expect(used).toHaveLength(1);
  });
});

describe("suggestFieldMap — real data (sample-data snapshot)", () => {
  it("rebuilds the MYSP preset from the real header row", () => {
    const suggestion = suggestFieldMap(REAL_COLUMNS);
    expect(suggestion.fieldMap).toMatchObject({
      code: MYSP_FIELD_MAP.code,
      name: MYSP_FIELD_MAP.name,
      description: MYSP_FIELD_MAP.description,
      category: MYSP_FIELD_MAP.category,
      season: MYSP_FIELD_MAP.season,
      stock: MYSP_FIELD_MAP.stock,
      note: MYSP_FIELD_MAP.note,
      colors: MYSP_FIELD_MAP.colors,
    });
  });

  it("keeps 'Lưu ý nhận sx 1c / sx hết tồn' on note, not on stock", () => {
    // The header ends with "tồn"; a naive contains-match would steal it.
    const suggestion = suggestFieldMap(REAL_COLUMNS);
    expect(suggestion.fieldMap.stock).toBe("Tồn");
    expect(suggestion.fieldMap.note).toBe("Lưu ý nhận sx 1c / sx hết tồn");
  });

  it("flags the four real price columns as unmapped money columns", () => {
    const suggestion = suggestFieldMap(REAL_COLUMNS);
    for (const column of MYSP_PRICE_COLUMNS) {
      expect(suggestion.unmappedColumns).toContain(column);
      expect(suggestion.priceLikeColumns).toContain(column);
    }
  });

  it("marks an exact alias as high confidence and a fuzzy hit for review", () => {
    const suggestion = suggestFieldMap(REAL_COLUMNS);
    const code = suggestion.fields.find((field) => field.field === "code");
    const note = suggestion.fields.find((field) => field.field === "note");
    expect(code).toMatchObject({ matchKind: "exact", confidence: 1, needsReview: false });
    expect(note?.matchKind).toBe("partial");
    expect(note?.needsReview).toBe(true);
  });
});

describe("suggestFieldMap — foreign sheets", () => {
  it("maps English headers", () => {
    const suggestion = suggestFieldMap([
      "SKU",
      "Product name",
      "Description",
      "Category",
      "Season",
      "Qty",
      "Note",
      "Color",
      "Price",
    ]);
    expect(suggestion.fieldMap).toMatchObject({
      code: "SKU",
      name: "Product name",
      description: "Description",
      category: "Category",
      season: "Season",
      stock: "Qty",
      note: "Note",
      colors: "Color",
    });
    expect(suggestion.priceLikeColumns).toEqual(["Price"]);
  });

  it("maps accent-free and abbreviated Vietnamese headers", () => {
    const suggestion = suggestFieldMap([
      "Ma hang",
      "Ten hang",
      "Mo ta",
      "Nhom hang",
      "Mua vu",
      "SL",
      "Ghi chu",
      "Mau",
    ]);
    expect(suggestion.fieldMap).toMatchObject({
      code: "Ma hang",
      name: "Ten hang",
      description: "Mo ta",
      category: "Nhom hang",
      season: "Mua vu",
      stock: "SL",
      note: "Ghi chu",
      colors: "Mau",
    });
  });
});

describe("isPriceLikeColumn", () => {
  it.each(["Nguyên Giá (bắt buộc)", "Giá TMĐT", "Đơn giá", "Unit price", "Cost"])(
    "flags '%s'",
    (column) => {
      expect(isPriceLikeColumn(column)).toBe(true);
    },
  );

  it.each(["Mã sản phẩm", "Tên sản phẩm", "Mùa vụ", "", null])("does not flag '%s'", (column) => {
    expect(isPriceLikeColumn(column)).toBe(false);
  });
});

describe("validateFieldMap — edge cases first", () => {
  it("reports both required fields when the map is empty", () => {
    const issues = validateFieldMapStructure(makeFieldMap({}));
    expect(issues.filter((issue) => issue.code === "FIELD_MAP_REQUIRED_MISSING")).toHaveLength(2);
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
  });

  it.each([null, undefined])("treats %s as an empty map instead of throwing", (map) => {
    expect(validateFieldMapStructure(map).length).toBeGreaterThan(0);
  });

  it("rejects one column serving two fields", () => {
    const issues = validateFieldMapStructure(makeFieldMap({ code: "A", name: "A" }));
    const reuse = issues.find((issue) => issue.code === "FIELD_MAP_COLUMN_REUSED");
    expect(reuse).toBeDefined();
    expect(reuse?.fields).toEqual(["code", "name"]);
    expect(reuse?.detail).toContain("A");
  });

  it("warns (does not block) when a caption field points at a price column", () => {
    const issues = validateFieldMapStructure(
      makeFieldMap({ code: "SKU", name: "Tên", description: "Giá bán" }),
    );
    const warning = issues.find((issue) => issue.code === "FIELD_MAP_PRICE_LIKE_COLUMN");
    expect(warning).toMatchObject({ severity: "warning", column: "Giá bán" });
  });

  it("reports a mapped column the sheet does not have", () => {
    const issues = validateFieldMap(makeFieldMap({ code: "SKU", name: "Tên", stock: "Kho"}), [
      "SKU",
      "Tên",
    ]);
    const missing = issues.filter((issue) => issue.code === "FIELD_MAP_COLUMN_NOT_FOUND");
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ column: "Kho", severity: "warning" });
  });

  it("treats a missing REQUIRED column as an error, not a warning", () => {
    const issues = validateFieldMap(makeFieldMap({ code: "SKU", name: "Tên" }), ["SKU"]);
    expect(issues.find((issue) => issue.code === "FIELD_MAP_COLUMN_NOT_FOUND")).toMatchObject({
      severity: "error",
      column: "Tên",
    });
  });

  it("does not flood the report when the sheet has no header row at all", () => {
    const issues = validateFieldMap(MYSP_FIELD_MAP, []);
    expect(issues.filter((issue) => issue.code === "FIELD_MAP_COLUMN_NOT_FOUND")).toHaveLength(0);
  });

  it("accepts the MYSP preset against the real header row", () => {
    expect(validateFieldMap(MYSP_FIELD_MAP, REAL_COLUMNS)).toEqual([]);
  });
});

describe("validateStockPolicy — edge cases first", () => {
  it.each([null, undefined, {}, { mode: "auto" }])("rejects %s", (policy) => {
    const issues = validateStockPolicy(policy as never);
    expect(issues[0]?.code).toBe("STOCK_POLICY_MODE_INVALID");
  });

  it("accepts the numeric default", () => {
    expect(validateStockPolicy({ mode: "numeric" })).toEqual([]);
  });

  it("refuses a textual policy with an empty vocabulary", () => {
    const issues = validateStockPolicy({
      mode: "textual",
      inStockValues: ["Còn hàng"],
      outOfStockValues: [],
    });
    expect(issues[0]?.code).toBe("STOCK_POLICY_VALUES_EMPTY");
  });

  it("refuses a value declared as both in and out of stock", () => {
    const issues = validateStockPolicy({
      mode: "textual",
      inStockValues: ["Còn hàng"],
      outOfStockValues: ["con hang"],
    });
    expect(issues.map((issue) => issue.code)).toContain("STOCK_POLICY_VALUE_AMBIGUOUS");
  });

  it.each(["", "   ", "hết"])("refuses disabled with reason '%s'", (reason) => {
    const issues = validateStockPolicy({ mode: "disabled", reason });
    expect(issues[0]?.code).toBe("STOCK_POLICY_REASON_MISSING");
  });

  it("accepts disabled once a real reason is written down", () => {
    expect(
      validateStockPolicy({ mode: "disabled", reason: "Khách quản lý tồn trên phần mềm riêng" }),
    ).toEqual([]);
  });
});

describe("matchStockText", () => {
  const policy: TextualStockPolicy = {
    mode: "textual",
    inStockValues: ["Còn hàng", "Sẵn hàng"],
    outOfStockValues: ["Hết hàng", "Ngừng bán"],
  };

  it.each(["con hang", "CÒN HÀNG", " Còn  hàng "])("matches '%s' as in stock", (raw) => {
    expect(matchStockText(policy, raw)).toBe("in_stock");
  });

  it.each(["het hang", "HẾT HÀNG", "ngưng bán"])("matches '%s' as out of stock", (raw) => {
    expect(matchStockText(policy, raw === "ngưng bán" ? "Ngừng bán" : raw)).toBe("out_of_stock");
  });

  it.each(["", "   ", "sắp về", "10", null])("answers unknown for '%s'", (raw) => {
    expect(matchStockText(policy, raw)).toBe("unknown");
  });

  it("lets out of stock win when a tenant declared the same word twice", () => {
    expect(
      matchStockText(
        { mode: "textual", inStockValues: ["Hàng"], outOfStockValues: ["Hàng"] },
        "hang",
      ),
    ).toBe("out_of_stock");
  });
});
