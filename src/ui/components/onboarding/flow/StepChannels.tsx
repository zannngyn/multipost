"use client";

import { FOCUS_CHANNELS, type FocusChannel } from "@/ui/schemas/onboarding-profile.schema";

import { ChannelTileGroup, type ChannelTileChoice } from "./ChannelTile";
import { StepActions } from "./StepActions";

/**
 * Step 4 of the survey: which channels the tenant cares about (spec section 6,
 * reference shot `04-channels.jpg`).
 *
 * SEVERAL ANSWERS AT ONCE. The column this writes is `focus_channels text[]`,
 * the reference shot draws a tick box in the tile's corner, and spec section 6
 * calls the answer a "phiếu bầu nhu cầu" — you cannot vote with one channel
 * when eight are listed. (Spec section 7.5 filed step 4 under single-choice in
 * its first draft; corrected 26/08 with those three reasons written down.)
 *
 * A PURE component, same as the other three steps.
 *
 * THE CODES COME FROM THE SCHEMA. `FOCUS_CHANNELS` is what the API route
 * validates against, and it is deliberately wider than what phase 1 can
 * publish to — see `COMING_SOON` below.
 */

/**
 * The one channel MYSP can actually publish to today. Everything else in
 * `FOCUS_CHANNELS` is unbuilt and says so on the tile.
 *
 * A LIST, not a boolean on each channel: phase 2 turns TikTok on by adding one
 * code here, and the labels follow by themselves. Writing `isComingSoon: true`
 * eight times is how one of them gets forgotten the day it ships.
 */
const AVAILABLE_CHANNELS: readonly FocusChannel[] = ["facebook"];

/**
 * `value` is typed `ChannelMarkId` on the other side, so this map is also the
 * DRIFT LOCK between the API's vocabulary and the drawn marks: add a code to
 * `FOCUS_CHANNELS` with no mark behind it and this file stops type-checking,
 * rather than shipping a step that renders seven tiles out of eight.
 */
const CHOICES: readonly ChannelTileChoice[] = FOCUS_CHANNELS.map((value) => ({
  value,
  isComingSoon: !AVAILABLE_CHANNELS.includes(value),
}));

const QUESTION = "Kênh nào bạn đang tập trung?";

/** Narrowing at the boundary: the group hands back a `string`. */
function isFocusChannel(value: string): value is FocusChannel {
  return (FOCUS_CHANNELS as readonly string[]).includes(value);
}

export function StepChannels({
  /** Empty = unanswered here. "None of these" is what "Bỏ qua" says. */
  values,
  onToggle,
  onContinue,
  onSkip,
  /** True while the answer is being written (wired up in task 9). */
  isSaving = false,
}: {
  values: readonly FocusChannel[];
  onToggle: (value: FocusChannel, isChecked: boolean) => void;
  onContinue: () => void;
  onSkip: () => void;
  isSaving?: boolean;
}) {
  const handleToggle = (raw: string, isChecked: boolean) => {
    // --- Edge case first ---------------------------------------------------
    // A code the schema does not know must not reach the store, where it would
    // be rejected on the next read instead of here.
    if (!isFocusChannel(raw)) {
      console.warn("[onboarding] channels step received a code outside the schema", {
        error_code: "ONBOARDING_UNKNOWN_ANSWER_CODE",
        step: "channels",
        answer: raw,
      });
      return;
    }
    onToggle(raw, isChecked);
  };

  return (
    <div className="flex w-full flex-col items-center gap-8">
      <h1
        tabIndex={-1}
        className="text-foreground font-heading text-center text-[1.75rem] leading-[2.1875rem] font-medium text-balance outline-none"
      >
        {QUESTION}
      </h1>

      <ChannelTileGroup
        name="channels"
        // The same sentence as the <h1>: it names the group for a screen reader
        // that meets the tick boxes without having passed the heading.
        legend={QUESTION}
        choices={CHOICES}
        values={values}
        onToggle={handleToggle}
      />

      <StepActions
        canContinue={values.length > 0}
        isSaving={isSaving}
        onContinue={onContinue}
        onSkip={onSkip}
        className="-mt-2"
      />
    </div>
  );
}
