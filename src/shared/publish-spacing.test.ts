import { describe, expect, it } from "vitest";

import {
  MAX_SPACING_MS,
  MIN_SPACING_MS,
  MS_PER_MINUTE,
  RECOMMENDED_MIN_SPACING_MS,
  spacingMinutesToMs,
  spacingMsField,
} from "./publish-spacing";

const field = spacingMsField();

describe("spacingMsField — the HTTP contract, edge cases first", () => {
  it.each([
    ["a negative gap", -1],
    ["one above the ceiling", MAX_SPACING_MS + 1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a numeric string — never coerced", "300000"],
    ["a boolean", true],
    ["an object", {}],
  ])("refuses %s", (_case, raw) => {
    expect(field.safeParse(raw).success).toBe(false);
  });

  it("gives a Vietnamese message the form can show inline", () => {
    const parsed = field.safeParse(-1);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toContain("Khoảng giãn cách");
  });

  it.each([
    ["absent", undefined],
    ["explicit null", null],
    ["zero", MIN_SPACING_MS],
    ["the 24h ceiling", MAX_SPACING_MS],
    ["one minute, under the recommendation", MS_PER_MINUTE],
  ])("accepts %s", (_case, raw) => {
    expect(field.safeParse(raw).success).toBe(true);
  });

  it("does not enforce the 5-minute recommendation", () => {
    expect(RECOMMENDED_MIN_SPACING_MS).toBe(5 * MS_PER_MINUTE);
    expect(field.safeParse(RECOMMENDED_MIN_SPACING_MS - 1).success).toBe(true);
  });
});

describe("spacingMinutesToMs", () => {
  it("converts what an operator typed into what the API takes", () => {
    expect(spacingMinutesToMs(0)).toBe(0);
    expect(spacingMinutesToMs(5)).toBe(300_000);
    expect(spacingMinutesToMs(1440)).toBe(MAX_SPACING_MS);
  });

  it("rounds a fractional minute to a whole millisecond the schema accepts", () => {
    const ms = spacingMinutesToMs(1.5);
    expect(ms).toBe(90_000);
    expect(field.safeParse(spacingMinutesToMs(0.0001)).success).toBe(true);
  });
});
