"use client";

import { cn } from "@/shared/utils";

import { ENTER_DELAY_CARDS, enterDelay, enterIndex } from "./onboarding-motion";
import {
  EmojiWell,
  activateCardOnEnter,
  OPTION_CARD_SHELL,
  OptionTick,
  optionCardBorder,
  type OptionTone,
} from "./OptionCard";

/**
 * Dạng B: several answers at once, each card carrying a tick box on its right
 * and, when the choice needs one, a second line of explanation
 * (spec section 5.2, reference shot `02-tools-selected.jpg`).
 *
 * REAL CHECKBOXES. Same reasoning as `OptionCard`: `<input type="checkbox">`
 * already announces its role and its checked state, and a `<label>` around it
 * already activates it. `role="checkbox"` on a div would be a re-implementation
 * with fewer features.
 *
 * THE 16px BOX IS NOT THE TARGET. Buffer makes the tick box itself the button;
 * 16px is below WCAG 2.2's 24x24 minimum. Here the box is painted decoration
 * and the pressable thing is the 375px card around it (spec section 9.5).
 *
 * NO `<fieldset>` SIBLING TO DẠNG A BY ACCIDENT: the shell, the border rule,
 * the tick glyph and the emoji well all come from `OptionCard`, so the two
 * variants cannot drift apart on radius, focus ring or transition. That now
 * covers the hover lift and the press as well — they hang off the shared
 * `onboarding-card` marker, so a card behaves the same under a pointer whether
 * it takes one answer or several.
 *
 * WHAT THIS VARIANT DELIBERATELY DOES NOT COPY FROM DẠNG A: the dimming of the
 * cards that were not chosen (animation spec section 5.2, point 3). That rule
 * belongs to a question with ONE answer, where turning the other five down
 * points at the one. Here every unticked card is still an answer the operator
 * is being invited to add, and fading them would be the screen arguing against
 * its own question.
 */

export interface CheckOptionChoice {
  /** The stable code that reaches the database. Never the Vietnamese wording. */
  readonly value: string;
  readonly label: string;
  /** The 12px second line — "vd: Hootsuite, Later". Optional by design. */
  readonly hint?: string;
  readonly emoji?: string;
  readonly tone?: OptionTone;
}

export function CheckOptionCardGroup({
  name,
  /** The question. Rendered `sr-only`: the screen's own <h1> already shows it. */
  legend,
  choices,
  /** Empty array = answered "none of these". That is not the same as unanswered. */
  values,
  onToggle,
  className,
}: {
  name: string;
  legend: string;
  choices: readonly CheckOptionChoice[];
  values: readonly string[];
  onToggle: (value: string, isChecked: boolean) => void;
  className?: string;
}) {
  // --- Edge cases first ----------------------------------------------------
  if (choices.length === 0) {
    console.warn("[onboarding] survey step rendered with no choices", {
      error_code: "ONBOARDING_EMPTY_CHOICE_SET",
      step: name,
    });
    return null;
  }

  const unknown = values.filter((value) => !choices.some((choice) => choice.value === value));
  if (unknown.length > 0) {
    console.warn("[onboarding] stored answers are outside the current vocabulary", {
      error_code: "ONBOARDING_UNKNOWN_ANSWER_CODE",
      step: name,
      answers: unknown,
    });
  }

  return (
    <fieldset className={cn("m-0 w-full min-w-0 border-0 p-0", className)}>
      {/* No `role` override here: a set of independent checkboxes IS a `group`,
          which is what `<fieldset>` already is. `radiogroup` would be a lie
          about how many answers fit. */}
      <legend className="sr-only">{legend}</legend>

      {/* Two columns of 375px with an 8px gutter — 758px in total
          (spec section 5.2). One column below `sm`. */}
      <div
        // One series, one base delay — see `OptionCard` for the same shape.
        style={enterDelay(ENTER_DELAY_CARDS)}
        className="mx-auto grid w-full max-w-[47.375rem] grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {choices.map((choice, index) => {
          const isSelected = values.includes(choice.value);
          return (
            // Entrance on the wrapper, state on the label — the split explained
            // at length in `OptionCard`. Dạng B carries no dim today, but the
            // shape is shared so that adding one later cannot resurrect the bug.
            <div
              key={choice.value}
              style={enterIndex(index)}
              className="onboarding-enter"
            >
              <label
                data-chosen={isSelected ? "true" : undefined}
                className={cn(
                  OPTION_CARD_SHELL,
                  optionCardBorder(isSelected),
                  // 12px 16px 12px 12px, measured (spec section 5.2).
                  "h-full min-h-[3.625rem] gap-2 py-3 pr-4 pl-3",
                )}
              >
                <input
                  type="checkbox"
                  name={name}
                  value={choice.value}
                  checked={isSelected}
                  onChange={(event) =>
                    onToggle(choice.value, event.currentTarget.checked)
                  }
                  // Enter, which a native checkbox ignores just as a radio does.
                  // Space stays the browser's job — see `activateCardOnEnter`.
                  onKeyDown={(event) =>
                    activateCardOnEnter(event, () =>
                      onToggle(choice.value, !isSelected),
                    )
                  }
                  className="sr-only"
                />

                {choice.emoji === undefined ? null : (
                  <EmojiWell emoji={choice.emoji} tone={choice.tone} />
                )}

                <span className="min-w-0 flex-1">
                  <span className="text-foreground block text-base leading-[1.3125rem]">
                    {choice.label}
                  </span>
                  {choice.hint === undefined ? null : (
                    <span className="text-muted-foreground block text-xs leading-tight">
                      {choice.hint}
                    </span>
                  )}
                </span>

                {/*
                The measured 16px box with its measured 4px corner. There is no
                4px radius token — `--radius-sm` is 9.6px — so the corner is
                CLAMPED off the token rather than written as a bare 4px, the
                same idiom the shared `Button` uses for its small sizes.

                THE EMPTY BOX IS NOT `border-input`. That token lands at 1.36:1
                against the card (measured in the browser) and this outline is
                the boundary of a control, which WCAG 1.4.11 puts at 3:1.
                `foreground/55` measures 3.45:1, and being an alpha of the ink
                it holds that ratio in the dark theme too.
              */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-[min(var(--radius-sm),0.25rem)] border",
                    // The card's own micro clock, read off the alias the
                    // stylesheet maps onto `--duration-fast-max`.
                    "motion-safe:transition-colors motion-safe:duration-[var(--dur-micro)]",
                    isSelected
                      ? "border-foreground bg-foreground"
                      : "border-foreground/55 bg-card",
                  )}
                >
                  {/* The tick springs in rather than blinking on — the same
                    `onboarding-check-in` the dạng A badge uses, so one gesture
                    means "chosen" everywhere in the flow. Here it rides on the
                    glyph because the box it lands in is drawn either way. */}
                  {isSelected ? (
                    <OptionTick className="onboarding-check-in text-background size-3" />
                  ) : null}
                </span>
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
