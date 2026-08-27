/**
 * Where the operator is in the onboarding survey — a PURE function of the URL
 * and of which questions already have an answer.
 *
 * NO SERVER FLAG DECIDES POSITION ANY MORE. The screens this file drives are a
 * profile survey, not a setup wizard: there is no "is Google connected yet" to
 * reconcile against, and connecting sources moved back to `SetupDock` and the
 * real routes. What is left is small on purpose — `?step=` carries an INTENT,
 * the answers carry the truth, and the intent is clamped to the truth here.
 */

export const ONBOARDING_SCREENS = ["welcome", "seller", "tools", "count", "channels"] as const;

export type OnboardingScreen = (typeof ONBOARDING_SCREENS)[number];

/** The four screens that ask a question. `welcome` only greets. */
const SURVEY_SCREENS = ["seller", "tools", "count", "channels"] as const;

export const SURVEY_STEP_COUNT = SURVEY_SCREENS.length;

/** The last survey screen, used as the clamp when everything is answered. */
const LAST_SURVEY_SCREEN: OnboardingScreen = SURVEY_SCREENS[SURVEY_SCREENS.length - 1]!;

export function isOnboardingScreen(value: unknown): value is OnboardingScreen {
  return typeof value === "string" && (ONBOARDING_SCREENS as readonly string[]).includes(value);
}

/** 1..4 for the survey steps; `welcome` gets 0 because it draws no dot. */
export function screenStep(id: OnboardingScreen): 0 | 1 | 2 | 3 | 4 {
  const index = SURVEY_SCREENS.indexOf(id as (typeof SURVEY_SCREENS)[number]);
  return index < 0 ? 0 : ((index + 1) as 1 | 2 | 3 | 4);
}

export interface ResolveScreenInput {
  /** `?step=` off the URL. An INTENT: it is clamped, never trusted. */
  readonly requested: string | null;
  /**
   * Which questions already carry an answer. A skipped question counts as
   * answered — "Bỏ qua" is a decision, and re-asking it would trap the flow.
   */
  readonly answered: Partial<Record<OnboardingScreen, boolean>>;
  /** True once "Bắt đầu" has been pressed on the welcome screen. */
  readonly hasStarted: boolean;
}

export function resolveScreen({ requested, answered, hasStarted }: ResolveScreenInput): OnboardingScreen {
  // --- Edge cases first ----------------------------------------------------
  // An answer on file is proof the greeting was passed: closing the tab
  // mid-survey and coming back must reopen the pending question rather than
  // replay the greeting (spec section 7.6).
  const hasAnswer = SURVEY_SCREENS.some((id) => answered[id] === true);
  if (!hasStarted && !hasAnswer) return "welcome";

  const firstOpen: OnboardingScreen =
    SURVEY_SCREENS.find((id) => answered[id] !== true) ?? LAST_SURVEY_SCREEN;

  // A hand-typed or stale `?step=` must not blank the screen.
  if (!isOnboardingScreen(requested)) return firstOpen;

  // Going BACK is allowed — re-reading an answered question costs nothing, and
  // the back arrow depends on it. Going FORWARD past an unanswered question is
  // not: the flow would skip a step the operator never saw.
  const isBehind =
    ONBOARDING_SCREENS.indexOf(requested) <= ONBOARDING_SCREENS.indexOf(firstOpen);

  return isBehind ? requested : firstOpen;
}

/** `'done'` rather than a sixth screen: leaving the flow is the caller's job. */
export function nextScreen(current: OnboardingScreen): OnboardingScreen | "done" {
  const index = ONBOARDING_SCREENS.indexOf(current);
  return ONBOARDING_SCREENS[index + 1] ?? "done";
}

export function previousScreen(current: OnboardingScreen): OnboardingScreen | null {
  const index = ONBOARDING_SCREENS.indexOf(current);
  return index <= 0 ? null : ONBOARDING_SCREENS[index - 1]!;
}
