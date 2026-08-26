"use client";

import { cn } from "@/shared/utils";

import {
  CHANNEL_BRAND_COLOR,
  CHANNEL_MARK_LABELS,
  channelMark,
  type ChannelMarkId,
} from "./channel-marks";
import { OPTION_CARD_SHELL, OptionTick, optionCardBorder } from "./OptionCard";

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
      <div className="mx-auto flex w-full max-w-[69.375rem] flex-wrap justify-center gap-3">
        {choices.map((choice) => {
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
            <label
              key={choice.value}
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
                onChange={(event) => onToggle(choice.value, event.currentTarget.checked)}
                className="sr-only"
              />

              {/*
                A neutral 40px well carrying the channel's own colour, which is
                the pattern `GridBackdrop` already set in this flow and the one
                the header of `channel-marks` allows: those literals name
                somebody else's identity, they are not surfaces of ours.

                THE WELL STAYS PALE IN THE DARK THEME. On `--secondary` it does
                not: TikTok's mark is #010101 and Threads' is #101010, and both
                disappeared into dyed-dark cloth when this was first drawn.
                Brand marks are designed against a light ground, so the well
                keeps one — `--foreground` is the near-white of the dark theme,
                which is also what an app icon looks like at 40px.
              */}
              <span
                aria-hidden="true"
                className="bg-secondary dark:bg-foreground flex size-10 shrink-0 items-center justify-center rounded-sm"
                style={{ color: CHANNEL_BRAND_COLOR[choice.value] }}
              >
                <Mark className="size-6" />
              </span>

              <span className="flex min-w-0 flex-col items-center gap-1 text-center">
                <span className="text-foreground text-base leading-[1.3125rem]">
                  {CHANNEL_MARK_LABELS[choice.value]}
                </span>
                {choice.isComingSoon === true ? (
                  <span className="text-muted-foreground text-xs leading-none">Sắp có</span>
                ) : null}
              </span>

              {/* Top-right, always drawn. Same 16px box, clamped 4px corner and
                  3:1 outline as dạng B, so one tick reads the same everywhere
                  in the flow — see the note in `CheckOptionCard`. */}
              <span
                data-slot="channel-tick-box"
                aria-hidden="true"
                className={cn(
                  "absolute top-2 right-2 flex size-4 items-center justify-center rounded-[min(var(--radius-sm),0.25rem)] border",
                  "motion-safe:transition-colors motion-safe:duration-150",
                  isSelected ? "border-primary bg-primary" : "border-foreground/55 bg-card",
                )}
              >
                {isSelected ? <OptionTick className="text-primary-foreground size-3" /> : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
