"use client";

import { TOOL_KINDS, type ToolKind } from "@/ui/schemas/onboarding-profile.schema";

import { CheckOptionCardGroup, type CheckOptionChoice } from "./CheckOptionCard";
import { ENTER_DELAY_HEADING, enterDelay } from "./onboarding-motion";
import { StepActions } from "./StepActions";

/**
 * Step 2 of the survey: what the tenant posts with today (spec section 6,
 * reference shot `02-tools-selected.jpg`).
 *
 * SEVERAL ANSWERS AT ONCE. Dạng B cards — emoji well, label, optional second
 * line, tick box on the RIGHT, 375px wide — drawn by `CheckOptionCardGroup`,
 * which is a `<fieldset>` of real checkboxes. No `radiogroup` here: this
 * question genuinely takes more than one answer, and saying otherwise in the
 * markup would mislead every screen reader that reads it.
 *
 * A PURE component, same as `StepSeller`: answers and handlers arrive as props.
 *
 * THE CODES COME FROM THE SCHEMA. `TOOL_KINDS` is what the API route validates
 * against; this file only owns the Vietnamese wording.
 */

/**
 * Spec section 6 verbatim, in schema order. Only two choices carry the second
 * line, and they are the two the spec gives an example for — a hint invented
 * for the other four would be wording that no source asked for.
 */
const TOOL_LABEL: Record<
  ToolKind,
  { label: string; hint?: string; emoji: string; tone: CheckOptionChoice["tone"] }
> = {
  // Six different tones, because six wells in one grey family read as one
  // block. The prototype has no step 2 to copy, so the only fixed points are
  // 🔵 on blue (it IS a blue circle) and 🦄 on purple, which is what the
  // prototype paints that same unicorn on in step 1.
  manual_facebook: {
    label: "Tự đăng tay trên Facebook",
    emoji: "💻",
    tone: "yellow",
  },
  meta_business_suite: {
    label: "Meta Business Suite",
    emoji: "🔵",
    tone: "blue",
  },
  smm_tool: {
    label: "Công cụ quản lý mạng xã hội",
    hint: "vd: Hootsuite, Later",
    emoji: "🛠️",
    tone: "green",
  },
  platform_specific_tool: {
    label: "Công cụ chuyên một nền tảng",
    emoji: "🧩",
    tone: "orange",
  },
  ai_platform: {
    label: "Nền tảng AI",
    hint: "ChatGPT/Claude…",
    emoji: "🤖",
    tone: "pink",
  },
  other: { label: "Khác", emoji: "🦄", tone: "purple" },
};

const CHOICES: readonly CheckOptionChoice[] = TOOL_KINDS.map((value) => ({
  value,
  ...TOOL_LABEL[value],
}));

const QUESTION = "Bạn đang đăng bài bằng gì?";

/** Narrowing at the boundary: the group hands back a `string`, not a `ToolKind`. */
function isToolKind(value: string): value is ToolKind {
  return (TOOL_KINDS as readonly string[]).includes(value);
}

export function StepTools({
  /** Empty = unanswered here. "None of these" is what "Bỏ qua" says. */
  values,
  onToggle,
  onContinue,
  onSkip,
  /** True while the answer is being written (wired up in task 9). */
  isSaving = false,
}: {
  values: readonly ToolKind[];
  onToggle: (value: ToolKind, isChecked: boolean) => void;
  onContinue: () => void;
  onSkip: () => void;
  isSaving?: boolean;
}) {
  const handleToggle = (raw: string, isChecked: boolean) => {
    // --- Edge case first ---------------------------------------------------
    // Same reasoning as `StepSeller`: a code the schema does not know must not
    // reach the store, where it would be rejected on the next read instead.
    if (!isToolKind(raw)) {
      console.warn(
        "[onboarding] tools step received a code outside the schema",
        {
          error_code: "ONBOARDING_UNKNOWN_ANSWER_CODE",
          step: "tools",
          answer: raw,
        },
      );
      return;
    }
    onToggle(raw, isChecked);
  };

  return (
    <div className="flex w-full flex-col items-center gap-8">
      <h1
        tabIndex={-1}
        style={enterDelay(ENTER_DELAY_HEADING)}
        className="onboarding-enter text-foreground font-heading text-center text-[1.75rem] leading-[2.1875rem] font-medium text-balance outline-none"
      >
        {QUESTION}
      </h1>

      <CheckOptionCardGroup
        name="tools"
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
