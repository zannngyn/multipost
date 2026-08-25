import { describe, expect, it } from "vitest";

import { readFixtureSheetSnapshot } from "@/adapters/google/fixture-catalog-source";

import { makeFieldMap, MYSP_FIELD_MAP, type CatalogFieldMap } from "./catalog-field-map";
import { parseSheetRow, SHEET_COLUMNS, toPromptInput } from "./product";

/**
 * `parseSheetRow` under a tenant field map, on the REAL sheet export.
 *
 * The trick used throughout: take the real rows of sample-data and rename their
 * headers to a customer's wording. Same data, foreign column names — which is
 * exactly the situation the mapping exists for.
 */

/** A customer sheet that shares nothing with ours except the values. */
const CUSTOMER_MAP: CatalogFieldMap = makeFieldMap({
  code: "SKU",
  name: "Product name",
  description: "Chi tiết",
  category: "Nhóm hàng",
  season: "Season",
  stock: "Qty",
  note: "Ghi chú",
  colors: "Color",
});

const HEADER_BY_MYSP: Readonly<Record<string, string>> = {
  [SHEET_COLUMNS.code]: "SKU",
  [SHEET_COLUMNS.name]: "Product name",
  [SHEET_COLUMNS.description]: "Chi tiết",
  [SHEET_COLUMNS.category]: "Nhóm hàng",
  [SHEET_COLUMNS.season]: "Season",
  [SHEET_COLUMNS.stock]: "Qty",
  [SHEET_COLUMNS.note]: "Ghi chú",
  [SHEET_COLUMNS.colors]: "Color",
};

/** Real rows, headers renamed. Unknown columns (prices...) keep their names. */
function customerRows() {
  return readFixtureSheetSnapshot().rows.map((row) => ({
    rowNumber: row.rowNumber,
    values: Object.fromEntries(
      Object.entries(row.values).map(([column, value]) => [HEADER_BY_MYSP[column] ?? column, value]),
    ) as Record<string, string>,
  }));
}

function findRow(code: string) {
  const row = customerRows().find((candidate) => candidate.values["SKU"] === code);
  if (!row) throw new Error(`sample-data has no row for ${code}`);
  return row;
}

describe("parseSheetRow(fieldMap) — edge cases first", () => {
  it("refuses a map with no code column instead of reading every row as empty", () => {
    const result = parseSheetRow(2, { SKU: "MR0AC6080" }, makeFieldMap({ name: "Product name" }));
    expect(result).toMatchObject({ ok: false, issue: "FIELD_MAP_INCOMPLETE" });
    if (!result.ok) expect(result.detail).toContain("Mã sản phẩm");
  });

  it("refuses a map with no name column", () => {
    const result = parseSheetRow(2, { SKU: "MR0AC6080" }, makeFieldMap({ code: "SKU" }));
    expect(result).toMatchObject({ ok: false, issue: "FIELD_MAP_INCOMPLETE" });
  });

  it("names the TENANT's column in the operator message, not ours", () => {
    const result = parseSheetRow(7, { SKU: "  ", "Product name": "Penny" }, CUSTOMER_MAP);
    expect(result).toMatchObject({ ok: false, issue: "MISSING_CODE" });
    if (!result.ok) {
      expect(result.detail).toContain("SKU");
      expect(result.detail).not.toContain("Mã sản phẩm");
    }
  });

  it("names the tenant's name column when the name is missing", () => {
    const result = parseSheetRow(9, { SKU: "MR0AC6080", "Product name": "" }, CUSTOMER_MAP);
    expect(result).toMatchObject({ ok: false, issue: "MISSING_NAME" });
    if (!result.ok) expect(result.detail).toContain("Product name");
  });

  it("leaves an unmapped field null instead of falling back to our header", () => {
    const map = makeFieldMap({ code: "SKU", name: "Product name" });
    const result = parseSheetRow(3, findRow("MR0AC6080").values, map);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content.description).toBeNull();
    expect(result.value.content.category).toBeNull();
    expect(result.value.operational.stockRaw).toBe("");
    expect(result.value.operational.noteRaw).toBe("");
  });
});

