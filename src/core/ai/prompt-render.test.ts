import { describe, expect, it } from "vitest";

import { assertTemplateValid, extractVariables, renderPrompt } from "@/core/ai/prompt-render";
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
