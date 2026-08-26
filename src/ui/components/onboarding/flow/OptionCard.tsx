"use client";

import { Check } from "lucide-react";

import { cn } from "@/shared/utils";

/**
 * Dạng A and dạng C of the survey cards: one answer out of several, drawn as a
 * two-column grid of cards (spec sections 5.1 and 5.3).
 *
 * ONE COMPONENT FOR BOTH because they differ by one thing only — dạng A carries
 * an emoji well and stands 58px tall, dạng C has no well and stands 47px. A
 * choice that brings an `emoji` gets the well; a choice that does not, does not.
 * Two components would be one component and a copy of its border, its focus
 * ring, its tick and its keyboard behaviour.
 *
 * NATIVE RADIOS, NOT `role="radio"` ON A DIV. The plan asks for arrow-key
 * navigation inside the group; `<input type="radio">` sharing one `name` has it
 * built in, along with the announced role, the checked state, label activation
 * and form participation. Re-implementing that on divs means writing roving
 * tabindex by hand and getting three of those four wrong. The FIELDSET does
 * carry `role="radiogroup"` — its own implicit role is `group`, so there the
 * attribute adds something.
 *
 * THE HIT AREA IS THE WHOLE CARD. The input is `sr-only`, the `<label>` around
 * it is what the pointer meets, and the label is 341px wide — well past WCAG
 * 2.2's 24x24 minimum, which Buffer's own 16px tick box does not reach.
 *
 * THE CHOSEN CARD GETS A TICK, not just the green border Buffer uses (spec
 * section 9.3). `--primary` against `--border` is a colour difference, and a
 * colour difference alone is not allowed to be the only carrier of meaning.
 */

/**
 * The emoji well's wash. Buffer paints each one with the brand colour of
 * whatever the emoji depicts, at 20-24% alpha; those are literal hexes and this
 * repo does not take literal hexes (spec section 10), so the wash comes off the
 * theme instead. Six of them, so a column of cards does not read as one block.
 */
export type OptionTone = "indigo" | "leaf" | "turmeric" | "sky" | "madder" | "neutral";

const TONE_CLASS: Record<OptionTone, string> = {
  indigo: "bg-accent",
  leaf: "bg-success/20",
  turmeric: "bg-warning/25",
  sky: "bg-info/20",
  madder: "bg-destructive/15",
  neutral: "bg-secondary",
};

export interface OptionChoice {
  /** The stable code that reaches the database. Never the Vietnamese wording. */
  readonly value: string;
  readonly label: string;
  /** Present -> dạng A (58px, with a well). Absent -> dạng C (47px, plain). */
  readonly emoji?: string;
  readonly tone?: OptionTone;
}

/**
 * The card's own frame, shared with dạng B and dạng D so the four variants
 * cannot drift apart on radius, border, focus ring or transition.
 *
 * `rounded-md` is the token nearest the measured 12px (`--radius` * 0.8 =
 * 12.8px). The visual gate names this explicitly: a literal 12px would be a
 * radius hardcoded against the theme's own scale.
 *
 * No shadow, on purpose — spec section 2.4 measured `box-shadow: none` on every
 * card Buffer draws. Cards are told apart by a 1px border and nothing else.
 *
 * THE FOCUS RING IS INK, NOT `--ring`. The shared `Button` draws `ring-ring/50`,
 * which resolves to the accent at 22.5% alpha and measured well under the 3:1
 * WCAG 2.2 asks of a focus indicator — and `--ring` is derived from the
 * TENANT's chosen palette, so its contrast is not even fixed. `--foreground` at
 * 60% measures ~3.9:1 against the card and holds that in the dark theme, where
 * the ink is the pale colour. (The weak ring on the shared controls is an
 * app-wide matter, raised with the PM rather than changed from here.)
 */
export const OPTION_CARD_SHELL = cn(
  "bg-card relative flex cursor-pointer items-center rounded-md border",
  "has-focus-visible:ring-foreground/60 has-focus-visible:ring-3",
  "motion-safe:transition-colors motion-safe:duration-150",
);

/** Border of a card in each of its two states. Selected also gets a tick. */
export function optionCardBorder(isSelected: boolean): string {
  return isSelected ? "border-primary" : "border-border hover:border-foreground/30";
}

