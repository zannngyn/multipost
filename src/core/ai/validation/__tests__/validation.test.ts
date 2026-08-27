import { describe, expect, it } from "vitest";

import { validateGeneratedContent } from "@/core/ai/validation";
import { validateBusiness } from "@/core/ai/validation/business";
import { validateClaims } from "@/core/ai/validation/claim";
import { validateContentPolicy } from "@/core/ai/validation/content-policy";
import { validateSchema } from "@/core/ai/validation/schema";
import type { ValidationContext } from "@/core/ai/validation/types";
import type { CaptionContent, CaptionInput } from "@/core/domain/caption";

const product: CaptionInput = {
  name: "Penny",
  description:
    "Đầm dáng suông tay lỡ, phối nút ngọc tinh tế. Chất liệu lụa mềm mát, thấm hút tốt, thoải mái cả ngày hè.",
  category: "Đầm",
  season: "Hè 2026",
};

const context: ValidationContext = {
  product,
  constraints: { hashtagMin: 3, hashtagMax: 5 },
  existingCaptions: [],
};

const validContent: CaptionContent = {
  title: "MANG CẢ NHỊP THỞ MÙA HÈ VÀO TỪNG BƯỚC CHÂN",
  body: "Dáng suông nhẹ nhàng, tay lỡ thanh lịch cùng chất liệu lụa mềm mát nâng niu làn da suốt ngày dài.",
  hashtags: ["#dam", "#hemoi", "#thoitrangnu"],
  claims: [
    { field: "material", statement: "chất liệu lụa mềm mát", sourceText: "Chất liệu lụa mềm mát" },
    { field: "season", statement: "dành cho mùa hè", sourceText: "ngày hè" },
  ],
  confidence: 0.82,
};

// ---------------------------------------------------------------------------
// Stage 1 — schema
// ---------------------------------------------------------------------------

const NUL = "\u0000";

