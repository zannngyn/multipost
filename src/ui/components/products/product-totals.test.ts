import { describe, expect, it } from "vitest";

import { matchingTotal } from "@/ui/components/products/product-totals";

const TOTALS = { total: 299, ok: 20, blocked: 279 };

describe("matchingTotal", () => {
  it("uses the whole catalog when no status is selected", () => {
    expect(matchingTotal(TOTALS, { status: null, q: null })).toBe(299);
  });

  it("uses the publishable count for status=ok", () => {
    // The bug this guards: showing "20 / 299" while the list is filtered to 20.
    expect(matchingTotal(TOTALS, { status: "ok", q: null })).toBe(20);
  });

  it("uses the blocked count for status=blocked", () => {
    expect(matchingTotal(TOTALS, { status: "blocked", q: null })).toBe(279);
  });

  it("keeps using the status count when a search is also active", () => {
    // The API already narrowed `totals` by the query, so the status count is
    // still the right denominator — it must not fall back to total.
    const searched = { total: 4, ok: 1, blocked: 3 };
    expect(matchingTotal(searched, { status: "ok", q: "Mironne" })).toBe(1);
    expect(matchingTotal(searched, { status: null, q: "Mironne" })).toBe(4);
  });
});