/**
 * The mark that makes "chosen" mean something without colour vision.
 *
 * `data-slot` rather than a class name so the render tests can assert its
 * presence without being coupled to how it is painted.
 */
export function OptionTick({ className }: { className?: string }) {
  return (
    <Check
      data-slot="option-tick"
      aria-hidden="true"
      className={cn("size-4 shrink-0", className)}
    />
  );
}

/**
 * The 32px emoji well (spec section 5.1). `rounded-sm` is the token nearest the
 * measured 8px (`--radius` * 0.6 = 9.6px), matching what `GridBackdrop` already
 * uses for the same measurement.
 *
 * `aria-hidden`: the emoji decorates a label that already reads out loud, so
 * announcing "waving hand" before "Bán lẻ cá nhân" only adds noise.
 */
export function EmojiWell({ emoji, tone = "neutral" }: { emoji: string; tone?: OptionTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-sm text-base leading-none",
        TONE_CLASS[tone],
      )}
    >
      {emoji}
    </span>
  );
}

export function OptionCardGroup({
  /** Shared by every radio in the group — this is what makes it ONE group. */
  name,
  /** The question. Rendered `sr-only`: the screen's own <h1> already shows it. */
  legend,
  choices,
  /** `null` while the question is unanswered. */
  value,
  onChange,
  className,
}: {
  name: string;
  legend: string;
  choices: readonly OptionChoice[];
  value: string | null;
  onChange: (value: string) => void;
  className?: string;
}) {
  // --- Edge cases first ----------------------------------------------------
  // An empty vocabulary is a bug upstream, not a screen state: a radiogroup
  // with no members announces itself and then offers nothing.
  if (choices.length === 0) {
    console.warn("[onboarding] survey step rendered with no choices", {
      error_code: "ONBOARDING_EMPTY_CHOICE_SET",
      step: name,
    });
    return null;
  }

  // A stored answer whose code is no longer in the list. The step still works —
  // nothing is ticked — but it means the vocabulary changed under saved data,
  // and that has to be visible without a debugger.
  if (value !== null && !choices.some((choice) => choice.value === value)) {
    console.warn("[onboarding] stored answer is outside the current vocabulary", {
      error_code: "ONBOARDING_UNKNOWN_ANSWER_CODE",
      step: name,
      answer: value,
    });
  }

  const hasEmoji = choices.some((choice) => choice.emoji !== undefined);

  return (
    <fieldset
      // `<fieldset>` alone announces "group"; the survey needs "radio group".
      role="radiogroup"
      className={cn("m-0 w-full min-w-0 border-0 p-0", className)}
    >
      <legend className="sr-only">{legend}</legend>

      {/*
        Two columns of 341px with an 8px gutter — 690px in total (spec section
        5.1), which is where the odd last choice ends up alone in the left
        column, as it does in `01-seller-selected.jpg`. One column below the
        `sm` breakpoint: 341px twice does not fit a 375px phone.
      */}
      <div className="mx-auto grid w-full max-w-[43.125rem] grid-cols-1 gap-2 sm:grid-cols-2">
        {choices.map((choice) => {
          const isSelected = choice.value === value;
          return (
            <label
              key={choice.value}
              className={cn(
                OPTION_CARD_SHELL,
                optionCardBorder(isSelected),
                "gap-2 p-3",
                // 58px with a well, 47px without (spec sections 5.1, 5.3).
                hasEmoji ? "min-h-[3.625rem]" : "min-h-[2.9375rem]",
              )}
            >
              <input
                type="radio"
                name={name}
                value={choice.value}
                checked={isSelected}
                onChange={() => onChange(choice.value)}
                className="sr-only"
              />

              {choice.emoji === undefined ? null : (
                <EmojiWell emoji={choice.emoji} tone={choice.tone} />
              )}

              {/*
                21px line box, which is what makes dạng C exactly the measured
                47px: 12px padding + 1px border on each side leaves 21px for the
                line. Tailwind's own `text-base` leading is 24px and rendered a
                49px card — measured in the browser, not reasoned about.
              */}
              <span className="text-foreground min-w-0 flex-1 text-base leading-[1.3125rem]">
                {choice.label}
              </span>

              {isSelected ? (
                <OptionTick className="text-primary" />
              ) : (
                /* Holds the tick's place so choosing a card does not reflow the
                   label beside it. */
                <span aria-hidden="true" className="size-4 shrink-0" />
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