describe("stage 1 — schema", () => {
  it("rejects null / string / array payloads without leaking them", () => {
    for (const payload of [null, "some text", [1, 2, 3]]) {
      const result = validateSchema(payload);
      expect(result.ok).toBe(false);
      expect(result.failures[0].rule).toBe("schema.not_object");
      expect(JSON.stringify(result.failures)).not.toContain("some text");
    }
  });

  /**
   * Measured live 15/08/2026: gpt-4.1-mini returned mojibake carrying U+0000.
   * It used to pass stage 1, get rejected at stage 3 with a confusing "source
   * not found", and then break the ai_generation INSERT (Postgres cannot store
   * NUL). Rejecting it here makes the escalation carry an honest reason.
   */
  it.each([
    ["title", { ...validContent, title: `MÙA${NUL} HÈ` }],
    ["body", { ...validContent, body: `Dáng suông${NUL} nhẹ nhàng.` }],
    ["hashtags", { ...validContent, hashtags: [`#a${NUL}`, "#b", "#c"] }],
    [
      "claims",
      {
        ...validContent,
        claims: [{ field: "material", statement: "lụa", sourceText: `lụa${NUL} mềm mát` }],
      },
    ],
  ])("rejects a control character in %s", (_where, payload) => {
    const result = validateSchema(payload);

    expect(result.ok).toBe(false);
    expect(result.failures[0].rule).toBe("schema.control_characters");
  });

  it("keeps accepting the newlines and tabs real copy uses", () => {
    const result = validateSchema({ ...validContent, body: "Dòng 1\nDòng 2\tcó tab" });
    expect(result.ok).toBe(true);
  });

  it("rejects fewer than 3 hashtags", () => {
    const result = validateSchema({ ...validContent, hashtags: ["#a", "#b"] });
    expect(result.ok).toBe(false);
    expect(result.failures.some((item) => item.detail?.path === "hashtags")).toBe(true);
  });

  it("rejects more than 5 hashtags", () => {
    const result = validateSchema({
      ...validContent,
      hashtags: ["#a", "#b", "#c", "#d", "#e", "#f"],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a claim missing sourceText", () => {
    const result = validateSchema({
      ...validContent,
      claims: [{ field: "material", statement: "lụa" }],
    });
    expect(result.ok).toBe(false);
  });

  it("reports paths and codes only — never the raw value", () => {
    const result = validateSchema({ ...validContent, title: 12345 });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.failures)).not.toContain("12345");
  });

  it("accepts a valid payload and tolerates a missing confidence", () => {
    const { confidence: _confidence, ...withoutConfidence } = validContent;
    expect(validateSchema(withoutConfidence).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — business
// ---------------------------------------------------------------------------

describe("stage 2 — business", () => {
  it("fails a lowercase title", () => {
    const failures = validateBusiness({ ...validContent, title: "Mang cả mùa hè" }, context);
    expect(failures.map((item) => item.rule)).toContain("business.title_not_uppercase");
  });

  it("fails a title that repeats the product name", () => {
    const failures = validateBusiness({ ...validContent, title: "PENNY VÀO HÈ" }, context);
    expect(failures.map((item) => item.rule)).toContain("business.title_contains_product_name");
  });

  it("fails a body mentioning another model name", () => {
    const failures = validateBusiness(
      { ...validContent, body: "Nàng sẽ yêu Piera ngay từ cái nhìn đầu tiên." },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("business.foreign_product_name");
  });

  it("fails a body leaking the internal product code", () => {
    const failures = validateBusiness(
      { ...validContent, body: "Mẫu MG0SV6055 vừa cập bến, dáng suông nhẹ nhàng." },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("business.product_code_leaked");
  });

  it("fails a malformed hashtag", () => {
    const failures = validateBusiness(
      { ...validContent, hashtags: ["#dam", "hemoi", "#thoitrangnu"] },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("business.hashtag_malformed");
  });

  it("fails a body longer than the constraint", () => {
    const failures = validateBusiness(validContent, {
      ...context,
      constraints: { hashtagMin: 3, hashtagMax: 5, maxBodyChars: 20 },
    });
    expect(failures.map((item) => item.rule)).toContain("business.body_too_long");
  });

  it("fails when it repeats more than 8 consecutive words of another channel // PENDING(D1)", () => {
    const otherChannel =
      "Penny – MÙA HÈ RỰC RỠ\n\nDáng suông nhẹ nhàng, tay lỡ thanh lịch cùng chất liệu lụa mềm mát nâng niu làn da suốt ngày dài.\n\n#a #b #c";
    const failures = validateBusiness(validContent, {
      ...context,
      existingCaptions: [otherChannel],
    });
    expect(failures.map((item) => item.rule)).toContain("business.duplicate_with_other_channel");
  });

  it("passes a clean caption", () => {
    expect(validateBusiness(validContent, context)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage 3 — claims
// ---------------------------------------------------------------------------

describe("stage 3 — claims", () => {
  it("fails a claim whose sourceText is nowhere in the whitelisted data", () => {
    const failures = validateClaims(
      {
        ...validContent,
        claims: [
          { field: "material", statement: "lụa tơ tằm cao cấp", sourceText: "lụa tơ tằm cao cấp" },
        ],
      },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("claim.source_not_found");
  });

  /**
   * Regression from real runs on 15/08/2026: the prompt lists the product as
   * "- Chủng loại: Đầm", the model quotes the whole line, and stage 3 blocked
   * 3 of 4 real generations for it.
   */
  it.each([
    "- Chủng loại: Đầm",
    "Chủng loại: Đầm",
    "* Mùa vụ: Hè 2026",
    "- Mô tả sản phẩm: Chất liệu lụa mềm mát",
  ])("accepts a source quoted with the prompt's own label prefix (%j)", (sourceText) => {
    const failures = validateClaims(
      { ...validContent, claims: [{ field: "other", statement: "kiểu dáng", sourceText }] },
      context,
    );
    expect(failures).toEqual([]);
  });

  it("still rejects an invented value even when it wears a label prefix", () => {
    const failures = validateClaims(
      {
        ...validContent,
        claims: [{ field: "material", statement: "linen", sourceText: "- Chất liệu: linen Ý" }],
      },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("claim.source_not_found");
  });

  /**
   * Found by review of the first fix: stripping "anything before a colon" turned
   * `sourceText` into a free text field. It is not published, but it IS stored in
   * ai_generation and shown to the human approver as the evidence for a claim, so
   * invented text there is a real misrepresentation — a price-shaped string most
   * of all.
   */
  it.each([
    "Hàng nhập khẩu Ý cao cấp: Đầm",
    "Giá chỉ 350.000: Đầm",
    "Bịa: Hè 2026",
  ])("rejects a made-up prefix pretending to be a label (%j)", (sourceText) => {
    const failures = validateClaims(
      { ...validContent, claims: [{ field: "other", statement: "x", sourceText }] },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("claim.source_not_found");
  });

  it("rejects a one-character source that would match almost anything", () => {
    const failures = validateClaims(
      { ...validContent, claims: [{ field: "other", statement: "x", sourceText: "a" }] },
      context,
    );
    // Distinct from an EMPTY source: the model did quote something, it is just
    // too short to prove anything, and the operator deserves the true reason.
    expect(failures.map((item) => item.rule)).toContain("claim.source_too_short");
  });

  it("still reports a truly empty source as such", () => {
    const failures = validateClaims(
      { ...validContent, claims: [{ field: "other", statement: "x", sourceText: "   " }] },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("claim.empty_source");
  });

  it("requires a whole word, not a fragment buried inside one", () => {
    // "uông" sits inside "suông" but is not a word of the description.
    const failures = validateClaims(
      { ...validContent, claims: [{ field: "other", statement: "x", sourceText: "uông" }] },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("claim.source_not_found");
  });

  it("does not let a long prefix hide an ungrounded claim", () => {
    // 33+ chars before the colon: beyond what a label can plausibly be, so the
    // stripping rule must not apply and the claim stays ungrounded.
    const failures = validateClaims(
      {
        ...validContent,
        claims: [
          {
            field: "other",
            statement: "bịa",
            sourceText: "Đây là một đoạn mở đầu rất dài dùng để né kiểm tra: vải dệt kim Nhật",
          },
        ],
      },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("claim.source_not_found");
  });

  it("fails an invented material that never appears in the description", () => {
    const failures = validateClaims(
      { ...validContent, body: "Chất linen mát lành cho ngày dài.", claims: [] },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("claim.invented_material");
  });

  it("fails an ungrounded measurement", () => {
    const failures = validateClaims(
      { ...validContent, body: "Dáng dài 95 cm ôm trọn vóc dáng.", claims: [] },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("claim.ungrounded_measurement");
  });

  it("accepts a measurement that IS in the description", () => {
    const failures = validateClaims(
      { ...validContent, body: "Dáng dài 95cm ôm trọn vóc dáng.", claims: [] },
      { ...context, product: { ...product, description: `${product.description} Dài 95 cm.` } },
    );
    expect(failures).toEqual([]);
  });

  it("fails an empty sourceText", () => {
    const failures = validateClaims(
      { ...validContent, claims: [{ field: "other", statement: "siêu bền", sourceText: "  " }] },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("claim.empty_source");
  });

  it("passes grounded claims", () => {
    expect(validateClaims(validContent, context)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage 4 — content policy
// ---------------------------------------------------------------------------

describe("stage 4 — content policy", () => {
  it("fails a price-like number in the body // PENDING(D2)", () => {
    const failures = validateContentPolicy(
      { ...validContent, body: "Chỉ 1.250.000 cho một mùa hè rực rỡ." },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("policy.price_like_number");
    expect(failures[0].detail?.tokens).toEqual(["1.250.000"]);
  });

  it("fails a price hidden in a hashtag", () => {
    const failures = validateContentPolicy(
      { ...validContent, hashtags: ["#sale750.000", "#dam", "#he"] },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("policy.price_like_number");
  });

  it("fails internal stock / production wording", () => {
    const failures = validateContentPolicy(
      { ...validContent, body: "Tồn kho chỉ còn vài chiếc, nhận sx thêm nhé." },
      context,
    );
    expect(failures.map((item) => item.rule)).toContain("policy.internal_info");
  });

  it("fails a tenant blacklisted word", () => {
    const failures = validateContentPolicy(validContent, {
      ...context,
      constraints: { hashtagMin: 3, hashtagMax: 5, forbiddenWords: ["thanh lịch"] },
    });
    expect(failures.map((item) => item.rule)).toContain("policy.blacklisted_word");
  });

  it("passes clean content", () => {
    expect(validateContentPolicy(validContent, context)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

describe("validateGeneratedContent (pipeline)", () => {
  it("short-circuits at stage 1 and reports the stage", () => {
    const result = validateGeneratedContent({ title: "X" }, context);
    expect(result.pass).toBe(false);
    expect(result.firstFailedStage).toBe(1);
    expect(result.content).toBeUndefined();
  });

  it("runs stages 2–4 together so one escalation carries every reason", () => {
    const result = validateGeneratedContent(
      {
        ...validContent,
        title: "mang cả mùa hè",
        body: "Chất linen mát lành, chỉ 750.000 thôi.",
      },
      context,
    );

    expect(result.pass).toBe(false);
    const rules = result.failures.map((item) => item.rule);
    expect(rules).toContain("business.title_not_uppercase");
    expect(rules).toContain("claim.invented_material");
    expect(rules).toContain("policy.price_like_number");
    expect(result.firstFailedStage).toBe(2);
  });

  it("passes a clean generation", () => {
    const result = validateGeneratedContent(validContent, context);
    expect(result.failures).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.content?.title).toBe(validContent.title);
  });
});