describe("parseSheetRow(fieldMap) — whitelist is opt-in (business rule 2)", () => {
  it("never lets an UNMAPPED price column reach the caption half", () => {
    // The real row carries "Nguyên Giá (bắt buộc)" = 750.000 and the map does
    // not mention it — no blacklist involved, it is simply never read.
    const row = findRow("MR0AC6080");
    expect(row.values["Nguyên Giá (bắt buộc)"]).toBe("750.000");

    const result = parseSheetRow(row.rowNumber, row.values, CUSTOMER_MAP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const serialised = JSON.stringify(toPromptInput(result.value));
    expect(serialised).not.toContain("750.000");
    expect(Object.keys(toPromptInput(result.value)).sort()).toEqual([
      "category",
      "code",
      "description",
      "name",
      "season",
    ]);
  });

  it("keeps stock/note out of the caption half under a tenant map too", () => {
    const row = findRow("MR0AC6080");
    const result = parseSheetRow(row.rowNumber, row.values, CUSTOMER_MAP);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.operational).toMatchObject({ stockRaw: "0", noteRaw: "HẾT HÀNG" });
    expect(JSON.stringify(toPromptInput(result.value))).not.toContain("HẾT HÀNG");
  });

  it("reads a price column ONLY if the tenant deliberately maps it to a content field", () => {
    // Not a recommendation — proof that the map is the only door, which is why
    // validateFieldMap warns about exactly this case.
    const row = findRow("MR0AC6080");
    const map = makeFieldMap({
      code: "SKU",
      name: "Product name",
      description: "Nguyên Giá (bắt buộc)",
    });
    const result = parseSheetRow(row.rowNumber, row.values, map);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.content.description).toBe("750.000");
  });
});

describe("parseSheetRow(fieldMap) — the five sample codes (docs/05 section 5)", () => {
  it.each([
    ["MGKVX6310", "Giannal", "104"],
    ["MGKAD6045", "Claires", "157"],
    ["MG0AC6017", "Maelis", "0"],
    ["MR0AC6080", "Penny", "0"],
    ["MG0VS6111", "Pavly", "3"],
  ])("parses %s under a customer map exactly as under the preset", (code, name, stock) => {
    const renamed = findRow(code);
    const original = readFixtureSheetSnapshot().rows.find(
      (row) => row.values[SHEET_COLUMNS.code] === code,
    );
    if (!original) throw new Error(`sample-data has no row for ${code}`);

    const viaCustomer = parseSheetRow(renamed.rowNumber, renamed.values, CUSTOMER_MAP);
    const viaPreset = parseSheetRow(original.rowNumber, original.values, MYSP_FIELD_MAP);
    const viaDefault = parseSheetRow(original.rowNumber, original.values);

    expect(viaCustomer.ok).toBe(true);
    if (!viaCustomer.ok || !viaPreset.ok || !viaDefault.ok) return;
    expect(viaCustomer.value).toEqual(viaPreset.value);
    expect(viaDefault.value).toEqual(viaPreset.value);
    expect(viaCustomer.value.content.name).toBe(name);
    expect(viaCustomer.value.operational.stockRaw).toBe(stock);
  });
});

describe("parseSheetRow — the default stays the MYSP preset", () => {
  it("parses the real snapshot with no third argument at all", () => {
    const rows = readFixtureSheetSnapshot().rows;
    const parsed = rows.map((row) => parseSheetRow(row.rowNumber, row.values));
    const ok = parsed.filter((result) => result.ok).length;
    // docs/05 section 2.1: 301 of 302 rows carry a code.
    expect(ok).toBeGreaterThanOrEqual(295);
  });
});
