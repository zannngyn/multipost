"use client";

import { cn } from "@/shared/utils";
import type { COMPOSE_STEPS, ComposeStepSlug } from "@/ui/hooks/useComposeWizard";

/**
 * Step indicator. A semantic ordered list, not a row of divs: a screen reader
 * must be able to tell how many steps there are, which one is current, and
 * which ones are done (web-wizard rule 5).
 *
 * Done steps are real buttons — going back must be cheap. Steps not reached
 * yet are disabled, because their data does not exist.
 */
export function WizardStepper({
  steps,
  currentIndex,
  maxReachedIndex,
  onSelect,
}: {
  steps: typeof COMPOSE_STEPS;
  currentIndex: number;
  /** Highest step the operator is allowed to jump to right now. */
  maxReachedIndex: number;
  onSelect: (slug: ComposeStepSlug) => void;
}) {
  return (
    <nav aria-label="Các bước soạn bài">
      <ol className="flex flex-wrap gap-2">
        {steps.map((step) => {
          const isCurrent = step.index === currentIndex;
          const isDone = step.index < currentIndex;
          const isReachable = step.index <= maxReachedIndex;

          return (
            <li key={step.slug}>
              <button
                type="button"
                onClick={() => onSelect(step.slug)}
                disabled={!isReachable || isCurrent}
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "focus-visible:ring-ring/50 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors outline-none focus-visible:ring-3",
                  isCurrent && "border-primary bg-primary/5 font-medium",
                  !isCurrent && isReachable && "hover:bg-muted",
                  !isReachable && "text-muted-foreground opacity-60",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 items-center justify-center rounded-full border text-xs tabular-nums",
                    isDone && "border-success/40 bg-success/10",
                  )}
                  aria-hidden="true"
                >
                  {step.index}
                </span>
                <span>
                  <span className="sr-only">
                    Bước {step.index} trên {steps.length}:{" "}
                  </span>
                  {step.title}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
