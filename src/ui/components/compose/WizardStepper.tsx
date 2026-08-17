"use client";

import { cn } from "@/shared/utils";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
import type { ComposeStepSlug } from "@/ui/hooks/useComposeWizard";

/**
 * Step indicator, rendered as the wizard's left rail on a wide screen and as a
 * scrollable strip on a narrow one — two renders of the same list, not one
 * layout squeezed (core-layout-shell §adaptive).
 *
 * It stays a semantic ordered list: a screen reader must be able to tell how
 * many steps there are, which one is current, and which ones are done
 * (web-wizard rule 5). Done steps are real buttons — going back must be cheap.
 * Steps not reached yet are disabled, because their data does not exist.
 *
 * Each step carries a `summary` written by the wizard, so the rail says what is
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
  notes,
}: {
  steps: readonly StepperStep[];
  currentIndex: number;
  /** Highest step the operator is allowed to jump to right now. */
  maxReachedIndex: number;
  onSelect: (slug: ComposeStepSlug) => void;
  /** Standing rules of the screen, pinned to the bottom of the rail. */
  notes?: React.ReactNode;
}) {
  return (
    <nav
      aria-label="Các bước soạn bài"
      className="bg-card border-border flex shrink-0 flex-col gap-2.5 border-b px-5 py-4 lg:w-75 lg:overflow-y-auto lg:border-r lg:border-b-0 lg:px-5 lg:py-6"
    >
      <Eyebrow className="hidden lg:block">Tiến trình</Eyebrow>

      <ol className="flex gap-1.5 overflow-x-auto lg:flex-col lg:overflow-x-visible">
        {steps.map((step, position) => {
          const isCurrent = step.index === currentIndex;
          const isDone = step.index < currentIndex;
          const isReachable = step.index <= maxReachedIndex;

          return (
            <li key={step.slug} className="min-w-0 shrink-0 lg:shrink">
              <button
                type="button"
                onClick={() => onSelect(step.slug)}
                disabled={!isReachable || isCurrent}
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "focus-visible:ring-ring/50 border-border bg-card flex w-full items-start gap-3.5 rounded-xl border p-3.5 text-left transition-colors outline-none focus-visible:ring-3",
                  isCurrent && "border-primary bg-accent/20 ring-primary ring-1",
                  !isCurrent && isReachable && "hover:bg-muted cursor-pointer",
                  !isReachable && "opacity-60",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-xl text-sm font-semibold tabular-nums",
                    isCurrent && "bg-primary text-primary-foreground",
                    isDone && "bg-success/30 text-success-foreground",
                    !isCurrent && !isDone && "bg-muted text-foreground-subtle",
                  )}
                >
                  {step.index}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm leading-5 font-semibold">
                    <span className="sr-only">
                      Bước {step.index} trên {steps.length}:{" "}
                    </span>
                    {step.title}
                  </span>
                  <span className="text-muted-foreground hidden text-xs leading-relaxed lg:block">
                    {step.summary}
                  </span>
                </span>
              </button>

              {position < steps.length - 1 ? (
                <span aria-hidden="true" className="bg-border ml-7.5 hidden h-3.5 w-px lg:block" />
              ) : null}
            </li>
          );
        })}
      </ol>

      {notes ? <div className="mt-auto hidden flex-col gap-2 pt-6 lg:flex">{notes}</div> : null}
    </nav>
  );
}
