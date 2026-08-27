import { describe, expect, it } from "vitest";

import {
  ONBOARDING_SCREENS,
  SURVEY_STEP_COUNT,
  isOnboardingScreen,
  nextScreen,
  previousScreen,
  resolveScreen,
  screenStep,
} from "./onboarding-steps";

import type { OnboardingScreen } from "./onboarding-steps";

/**
 * Position in the survey is DERIVED, never stored on the server: there is no
 * "have you connected Google yet" flag behind these five screens. The URL
 * carries an intent (`?step=`), the answers carry the truth, and this file
 * pins how the two are reconciled.
 */

type Answered = Partial<Record<OnboardingScreen, boolean>>;

function resolve(
  requested: string | null,
  answered: Answered,
  hasStarted = true,
): OnboardingScreen {
  return resolveScreen({ requested, answered, hasStarted });
}

describe("ONBOARDING_SCREENS", () => {
  it("lists the welcome screen and the four survey steps in running order", () => {
    expect(ONBOARDING_SCREENS).toEqual([
      "welcome",
      "seller",
      "tools",
      "count",
      "channels",
    ]);
  });

  it("counts four survey steps, which is what the dots draw", () => {
    expect(SURVEY_STEP_COUNT).toBe(4);
  });
});

describe("isOnboardingScreen", () => {
  it("accepts a real screen and rejects anything else", () => {
    expect(isOnboardingScreen("tools")).toBe(true);
    expect(isOnboardingScreen("company")).toBe(false);
    expect(isOnboardingScreen(null)).toBe(false);
    expect(isOnboardingScreen(3)).toBe(false);
  });
});

describe("screenStep", () => {
  it("gives the welcome screen no step number — it has no dot", () => {
    expect(screenStep("welcome")).toBe(0);
  });

  it("numbers the four survey steps 1..4", () => {
    expect(screenStep("seller")).toBe(1);
    expect(screenStep("tools")).toBe(2);
    expect(screenStep("count")).toBe(3);
    expect(screenStep("channels")).toBe(4);
  });
});

describe("resolveScreen — edge cases first", () => {
  it("pins to the welcome screen until the operator has pressed Bắt đầu", () => {
    // Deep-linking past the greeting would drop somebody into a question with
    // no idea what they are answering for.
    expect(resolve("channels", {}, false)).toBe("welcome");
    expect(resolve(null, {}, false)).toBe("welcome");
  });

  it("ignores a requested value that is not a screen", () => {
    expect(resolve("../../etc/passwd", {}, false)).toBe("welcome");
    expect(resolve("../../etc/passwd", {})).toBe("seller");
  });

  it("clamps a request that runs ahead of the first unanswered step", () => {
    expect(resolve("channels", {})).toBe("seller");
    expect(resolve("count", { seller: true })).toBe("tools");
  });

  it("treats saved answers as proof the flow was started", () => {
    // Closing the tab mid-survey and coming back must reopen the pending step,
    // not replay the greeting (spec section 7.6).
    expect(resolve(null, { seller: true }, false)).toBe("tools");
  });
});

describe("resolveScreen — walking the survey", () => {
  it("opens the first question once the flow has started", () => {
    expect(resolve(null, {})).toBe("seller");
  });

  it("moves on to the next question once one is answered", () => {
    expect(resolve(null, { seller: true })).toBe("tools");
    expect(resolve(null, { seller: true, tools: true })).toBe("count");
  });

  it("allows going BACK to a step that is already answered", () => {
    expect(resolve("seller", { seller: true, tools: true })).toBe("seller");
    expect(resolve("welcome", { seller: true })).toBe("welcome");
  });

  it("stays on the last question when every step is answered", () => {
    // Finishing is `nextScreen`'s job; resolving must never return a screen
    // that does not exist.
    expect(
      resolve(null, { seller: true, tools: true, count: true, channels: true }),
    ).toBe("channels");
  });
});

describe("nextScreen / previousScreen", () => {
  it("walks forward from the greeting into the survey", () => {
    expect(nextScreen("welcome")).toBe("seller");
    expect(nextScreen("count")).toBe("channels");
  });

  it("reports the end of the flow instead of a sixth screen", () => {
    expect(nextScreen("channels")).toBe("done");
  });

  it("walks backward and reports nothing before the greeting", () => {
    expect(previousScreen("tools")).toBe("seller");
    expect(previousScreen("seller")).toBe("welcome");
    expect(previousScreen("welcome")).toBeNull();
  });
});

describe("the celebration is deliberately NOT one of these screens", () => {
  /**
   * REGRESSION GUARD FOR A DESIGN DECISION, not for a bug that happened.
   *
   * The obvious way to add a celebration is to append it to
   * `ONBOARDING_SCREENS`. That single edit changes the answer of `screenStep`,
   * `nextScreen`, `previousScreen` AND `isOnboardingScreen` at once — and the
   * last of those is the one that bites: it would make `?step=celebrate`
   * a valid, hand-typable URL, i.e. a way to skip all four questions and land
   * on "xong rồi". The celebration is a consequence of a mutation succeeding,
   * not a position in a URL.
   */
  it("keeps the URL vocabulary at five screens", () => {
    expect(ONBOARDING_SCREENS).toEqual([
      "welcome",
      "seller",
      "tools",
      "count",
      "channels",
    ]);
    expect(ONBOARDING_SCREENS).not.toContain("celebrate");
  });

  it("refuses `?step=celebrate` rather than honouring it", () => {
    const answered = { seller: true, tools: true, count: true, channels: true };
    expect(isOnboardingScreen("celebrate")).toBe(false);
    // A hand-typed one clamps to the flow's own answer, exactly like any other
    // stale or invented value.
    expect(
      resolveScreen({ requested: "celebrate", answered, hasStarted: true }),
    ).toBe("channels");
    expect(
      resolveScreen({
        requested: "celebrate",
        answered: {},
        hasStarted: false,
      }),
    ).toBe("welcome");
  });

  it("still ends the survey at `done` after the last question", () => {
    // `nextScreen` is what `runAttempt` reads to decide whether to call
    // `finish`. A sixth entry in the array above would turn this into
    // `"celebrate"` and the survey would never write `completed_at` at all.
    expect(nextScreen("channels")).toBe("done");
  });

  it("gives the celebration no position among the dots", () => {
    // `screenStep` answers for the four QUESTIONS. `StepDots` handles the
    // finished state itself — a fifth position here would mean a fifth dot
    // everywhere this type is read.
    expect(screenStep("welcome")).toBe(0);
    expect(screenStep("channels")).toBe(4);
  });
});
