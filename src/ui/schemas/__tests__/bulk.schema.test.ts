import { describe, expect, it } from "vitest";

import {
  BulkRunFormSchema,
  MAX_BULK_CODES,
  findUnknownTemplateVariables,
  parseBulkCodes,
  renderCaptionTemplate,
} from "../bulk.schema";

/**
 * Edge cases first (CLAUDE.md technical rule 1): everything that can arrive in
 * that textarea from a Sheet paste, then the happy path.
 */

describe("parseBulkCodes — edge cases", () => {
  it("returns nothing for empty, blank or non-string input", () => {
    expect(parseBulkCodes("")).toEqual({ codes: [], invalid: [], duplicates: 0, overLimit: [] });
    expect(parseBulkCodes("   \n\n  ").codes).toHaveLength(0);
    expect(parseBulkCodes(undefined as unknown as string).codes).toHaveLength(0);
  });

  it("skips blank lines and stray commas without reporting them as errors", () => {
    const parsed = parseBulkCodes("MGK01\n\n , ,\nMGK02\n");
    expect(parsed.codes.map((item) => item.code)).toEqual(["MGK01", "MGK02"]);
    expect(parsed.invalid).toHaveLength(0);
  });

  it("reports an invalid code with its line number and what was typed", () => {
    const parsed = parseBulkCodes("MGK01\nÁo dài trắng\nMGK02");
    expect(parsed.codes.map((item) => item.code)).toEqual(["MGK01", "MGK02"]);
    expect(parsed.invalid).toEqual([
      {
        line: 2,
        raw: "Áo dài trắng",
        message: "Mã chỉ gồm chữ, số và các ký tự . _ - (ví dụ: MGKVX6310).",
      },
    ]);
  });

  it("rejects an over-long token instead of sending it to the server", () => {
    const parsed = parseBulkCodes("A".repeat(65));
    expect(parsed.codes).toHaveLength(0);
    expect(parsed.invalid[0].message).toContain("64 ký tự");
  });

  it("drops duplicates case-insensitively and counts them", () => {
    const parsed = parseBulkCodes("mgk01\nMGK01\nMGK02\nmgk02");
    expect(parsed.codes.map((item) => item.code)).toEqual(["MGK01", "MGK02"]);
    expect(parsed.duplicates).toBe(2);
  });

  it("keeps the first MAX_BULK_CODES codes and hands the rest back separately", () => {
    const raw = Array.from({ length: MAX_BULK_CODES + 3 }, (_, i) => `MGK${i}`).join("\n");
    const parsed = parseBulkCodes(raw);
    expect(parsed.codes).toHaveLength(MAX_BULK_CODES);
    expect(parsed.overLimit.map((item) => item.code)).toEqual(["MGK50", "MGK51", "MGK52"]);
  });
});

describe("parseBulkCodes — happy path", () => {
  it("accepts a pasted Sheet column and upper-cases every code", () => {
    const parsed = parseBulkCodes("mgkvx6310\nMGK-02\nmgk_03.a\n");
    expect(parsed.codes).toEqual([
      { code: "MGKVX6310", line: 1 },
      { code: "MGK-02", line: 2 },
      { code: "MGK_03.A", line: 3 },
    ]);
  });

  it("accepts several codes typed on one line, keeping that line number", () => {
    const parsed = parseBulkCodes("MGK01, MGK02 ,MGK03");
    expect(parsed.codes).toEqual([
      { code: "MGK01", line: 1 },
      { code: "MGK02", line: 1 },
      { code: "MGK03", line: 1 },
    ]);
  });
});

