"use client";

import { cn } from "@/shared/utils";
import type { ComposeStepSlug } from "@/ui/hooks/useComposeWizard";

/**
 * Step indicator, drawn as one horizontal bar across the top of the wizard.
 *
 * It used to be a left rail. The approved compose design gives the width to the
 * work and the live preview instead — three columns on a 1440px screen left the
 * album grid and the Facebook card fighting over the same 700px.
 *
 * It stays a semantic ordered list: a screen reader must be able to tell how
 * many steps there are, which one is current, and which ones are done
 * (web-wizard rule 5). Done steps are real buttons — going back must be cheap.
 * Steps not reached yet are disabled, because their data does not exist.
 *
 * Each step carries a `summary` written by the wizard, so the bar says what is
 * actually in the post ("MGKVX6310 · KEM · 10 ảnh") instead of repeating the
 * step title in smaller type.
 */

export interface StepperStep {
  readonly slug: ComposeStepSlug;
  readonly index: number;
  readonly title: string;
  /** One line of live detail about this step's contents. */
  readonly summary: string;
}

export function WizardStepper({
  steps,
  currentIndex,
  maxReachedIndex,
  onSelect,
}: {
  steps: readonly StepperStep[];
  currentIndex: number;
  /** Highest step the operator is allowed to jump to right now. */
  maxReachedIndex: number;
  onSelect: (slug: ComposeStepSlug) => void;
}) {
  return (
    <nav
      aria-label="Các bước soạn bài"
      className="bg-card border-border shrink-0 border-b px-4 py-2.5 lg:px-8"
    >
      <ol className="flex items-center gap-1 overflow-x-auto">
        {steps.map((step, position) => {
          const isCurrent = step.index === currentIndex;
          const isDone = step.index < currentIndex;
          const isReachable = step.index <= maxReachedIndex;

          return (
            <li key={step.slug} className="flex min-w-0 shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => onSelect(step.slug)}
                disabled={!isReachable || isCurrent}
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-xl border border-transparent px-3 py-2 text-left transition-colors outline-none focus-visible:ring-3",
                  isCurrent && "border-primary bg-accent/20",
                  !isCurrent && isReachable && "hover:bg-muted cursor-pointer",
                  !isReachable && "opacity-60",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-lg text-sm font-semibold tabular-nums",
                    isCurrent && "bg-primary text-primary-foreground",
                    isDone && "bg-success/30 text-success-foreground",
                    !isCurrent && !isDone && "bg-muted text-foreground-subtle",
                  )}
                >
                  {step.index}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm leading-5 font-semibold whitespace-nowrap">
                    <span className="sr-only">
                      Bước {step.index} trên {steps.length}:{" "}
                    </span>
                    {step.title}
                  </span>
                  <span className="text-muted-foreground hidden max-w-60 truncate text-xs leading-4 lg:block">
                    {step.summary}
                  </span>
                </span>
              </button>

              {position < steps.length - 1 ? (
                <span aria-hidden="true" className="text-foreground-subtle px-1 text-sm">
                  ›
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
