"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAdoptActiveTenant, useMe } from "@/ui/hooks/useMe";
import type {
  CreatePlatformTenantFormValues,
  CreatePlatformTenantResponse,
  PlatformTenantListResponse,
  StartSupportSessionResponse,
} from "@/ui/schemas/platform.schema";
import { canViewPlatform } from "@/ui/schemas/platform.schema";
import { ApiError } from "@/ui/services/api-error";
import {
  activatePlatformTenant,
  createPlatformTenant,
  endSupportSession,
  listPlatformTenants,
  platformKeys,
  startSupportSession,
  suspendPlatformTenant,
} from "@/ui/services/platform.api";
import { meKeys } from "@/ui/services/me.api";

/**
 * Logic layer of the platform admin screen (M3.2), docs/07 §4.1.
 *
 * The query key carries NO tenant segment: this list belongs to the account,
 * not to a company, and it must survive a company switch untouched — it is the
 * one screen a platform admin uses while standing outside every tenant.
 *
 * Writes are never auto-retried: creating twice makes two companies for the
 * customer, and re-sending a suspend after a timeout would act twice on a
 * request the server may already have accepted.
 */

export function usePlatformTenants() {
  const me = useMe();
  const platformRole = me.data?.account?.platformRole ?? null;

  return useQuery<PlatformTenantListResponse, ApiError>({
    queryKey: platformKeys.tenants(),
    queryFn: ({ signal }) => listPlatformTenants(signal),
    // Nothing is asked until `/api/me` says this account may ask: a 403 the UI
    // could have predicted is a 403 nobody needs to see.
    enabled: me.data !== undefined && canViewPlatform(platformRole),
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 15_000,
  });
}

export function useCreatePlatformTenant() {
  const queryClient = useQueryClient();

  return useMutation<CreatePlatformTenantResponse, ApiError, CreatePlatformTenantFormValues>({
    mutationFn: (values) => createPlatformTenant(values),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: platformKeys.tenants() });
      // A platform admin can be a member of the company they just made (the
      // owner invite is theirs to hand over, but not always), so the company
      // list in the switcher may have changed too.
      void queryClient.invalidateQueries({ queryKey: meKeys.me() });
    },
  });
}

export function useSuspendPlatformTenant() {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, { tenantId: string; reason: string }>({
    mutationFn: ({ tenantId, reason }) => suspendPlatformTenant({ tenantId, reason }),
    retry: false,
    onSettled: () => {
      // Also on failure: another admin may have changed the same company, which
      // is often exactly why this call was refused.
      void queryClient.invalidateQueries({ queryKey: platformKeys.tenants() });
      // A suspended company drops out of `/api/me`'s list (docs/09 §3.7), so an
      // admin who suspends their OWN company must not keep working in it.
      void queryClient.invalidateQueries({ queryKey: meKeys.me() });
    },
  });
}

export function useActivatePlatformTenant() {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, { tenantId: string; reason: string }>({
    mutationFn: ({ tenantId, reason }) => activatePlatformTenant({ tenantId, reason }),
    retry: false,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: platformKeys.tenants() });
      void queryClient.invalidateQueries({ queryKey: meKeys.me() });
    },
  });
}

/**
 * Entering support mode (M3.3).
 *
 * On success the server has moved the active-tenant cookie to the customer's
 * company, so this ends where every company change ends: the whole cache is
 * dropped and `/api/me` is re-read (`useAdoptActiveTenant`). Skipping that
 * would leave MYSP's own rows on screen under the customer's name — the exact
 * leak core-auth-session warns about, made worse by the fact that the two
 * companies belong to different organisations.
 */
export function useStartSupportSession() {
  const adopt = useAdoptActiveTenant();

  return useMutation<StartSupportSessionResponse, ApiError, { tenantId: string; purpose: string }>({
    mutationFn: ({ tenantId, purpose }) => startSupportSession({ tenantId, purpose }),
    retry: false,
    onSuccess: () => adopt(),
  });
}

/** Leaving it — same cache rule, in the other direction. */
export function useEndSupportSession() {
  const adopt = useAdoptActiveTenant();

  return useMutation<unknown, ApiError, void>({
    mutationFn: () => endSupportSession(),
    retry: false,
    // On SETTLED, not just success: an expired session answers with an error,
    // and the browser must still stop believing it is inside that company.
    onSettled: () => adopt(),
  });
}
