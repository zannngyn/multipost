import { describe, expect, it } from "vitest";

import type { SetupProgress, SetupStepId } from "@/ui/schemas/setup-progress.schema";

import {
  ONBOARDING_SLIDE_IDS,
  isOnboardingSlideId,
  nextSlide,
  previousSlide,
  resolveSlide,
  slideOrdinal,
} from "./onboarding-steps";

/**
 * Position in the flow is derived, never stored: the two middle slides leave
 * the page for OAuth, so any React state would be gone by the time the browser
 * comes back. These tests pin the derivation.
 */

const ALL: readonly SetupStepId[] = [
  "tenant",
  "google",
  "source",
  "facebook",
  "group",
  "firstPost",
];

function progressOf(done: Partial<Record<SetupStepId, boolean>>): SetupProgress {
  return {
    tenantId: "00000000-0000-0000-0000-000000000001",
    steps: ALL.map((id) => ({ id, isDone: done[id] ?? false })),
    doneCount: ALL.filter((id) => done[id]).length,
    requiredCount: 5,
    isReady: Boolean(done.source && done.facebook),
  };
}

describe("ONBOARDING_SLIDE_IDS", () => {
  it("lists the six slides in running order", () => {
    expect(ONBOARDING_SLIDE_IDS).toEqual([
      "company",
      "data",
      "facebook",
      "group",
      "invite",
      "congrats",
    ]);
  });

  it("numbers them 1..6 for the progress rail", () => {
    expect(ONBOARDING_SLIDE_IDS.map(slideOrdinal)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("isOnboardingSlideId", () => {
  it("accepts a real id and rejects anything else", () => {
    expect(isOnboardingSlideId("data")).toBe(true);
    expect(isOnboardingSlideId("nonsense")).toBe(false);
    expect(isOnboardingSlideId(null)).toBe(false);
    expect(isOnboardingSlideId(2)).toBe(false);
  });
});

describe("resolveSlide — edge cases first", () => {
  it("pins to the company slide when there is no tenant yet", () => {
    // No company means every tenant-scoped API answers 409; nothing else can run.
    expect(resolveSlide({ progress: null, requested: "congrats", passed: [] })).toBe("company");
  });

  it("ignores a requested id that is not a slide", () => {
    const progress = progressOf({ tenant: true });
    expect(resolveSlide({ progress, requested: "../../etc/passwd", passed: [] })).toBe("data");
  });

  it("clamps a requested slide that runs ahead of the first open one", () => {
    const progress = progressOf({ tenant: true });
    expect(resolveSlide({ progress, requested: "congrats", passed: [] })).toBe("data");
  });

  it("allows going BACK to an already settled slide", () => {
    const progress = progressOf({ tenant: true });
    expect(resolveSlide({ progress, requested: "company", passed: [] })).toBe("company");
  });
});

describe("resolveSlide — walking the flow", () => {
  it("opens the data slide once the company exists", () => {
    expect(resolveSlide({ progress: progressOf({ tenant: true }), requested: null, passed: [] })).toBe(
      "data",
    );
  });

  it("moves past a slide the operator chose to do later", () => {
    // "Để sau" must not bounce the operator back onto the slide they just left.
    expect(
      resolveSlide({ progress: progressOf({ tenant: true }), requested: null, passed: ["data"] }),
    ).toBe("facebook");
  });

  it("moves past a slide the server already reports as done", () => {
    expect(
      resolveSlide({
        progress: progressOf({ tenant: true, source: true }),
        requested: null,
        passed: [],
      }),
    ).toBe("facebook");
  });

  it("still stops on the invite slide, which has no server flag", () => {
    expect(
      resolveSlide({
        progress: progressOf({ tenant: true, source: true, facebook: true, group: true }),
        requested: null,
        passed: [],
      }),
    ).toBe("invite");
  });

  it("lands on congrats when everything is settled", () => {
    expect(
      resolveSlide({
        progress: progressOf({ tenant: true, source: true, facebook: true, group: true }),
        requested: null,
        passed: ["invite"],
      }),
    ).toBe("congrats");
  });
});

describe("nextSlide / previousSlide", () => {
  it("walks forward and stops at congrats", () => {
    expect(nextSlide("company")).toBe("data");
    expect(nextSlide("invite")).toBe("congrats");
    expect(nextSlide("congrats")).toBe("congrats");
  });

  it("walks backward and reports no slide before the first", () => {
    expect(previousSlide("data")).toBe("company");
    expect(previousSlide("company")).toBeNull();
  });
});
