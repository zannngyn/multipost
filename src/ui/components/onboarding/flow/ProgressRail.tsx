"use client";

import { cn } from "@/shared/utils";

import {
  ONBOARDING_SLIDE_IDS,
  SLIDE_TITLES,
  slideOrdinal,
  type OnboardingSlideId,
} from "./onboarding-steps";

/**
 * "Where am I, and how much is left" — stated in words as well as in colour.
 *
 * The bar is animated with `scaleX`, never `width`: animating width forces
 * layout on every frame and shows up as CLS. Every text colour on this strip is
 * declared, never inherited (spec §10).
 */
export function ProgressRail({ current }: { current: OnboardingSlideId }) {
  const position = slideOrdinal(current);
  const total = ONBOARDING_SLIDE_IDS.length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <p className="text-foreground text-sm font-semibold">{SLIDE_TITLES[current]}</p>
        {/* The count is TEXT, so the position survives without colour vision. */}
        <p className="text-muted-foreground text-xs tabular-nums">
          Bước {position}/{total}
        </p>
      </div>

      <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
        <div
          aria-hidden="true"
          className="bg-primary h-full w-full origin-left rounded-full motion-safe:transition-transform motion-safe:duration-300"
          style={{ transform: `scaleX(${position / total})` }}
        />
      </div>

      <ol className="flex flex-wrap gap-x-4 gap-y-1">
        {ONBOARDING_SLIDE_IDS.map((id) => {
          const isCurrent = id === current;
          return (
            <li
              key={id}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "text-xs",
                isCurrent ? "text-foreground font-semibold" : "text-muted-foreground",
              )}
            >
              {SLIDE_TITLES[id]}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
