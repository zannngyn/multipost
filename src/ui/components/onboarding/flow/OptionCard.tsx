"use client";

import { Check } from "lucide-react";

import { cn } from "@/shared/utils";

import { ENTER_DELAY_CARDS, enterDelay, enterIndex } from "./onboarding-motion";
import "./onboarding-motion.css";

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
 * section 9.3). `--foreground` against `--border` is a colour difference, and a
 * colour difference alone is not allowed to be the only carrier of meaning.
 * Since 26/08/2026 the tick is a 26px badge on the card's top-right corner
 * rather than a glyph in the row (animation spec section 5.2); it still has to
 * be ABSENT until the card is chosen, which is the part that carries meaning.
 */

/**
 * The emoji well's wash — the prototype's own six tints, declared as scoped
 * custom properties in `onboarding-motion.css` where the exception to the
 * literal-colour rule is argued in full.
 *
 * NAMED FOR THE COLOUR THEY PAINT. They were `indigo`/`leaf`/`turmeric`/`sky`/
 * `madder`, dye names inherited from the theme — and when the values became the
 * prototype's, `indigo` started painting a 310° purple while the screens went
 * on choosing it as if it were still indigo. Four of the six cards came out the
 * wrong colour. A tone whose name disagrees with its pixels is a trap, so they
 * are now the prototype's own words.
 *
 * They used to be built from theme roles (`bg-warning/25`, `bg-info/20`, …).
 * Measured against the prototype that produced a dull yellow, a blue with no
 * blue left in it, and a BEIGE where the purple should be — the theme simply
 * has no hue near 310°. Six tints exist so a column of cards does not read as
 * one grey block; none of them is decoded, so none of them needs a role.
 */
export type OptionTone =
  "yellow" | "green" | "blue" | "orange" | "pink" | "purple" | "neutral";

const TONE_CLASS: Record<OptionTone, string> = {
  yellow: "bg-[var(--well-yellow)]",
  green: "bg-[var(--well-green)]",
  blue: "bg-[var(--well-blue)]",
  orange: "bg-[var(--well-orange)]",
  pink: "bg-[var(--well-pink)]",
  purple: "bg-[var(--well-purple)]",
  // The one that stays on the theme: a neutral well IS the theme's neutral,
  // and it is the only tone that already inverted correctly in the dark.
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
 * `rounded-lg` IS `--radius`, i.e. exactly the 16px the prototype rounds a card
 * to — no arithmetic and no new token. It was `rounded-md` (12.8px), measured
 * off the Buffer screenshots; the PM chose the prototype over those on
 * 26/08/2026, and the theme already held the right value.
 *
 * AT REST THERE IS STILL NO SHADOW — that part of the Buffer measurement holds,
 * and a resting card is told apart by its 1px border alone. What changed on
 * 26/08/2026, by the PM's decision over the earlier note, is that HOVER now
 * lifts the card 3px onto `--shadow-med` (animation spec section 5.1). The lift,
 * the press and the dimming of the cards that were not chosen all live in
 * `onboarding-motion.css` behind `prefers-reduced-motion: no-preference`; this
 * class only carries the marker they hang off, so that all four card variants
 * answer the pointer the same way.
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
  "onboarding-card bg-card relative flex cursor-pointer items-center rounded-lg border",
  "has-focus-visible:ring-foreground/60 has-focus-visible:ring-3",
);

/** The shape of a keyboard event this needs — narrower than React's, so the
 *  behaviour can be exercised without a DOM. */
export interface CardKeyEvent {
  readonly key: string;
  preventDefault: () => void;
}

/**
 * Adds ENTER to a card, which the browser does not give us.
 *
 * A native radio or checkbox is operated with Space and the arrow keys; Enter
 * does nothing on it unless it sits in a `<form>`, where it submits instead.
 * That is correct HTML and still a failure here: the flow's acceptance
 * checklist says Enter activates a card, and a card LOOKS like a button, so
 * Enter is what an operator tries first. Measured before it was fixed — focus a
 * card, press Enter, nothing happens; press Space, it changes.
 *
 * IT ONLY ADDS. Space and the arrows are left alone, so the browser keeps
 * giving us roving focus, group wrap-around and the announcements. Note the
 * early return: it is what makes sure Space is NOT `preventDefault`-ed, because
 * swallowing Space would trade a missing key for a broken one.
 *
 * NAMED FOR WHAT IT DOES. It was `isCardActivationKey`, which read as "every
 * key that activates a card" while only ever answering for Enter — Space
 * activates a card too, just not through here.
 *
 * Shared by all four card variants so the keyboard cannot drift between a
 * question that takes one answer and one that takes several.
 */
export function activateCardOnEnter(
  event: CardKeyEvent,
  activate: () => void,
): void {
  if (event.key !== "Enter") return;
  event.preventDefault();
  activate();
}

