"use client";

import { cn } from "@/shared/utils";

import {
  ONBOARDING_SLIDE_IDS,
  SLIDE_TITLES,
  slideOrdinal,
  type OnboardingSlideId,
} from "./onboarding-steps";

/**
 * "Where am I, and how much is left" — six dots plus the count in words, at the
 * foot of the story column.
 *
 * IT NO LONGER PRINTS THE SLIDE TITLE. The title belongs to the slide's single
 * <h1>, two rows above it in the same column; printing it here as well put the
 * same words on screen twice, which is one of the three defects that sent the
 * one-column frame back.
 *
 * The dots are decoration — `aria-hidden` — and every one of them carries an
 * `sr-only` name, because a row of coloured circles with no words is the exact
 * "state conveyed by colour alone" failure (spec section 9).
 *
 * Every colour here is DECLARED, never inherited: Astryx's `<Theme>` scopes
 * `--color-text-primary` onto text below it and that is the same near-black a
 * dark surface uses as its background (spec section 10).
 */
export function ProgressRail({ current }: { current: OnboardingSlideId }) {
  const position = slideOrdinal(current);
  const total = ONBOARDING_SLIDE_IDS.length;

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex items-center gap-2.5">
        {ONBOARDING_SLIDE_IDS.map((id) => {
          const isCurrent = id === current;
          const isBehind = slideOrdinal(id) < position;

          return (
            <li
              key={id}
              aria-current={isCurrent ? "step" : undefined}
              className="flex items-center"
            >
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
                {isBehind ? `${SLIDE_TITLES[id]} — đã qua` : SLIDE_TITLES[id]}
              </span>
            </li>
          );
        })}
      </ol>

      {/* The count is TEXT, so the position survives without colour vision. */}
      <p className="text-foreground-subtle text-xs tabular-nums">
        Bước {position}/{total}
      </p>
    </div>
  );
}
