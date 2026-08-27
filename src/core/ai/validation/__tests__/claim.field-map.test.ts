/**
 * Stage 3 against a TENANT's own sheet headers.
 *
 * Before the field map, the prompt labels stage 3 knows how to strip were the
 * internal company's four column names. An outside tenant whose sheet says
 * "Nhóm hàng" got its quoted sources rejected as ungrounded — the same false
 * reject that blocked 3 of 4 real generations on 15/08/2026, only permanent.
 *
 * Edge cases first: a map is external data and may be partial, empty, full of
 * punctuation, or carry regex metacharacters.
 */

import { describe, expect, it } from "vitest";

import { validateClaims } from "@/core/ai/validation/claim";
import { validateGeneratedContent } from "@/core/ai/validation";
import type { ValidationContext } from "@/core/ai/validation/types";
import { makeFieldMap, MYSP_FIELD_MAP } from "@/core/domain/catalog-field-map";
import type { CaptionContent, CaptionInput } from "@/core/domain/caption";

const product: CaptionInput = {
  name: "Penny",
  description:
    "Đầm dáng suông tay lỡ, phối nút ngọc tinh tế. Chất liệu lụa mềm mát, thấm hút tốt, thoải mái cả ngày hè.",
  category: "Đầm",
  season: "Hè 2026",
};

const content: CaptionContent = {
  title: "MANG CẢ NHỊP THỞ MÙA HÈ VÀO TỪNG BƯỚC CHÂN",
  body: "Dáng suông nhẹ nhàng, tay lỡ thanh lịch cùng chất liệu lụa mềm mát nâng niu làn da suốt ngày dài.",
  hashtags: ["#dam", "#hemoi", "#thoitrangnu"],
  claims: [{ field: "material", statement: "chất liệu lụa mềm mát", sourceText: "Chất liệu lụa mềm mát" }],
  confidence: 0.82,
};

const baseContext: ValidationContext = {
  product,
  constraints: { hashtagMin: 3, hashtagMax: 5 },
  existingCaptions: [],
};

/** An outside customer: English/Vietnamese mix, none of the preset headers. */
const outsideMap = makeFieldMap({
  code: "SKU",
  name: "Tên hàng",
  description: "Chi tiết",
  category: "Nhóm hàng",
  season: "Season",
  stock: "Số lượng",
});

function claim(sourceText: string): CaptionContent {
  return { ...content, claims: [{ field: "other", statement: "kiểu dáng", sourceText }] };
}

function rules(context: ValidationContext, sourceText: string): string[] {
  return validateClaims(claim(sourceText), context).map((item) => item.rule);
}

describe("stage 3 — prompt labels follow the tenant's field map", () => {
  it("accepts a source quoted with the TENANT's own column label", () => {
    const context = { ...baseContext, fieldMap: outsideMap };
    for (const sourceText of ["- Nhóm hàng: Đầm", "Chi tiết: Chất liệu lụa mềm mát", "* Season: Hè 2026"]) {
      expect(rules(context, sourceText)).toEqual([]);
    }
  });

  it("rejects that same label when the tenant has no map — no guessing", () => {
    // Proof the acceptance above comes from the map, not from a loosened rule.
    expect(rules(baseContext, "- Nhóm hàng: Đầm")).toContain("claim.source_not_found");
  });

  it("still strips the built-in template's preset labels for a mapped tenant", () => {
    // The shipped template prints "- Chủng loại: ..." whatever the sheet says.
    const context = { ...baseContext, fieldMap: outsideMap };
    for (const sourceText of ["- Chủng loại: Đầm", "- Mô tả sản phẩm: Chất liệu lụa mềm mát"]) {
      expect(rules(context, sourceText)).toEqual([]);
    }
  });

  it("still rejects a made-up prefix pretending to be a label", () => {
    const context = { ...baseContext, fieldMap: outsideMap };
    for (const sourceText of ["Giá chỉ 350.000: Đầm", "Hàng nhập khẩu Ý cao cấp: Đầm", "Bịa: Hè 2026"]) {
      expect(rules(context, sourceText)).toContain("claim.source_not_found");
    }
  });

  it("treats a header with regex metacharacters as text, not as a pattern", () => {
    const context = { ...baseContext, fieldMap: makeFieldMap({ description: "Mô tả (chi tiết)" }) };
    expect(rules(context, "- Mô tả (chi tiết): Chất liệu lụa mềm mát")).toEqual([]);
    // Same words without the parentheses is a DIFFERENT header, so no stripping.
    expect(rules(context, "- Mô tả chi tiết: Chất liệu lụa mềm mát")).toContain(
      "claim.source_not_found",
    );
  });

  it("falls back to the preset when the map has no content column at all", () => {
    const context = { ...baseContext, fieldMap: makeFieldMap({ code: "SKU" }) };
    expect(rules(context, "- Chủng loại: Đầm")).toEqual([]);
    // An empty alternation would strip ANY prefix and call the rest grounded.
    expect(rules(context, "Bịa: Đầm")).toContain("claim.source_not_found");
  });

  it("ignores a punctuation-only header instead of matching every prefix", () => {
    const context = { ...baseContext, fieldMap: makeFieldMap({ category: "###" }) };
    expect(rules(context, "Bịa: Đầm")).toContain("claim.source_not_found");
    expect(rules(context, "- Chủng loại: Đầm")).toEqual([]);
  });

  it("survives a tenant header identical to a preset label", () => {
    const context = { ...baseContext, fieldMap: makeFieldMap({ ...MYSP_FIELD_MAP }) };
    expect(rules(context, "- Mô tả sản phẩm: Chất liệu lụa mềm mát")).toEqual([]);
  });

  it("keeps the preset behaviour byte-for-byte when no map is passed", () => {
    expect(validateClaims(content, baseContext)).toEqual([]);
    expect(rules(baseContext, "- Chủng loại: Đầm")).toEqual([]);
  });
});

describe("stage 3 — operator messages name the tenant's own columns", () => {
  it("names the mapped source columns in an ungrounded claim", () => {
    const failures = validateClaims(claim("vải dệt kim Nhật"), {
      ...baseContext,
      fieldMap: outsideMap,
    });
    expect(failures[0].rule).toBe("claim.source_not_found");
    expect(failures[0].message).toContain("Chi tiết/Nhóm hàng/Season");
  });

  it("names the mapped description column for an invented material", () => {
    const failures = validateClaims(
      { ...content, body: "Chất linen mát lành cho ngày dài.", claims: [] },
      { ...baseContext, fieldMap: outsideMap },
    );
    expect(failures.map((item) => item.rule)).toContain("claim.invented_material");
    expect(failures[0].message).toContain("Chi tiết");
  });

  it("keeps the preset wording when nothing is mapped", () => {
    const failures = validateClaims(claim("vải dệt kim Nhật"), baseContext);
    expect(failures[0].message).toContain("Mô tả sản phẩm/Chủng loại/Mùa vụ");
  });

  it("uses the preset name for a column the tenant left unmapped", () => {
    const failures = validateClaims(claim("vải dệt kim Nhật"), {
      ...baseContext,
      fieldMap: makeFieldMap({ description: "Chi tiết" }),
    });
    expect(failures[0].message).toContain("Chi tiết/Chủng loại/Mùa vụ");
  });
});

describe("validation pipeline carries the field map to stage 3", () => {
  it("passes a caption whose claim quotes a tenant label", () => {
    const result = validateGeneratedContent(
      { ...content, claims: [{ field: "other", statement: "kiểu dáng", sourceText: "- Nhóm hàng: Đầm" }] },
      { ...baseContext, fieldMap: outsideMap },
    );
    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
  });
});
