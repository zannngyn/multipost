import type { MembershipRole } from "@/ui/schemas/me.schema";

/**
 * The colour a membership role wears — ONE table, for every surface that shows
 * a role.
 *
 * It exists because there were two: the member table gave "Chủ sở hữu" purple
 * while the invite table gave the same word blue, so the same role looked like
 * two different things one tab apart. A role is a category, not a system
 * status, which is why these are Astryx's plain colour variants and never
 * `success` / `warning` (`astryx component Badge`).
 *
 * Owner is the only role held apart: it is the one that cannot be revoked by
 * anybody else on the screen. The other three read as one family on purpose —
 * the label carries the difference, colour is never the only signal
 * (core-accessibility §5).
 */
export const MEMBERSHIP_ROLE_BADGE_TONES: Record<MembershipRole, "purple" | "blue"> = {
  owner: "purple",
  admin: "blue",
  editor: "blue",
  viewer: "blue",
};
