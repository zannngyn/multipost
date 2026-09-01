"use client";

import { useReducedMotion } from "framer-motion";
import { ArrowRight, Loader2 } from "lucide-react";
import { useEffect, useState, type AnimationEvent } from "react";

import { cn } from "@/shared/utils";
import { Button } from "@/ui/components/ui/button";

import {
  ENTER_DELAY_CTA,
  ENTER_DELAY_SKIP,
  enterDelay,
} from "./onboarding-motion";
import "./onboarding-motion.css";

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
 * THE BLOCKED BUTTON IS NOT `disabled`, IT IS `aria-disabled` (animation spec
 * section 5.3). A truly disabled button swallows the press, so the operator who
 * presses it learns nothing; here the press still arrives and is answered with
 * a sentence that fades in under the controls. `aria-disabled` is what tells
 * assistive technology the same thing without taking the control out of the tab
 * order, which is the whole point — the explanation has to be reachable.
 *
 * SAVING IS A DIFFERENT MATTER AND STAYS TRULY `disabled`. A second press there
 * is a second write and a second step forward, and no amount of explanation
 * makes that acceptable.
 *
 * "BỎ QUA" IS NOT UNDERLINED (spec section 7.2). It is a button, not a link: it
 * moves the flow on without writing an answer, and it stays reachable in every
 * state except while a write is in flight.
 *
 * 352x48 with `rounded-lg` — the button is past every size the shared `Button`
 * scale reaches (it tops out at 36px), so those come through `className`
 * rather than as a new variant nobody else in the app would use. `rounded-lg`
 * IS `--radius` (16px) — the prototype's own corner, and the value the shared
 * `Button` already defaults to; the earlier `rounded-md` (12.8px) came from the
 * Buffer screenshots, which the PM set aside on 26/08/2026.
 */

/**
 * How long the ready LOOK waits behind the answer (animation spec section 5.3).
 *
 * The 150ms is there so the check badge finishes springing before the button
 * changes underneath it — one thing moving at a time. It is a delay, not a
 * duration, so it is a plain number rather than a token: the theme's scale
 * describes how long things take, not when they start.
 *
 * IT DELAYS THE PAINT AND NOTHING ELSE. `canContinue` is what decides whether a
 * press moves the flow on, and it is true from the instant the answer exists —
 * a press inside the 150ms window advances rather than being told to choose
 * something. Getting that backwards would turn a piece of choreography into a
 * dead button.
 */
const READY_LOOK_DELAY_MS = 150;

/*
 * WHAT IS NOT UNDER TEST IN THIS FILE, and why — so the next reader does not
 * mistake a green suite for coverage.
 *
 * Four behaviours here are state changing over TIME inside a real document:
 *   - the 150ms window between `canContinue` and `hasReadyLook`, and the fact
 *     that a press inside it still advances;
 *   - `isPopping` firing once on the false -> true edge and never on a change
 *     of answer;
 *   - `hintPressCount` re-keying the live region so a second press announces;
 *   - the `direction` derivation in `OnboardingFlow`, which needs two renders
 *     with different screens.
 *
 * vitest runs `environment: "node"` and the repo deliberately has no jsdom, so
 * none of these can be exercised: `renderToStaticMarkup` returns one frame of
 * HTML and cannot advance a timer, fire an event, or re-render. The parts that
 * COULD be reached without a DOM are tested — the keyboard handlers in
 * `card-keyboard.test.tsx` are pulled straight off the element tree, and the
 * markup-shape rules are in `option-card-render.test.tsx`.
 *
 * This is a known, accepted gap rather than an oversight, and it is not worth
 * papering over with a test that asserts the implementation back to itself.
 * Closing it properly means either a DOM environment or the Playwright pass the
 * PM already runs against the real screen.
 */

/** The name of the keyframe below, so a stray animation event is not mistaken
 *  for the end of the pop. The entrance runs on the wrapper, but a future
 *  animation on the button itself would bubble here too. */
