"use client";

import { cn } from "@/shared/utils";

import { SURVEY_STEP_COUNT, screenStep, type OnboardingScreen } from "./onboarding-steps";

/**
 * "Where am I, and how much is left" — one dot per survey step plus the count
 * in words.
 *
 * The welcome screen draws NOTHING: it asks no question, so it owns no dot
 * (spec section 3). `screenStep` answers 0 for it, and this component renders
 * null rather than a rail of four empty dots that would imply a pending step.
 *
 * The dots are decoration — `aria-hidden` — and every one of them carries an
 * `sr-only` name, because a row of coloured circles with no words is the exact
 * "state conveyed by colour alone" failure (spec section 9).
 *
 * Every colour here is DECLARED, never inherited: Astryx's `<Theme>` scopes
 * `--color-text-primary` onto text below it and that is the same near-black a
 * dark surface uses as its background (spec section 10).
 *
 * NOTE: task 5 replaces this rail with `StepDots` from spec section 2.4. It is
 * kept here, retargeted, so the flow still states its position in words in the
 * meantime.
 */

/** Short names for the dots only. The visible question lives in each step's <h1>. */
const STEP_NAMES: Record<Exclude<OnboardingScreen, "welcome">, string> = {
  seller: "Kiểu bán hàng",
  tools: "Công cụ đang dùng",
  count: "Số trang đang quản lý",
  channels: "Kênh tập trung",
};

const SURVEY_SCREENS = Object.keys(STEP_NAMES) as (keyof typeof STEP_NAMES)[];

export function ProgressRail({ current }: { current: OnboardingScreen }) {
  const position = screenStep(current);

  // --- Edge case first: the greeting has no position to report --------------
  if (position === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex items-center gap-2.5">
        {SURVEY_SCREENS.map((id) => {
          const isCurrent = id === current;
          const isBehind = screenStep(id) < position;

          return (
            <li key={id} aria-current={isCurrent ? "step" : undefined} className="flex items-center">
              {/* Size AND fill change together: two channels, so the current
                  dot still reads at a glance without colour vision. */}
              <span
                aria-hidden="true"
                className={cn(
                  "block rounded-full motion-safe:transition-all motion-safe:duration-300",
                  isCurrent
                    ? "bg-primary size-2.5"
                    : isBehind
                      ? "bg-primary/70 size-1.5"
                      : "bg-muted-foreground/30 size-1.5",
                )}
              />
              <span className="sr-only">
                {isBehind ? `${STEP_NAMES[id]} — đã qua` : STEP_NAMES[id]}
              </span>
            </li>
          );
        })}
      </ol>

      {/* The count is TEXT, so the position survives without colour vision. */}
      <p className="text-foreground-subtle text-xs tabular-nums">
        Bước {position}/{SURVEY_STEP_COUNT}
      </p>
    </div>
  );
}
