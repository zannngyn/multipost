import { describe, expect, it } from "vitest";

import { decideOnboardingEntry, type OnboardingEntryInput } from "@/ui/hooks/onboarding-entry";

/**
 * The one decision that can trap an operator: "does this account go to the
 * survey, or into the app?".
 *
 * It lives outside `FirstRunGate` because it is the part that must not
 * regress and the repo has no DOM harness (`vitest.config.ts`:
 * `environment: "node"`) — same reasoning as `read-only-gate.ts`.
 *
 * Four outcomes, and the two quiet ones are not the same:
 *   wait      — nothing is known yet; navigate nowhere, decide nothing;
 *   app       — the answer is "leave them alone", and it is FINAL.
 */

const BASE: OnboardingEntryInput = {
  hasNoMembership: false,
  isTenantResolved: true,
  role: "owner",
  profileStatus: "ready",
  completedAt: null,
};

function decide(overrides: Partial<OnboardingEntryInput>) {
  return decideOnboardingEntry({ ...BASE, ...overrides });
}

describe("decideOnboardingEntry", () => {
  it("sends an owner who has not finished the survey into it", () => {
    expect(decide({ completedAt: null })).toBe("onboard");
  });

  it("does NOT re-ask a tenant that already finished it", () => {
    expect(decide({ completedAt: "2026-08-26T02:00:00.000Z" })).toBe("app");
  });

  it("provisions a company first for an account that belongs nowhere", () => {
    // No membership means no role and no profile to read — the company has to
    // exist before the survey can be about anything.
    expect(
      decide({ hasNoMembership: true, isTenantResolved: false, role: null, profileStatus: "loading" }),
    ).toBe("provision");
  });

  it("never sends an editor into the survey", () => {
    // The endpoint answers 403 to an editor, and the survey describes the
    // company — it is not theirs to answer.
    expect(decide({ role: "editor", profileStatus: "loading" })).toBe("app");
    expect(decide({ role: "viewer", profileStatus: "loading" })).toBe("app");
  });

  it("waits instead of guessing while the session is still resolving", () => {
    expect(decide({ isTenantResolved: false, role: null, profileStatus: "loading" })).toBe("wait");
  });

  it("waits while the profile is still being read", () => {
    expect(decide({ profileStatus: "loading" })).toBe("wait");
  });

  it("lets the operator work when the profile cannot be read at all", () => {
    // A failed read is not evidence the survey is unanswered. Forcing the flow
    // on a 500 would lock a finished tenant out of its own app.
    expect(decide({ profileStatus: "unavailable" })).toBe("app");
  });

  it("treats an admin exactly like an owner", () => {
    expect(decide({ role: "admin" })).toBe("onboard");
  });

  it("provisions before anything else, even for a role that could not answer", () => {
    expect(decide({ hasNoMembership: true, role: "viewer", profileStatus: "loading" })).toBe(
      "provision",
    );
  });
});