const POP_ANIMATION_NAME = "onboarding-cta-pop";

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
  const prefersReducedMotion = useReducedMotion();

  /**
   * The ready LOOK, which lags `canContinue` by `READY_LOOK_DELAY_MS`. Seeded
   * from the answer rather than from `false`, so a step reopened with its
   * answer already on file renders finished on the first frame instead of
   * animating a decision the operator made last week.
   */
  const [hasReadyLook, setHasReadyLook] = useState(canContinue);
  const [isPopping, setIsPopping] = useState(false);
  /** How many times the blocked CTA has been pressed. 0 means "never" — the
   *  hint is not shown. Any other value both shows it and re-keys it. */
  const [hintPressCount, setHintPressCount] = useState(0);

  /**
   * WHAT THE STEP LOOKED LIKE LAST RENDER — the edge the whole sequence hangs
   * off. Without it, swapping between two cards (both of which leave
   * `canContinue` true) would pop the button again on every change, which
   * section 10 lists as a failure in its own right.
   *
   * Adjusted during render rather than from an effect: an effect that calls
   * `setState` synchronously paints the stale state for one frame first and
   * then corrects it, which is a visible flicker on exactly the transition this
   * component exists to make smooth. React supports this shape for state
   * derived from a prop that changed, and the linter enforces the distinction.
   */
  const [answerLastSeen, setAnswerLastSeen] = useState(canContinue);
  if (answerLastSeen !== canContinue) {
    setAnswerLastSeen(canContinue);
    setIsPopping(false);

    if (canContinue) {
      // The hint was answering a press that no longer has anything to explain.
      setHintPressCount(0);
      // Reduced motion: no wait and no pop. The state still changes — only the
      // choreography around it does not (spec section 7).
      if (prefersReducedMotion === true) setHasReadyLook(true);
    } else {
      // --- Edge case: the answer went away (every box unticked) ------------
      setHasReadyLook(false);
    }
  }

  useEffect(() => {
    // Nothing to wait for: no answer yet, already ready, or a visitor who asked
    // for less motion (handled above, without the wait).
    if (!canContinue || hasReadyLook || prefersReducedMotion === true) return;

    const timer = setTimeout(() => {
      setHasReadyLook(true);
      setIsPopping(true);
    }, READY_LOOK_DELAY_MS);

    // Cleared if the answer disappears inside the window, so a ready look is
    // never painted onto a step that has nothing chosen.
    return () => clearTimeout(timer);
  }, [canContinue, hasReadyLook, prefersReducedMotion]);

  const handleContinue = () => {
    // --- Edge cases first ---------------------------------------------------
    // The button is really `disabled` while saving, so this cannot normally
    // fire; it is here because a second write is the one failure that costs the
    // operator an answer rather than a second.
    if (isSaving) return;

    // The press is honoured against the ANSWER, not against the paint: inside
    // the 150ms the ready look is waiting out, the flow still moves on.
    if (!canContinue) {
      /*
        COUNTED, NOT A BOOLEAN. `setIsHintShown(true)` on an already-true flag
        changes nothing, so a second press re-rendered nothing, the live region
        never mutated, and the operator who pressed again got no answer at all —
        exactly when they are most likely to press again. The count re-keys the
        sentence below, which replaces the node inside the region and gives the
        screen reader something new to read every single press.
      */
      setHintPressCount((previous) => previous + 1);
      return;
    }

    onContinue();
  };

  const handleAnimationEnd = (event: AnimationEvent<HTMLButtonElement>) => {
    if (event.animationName !== POP_ANIMATION_NAME) return;
    // Taken off again so the class is a one-shot: a class that stays on cannot
    // be re-added, and re-adding it is how the next step's pop happens.
    setIsPopping(false);
  };

  const isBlockedLook = !hasReadyLook && !isSaving;

  return (
    /*
      20px between the two, not 8px. Measured by scanning `03-count-selected.jpg`
      pixel by pixel: the foot of the green button sits at image row 589 and the
      first ink of "Skip" at 618 — 29 image px, and the shot is a 0.9126 print of
      the real frame, so 31.8 CSS px (spec section 0b: a DISTANCE off the image
      is divided by the scale, only vertical POSITIONS are compared as ratios).
      "Bỏ qua" sits in a 32px ghost button whose 14px line leaves ~7px of air
      above the ink, so 20px of gap lands the ink 30.6px below the button —
      within a pixel and a half of Buffer. 8px put it at 18.6 and the two
      controls read as one block.
    */
    <div className={cn("flex w-full flex-col items-center gap-5", className)}>
      {/*
        THE ENTRANCE IS ON THE WRAPPER, THE POP IS ON THE BUTTON. Both are
        `animation-name` declarations, and two of those on one element overwrite
        each other silently rather than running together — the CTA arriving and
        the CTA popping would be one animation, whichever CSS rule came last.
      */}
      <div
        style={enterDelay(ENTER_DELAY_CTA)}
        className="onboarding-enter flex w-full justify-center"
      >
        <Button
          type="button"
          variant={isBlockedLook ? "secondary" : "default"}
          // Truly shut only while writing. Blocked is `aria-disabled`, which
          // keeps the press — and therefore the explanation — reachable.
          disabled={isSaving}
          /*
            READ OFF `isBlockedLook`, THE SAME THING THE LABEL READS. It used to
            read `canContinue`, which is immediate, while the label waits out
            the 150ms — so for that 150ms assistive tech was told the control
            was available while the label still said "Chọn một mục để tiếp tục".
            Two answers to one question. Now they always agree, and the press is
            still honoured against the real answer inside the window (see
            `handleContinue`): the control does slightly MORE than it announces
            for 150ms, which is the harmless direction of that mismatch.
          */
          aria-disabled={isBlockedLook ? true : undefined}
          onClick={handleContinue}
          onAnimationEnd={handleAnimationEnd}
          className={cn(
            // 352x48, 0 24px of padding, corners off the token (spec section 2.4).
            "h-12 w-[22rem] max-w-full gap-2 rounded-lg px-6 text-sm font-bold",
            // THE READY CTA IS INK ON CREAM, not the dye. `#2e2820` in the
            // prototype IS this app's `--foreground`; using the token rather
            // than the hex is also what makes it invert correctly in the dark
            // theme, which the prototype has no answer for. Measured after the
            // swap: 12.85:1 light, 13.82:1 dark.
            !isBlockedLook &&
            !isSaving &&
            "bg-foreground text-background hover:bg-foreground/90",
            // Keeps the explanation legible instead of fading it to half.
            isBlockedLook && "text-muted-foreground",
            // The lift, the press and the arrow's nudge hang off this marker;
            // all three live in `onboarding-motion.css` behind `no-preference`.
            !isBlockedLook && !isSaving && "onboarding-cta-ready",
            isPopping && "onboarding-cta-pop",
          )}
        >
          {isSaving ? (
            <>
              <Loader2
                aria-hidden="true"
                className="motion-safe:animate-spin"
              />
              Đang lưu…
            </>
          ) : isBlockedLook ? (
            "Chọn một mục để tiếp tục"
          ) : (
            <>
              {continueLabel}
              {/*
                THE ARROW SLIDES IN ON `transform`, NOT ON `width`. Spec section
                5.3 writes it as `width: 0 → 16px`, which section 2.4 of the same
                spec forbids — see the note on `.onboarding-cta-arrow`.
              */}
              <ArrowRight aria-hidden="true" className="onboarding-cta-arrow" />
            </>
          )}
        </Button>
      </div>

      {/*
        Ghost, so the pill-shaped wash only appears under a pointer or a focus
        ring, which is how `03-count-selected.jpg` catches it. `size` default is
        32px tall — past WCAG 2.2's 24px minimum — at 14px / weight 500, the
        measured type (spec section 2.3).

        Nothing else is added to it (spec section 9): "Bỏ qua" has to stay
        visually weaker than the CTA, so it fades in and does not travel.
      */}
      <div className="relative">
        {/*
          THE ENTRANCE IS ON A WRAPPER HERE TOO, and for the same reason as the
          cards. It used to sit directly on this `<Button disabled={isSaving}>`,
          where the running keyframe's `opacity: 1` would outrank the shared
          `Button`'s `disabled:opacity-50` — a "Bỏ qua" that looks available
          while a save is in flight. The window is narrower than the cards' so
          it had not been caught in the browser yet; it is the identical bug.
        */}
        <div
          style={enterDelay(ENTER_DELAY_SKIP)}
          className="onboarding-enter-fade"
        >
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

        {/*
          THE ANSWER TO A PRESS THAT CANNOT GO ANYWHERE.

          The live region is in the document from the first render and only its
          CONTENTS change: a `role="status"` element inserted at the same moment
          as its text is frequently not announced at all, because there was no
          region for the screen reader to be watching.

          OUT OF THE FLOW, so it costs no layout and moves nothing when it
          appears — an explanation that shoves the two controls upwards would be
          answering a mis-press with a second surprise.

          NO `aria-describedby` ON THE BUTTON POINTING HERE. It used to, and
          that made one element both the button's description AND a live region:
          on the press that reveals the sentence, a screen reader can announce
          it once as the region changing and again as the description of the
          control that still has focus. One event, said twice. The live region
          is the right of the two — it fires exactly when the sentence appears,
          which is the moment it means something — so the description was
          dropped rather than duplicated into a second hidden copy of the text.
        */}
        <p
          role="status"
          className="text-muted-foreground absolute top-full left-1/2 mt-2 w-max max-w-[18rem] -translate-x-1/2 text-center text-xs"
        >
          {hintPressCount > 0 ? (
            <span key={hintPressCount} className="onboarding-hint-in block">
              Chọn một lựa chọn ở trên…
            </span>
          ) : null}
        </p>
      </div>
    </div>
  );
}
