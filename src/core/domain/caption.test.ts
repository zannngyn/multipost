import { describe, expect, it } from "vitest";

import {
  buildCaptionText,
  captionInputSchema,
  findForeignNameTokens,
  findPriceLikeNumbers,
  findProductCodeTokens,
  findSharedWordRun,
  isUpperCaseTitle,
  isWellFormedHashtag,
  normalizeLoose,
  toWords,
} from "@/core/domain/caption";

describe("captionInputSchema (whitelist boundary)", () => {
  // --- Edge cases first ----------------------------------------------------
  it("rejects an empty product name", () => {
    const result = captionInputSchema.safeParse({
      name: "   ",
      description: "x",
      category: "Đầm",
      season: "Hè",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing description field", () => {
    const result = captionInputSchema.safeParse({ name: "Penny", category: "Đầm", season: "Hè" });
    expect(result.success).toBe(false);
  });

  it("STRIPS forbidden columns even when a caller smuggles them in", () => {
    const parsed = captionInputSchema.parse({
      name: "Penny",
      description: "Đầm lụa",
      category: "Đầm",
      season: "Hè 2026",
      price: 1_250_000,
      stock: 3,
      note: "HẾT HÀNG",
    });

    expect(parsed).toEqual({
      name: "Penny",
      description: "Đầm lụa",
      category: "Đầm",
      season: "Hè 2026",
    });
    expect(JSON.stringify(parsed)).not.toContain("1250000");
  });

  it("rejects a cover image with an unsupported mime type", () => {
    const result = captionInputSchema.safeParse({
      name: "Penny",
      description: "Đầm lụa",
      category: "Đầm",
      season: "Hè",
      coverImage: { ref: "1", mimeType: "image/gif", dataBase64: "AAA", kind: "real" },
    });
    expect(result.success).toBe(false);
  });
});

describe("findPriceLikeNumbers // PENDING(D2)", () => {
  it("flags grouped numbers with at least 5 digits", () => {
    expect(findPriceLikeNumbers("giá chỉ 1.250.000 thôi")).toEqual(["1.250.000"]);
    expect(findPriceLikeNumbers("chỉ 750.000đ")).toEqual(["750.000"]);
  });

  it("ignores short numbers and ungrouped digits", () => {
    expect(findPriceLikeNumbers("size 38, dài 95 cm, năm 2026")).toEqual([]);
    expect(findPriceLikeNumbers("mã 1234567")).toEqual([]);
  });
});

describe("findSharedWordRun // PENDING(D1)", () => {
  const base = "Nàng thơ mùa hè dịu dàng bước xuống phố trong sắc nắng vàng";

  it("returns null when captions are short", () => {
    expect(findSharedWordRun("một hai ba", "một hai ba")).toBeNull();
  });

  it("returns null when the overlap is exactly 8 words", () => {
    const eightWords = "Nàng thơ mùa hè dịu dàng bước xuống";
    expect(findSharedWordRun(base, `${eightWords} khác hẳn phần còn lại của câu`)).toBeNull();
  });

  it("detects an overlap longer than 8 words", () => {
    const nineWords = "Nàng thơ mùa hè dịu dàng bước xuống phố";
    expect(findSharedWordRun(base, `${nineWords} cùng vài từ nữa`)).toBe(
      "nàng thơ mùa hè dịu dàng bước xuống phố",
    );
  });
});

describe("isUpperCaseTitle", () => {
  it("rejects empty, digit-only and mixed case titles", () => {
    expect(isUpperCaseTitle("")).toBe(false);
    expect(isUpperCaseTitle("123")).toBe(false);
    expect(isUpperCaseTitle("Mang cả nhịp thở")).toBe(false);
  });

  it("accepts Vietnamese uppercase with diacritics", () => {
    expect(isUpperCaseTitle("MANG CẢ NHỊP THỞ MÙA HÈ")).toBe(true);
  });
});

describe("isWellFormedHashtag", () => {
  it("rejects tags without #, with spaces or empty", () => {
    expect(isWellFormedHashtag("thoitrang")).toBe(false);
    expect(isWellFormedHashtag("#thoi trang")).toBe(false);
    expect(isWellFormedHashtag("#")).toBe(false);
  });

  it("accepts unicode tags", () => {
    expect(isWellFormedHashtag("#thoitrangnu")).toBe(true);
    expect(isWellFormedHashtag("#đầmlụa")).toBe(true);
  });
});

describe("findForeignNameTokens (brief §7.4, ca MG0SV6055-PIERA)", () => {
  const sources = ["Đầm lụa dáng suông", "Đầm", "Hè 2026"];

  it("flags another model name mentioned mid-sentence", () => {
    expect(findForeignNameTokens("Nàng sẽ yêu Piera ngay từ cái nhìn đầu tiên", "Penny", sources)).toEqual(
      ["Piera"],
    );
  });

  it("does not flag the product's own name", () => {
    expect(findForeignNameTokens("Nàng sẽ yêu Penny ngay lập tức", "Penny", sources)).toEqual([]);
  });

  it("does not flag a sentence-initial Vietnamese word without diacritics", () => {
    expect(findForeignNameTokens("Mang cả mùa hè theo bước chân.", "Penny", sources)).toEqual([]);
  });
});

describe("findProductCodeTokens", () => {
  it("finds internal product codes", () => {
    expect(findProductCodeTokens("mã MG0SV6055 vừa về")).toEqual(["MG0SV6055"]);
  });

  it("ignores ordinary uppercase words", () => {
    expect(findProductCodeTokens("SIÊU XINH")).toEqual([]);
  });
});

describe("buildCaptionText", () => {
  it("puts the sheet name on the first line, then body, then hashtags", () => {
    const text = buildCaptionText("Penny", {
      title: "MANG CẢ MÙA HÈ",
      body: "Dáng suông nhẹ nhàng.",
      hashtags: ["#penny", "#dam", "#he2026"],
      claims: [],
    });

    expect(text).toBe("Penny – MANG CẢ MÙA HÈ\n\nDáng suông nhẹ nhàng.\n\n#penny #dam #he2026");
  });
});

describe("text helpers", () => {
  it("normalizeLoose drops punctuation but keeps diacritics", () => {
    expect(normalizeLoose("Chất liệu: lụa, mềm!")).toBe("chất liệu lụa mềm");
  });

  it("toWords splits on non letters/digits", () => {
    expect(toWords("Đầm lụa — size 38")).toEqual(["đầm", "lụa", "size", "38"]);
  });
});
