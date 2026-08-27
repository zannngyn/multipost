"use client";

import { SELLER_KINDS, type SellerKind } from "@/ui/schemas/onboarding-profile.schema";

import { OptionCardGroup, type OptionChoice } from "./OptionCard";
import { ENTER_DELAY_HEADING, enterDelay } from "./onboarding-motion";
import { StepActions } from "./StepActions";

/**
 * Step 1 of the survey: how the tenant sells (spec section 6, reference shot
 * `01-seller-selected.jpg`).
 *
 * ONE ANSWER. Dạng A cards — a 40px emoji well, a label, 65px tall, two columns
 * — drawn by `OptionCardGroup`, which is a real `<fieldset role="radiogroup">`
 * of real radios, so the arrow keys walk the group without any code here.
 *
 * A PURE component: the answer and the three handlers arrive as props. It
 * renders without a router and without `/api/me`, which is what lets the test
 * suite check it under `renderToStaticMarkup` with no DOM at all.
 *
 * THE CODES COME FROM THE SCHEMA, NOT FROM THIS FILE. `SELLER_KINDS` is the
 * vocabulary `/api/tenants/onboarding-profile` validates against; declaring the
 * strings again here is how a screen starts sending answers the route rejects.
 * The labels are this file's business, the codes are not.
 */

/**
 * The Vietnamese wording is spec section 6 verbatim, in the schema's own order,
 * which is the order the cards render in.
 *
 * The emoji is decoration on a label that already reads out loud (`EmojiWell`
 * hides it from assistive tech). The tone is only there so a column of six
 * cards does not read as one grey block — it carries no meaning, which is why
 * nothing is coloured by it except the well behind the emoji.
 */
const SELLER_LABEL: Record<
  SellerKind,
  { label: string; emoji: string; tone: OptionChoice["tone"] }
> = {
  // Colours and emoji are the prototype's, card for card
  // (`mysp-onboarding-animation.html`, the six `.card` elements of screen 1).
  solo_seller: { label: "Bán lẻ cá nhân", emoji: "👋", tone: "yellow" },
  shop_owner: { label: "Chủ shop nhỏ", emoji: "💪", tone: "green" },
  marketing_team: { label: "Trong đội marketing", emoji: "👥", tone: "blue" },
  freelancer: {
    label: "Cộng tác viên/freelancer",
    emoji: "✨",
    tone: "orange",
  },
  agency: { label: "Agency", emoji: "🎯", tone: "pink" },
  other: { label: "Khác", emoji: "🦄", tone: "purple" },
};

const CHOICES: readonly OptionChoice[] = SELLER_KINDS.map((value) => ({
  value,
  ...SELLER_LABEL[value],
}));

const QUESTION = "Mô tả đúng nhất về công việc của bạn?";

/** Narrowing at the boundary: the group hands back a `string`, not a `SellerKind`. */
function isSellerKind(value: string): value is SellerKind {
  return (SELLER_KINDS as readonly string[]).includes(value);
}

export function StepSeller({
  /** `null` while the question is unanswered. */
  value,
  onChange,
  onContinue,
  onSkip,
  /** True while the answer is being written (wired up in task 9). */
  isSaving = false,
}: {
  value: SellerKind | null;
  onChange: (value: SellerKind) => void;
  onContinue: () => void;
  onSkip: () => void;
  isSaving?: boolean;
}) {
  const handleChange = (raw: string) => {
    // --- Edge case first ---------------------------------------------------
    // A code outside the vocabulary can only come from a card this file did not
    // build. Passing it on would put a value in `tenant_profile` that the route
    // rejects on the next read, so it is refused loudly and never forwarded.
    if (!isSellerKind(raw)) {
      console.warn("[onboarding] seller step received a code outside the schema", {
        error_code: "ONBOARDING_UNKNOWN_ANSWER_CODE",
        step: "seller",
        answer: raw,
      });
      return;
    }
    onChange(raw);
  };

  return (
    <div className="flex w-full flex-col items-center gap-8">
      {/*
        28px / 35px, measured (spec section 2.3), neither of them on the type
        scale. `tabIndex={-1}` because changing step is a navigation and
        `OnboardingFrame` moves focus to the arriving screen's <h1>.
      */}
      <h1
        tabIndex={-1}
        style={enterDelay(ENTER_DELAY_HEADING)}
        className="onboarding-enter text-foreground font-heading text-center text-[1.75rem] leading-[2.1875rem] font-medium text-balance outline-none"
      >
        {QUESTION}
      </h1>

      <OptionCardGroup
        name="seller"
        // The same sentence as the <h1>: it names the group for a screen reader
        // that meets the radios without having passed the heading.
        legend={QUESTION}
        choices={CHOICES}
        value={value}
        onChange={handleChange}
      />

      {/* 24px between the cards and the button, measured off the reference shot
          (the column's own 32px rhythm is wider than Buffer's gap here). */}
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
