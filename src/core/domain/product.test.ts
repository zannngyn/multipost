import { describe, expect, it } from "vitest";

import type { MediaAsset } from "./product";
import {
  dedupeMediaByName,
  FORBIDDEN_SHEET_COLUMNS,
  mergeDuplicateProducts,
  parseSheetRow,
  SHEET_COLUMNS,
  toPromptInput,
} from "./product";

/** A row shaped like the real snapshot (sample-data/sheet-mau2026-*.csv). */
function row(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [SHEET_COLUMNS.code]: "MR0AC6080",
    [SHEET_COLUMNS.name]: "Penny",
    [SHEET_COLUMNS.description]: "Áo cộc tay dáng suông",
    [SHEET_COLUMNS.category]: "Áo cộc tay",
    [SHEET_COLUMNS.season]: "Xuân hè 2026",
    [SHEET_COLUMNS.stock]: "0",
    [SHEET_COLUMNS.note]: "HẾT HÀNG",
    [SHEET_COLUMNS.colors]: "TRẮNG TIÊU",
    "Nguyên Giá (bắt buộc)": "750.000",
    "Giá TMĐT": "900.000",
    ...overrides,
  };
}

describe("parseSheetRow — edge cases first", () => {
  it("rejects a row without a product code", () => {
    const result = parseSheetRow(7, row({ [SHEET_COLUMNS.code]: "   " }));
    expect(result).toMatchObject({ ok: false, issue: "MISSING_CODE", rowNumber: 7 });
  });

  it("rejects a row whose code is unusable", () => {
    const result = parseSheetRow(9, row({ [SHEET_COLUMNS.code]: "??" }));
    expect(result).toMatchObject({ ok: false, issue: "MALFORMED_CODE" });
  });

  it("rejects a row without a product name (the caption opens with it)", () => {
    const result = parseSheetRow(11, row({ [SHEET_COLUMNS.name]: "" }));
    expect(result).toMatchObject({ ok: false, issue: "MISSING_NAME" });
    if (!result.ok) expect(result.detail).toContain("MR0AC6080");
  });

  it("keeps a row that is missing the description (15 real rows)", () => {
    const result = parseSheetRow(3, row({ [SHEET_COLUMNS.description]: "" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content.description).toBeNull();
  });

  it("upper-cases a lower-case code so Sheet and Drive meet", () => {
    const result = parseSheetRow(4, row({ [SHEET_COLUMNS.code]: "Mrkvx6330" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content.code).toBe("MRKVX6330");
  });

  it("ignores unknown/renamed columns instead of guessing by position", () => {
    const result = parseSheetRow(5, { "Ma san pham": "MR0AC6080", "Ten": "Penny" });
    expect(result).toMatchObject({ ok: false, issue: "MISSING_CODE" });
  });
});

describe("parseSheetRow — whitelist enforcement (business rule 2)", () => {
  it("never copies a price column into the caption-safe half", () => {
    const result = parseSheetRow(2, row());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const content = toPromptInput(result.value);
    const serialised = JSON.stringify(content);
    for (const column of FORBIDDEN_SHEET_COLUMNS) {
      expect(serialised).not.toContain(column);
    }
    expect(serialised).not.toContain("750.000");
    expect(Object.keys(content).sort()).toEqual([
      "category",
      "code",
      "description",
      "name",
      "season",
    ]);
  });

  it("keeps stock and note in the operational half only", () => {
    const result = parseSheetRow(2, row());
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.operational).toMatchObject({ stockRaw: "0", noteRaw: "HẾT HÀNG" });
    expect(JSON.stringify(toPromptInput(result.value))).not.toContain("HẾT HÀNG");
  });
});

describe("mergeDuplicateProducts (docs/05 section 2.5)", () => {
  const first = parseSheetRow(2, row({ [SHEET_COLUMNS.code]: "MRKSQ6066" }));
  const identical = parseSheetRow(40, row({ [SHEET_COLUMNS.code]: "MRKSQ6066" }));
  const conflicting = parseSheetRow(
    41,
    row({ [SHEET_COLUMNS.code]: "MRKSQ6066", [SHEET_COLUMNS.name]: "Fioraé" }),
  );

  it("collapses two identical rows without raising a conflict", () => {
    if (!first.ok || !identical.ok) throw new Error("fixture broken");
    const merged = mergeDuplicateProducts(first.value, identical.value);
    expect(merged.hasConflict).toBe(false);
    expect(merged.sourceRows).toEqual([2, 40]);
  });

  it("flags a conflict when two rows disagree (MGKSQ6031 case)", () => {
    if (!first.ok || !conflicting.ok) throw new Error("fixture broken");
    const merged = mergeDuplicateProducts(first.value, conflicting.value);
    expect(merged.hasConflict).toBe(true);
    expect(merged.sourceRows).toEqual([2, 41]);
  });
});

describe("dedupeMediaByName (docs/05 section 1.4)", () => {
  function asset(overrides: Partial<MediaAsset>): MediaAsset {
    return {
      driveFileId: "id-1",
      origin: "drive",
      storageKey: null,
      fileName: "MGKVX6310-KEM (1).jpeg",
      productCode: "MGKVX6310",
      color: "KEM",
      colorRaw: "KEM",
      sequence: 1,
      kind: "image",
      variants: { aiGenerated: false, realPhoto: false, backView: false },
      mimeType: "image/jpeg",
      sizeBytes: 100,
      modifiedTime: "2026-01-01T00:00:00.000Z",
      warnings: [],
      needsReview: false,
      ...overrides,
    };
  }

  it("keeps the newest file when one name maps to several ids", () => {
    const older = asset({ driveFileId: "old", modifiedTime: "2026-01-01T00:00:00.000Z" });
    const newer = asset({ driveFileId: "new", modifiedTime: "2026-08-01T00:00:00.000Z" });
    const { kept, dropped } = dedupeMediaByName([older, newer]);
    expect(kept.map((item) => item.driveFileId)).toEqual(["new"]);
    expect(dropped.map((item) => item.driveFileId)).toEqual(["old"]);
  });

  it("is order-independent", () => {
    const older = asset({ driveFileId: "old", modifiedTime: "2026-01-01T00:00:00.000Z" });
    const newer = asset({ driveFileId: "new", modifiedTime: "2026-08-01T00:00:00.000Z" });
    expect(dedupeMediaByName([newer, older]).kept[0].driveFileId).toBe("new");
  });

  it("falls back to the file id when timestamps are missing or tied", () => {
    const a = asset({ driveFileId: "aaa", modifiedTime: null });
    const b = asset({ driveFileId: "bbb", modifiedTime: null });
    expect(dedupeMediaByName([a, b]).kept[0].driveFileId).toBe("bbb");
    expect(dedupeMediaByName([b, a]).kept[0].driveFileId).toBe("bbb");
  });

  it("prefers a file that has a timestamp over one that has none", () => {
    const dated = asset({ driveFileId: "dated", modifiedTime: "2026-02-02T00:00:00.000Z" });
    const undated = asset({ driveFileId: "undated", modifiedTime: "not-a-date" });
    expect(dedupeMediaByName([undated, dated]).kept[0].driveFileId).toBe("dated");
  });

  it("does not merge different names or different products", () => {
    const one = asset({ driveFileId: "a", fileName: "MGKVX6310-KEM (1).jpeg" });
    const two = asset({ driveFileId: "b", fileName: "MGKVX6310-KEM (2).jpeg", sequence: 2 });
    const other = asset({ driveFileId: "c", productCode: "MGKAD6045" });
    expect(dedupeMediaByName([one, two, other]).kept).toHaveLength(3);
  });

  it("returns empty results for an empty input", () => {
    expect(dedupeMediaByName([])).toEqual({ kept: [], dropped: [] });
  });
});
