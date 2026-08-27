"use client";

import { CHANNEL_COUNTS, type ChannelCount } from "@/ui/schemas/onboarding-profile.schema";

import { OptionCardGroup, type OptionChoice } from "./OptionCard";
import { ENTER_DELAY_HEADING, enterDelay } from "./onboarding-motion";
import { StepActions } from "./StepActions";

/**
 * Step 3 of the survey: how many pages the tenant runs (spec section 6,
 * reference shot `03-count-selected.jpg`).
 *
 * ONE ANSWER. Dạng C cards — the same two-column grid as step 1 with the emoji
 * well left off, which is the whole of the difference between the two variants
 * and the reason the card stands 47px instead of 58px (spec section 5.3).
 * `OptionCardGroup` decides that by whether a choice carries an `emoji`, so the
 * variant is chosen HERE by simply not passing one.
 *
 * A PURE component, same as steps 1 and 2: the answer and the three handlers
 * arrive as props, so it renders under `renderToStaticMarkup` with no DOM.
 *
 * THE CODES COME FROM THE SCHEMA. `CHANNEL_COUNTS` is what the API route
 * validates against.
 */

/**
 * The buckets read the same in Vietnamese as they do in the stored code, which
 * makes it tempting to render `CHANNEL_COUNTS` straight. The map stays anyway:
 * the day this reads "1-3 trang" or "trên 50", the wording changes here and the
 * stored answers do not move. A screen that renders its own codes is a screen
 * that cannot be reworded without a migration.
 */
const COUNT_LABEL: Record<ChannelCount, string> = {
  "1-3": "1-3",
  "4-6": "4-6",
  "7-10": "7-10",
  "11-20": "11-20",
  "21-50": "21-50",
  "50+": "50+",
};

/** No `emoji`, on purpose: that absence is what makes these dạng C cards. */
const CHOICES: readonly OptionChoice[] = CHANNEL_COUNTS.map((value) => ({
  value,
  label: COUNT_LABEL[value],
}));

const QUESTION = "Bạn quản lý bao nhiêu trang mạng xã hội? ";

/** Narrowing at the boundary: the group hands back a `string`. */
function isChannelCount(value: string): value is ChannelCount {
  return (CHANNEL_COUNTS as readonly string[]).includes(value);
}

export function StepCount({
  /** `null` while the question is unanswered. */
  value,
  onChange,
  onContinue,
  onSkip,
  /** True while the answer is being written (wired up in task 9). */
  isSaving = false,
}: {
  value: ChannelCount | null;
  onChange: (value: ChannelCount) => void;
  onContinue: () => void;
  onSkip: () => void;
  isSaving?: boolean;
}) {
  const handleChange = (raw: string) => {
    // --- Edge case first ---------------------------------------------------
    // A code outside the vocabulary can only come from a card this file did not
    // build. Forwarding it would put a value in `tenant_profile` that the route
    // rejects on the next read, so it is refused loudly instead.
    if (!isChannelCount(raw)) {
      console.warn("[onboarding] count step received a code outside the schema", {
        error_code: "ONBOARDING_UNKNOWN_ANSWER_CODE",
        step: "count",
        answer: raw,
      });
      return;
    }
    onChange(raw);
  };

  return (
    <div className="flex w-full flex-col items-center gap-8 font-bold">
      {/* 28px / 35px, measured (spec section 2.3). `tabIndex={-1}` because
          `OnboardingFrame` moves focus to the arriving screen's <h1>. */}
      <h1
        tabIndex={-1}
        style={enterDelay(ENTER_DELAY_HEADING)}
        className="onboarding-enter text-foreground font-heading text-center text-[1.75rem] leading-[2.1875rem] text-balance outline-none"
      >
        {QUESTION}
      </h1>

      <OptionCardGroup
        className="text-center"
        name="count"
        // The same sentence as the <h1>: it names the group for a screen reader
        // that meets the radios without having passed the heading.
        legend={QUESTION}
        choices={CHOICES}
        value={value}
        onChange={handleChange}
      />

      <StepActions
        canContinue={value !== null}
        isSaving={isSaving}
        onContinue={onContinue}
        onSkip={onSkip}
        className="-mt-2"
      />
    </div>
  );
}
