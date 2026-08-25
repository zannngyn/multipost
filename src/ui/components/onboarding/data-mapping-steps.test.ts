import { describe, expect, it } from "vitest";

import {
  DATA_MAPPING_STEPS,
  canVisitStep,
  resolveStep,
  stepHref,
  stepStatuses,
} from "@/ui/components/onboarding/data-mapping-steps";

/** Edge cases first: a hand-typed URL must never produce a broken screen. */
describe("resolveStep", () => {
  it("falls back to the first step for a missing or nonsense value", () => {
    expect(resolveStep(null, { hasSource: true })).toEqual({ step: "nguon", refusedStep: null });
    expect(resolveStep("buoc-99", { hasSource: true })).toEqual({
      step: "nguon",
      refusedStep: null,
    });
  });

  it("refuses a later step when the tenant has no source yet, and SAYS which one", () => {
    expect(resolveStep("anh-xa", { hasSource: false })).toEqual({
      step: "nguon",
      refusedStep: "anh-xa",
    });
  });

  it("does not bounce while the source query has not answered", () => {
    // `null` is "chưa biết". Redirecting on it would throw an operator back to
    // step 1 every time the page loads slowly.
    expect(resolveStep("bao-cao", { hasSource: null })).toEqual({
      step: "bao-cao",
      refusedStep: null,
    });
  });

  it("lets a configured tenant land straight on any step", () => {
    expect(resolveStep("bao-cao", { hasSource: true }).step).toBe("bao-cao");
    expect(resolveStep("anh-xa", { hasSource: true }).step).toBe("anh-xa");
  });
});

describe("stepHref", () => {
  it("keeps the bare path for step 1 so the default URL stays clean", () => {
    expect(stepHref("nguon")).toBe("/data-mapping");
  });

  it("puts the step — and only the step — in the query string", () => {
    expect(stepHref("anh-xa")).toBe("/data-mapping?buoc=anh-xa");
  });
});

describe("stepStatuses", () => {
  it("marks step 1 done once a source is stored, even while standing on step 3", () => {
    const statuses = stepStatuses("anh-xa", { hasSource: true });

    expect(statuses).toEqual({ nguon: "done", "bao-cao": "done", "anh-xa": "current" });
  });

  it("does not call step 1 done for a tenant with no source", () => {
    const statuses = stepStatuses("nguon", { hasSource: false });

    expect(statuses).toEqual({ nguon: "current", "bao-cao": "todo", "anh-xa": "todo" });
  });
});

describe("canVisitStep", () => {
  it("always allows step 1 and gates the rest on a stored source", () => {
    expect(canVisitStep("nguon", { hasSource: false })).toBe(true);
    expect(canVisitStep("bao-cao", { hasSource: false })).toBe(false);
    expect(canVisitStep("bao-cao", { hasSource: null })).toBe(false);
    expect(canVisitStep("anh-xa", { hasSource: true })).toBe(true);
  });
});

describe("the rail itself", () => {
  it("names each step by its content, never 'Bước N'", () => {
    for (const step of DATA_MAPPING_STEPS) {
      expect(step.label).not.toMatch(/^Bước\s*\d/i);
      expect(step.label.length).toBeGreaterThan(0);
    }
  });
});
