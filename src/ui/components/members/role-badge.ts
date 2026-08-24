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
 *
 * WHY NOT PURPLE any more: purple is the accent of the generic admin SaaS this
 * app's whole design refuses (thesis, docs/superpowers/specs §26). Owner now
 * wears the indigo of the world — the dye every primary surface is cut from —
 * and the other three the neutral of a woven label. That is one colour idea
 * across members, invites and the history tab (which prints roles as plain
 * text, so it needs no tone of its own).
 */
export const MEMBERSHIP_ROLE_BADGE_TONES: Record<MembershipRole, "blue" | "neutral"> = {
  owner: "blue",
  admin: "neutral",
  editor: "neutral",
  viewer: "neutral",
};
