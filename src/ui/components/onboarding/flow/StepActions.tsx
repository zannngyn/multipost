"use client";

import { ArrowRight, Loader2 } from "lucide-react";

import { cn } from "@/shared/utils";
import { Button } from "@/ui/components/ui/button";

/**
 * The pair of controls under every survey step: one way forward, one way past
 * (spec section 7.1 and 7.2, reference shots `01-…` through `04-…`).
 *
 * THE LABEL CHANGES, IT DOES NOT ONLY FADE. A greyed-out "Tiếp tục" tells the
 * operator that something is wrong but not what; the button says what it is
 * waiting for instead. That is the pattern recorded from Buffer's own system
 * (analysis 3.9) and it is why this component owns the wording rather than
 * taking a label prop for the blocked state by default.
 *
 * THE BLOCKED BUTTON KEEPS ITS CONTRAST. The shared `Button` fades a disabled
 * control to 50% opacity, which is fine when the label is "Tiếp tục" and
 * useless when the label is the explanation. So the blocked state changes
 * VARIANT — a sunken surface with muted text, which is what Buffer's measured
 * `#DEDCD9` on `#7C7B79` is — and keeps its opacity, so the sentence stays
 * readable.
 *
 * "BỎ QUA" IS NOT UNDERLINED (spec section 7.2). It is a button, not a link: it
 * moves the flow on without writing an answer, and it stays reachable in every
 * state except while a write is in flight.
 *
 * 352x48 with `rounded-md` — the button is past every size the shared `Button`
 * scale reaches (it tops out at 36px), so those come through `className`
 * rather than as a new variant nobody else in the app would use. `rounded-md`
 * is the token nearest the measured 12px (`--radius` * 0.8 = 12.8px); the
 * visual gate names a hardcoded 12px as a failure.
 */
export function StepActions({
  /** False until the step has an answer. Drives both label and variant. */
  canContinue,
  /** True while the answer is being written (spec section 2.5). */
  isSaving = false,
  onContinue,
  onSkip,
  /** The last step ends the flow, so it may want its own word for "forward". */
  continueLabel = "Tiếp tục",
  className,
}: {
  canContinue: boolean;
  isSaving?: boolean;
  onContinue: () => void;
  onSkip: () => void;
  continueLabel?: string;
  className?: string;
}) {
  // --- Edge cases first ----------------------------------------------------
  // Saving wins over everything: a second press would be a second write and,
  // worse, a second step forward. Both ways out are shut while it is in flight.
  const isBlocked = !canContinue && !isSaving;
  const isLocked = isSaving || isBlocked;

  return (
    <div className={cn("flex w-full flex-col items-center gap-2", className)}>
      <Button
        type="button"
        variant={isBlocked ? "secondary" : "default"}
        disabled={isLocked}
        onClick={onContinue}
        className={cn(
          // 352x48, 0 24px of padding, corners off the token (spec section 2.4).
          "h-12 w-[22rem] max-w-full gap-2 rounded-md px-6 text-sm font-medium",
          // Keeps the explanation legible instead of fading it to half.
          isBlocked && "text-muted-foreground disabled:opacity-100",
        )}
      >
        {isSaving ? (
          <>
            <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />
            Đang lưu…
          </>
        ) : isBlocked ? (
          "Chọn một mục để tiếp tục"
        ) : (
          <>
            {continueLabel}
            <ArrowRight aria-hidden="true" />
          </>
        )}
      </Button>

      {/*
        Ghost, so the pill-shaped wash only appears under a pointer or a focus
        ring, which is how `03-count-selected.jpg` catches it. `size` default is
        32px tall — past WCAG 2.2's 24px minimum — at 14px / weight 500, the
        measured type (spec section 2.3).
      */}
      <Button
        type="button"
        variant="ghost"
        disabled={isSaving}
        onClick={onSkip}
        className="text-foreground h-8 rounded-full px-4 text-sm font-medium"
      >
        Bỏ qua
      </Button>
    </div>
  );
}