/** Border of a card in each of its two states. Selected also gets a tick. */
export function optionCardBorder(isSelected: boolean): string {
  return isSelected
    ? "border-foreground"
    : "border-border hover:border-foreground/30";
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
 * The 26px badge that lands on the corner of the card just chosen (animation
 * spec section 5.2, point 2).
 *
 * RENDERED ONLY WHEN THE CARD IS CHOSEN, which is what makes its arrival mean
 * something and what keeps the "not a colour" guarantee testable: the tick is
 * absent, then present. It carries the same `data-slot="option-tick"` glyph the
 * inline tick did, so what a screen reader ignores and what a test looks for
 * did not change — only where it sits and how it gets there.
 *
 * OUT OF THE FLOW, on purpose. Absolutely positioned, it can appear without
 * moving the label beside it, which is the placeholder span the inline tick
 * used to need. `-top-2 -right-2` is the nearest the spacing scale gets to the
 * measured -9px overhang.
 */
export function OptionCheckBadge() {
  return (
    <span
      data-slot="option-check-badge"
      aria-hidden="true"
      className={cn(
        "onboarding-check-in bg-foreground text-background absolute -top-2 -right-2",
        "flex size-[1.625rem] items-center justify-center rounded-full shadow-[var(--shadow-low)]",
      )}
    >
      <OptionTick className="size-3.5" />
    </span>
  );
}

/**
 * The 40px emoji well — the prototype's size, up from the 32px measured off the
 * Buffer shots (PM 26/08/2026). `rounded-md` (`--radius` * 0.8 = 12.8px) is the
 * token nearest the prototype's 11px corner; `rounded-sm` (9.6px) went with the
 * smaller well.
 *
 * `aria-hidden`: the emoji decorates a label that already reads out loud, so
 * announcing "waving hand" before "Bán lẻ cá nhân" only adds noise.
 *
 * The class is the hook the stylesheet uses to make it answer a hover and hold
 * a larger size on the chosen card (animation spec sections 5.1, 5.2). The well
 * itself does not know either state — the card above it does.
 */
export function EmojiWell({
  emoji,
  tone = "neutral",
}: {
  emoji: string;
  tone?: OptionTone;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "onboarding-card-emoji flex size-10 shrink-0 items-center justify-center rounded-md text-base leading-none",
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

  /**
   * Whether ANY card is chosen — which is what turns the other five down
   * (animation spec section 5.2, point 3). Derived from the list rather than
   * from `value !== null`: a stored code outside the vocabulary ticks nothing,
   * and dimming six cards around a chosen card that is not on screen would be
   * the screen pointing at nothing.
   */
  const hasChoice = choices.some((choice) => choice.value === value);

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
      <div
        // The whole grid arrives as one series, so the base delay is stated
        // once here and each card only adds its place in it.
        style={enterDelay(ENTER_DELAY_CARDS)}
        className="mx-auto grid w-full max-w-[43.125rem] grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {choices.map((choice, index) => {
          const isSelected = choice.value === value;
          const isDimmed = hasChoice && !isSelected;
          return (
            /*
              THE ENTRANCE RIDES A WRAPPER, THE STATE RIDES THE LABEL, and they
              must never be the same element. A running animation's value comes
              from the ANIMATION origin, which outranks every author declaration
              for as long as the animation is live — so while a card was
              arriving, the keyframe's `opacity: 1` beat `opacity-45` and a
              dimmed card faded UP to full and only dropped to .45 when its
              animation ended. Measured in Chrome, five cards out of phase over
              ~1.1s; `scale-[0.985]` applied immediately (separate property), so
              the card sat shrunk but bright in between.

              `animation-fill-mode: backwards` does not fix this — it only frees
              the property AFTER the animation, never during. Splitting the two
              elements does, permanently: the wrapper owns `transform`/`opacity`
              for the animation, the label owns them for the state, and no
              cascade fight is possible. Same shape as the CTA in `StepActions`.
            */
            <div
              key={choice.value}
              style={enterIndex(index)}
              className="onboarding-enter"
            >
              <label
                data-chosen={isSelected ? "true" : undefined}
                data-dimmed={isDimmed ? "true" : undefined}
                className={cn(
                  OPTION_CARD_SHELL,
                  optionCardBorder(isSelected),
                  // `h-full` so a taller row (a label that wraps) still gives
                  // every card in it the same height now that the grid item is
                  // the wrapper rather than the card itself.
                  "h-full gap-2 p-3",
                  // 58px with a well, 47px without (spec sections 5.1, 5.3).
                  hasEmoji ? "min-h-[3.625rem]" : "min-h-[2.9375rem]",
                  /* THE DIM IS PAINT, NOT MOTION, so it is stated here and not
                     in the stylesheet's reduced-motion query: a visitor who
                     asked for less movement still has to be able to see which
                     card they chose. Only the TRANSITION between the two is
                     switched off. */
                  isDimmed && "scale-[0.985] opacity-45",
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={choice.value}
                  checked={isSelected}
                  onChange={() => onChange(choice.value)}
                  // Enter, which a native radio ignores. Space and the arrows stay
                  // the browser's job — see `activateCardOnEnter`.
                  onKeyDown={(event) =>
                    activateCardOnEnter(event, () => onChange(choice.value))
                  }
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

                {/* The badge hangs off the corner, outside the flow, so it needs
                  no placeholder to keep the label from reflowing — which is why
                  the empty 16px span that used to sit here is gone. */}
                {isSelected ? <OptionCheckBadge /> : null}
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
