import { HStack, StatusDot, Text } from "@astryxdesign/core";

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
 * There is no separator glyph between steps: each step already carries its own
 * dot, and a chevron between them would be decoration standing in for an icon.
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
    <HStack as="ol" aria-label={label} gap={3} wrap="wrap" align="center">
      {steps.map((step, position) => {
        const state = states[position] ?? "upcoming";
        return (
          <HStack
            as="li"
            key={step}
            gap={1.5}
            align="center"
            // State is spoken, never carried by colour alone (a11y).
            aria-current={state === "current" ? "step" : undefined}
          >
            {/* The dot's accessible name IS the state, so the step reads as
                "đã xong / Đóng gói ảnh" without a second hidden copy. */}
            <StatusDot
              variant={DOT_VARIANT[state]}
              label={STEP_STATE_LABELS[state]}
              isPulsing={state === "current"}
            />
            <Text
              size="2xs"
              color={TEXT_COLOR[state]}
              weight={state === "current" ? "medium" : "normal"}
            >
              {step}
            </Text>
          </HStack>
        );
      })}
    </HStack>
  );
}

const DOT_VARIANT: Record<StepState, "success" | "accent" | "neutral"> = {
  done: "success",
  current: "accent",
  upcoming: "neutral",
};

const TEXT_COLOR: Record<StepState, "primary" | "secondary" | "placeholder"> = {
  done: "secondary",
  current: "primary",
  upcoming: "placeholder",
};
