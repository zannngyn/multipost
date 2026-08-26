"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { useActiveTenant } from "@/ui/hooks/useMe";
import { decideOnboardingEntry, type OnboardingEntryDecision } from "@/ui/hooks/onboarding-entry";
import type {
  OnboardingProfilePatch,
  OnboardingProfileView,
} from "@/ui/schemas/onboarding-profile.schema";
import { ApiError } from "@/ui/services/api-error";
import {
  completeOnboarding,
  fetchOnboardingProfile,
  onboardingProfileKeys,
  saveOnboardingStep,
} from "@/ui/services/onboarding-profile.api";

/**
 * Logic layer of the onboarding survey (docs/07 §4.1): fetch policy, cache keys
 * and what a write does to the cache live here; transport does not.
 *
 * SAME SHAPE AS `useSetupProgress`, and for the same three reasons:
 *
 *  1. GATED BY ROLE. All three verbs are `minRole: "admin"`, so an editor
 *     asking would collect a 403 — an error state, on every screen, describing
 *     a flow they are never shown. The query simply does not run for them.
 *  2. `staleTime`. The profile changes when somebody answers a question in this
 *     very flow, not on a timer, so moving between screens re-reads the cache.
 *  3. NO RETRY ON 4xx. The same bad request repeated only hides it.
 *
 * The query is read by BOTH the flow and the first-run gate (which rides in the
 * app shell), so it must stay cheap: one key, one answer, shared.
 */
export function useOnboardingProfile(): UseQueryResult<OnboardingProfileView, ApiError> {
  const { tenantKey, isResolved, role } = useActiveTenant();
  const canSee = role === "owner" || role === "admin";

  return useQuery<OnboardingProfileView, ApiError>({
    queryKey: onboardingProfileKeys.profile(tenantKey),
    queryFn: ({ signal }) => fetchOnboardingProfile(signal),
    enabled: isResolved && canSee,
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 30_000,
  });
}

/**
 * Save ONE step, the moment "Tiếp tục" (or "Bỏ qua") is pressed.
 *
 * NEVER AUTO-RETRIED. Not because a repeat would corrupt anything — a
 * one-field PATCH is idempotent — but because the flow must not advance behind
 * a failure it never showed. The screen keeps the operator's choice and offers
 * "Thử lại"; that is the retry (spec §7, CLAUDE.md rule 5).
 *
 * The server answers with the WHOLE profile as stored, so the answer is written
 * straight into the cache instead of triggering a re-read: one round trip per
 * step, and the flow's idea of "which question is still open" is never a guess.
 */
export function useSaveOnboardingStep() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<OnboardingProfileView, ApiError, OnboardingProfilePatch>({
    mutationFn: (patch) => saveOnboardingStep(patch),
    retry: false,
    onSuccess: (saved) => {
      queryClient.setQueryData(onboardingProfileKeys.profile(tenantKey), saved);
    },
  });
}

/**
 * Finish the survey. Idempotent on the server (the first `completed_at` wins),
 * still not auto-retried: the flow leaves for the app on success, and leaving
 * twice is a navigation nobody asked for.
 *
 * Writing the answer into the cache is what stops the first-run gate bouncing
 * the operator straight back into the flow it just released them from.
 */
export function useCompleteOnboarding() {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<OnboardingProfileView, ApiError, void>({
    mutationFn: () => completeOnboarding(),
    retry: false,
    onSuccess: (finished) => {
      queryClient.setQueryData(onboardingProfileKeys.profile(tenantKey), finished);
    },
  });
}

export interface OnboardingEntry {
  readonly decision: OnboardingEntryDecision;
  /** Present only to render the failure of the profile read, never to decide. */
  readonly error: ApiError | null;
}

/**
 * "Survey, or app?" for the first-run gate — the session and the profile, run
 * through `decideOnboardingEntry` (which holds the rule and the tests).
 */
export function useOnboardingEntry(): OnboardingEntry {
  const { hasNoMembership, isResolved, role } = useActiveTenant();
  const profile = useOnboardingProfile();

  /**
   * A read that FAILED and a read still IN FLIGHT are different inputs: one
   * ends the decision ("leave them alone"), the other suspends it. Stale data
   * still counts as an answer — it is the tenant's own row, a minute old.
   */
  const profileStatus =
    profile.data !== undefined ? "ready" : profile.isError ? "unavailable" : "loading";

  return {
    decision: decideOnboardingEntry({
      hasNoMembership,
      isTenantResolved: isResolved,
      role,
      profileStatus,
      completedAt: profile.data?.completedAt ?? null,
    }),
    error: profile.isError ? profile.error : null,
  };
}
