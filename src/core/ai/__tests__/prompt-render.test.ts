import { describe, expect, it } from "vitest";

import {
  assertTemplateValid,
  extractVariables,
  inspectTemplateBody,
  renderPrompt,
} from "@/core/ai/prompt-render";
import { TEST_PROMPT_TEMPLATE } from "@/core/ai/testing";
import { AppError } from "@/core/domain/errors";

describe("assertTemplateValid (prompt-versioning.md §1)", () => {
  it("rejects a template missing {{product.name}}", () => {
    try {
      assertTemplateValid({
        ...TEST_PROMPT_TEMPLATE,
        userPromptTemplate: "Chỉ có {{constraints}}",
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).context.missing_variables).toEqual(["product.name"]);
    }
  });

  it("rejects a template missing {{constraints}}", () => {
    expect(() =>
      assertTemplateValid({ ...TEST_PROMPT_TEMPLATE, userPromptTemplate: "{{product.name}}" }),
    ).toThrowError(AppError);
  });

  it("accepts a template holding every required variable", () => {
    expect(() => assertTemplateValid(TEST_PROMPT_TEMPLATE)).not.toThrow();
  });
});

describe("renderPrompt", () => {
  it("throws instead of shipping a literal {{var}} to the model", () => {
    try {
      renderPrompt("Xin chào {{product.name}} và {{missing}}", { "product.name": "Penny" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).context.missing_variables).toEqual(["missing"]);
    }
  });

  it("substitutes every occurrence, tolerating inner spaces", () => {
    expect(renderPrompt("{{ product.name }} yêu {{product.name}}", { "product.name": "Penny" })).toBe(
      "Penny yêu Penny",
    );
  });

  it("accepts an intentionally empty value (no previous failures)", () => {
    expect(renderPrompt("A{{previousFailures}}B", { previousFailures: "" })).toBe("AB");
  });

  it("lists the variables a template declares", () => {
    expect(extractVariables("{{a}} {{b.c}} {{a}}")).toEqual(["a", "b.c"]);
  });
});

describe("inspectTemplateBody (whitelist — CLAUDE.md business rule 2)", () => {
  it("reports a required variable that is missing", () => {
    const report = inspectTemplateBody("Chỉ có {{constraints}}", "facebook_content");
    expect(report.missing).toEqual(["product.name"]);
    expect(report.unknown).toEqual([]);
  });

  it("reports a variable outside the whitelist — price/stock can never render", () => {
    const report = inspectTemplateBody(
      "{{product.name}} {{constraints}} giá {{product.price}} tồn {{product.stock}}",
      "facebook_content",
    );
    expect(report.unknown).toEqual(["product.price", "product.stock"]);
    expect(report.missing).toEqual([]);
  });

  it("warns (does not block) when a recommended variable is unused", () => {
    const report = inspectTemplateBody("{{product.name}}\n{{constraints}}", "facebook_content");
    expect(report.missing).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.join(" ")).toContain("otherCaptions");
  });

  it("applies per-task requirements", () => {
    expect(inspectTemplateBody("{{otherCaptions}}", "caption_dedupe_check").missing).toEqual([]);
    expect(inspectTemplateBody("{{product.name}}", "caption_dedupe_check").missing).toEqual([
      "otherCaptions",
    ]);
  });

  it("accepts the shipped Facebook template", () => {
    const report = inspectTemplateBody(
      TEST_PROMPT_TEMPLATE.userPromptTemplate,
      TEST_PROMPT_TEMPLATE.task,
    );
    expect(report.missing).toEqual([]);
    expect(report.unknown).toEqual([]);
  });
});

describe("assertTemplateValid — whitelist half", () => {
  it("rejects a template that reads a forbidden column", () => {
    try {
      assertTemplateValid({
        ...TEST_PROMPT_TEMPLATE,
        userPromptTemplate: "{{product.name}} {{constraints}} {{product.price}}",
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).context.unknown_variables).toEqual(["product.price"]);
    }
  });
});
