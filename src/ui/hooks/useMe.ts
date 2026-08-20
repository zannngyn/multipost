"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  tenantCacheKey,
  type MeResponse,
  type MembershipRole,
  type MeTenant,
} from "@/ui/schemas/me.schema";
import { ApiError } from "@/ui/services/api-error";
import { fetchMe, meKeys, setActiveTenant } from "@/ui/services/me.api";

/**
 * The session context every tenant-scoped screen reads (M1.4).
 *
 * WHY IT EXISTS: until M1.3b the browser decided which company a request was
 * for (a hardcoded `DEMO_TENANT_ID` travelled in every query string). The
 * server now takes that from the session and IGNORES anything the client
 * sends, so the UI needs its own answer to "which company am I in" — for the
 * header, for the picker, and above all for the CACHE KEY: rows of company A
 * must never be handed to company B (core-auth-session §Nhiều tổ chức: switching
 * without clearing is a data leak, not a display bug).
 */

/** One shared query for the whole app — every screen reads the same answer. */
export function useMe() {
  return useQuery<MeResponse, ApiError>({
    queryKey: meKeys.me(),
    queryFn: ({ signal }) => fetchMe(signal),
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    // The membership and its role can be revoked while a tab is open; a minute
    // is short enough that a removed operator stops seeing stale company data,
    // long enough that every screen does not re-ask on mount.
    staleTime: 60_000,
  });
}

export interface ActiveTenant {
  /** Null while unknown, while the picker is due, or for a session with no membership. */
  readonly tenantId: string | null;
  /** Always a string — the cache-partition segment of every tenant query key. */
  readonly tenantKey: string;
  readonly tenant: MeTenant | null;
  readonly role: MembershipRole | null;
  /** True once /api/me has answered — queries stay disabled until then. */
  readonly isResolved: boolean;
  /** Env allow-list operator; may work without an account/membership row. */
  readonly isBootstrapAdmin: boolean;
  readonly tenants: readonly MeTenant[];
  /** Signed in, but a member of nothing — the "chờ được mời" screen. */
  readonly hasNoMembership: boolean;
  /** Member of several companies and none picked yet — the picker. */
  readonly mustPickTenant: boolean;
}

/**
 * Derived view of `useMe()`. Kept separate so screens depend on the four facts
 * they need instead of on the whole payload shape.
 */
export function useActiveTenant(): ActiveTenant {
  const me = useMe();
  const data = me.data;

  const tenantId = data?.activeTenantId ?? null;
  const tenants = data?.tenants ?? [];
  const tenant = tenantId === null ? null : (tenants.find((item) => item.id === tenantId) ?? null);
  const isBootstrapAdmin = data?.isBootstrapAdmin ?? false;

  return {
    tenantId,
    tenantKey: tenantCacheKey(tenantId),
    tenant,
    role: tenant?.role ?? null,
    // A bootstrap operator has no membership row but reaches the app through
    // the env allow-list, so their screens must not wait for a tenant that will
    // never appear in this payload.
    isResolved: data !== undefined && (tenantId !== null || isBootstrapAdmin),
    isBootstrapAdmin,
    tenants,
    hasNoMembership: data !== undefined && tenants.length === 0 && !isBootstrapAdmin,
    mustPickTenant: data !== undefined && tenants.length > 0 && tenantId === null,
  };
}

/**
 * What EVERY way of landing in a different company has to do: switching (M2.3),
 * creating one (M2.1) and accepting an invite all end here.
 *
 * The ENTIRE cache is dropped, not just the queries that look tenant-scoped:
 * anything still holding company A's rows would be shown under company B's name
 * (core-auth-session: "chuyển tổ chức mà không dọn cache = rò rỉ dữ liệu giữa
 * các tổ chức").
 *
 * `removeQueries` rather than `invalidateQueries`: invalidation keeps the old
 * data on screen while it refetches, which is exactly the leak. Removing also
 * throws away infinite-query pages, so a products cursor from the previous
 * company cannot be sent to the new one (docs/11 §4).
 *
 * The cookie itself is already set by the server on all three paths — this side
 * only has to stop believing what it knew a moment ago.
 */
export function useAdoptActiveTenant(): () => Promise<void> {
  const queryClient = useQueryClient();

  return useCallback(async () => {
    queryClient.removeQueries();
    // The identity query is what every screen waits on, so it is refetched
    // immediately instead of on the next render.
    await queryClient.fetchQuery({
      queryKey: meKeys.me(),
      queryFn: ({ signal }) => fetchMe(signal),
    });
  }, [queryClient]);
}

/** Switching to a company the account is already a member of. */
export function useSwitchTenant() {
  const adopt = useAdoptActiveTenant();

  return useMutation<{ activeTenantId: string }, ApiError, { tenantId: string }>({
    mutationFn: ({ tenantId }) => setActiveTenant(tenantId),
    retry: false,
    onSuccess: () => adopt(),
  });
}
