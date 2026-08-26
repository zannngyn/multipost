import type { MembershipRole } from "@/ui/schemas/me.schema";

/**
 * "Does this account go to the survey, or straight into the app?" — the whole
 * of `FirstRunGate`'s judgement, with no React in it.
 *
 * Kept outside the component for the same reason as `read-only-gate.ts`: this
 * repo's vitest runs `environment: "node"` with no DOM harness, and a rule that
 * can lock an operator inside an onboarding loop is exactly the kind that has
 * to stay testable.
 *
 * The order of the checks IS the rule. Provisioning comes first because an
 * account that belongs nowhere has no role and no profile to read; the role
 * check comes before the profile because the endpoint answers 403 to an editor
 * and their query never runs.
 */

export type OnboardingEntryDecision =
  /** Not enough is known yet. Navigate nowhere; ask again on the next render. */
  | "wait"
  /** No company at all: `POST /api/tenants/ensure-default` before anything. */
  | "provision"
  /** Owner/admin with an unfinished survey — send them to `/onboarding`. */
  | "onboard"
  /** Leave them alone. This one is final. */
  | "app";

export interface OnboardingEntryInput {
  /** Signed in and a member of nothing (bootstrap admins excluded upstream). */
  readonly hasNoMembership: boolean;
  /** True once `/api/me` has answered with a company to work in. */
  readonly isTenantResolved: boolean;
  /** Support mode reports `viewer` — MYSP staff never answer a customer's survey. */
  readonly role: MembershipRole | null;
  readonly profileStatus: "loading" | "ready" | "unavailable";
  /** ISO string once the survey is finished; only read when status is "ready". */
  readonly completedAt: string | null;
}

export function decideOnboardingEntry(input: OnboardingEntryInput): OnboardingEntryDecision {
  // --- Edge cases first ----------------------------------------------------
  // No company: nothing else can be decided, and the survey would be about
  // nothing. `hasNoMembership` already implies `/api/me` has answered.
  if (input.hasNoMembership) return "provision";

  if (!input.isTenantResolved) return "wait";

  // The survey describes the COMPANY and is answered once by whoever set it up.
  // An editor cannot even read it (403), so they are never sent to it.
  if (input.role !== "owner" && input.role !== "admin") return "app";

  if (input.profileStatus === "loading") return "wait";

  /**
   * A read that FAILED is not evidence that the survey is unanswered. Treating
   * it as such would push a tenant that finished months ago back into the flow
   * every time the endpoint hiccups — a five-hundred turned into a lockout.
   */
  if (input.profileStatus === "unavailable") return "app";

  // `completed_at` is the single thing that decides re-showing (spec §8): not
  // "all four answered", because every step may legitimately be skipped.
  if (input.completedAt !== null) return "app";

  return "onboard";
}
