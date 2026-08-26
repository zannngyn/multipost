import { z } from "zod";

/**
 * Contract of `/api/tenants/onboarding-profile` — the four survey answers plus
 * the moment the flow was finished.
 *
 * NOTE: `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so
 * the four code lists below MIRROR `core/usecases/onboarding-profile.ts`, the
 * same way `setup-progress.schema.ts` mirrors its usecase. The mirror is not
 * kept honest by convention: `app/api/tenants/onboarding-profile/route.test.ts`
 * imports BOTH copies and asserts they are equal, list by list, order included.
 * Add a code on one side only and that test goes red.
 *
 * The route itself validates its request body with the schema below, so this
 * file is what a rejected answer is rejected BY — one more reason it may not
 * drift from the vocabulary the usecase enforces.
 *
 * Codes are stable identifiers, never the Vietnamese labels on screen; the
 * labels live with the components that render them, so rewording a question
 * never touches stored data.
 */

/** Step 1 — mirrors SELLER_KINDS. Order is the order the cards render in. */
export const SELLER_KINDS = [
  "solo_seller",
  "shop_owner",
  "marketing_team",
  "freelancer",
  "agency",
  "other",
] as const;

/** Step 2 — mirrors TOOL_KINDS. */
export const TOOL_KINDS = [
  "manual_facebook",
  "meta_business_suite",
  "smm_tool",
  "platform_specific_tool",
  "ai_platform",
  "other",
] as const;

/** Step 3 — mirrors CHANNEL_COUNTS. Buckets, never numbers to compute with. */
export const CHANNEL_COUNTS = ["1-3", "4-6", "7-10", "11-20", "21-50", "50+"] as const;

/** Step 4 — mirrors FOCUS_CHANNELS. Wider than what phase 1 can publish to. */
export const FOCUS_CHANNELS = [
  "facebook",
  "tiktok",
  "instagram",
  "youtube",
  "threads",
  "zalo_oa",
  "shopee",
  "lazada",
] as const;

export type SellerKind = (typeof SELLER_KINDS)[number];
export type ToolKind = (typeof TOOL_KINDS)[number];
export type ChannelCount = (typeof CHANNEL_COUNTS)[number];
export type FocusChannel = (typeof FOCUS_CHANNELS)[number];

/**
 * What `GET`/`PATCH`/`POST` answer. `completedAt` crosses the wire as an ISO
 * string, not a Date — JSON has no date type, and reading it as one is how a
 * "đã xong chưa?" check starts comparing a string to null and getting it right
 * by accident.
 *
 * Every list is `z.enum`, so a code this bundle does not know is a LOUD parse
 * failure rather than an option that renders with no label. The drift lock in
 * the route test is what keeps that from happening on a normal deploy.
 */
export const OnboardingProfileSchema = z.object({
  sellerKind: z.enum(SELLER_KINDS).nullable(),
  currentTools: z.array(z.enum(TOOL_KINDS)).nullable(),
  channelCount: z.enum(CHANNEL_COUNTS).nullable(),
  focusChannels: z.array(z.enum(FOCUS_CHANNELS)).nullable(),
  completedAt: z.string().min(1).nullable(),
});

export type OnboardingProfileView = z.infer<typeof OnboardingProfileSchema>;

/**
 * One step of the survey, as sent by `PATCH`.
 *
 * `strictObject` because an unknown key is a rejection, not something to drop:
 * a typo'd field name must not look like a successful save. Every field is
 * `.optional().nullable()` because absent and null are different facts —
 * absent leaves the stored answer alone, null is what "Bỏ qua" writes.
 *
 * The `refine` at the end refuses `{}`. That is deliberate and matches the
 * repo, which throws on an empty patch rather than no-opping: a step the
 * operator skipped is sent as `{field: null}` or not sent at all.
 */
export const OnboardingProfilePatchSchema = z
  .strictObject({
    sellerKind: z.enum(SELLER_KINDS).nullable().optional(),
    currentTools: z.array(z.enum(TOOL_KINDS)).nullable().optional(),
    channelCount: z.enum(CHANNEL_COUNTS).nullable().optional(),
    focusChannels: z.array(z.enum(FOCUS_CHANNELS)).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Patch must carry at least one answer",
  });

export type OnboardingProfilePatch = z.infer<typeof OnboardingProfilePatchSchema>;

/**
 * The one thing that decides whether the survey is shown again. Not
 * `sellerKind !== null` and not "all four answered": every step can be skipped,
 * so a finished survey may legitimately hold four nulls.
 */
export function isOnboardingFinished(profile: OnboardingProfileView): boolean {
  return profile.completedAt !== null;
}
