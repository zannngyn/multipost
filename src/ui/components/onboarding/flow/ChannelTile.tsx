"use client";

import { cn } from "@/shared/utils";

import {
  CHANNEL_BRAND_COLOR,
  CHANNEL_MARK_LABELS,
  channelMark,
  type ChannelMarkId,
} from "./channel-marks";
import { ENTER_DELAY_CARDS, enterDelay, enterIndex } from "./onboarding-motion";
import { activateCardOnEnter, OPTION_CARD_SHELL, OptionTick, optionCardBorder } from "./OptionCard";

/**
 * Dạng D: the channel tiles of step 4 — a 156x148 square per channel, wrapping
 * into a centred block (spec section 5.4, reference shot `04-channels.jpg`).
 *
 * THE TICK BOX IS ALWAYS THERE. Buffer only reveals it under the mouse; that is
 * the one thing this file deliberately does not copy (spec section 5.4). A
 * state that appears on hover does not appear for a keyboard and does not
 * appear for a finger, so it is not a state the operator can rely on.
 *
 * "SẮP CÓ" IS WORDS, NOT DIM PAINT. Every channel but Facebook is unbuilt, and
 * spec section 6 is explicit: the tiles stay choosable — the answer is a demand
 * signal — so they must not be `disabled`, and they must not merely be faded.
 * Faded-but-pressable is a control that lies about itself.
 *
 * CHECKBOXES, NOT RADIOS. Spec section 7.5 lists step 4 among the single-choice
 * steps, but the column it writes is `focusChannels: string[]`, the reference
 * shot draws a checkbox, and section 6 calls the answer a vote. Three to one.
 * Raised with the PM rather than resolved in silence.
 */

export interface ChannelTileChoice {
  readonly value: ChannelMarkId;
  /** Everything except Facebook, today. Still choosable — see the header. */
  readonly isComingSoon?: boolean;
}

export function ChannelTileGroup({
  name,
  /** The question. Rendered `sr-only`: the screen's own <h1> already shows it. */
  legend,
  choices,
  values,
  onToggle,
  className,
}: {
  name: string;
  legend: string;
  choices: readonly ChannelTileChoice[];
  values: readonly string[];
  onToggle: (value: string, isChecked: boolean) => void;
  className?: string;
}) {
  // --- Edge cases first ----------------------------------------------------
  if (choices.length === 0) {
    console.warn("[onboarding] channel step rendered with no channels", {
      error_code: "ONBOARDING_EMPTY_CHOICE_SET",
      step: name,
    });
    return null;
  }

  return (
    <fieldset className={cn("m-0 w-full min-w-0 border-0 p-0", className)}>
      <legend className="sr-only">{legend}</legend>

      {/* Up to 1110px of wrapping, centred, 12px gutters (spec section 5.4) —
          which is what puts six tiles on the first row, five on the second, and
          centres the short row underneath. */}
      <div
        // One series, one base delay. Eight tiles arrive on the same six-step
        // rhythm as the six cards elsewhere: `enterIndex` caps the stagger, so
        // the last three land together with the sixth rather than pushing the
        // screen past the 1.2s ceiling (see `onboarding-motion.ts`).
        style={enterDelay(ENTER_DELAY_CARDS)}
        className="mx-auto flex w-full max-w-[69.375rem] flex-wrap justify-center gap-3"
      >
        {choices.map((choice, index) => {
          const Mark = channelMark(choice.value);

          // An id with no mark behind it is a bug in a table. The step keeps
          // the channels it does know rather than going down over one of them.
          if (Mark === null) {
            console.warn("[onboarding] unknown channel in the survey step", {
              error_code: "ONBOARDING_UNKNOWN_CHANNEL",
              step: name,
              channel: choice.value,
            });
            return null;
          }

          const isSelected = values.includes(choice.value);

          return (
            // Entrance on the wrapper, state on the label — see `OptionCard`.
            <div
              key={choice.value}
              style={enterIndex(index)}
              className="onboarding-enter"
            >
              <label
                // No `data-chosen` here, unlike dạng A and B. That attribute
                // exists for ONE selector — the emoji well's hold on the chosen
                // card — and this variant draws a brand mark, not an emoji well.
                // An attribute that steers nothing is markup that reads as if it
                // does.
                className={cn(
                  OPTION_CARD_SHELL,
                  optionCardBorder(isSelected),
                  // 156x148, measured. `min-h` rather than a fixed height so a
                  // longer channel name wraps instead of being clipped.
                  "w-[9.75rem] min-h-[9.25rem] flex-col justify-center gap-3 px-2 py-4",
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

                {/*
                THE 40px WELL IS FILLED WITH THE CHANNEL'S OWN COLOUR, white
                glyph on top — an app icon, which is what `04-channels.jpg`
                draws and what the PM opened the token rule for on 26/08/2026
                (spec section 5.4; scope of the exception in the header of
                `channel-marks`). An earlier draft kept the well neutral and
                tinted the glyph; eight neutral wells read as one grey block and
                lose the half-second recognition the colour is here to buy.

                THE INK IS FIXED, NOT THEMED. The ground under it is a brand
                colour that does not change between light and dark, so a token
                that flips with the scheme would put dark ink on Lazada's navy
                the moment the operator switches. White clears 3:1 on all eight
                (Shopee's #EE4D2D is the tightest at 3.66:1).

                THE RING IS THERE FOR THE DARK THEME ONLY. Measured in the
                running app, TikTok #010101, Threads #101010 and Lazada #0F146D
                read 1.43:1, 1.30:1 and 1.07:1 against the dark card — the well
                simply disappears. A 1px inset `--foreground` at 50% composites
                to 3.2:1 against the card and 4.6:1 against TikTok's black, so
                the well keeps an edge on both of its sides; 40% cleared the
                well but only reached 2.3:1 against the card. In the light theme
                the card is near-white and every brand colour already clears 3:1
                against it, so no ring is drawn.
              */}
                <span
                  aria-hidden="true"
                  className="flex size-10 shrink-0 items-center justify-center rounded-sm text-white dark:ring-1 dark:ring-foreground/50 dark:ring-inset"
                  style={{ backgroundColor: CHANNEL_BRAND_COLOR[choice.value] }}
                >
                  <Mark className="size-6" />
                </span>

                <span className="flex min-w-0 flex-col items-center gap-1 text-center">
                  <span className="text-foreground text-base leading-[1.3125rem]">
                    {CHANNEL_MARK_LABELS[choice.value]}
                  </span>
                  {/*
                  THE SECOND LINE IS ALWAYS RESERVED, even on the one channel
                  that has nothing to say there. Without the 12px it holds, the
                  working channel's tile centres on a shorter stack and its logo
                  and name sit ~8px lower than the five beside it — measured in
                  the browser, and plain to see in a row of six.
                */}
                  <span className="text-muted-foreground min-h-3 text-xs leading-none">
                    {choice.isComingSoon === true ? "Sắp có" : null}
                  </span>
                </span>

                {/* Top-right, always drawn. Same 16px box, clamped 4px corner and
                  3:1 outline as dạng B, so one tick reads the same everywhere
                  in the flow — see the note in `CheckOptionCard`. */}
                <span
                  data-slot="channel-tick-box"
                  aria-hidden="true"
                  className={cn(
                    "absolute top-2 right-2 flex size-4 items-center justify-center rounded-[min(var(--radius-sm),0.25rem)] border",
                    "motion-safe:transition-colors motion-safe:duration-[var(--dur-micro)]",
                    isSelected
                      ? "border-foreground bg-foreground"
                      : "border-foreground/55 bg-card",
                  )}
                >
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
