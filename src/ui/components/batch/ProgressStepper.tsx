import { cn } from "@/shared/utils";
import {
  STEP_STATE_LABELS,
  stepStates,
  type StepState,
} from "@/ui/components/batch/channel-progress";

/**
 * Compact horizontal stepper for one channel row (design §5.9).
 *
 * [L6-New] Search-Before-Create: `compose/WizardStepper` is the only stepper in
 * the repo and does not fit — it is a NAVIGATION rail (buttons, jump back, typed
 * to `ComposeStepSlug`, vertical on desktop). This one is read-only, horizontal,
 * lives inside a table cell, and nothing on it is clickable. Wrapping it would
 * mean disabling every button it exists for.
 *
 * The labels come in from the server, which reads them from the domain: a stage
 * added there must not land on whatever index a screen happened to hardcode.
 *
 * NO `aria-live` here, on purpose: this list re-renders every 1.5s on every row,
 * and a live region per row turns a screen reader into noise. The batch summary
 * line at the top of the screen is the one place that speaks (design §5.9).
 */
export function ProgressStepper({
  steps,
  currentIndex,
  label,
}: {
  steps: readonly string[];
  currentIndex: number;
  /** Accessible name of the list, e.g. "Các bước đăng bài của kênh X". */
  label: string;
}) {
  if (steps.length === 0) return null;
  const states = stepStates(steps.length, currentIndex);

  return (
    <ol aria-label={label} className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      {steps.map((step, position) => {
        const state = states[position] ?? "upcoming";
        return (
          <li key={step} className="flex items-center gap-1.5">
            <span
              // State is spoken, never carried by colour alone (a11y).
              aria-current={state === "current" ? "step" : undefined}
              className={cn("flex items-center gap-1", toneOf(state))}
            >
              <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dotOf(state))} />
              {step}
              <span className="sr-only"> — {STEP_STATE_LABELS[state]}</span>
            </span>
            {position < steps.length - 1 ? (
              <span aria-hidden="true" className="text-foreground-subtle">
                ›
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function toneOf(state: StepState): string {
  if (state === "current") return "text-foreground font-medium";
  if (state === "done") return "text-muted-foreground";
  return "text-foreground-subtle";
}

function dotOf(state: StepState): string {
  if (state === "current") return "bg-primary";
  if (state === "done") return "bg-success";
  return "bg-border";
}
