import type {
  ChannelCount,
  FocusChannel,
  OnboardingProfilePatch,
  OnboardingProfileView,
  SellerKind,
  ToolKind,
} from "@/ui/schemas/onboarding-profile.schema";

import type { OnboardingScreen } from "./onboarding-steps";

/**
 * The translation between what the four screens hold and what
 * `PATCH /api/tenants/onboarding-profile` accepts — pure, so the three rules
 * below are testable without a DOM (`vitest.config.ts`: `environment: "node"`).
 *
 * RULE 1 — A STEP NEVER BUILDS AN EMPTY PATCH. The route refuses `{}` with 400
 * "Patch must carry at least one answer", and the usecase throws on it too:
 * an empty patch asserts nothing, so treating it as a no-op would surface later
 * as "câu trả lời không được lưu". "Bỏ qua" spells itself out as `null`.
 *
 * RULE 2 — `null` IS NOT `[]`. `null` means the question was skipped or never
 * reached; `[]` means "đã trả lời: không cái nào". The column, the usecase and
 * the platform survey screen all rely on the difference, and once the UI
 * collapses them, "how many operators skipped step 2?" stops having an answer.
 *
 * RULE 3 — DO NOT REWRITE WHAT IS ALREADY STORED. Stepping back and forward
 * through an answered flow would otherwise spend a round trip and a spinner per
 * screen, saving values identical to the ones on file.
 */

/** The four answers as the flow holds them. `null` = skipped / unanswered. */
export interface SurveyAnswers {
  readonly sellerKind: SellerKind | null;
  readonly currentTools: readonly ToolKind[] | null;
  readonly channelCount: ChannelCount | null;
  readonly focusChannels: readonly FocusChannel[] | null;
}

/** What "Bỏ qua" writes, and what a tenant who answered nothing looks like. */
export const EMPTY_ANSWERS: SurveyAnswers = {
  sellerKind: null,
  currentTools: null,
  channelCount: null,
  focusChannels: null,
};

/**
 * The one-field patch a screen writes when it is left, or `null` for the
 * greeting — it asks nothing, so it saves nothing (and `{}` would be a 400).
 */
export function stepPatch(
  screen: OnboardingScreen,
  answers: SurveyAnswers,
): OnboardingProfilePatch | null {
  switch (screen) {
    case "welcome":
      return null;
    case "seller":
      return { sellerKind: answers.sellerKind };
    /*
      Copied, not passed through: the patch is a request body about to be
      serialised, and handing out the array the screens are still toggling
      would let a later tick change what is already in flight. `null` survives
      the copy as `null` — that is the whole point (rule 2).
    */
    case "tools":
      return { currentTools: answers.currentTools === null ? null : [...answers.currentTools] };
    case "count":
      return { channelCount: answers.channelCount };
    case "channels":
      return { focusChannels: answers.focusChannels === null ? null : [...answers.focusChannels] };
  }
}

/** Element-wise, order included: pick order is what step 4 renders back. */
function sameList(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined,
): boolean {
  // `null` vs `[]` must fall out here as DIFFERENT (rule 2), which it does:
  // one is not an array and the other is.
  if (left === null || right === null) return left === right;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * True when the tenant's stored profile already holds exactly this patch.
 *
 * `undefined` (the profile has not been read) is deliberately NOT "already
 * stored": writing has to go ahead when we do not know what is on file.
 */
export function isAlreadyStored(
  patch: OnboardingProfilePatch,
  stored: OnboardingProfileView | undefined,
): boolean {
  if (stored === undefined) return false;

  if ("sellerKind" in patch && patch.sellerKind !== stored.sellerKind) return false;
  if ("channelCount" in patch && patch.channelCount !== stored.channelCount) return false;
  if ("currentTools" in patch && !sameList(patch.currentTools, stored.currentTools)) return false;
  if ("focusChannels" in patch && !sameList(patch.focusChannels, stored.focusChannels)) return false;

  return true;
}

/**
 * Which questions already carry an answer ON THE SERVER — the input
 * `resolveScreen` clamps a hand-typed `?step=` against, so reopening the flow
 * lands on the question that is still pending.
 *
 * An empty list counts as answered (rule 2). A skipped question does NOT: it
 * stores `null`, which is indistinguishable from "never reached" here, and that
 * is exactly what the session note in `usePassedSlides` is for.
 */
export function answeredScreens(
  profile: OnboardingProfileView | undefined,
): Partial<Record<OnboardingScreen, boolean>> {
  return {
    seller: profile?.sellerKind != null,
    tools: profile?.currentTools != null,
    count: profile?.channelCount != null,
    channels: profile?.focusChannels != null,
  };
}
