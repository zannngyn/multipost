import { cn } from "@/shared/utils";

import { SURVEY_STEP_COUNT, screenStep, type OnboardingScreen } from "./onboarding-steps";

/**
 * Four 6px dots at the top of the frame — "where am I in the survey".
 *
 * NOT INTERACTIVE (spec section 7.4). Plain spans, no button, no link: a dot is
 * a position report, and making it pressable would invite jumping over a
 * question the flow has not asked yet.
 *
 * The welcome screen draws NOTHING. It asks nothing, so it owns no dot
 * (spec section 3) and `screenStep` answers 0 for it — four empty dots would
 * imply a step that is pending.
 *
 * THE COUNT IS ALSO WORDS. Buffer ships the dots alone; a row of coloured
 * circles with no text is the "state conveyed by colour alone" failure, so
 * spec section 9.4 adds "Bước n/4" for screen readers. It is `sr-only` because
 * the sighted reading of the position is the dots themselves.
 *
 * Every colour is DECLARED, never inherited: Astryx's `<Theme>` scopes
 * `--color-text-primary` onto text below it, and that is the same near-black a
 * dark surface uses as its own background (spec section 10).
 */

const SURVEY_SCREENS: readonly Exclude<OnboardingScreen, "welcome">[] = [
  "seller",
  "tools",
  "count",
  "channels",
];

export function StepDots({ current }: { current: OnboardingScreen }) {
  const position = screenStep(current);

  // --- Edge case first: the greeting has no position to report --------------
  if (position === 0) return null;

  return (
    <div className="flex items-center">
      <span className="sr-only">
        Bước {position}/{SURVEY_STEP_COUNT}
      </span>

      {/* 6px dots, 6px apart — measured (spec section 2.4). Decoration beside
          the sentence above, so the whole row is hidden from assistive tech
          rather than announced a second time as four unnamed circles. */}
      <span aria-hidden="true" className="flex items-center gap-1.5">
        {SURVEY_SCREENS.map((id) => (
          <span
            key={id}
            className={cn(
              "block size-1.5 rounded-full motion-safe:transition-colors motion-safe:duration-300",
              screenStep(id) === position ? "bg-foreground" : "bg-foreground/25",
            )}
          />
        ))}
      </span>
    </div>
  );
}