describe("renderCaptionTemplate", () => {
  it("returns an empty string for an empty or non-string template", () => {
    expect(renderCaptionTemplate("", { code: "MGK01", name: "Áo" })).toBe("");
    expect(renderCaptionTemplate(undefined as unknown as string, { code: "A", name: "B" })).toBe("");
  });

  it("replaces every occurrence of both variables, spaces allowed", () => {
    const text = renderCaptionTemplate("{name} — mã { code }. Đặt {name} ngay, mã {code}.", {
      code: "MGKVX6310",
      name: "Áo dài trắng",
    });
    expect(text).toBe(
      "Áo dài trắng — mã MGKVX6310. Đặt Áo dài trắng ngay, mã MGKVX6310.",
    );
  });

  it("leaves an unknown placeholder untouched instead of deleting the text", () => {
    const text = renderCaptionTemplate("{name} giá {gia} — {code}", { code: "A1", name: "Áo" });
    expect(text).toBe("Áo giá {gia} — A1");
    expect(findUnknownTemplateVariables("{name} giá {gia} — {ton}")).toEqual(["gia", "ton"]);
  });

  it("tolerates missing values rather than printing 'undefined' on Facebook", () => {
    expect(
      renderCaptionTemplate("{name}/{code}", {} as unknown as { code: string; name: string }),
    ).toBe("/");
  });
});

describe("BulkRunFormSchema", () => {
  const base = {
    tenantId: "00000000-0000-0000-0000-000000000001",
    codesText: "MGK01\nMGK02",
    captionMode: "ai" as const,
    captionTone: "mac-dinh" as const,
    captionTemplate: "",
    spacingMinutes: "",
  };

  it("accepts a valid AI run with no template", () => {
    expect(BulkRunFormSchema.safeParse(base).success).toBe(true);
  });

  it("refuses a run with no usable code", () => {
    const result = BulkRunFormSchema.safeParse({ ...base, codesText: "Áo dài" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "codesText")).toBe(true);
  });

  it("refuses more than MAX_BULK_CODES codes", () => {
    const codesText = Array.from({ length: MAX_BULK_CODES + 1 }, (_, i) => `MGK${i}`).join("\n");
    const result = BulkRunFormSchema.safeParse({ ...base, codesText });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain(`tối đa ${MAX_BULK_CODES} mã`);
  });

  it("refuses template mode with a blank template", () => {
    const result = BulkRunFormSchema.safeParse({
      ...base,
      captionMode: "template",
      captionTemplate: "   ",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["captionTemplate"]);
  });

  it("refuses a tone outside the closed vocabulary", () => {
    // Rule: the client sends a KEY, never prompt text. Anything not in
    // CAPTION_TONES must not reach the writer.
    const result = BulkRunFormSchema.safeParse({ ...base, captionTone: "giọng tự chế" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "captionTone")).toBe(true);
  });

  it("refuses a run with no tone at all", () => {
    const { captionTone: _omitted, ...withoutTone } = base;
    expect(BulkRunFormSchema.safeParse(withoutTone).success).toBe(false);
  });

  it("treats an empty spacing as 'dùng cấu hình công ty', not as an error", () => {
    expect(BulkRunFormSchema.safeParse({ ...base, spacingMinutes: "  " }).success).toBe(true);
  });

  it("accepts 0 minutes — 'đăng liên tục' is a real choice, not a blank", () => {
    expect(BulkRunFormSchema.safeParse({ ...base, spacingMinutes: "0" }).success).toBe(true);
  });

  it("accepts a gap below the recommended 5 minutes — advice, not a floor", () => {
    expect(BulkRunFormSchema.safeParse({ ...base, spacingMinutes: "2" }).success).toBe(true);
  });

  it("refuses a negative gap", () => {
    const result = BulkRunFormSchema.safeParse({ ...base, spacingMinutes: "-1" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "spacingMinutes")).toBe(true);
  });

  it("refuses a gap past the 24h ceiling", () => {
    const result = BulkRunFormSchema.safeParse({ ...base, spacingMinutes: "1441" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("1440");
  });

  it.each(["abc", "5.5", "1e3000"])("refuses a spacing that is not a whole number: %s", (raw) => {
    const result = BulkRunFormSchema.safeParse({ ...base, spacingMinutes: raw });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "spacingMinutes")).toBe(true);
  });

  it("accepts template mode with a template", () => {
    const result = BulkRunFormSchema.safeParse({
      ...base,
      captionMode: "template",
      captionTemplate: "{name} — mã {code}",
    });
    expect(result.success).toBe(true);
  });
});
