import { describe, expect, it } from "vitest";

import type { OnboardingProfileView } from "@/ui/schemas/onboarding-profile.schema";

import {
  answeredScreens,
  EMPTY_ANSWERS,
  isAlreadyStored,
  stepPatch,
  type SurveyAnswers,
} from "../onboarding-answers";
import { ONBOARDING_SCREENS } from "../onboarding-steps";

/**
 * What the flow puts ON THE WIRE, and what it reads back off it.
 *
 * Three contract rules are locked here because every one of them is invisible
 * from the screen and expensive to find later:
 *   1. `PATCH {}` is refused by the route (400 "Patch must carry at least one
 *      answer"), so a step must never build one;
 *   2. `null` and `[]` are different facts — "bỏ qua" versus "không dùng cái
 *      nào" — at the DB, at the usecase and on the platform screen;
 *   3. a step whose stored answer already equals what is about to be written
 *      must not spend a round trip (and a spinner) rewriting it.
 */

const FULL: SurveyAnswers = {
  sellerKind: "shop_owner",
  currentTools: ["meta_business_suite"],
  channelCount: "4-6",
  focusChannels: ["facebook", "tiktok"],
};

const STORED: OnboardingProfileView = {
  sellerKind: "shop_owner",
  currentTools: ["meta_business_suite"],
  channelCount: "4-6",
  focusChannels: ["facebook", "tiktok"],
  completedAt: null,
};

const UNANSWERED: OnboardingProfileView = {
  sellerKind: null,
  currentTools: null,
  channelCount: null,
  focusChannels: null,
  completedAt: null,
};

describe("stepPatch — one step, one field", () => {
  it("carries exactly one answer for every survey screen", () => {
    for (const screen of ONBOARDING_SCREENS) {
      if (screen === "welcome") continue;
      const patch = stepPatch(screen, FULL);
      expect(patch, `${screen} must write something`).not.toBeNull();
      expect(Object.keys(patch!), `${screen} writes one field`).toHaveLength(1);
    }
  });

  it("NEVER builds an empty patch, not even when nothing was chosen", () => {
    // `PATCH {}` is a 400. "Bỏ qua" has to spell itself out as `null`.
    for (const screen of ONBOARDING_SCREENS) {
      if (screen === "welcome") continue;
      const patch = stepPatch(screen, EMPTY_ANSWERS);
      expect(Object.keys(patch ?? {}), `${screen} skipped`).toHaveLength(1);
    }
    expect(stepPatch("seller", EMPTY_ANSWERS)).toEqual({ sellerKind: null });
    expect(stepPatch("tools", EMPTY_ANSWERS)).toEqual({ currentTools: null });
    expect(stepPatch("count", EMPTY_ANSWERS)).toEqual({ channelCount: null });
    expect(stepPatch("channels", EMPTY_ANSWERS)).toEqual({ focusChannels: null });
  });

  it("writes nothing for the greeting — it asks no question", () => {
    expect(stepPatch("welcome", FULL)).toBeNull();
  });

  it("keeps an empty list as a list, never as null", () => {
    // `[]` is an answer ("không dùng cái nào"); `null` is a skip. Collapsing
    // one into the other makes "how many skipped?" unanswerable.
    expect(stepPatch("tools", { ...FULL, currentTools: [] })).toEqual({ currentTools: [] });
    expect(stepPatch("channels", { ...FULL, focusChannels: [] })).toEqual({ focusChannels: [] });
  });
});

describe("isAlreadyStored — do not rewrite what is already there", () => {
  it("recognises an unchanged single answer", () => {
    expect(isAlreadyStored({ sellerKind: "shop_owner" }, STORED)).toBe(true);
    expect(isAlreadyStored({ sellerKind: "agency" }, STORED)).toBe(false);
  });

  it("recognises an unchanged list, order included", () => {
    expect(isAlreadyStored({ focusChannels: ["facebook", "tiktok"] }, STORED)).toBe(true);
    // Order IS the operator's pick order and is what step 4 renders back.
    expect(isAlreadyStored({ focusChannels: ["tiktok", "facebook"] }, STORED)).toBe(false);
    expect(isAlreadyStored({ focusChannels: ["facebook"] }, STORED)).toBe(false);
  });

  it("never confuses null with an empty list", () => {
    const emptied: OnboardingProfileView = { ...STORED, currentTools: [] };
    expect(isAlreadyStored({ currentTools: null }, emptied)).toBe(false);
    expect(isAlreadyStored({ currentTools: [] }, emptied)).toBe(true);
    expect(isAlreadyStored({ currentTools: [] }, UNANSWERED)).toBe(false);
    expect(isAlreadyStored({ currentTools: null }, UNANSWERED)).toBe(true);
  });

  it("says no when nothing is known about the tenant yet", () => {
    // Undefined is "not read", not "empty" — writing must go ahead.
    expect(isAlreadyStored({ sellerKind: null }, undefined)).toBe(false);
  });
});

describe("answeredScreens — where the flow reopens", () => {
  it("counts a stored answer, whatever its shape", () => {
    expect(answeredScreens(STORED)).toEqual({
      seller: true,
      tools: true,
      count: true,
      channels: true,
    });
  });

  it("counts an empty list as answered", () => {
    expect(answeredScreens({ ...UNANSWERED, focusChannels: [] }).channels).toBe(true);
  });

  it("counts nothing for a tenant that never answered", () => {
    expect(answeredScreens(UNANSWERED)).toEqual({
      seller: false,
      tools: false,
      count: false,
      channels: false,
    });
  });

  it("counts nothing while the profile has not been read", () => {
    expect(answeredScreens(undefined)).toEqual({
      seller: false,
      tools: false,
      count: false,
      channels: false,
    });
  });
});
