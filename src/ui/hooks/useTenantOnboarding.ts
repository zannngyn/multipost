"use client";

import { useMutation } from "@tanstack/react-query";

import { useAdoptActiveTenant } from "@/ui/hooks/useMe";
import type {
  CreateTenantFormValues,
  CreateTenantResponse,
  EnsureDefaultTenantResponse,
  JoinTenantResponse,
} from "@/ui/schemas/tenant-onboarding.schema";
import { ApiError } from "@/ui/services/api-error";
import { createTenant, ensureDefaultTenant, joinTenant } from "@/ui/services/tenant-onboarding.api";

/**
 * Logic layer of the two ways into a company (M2.1), docs/07 §4.1.
 *
 * Neither is ever auto-retried. Creating twice makes two companies (and burns
 * the per-hour limit); joining twice is harmless on the server but would still
 * report a second, confusing outcome.
 *
 * Both end in `adopt()`: the server already moved the active-tenant cookie, so
 * the browser has to throw away everything it believed about the previous
 * company before any screen renders again.
 */

export function useCreateTenant() {
  const adopt = useAdoptActiveTenant();

  return useMutation<CreateTenantResponse, ApiError, CreateTenantFormValues>({
    mutationFn: (values) => createTenant(values),
    retry: false,
    onSuccess: () => adopt(),
  });
}

/**
 * E10 — the company an account gets without asking for one, provisioned by the
 * first-run gate before the onboarding survey.
 *
 * `retry: false` for the same reason as `useCreateTenant`: a blind repeat could
 * mint a second company. The gate calls it exactly once per mount and keeps a
 * latch, but the mutation must not undo that on its own.
 *
 * `adopt()` runs whatever the answer says. When a company was just created the
 * server moved the active-tenant cookie and the browser has to stop believing
 * "this account belongs nowhere"; when it was NOT created the cookie was left
 * alone, and a fresh `/api/me` is still the cheapest way to find out why the
 * gate and the server disagreed.
 */
export function useEnsureDefaultTenant() {
  const adopt = useAdoptActiveTenant();

  return useMutation<EnsureDefaultTenantResponse, ApiError, void>({
    mutationFn: () => ensureDefaultTenant(),
    retry: false,
    onSuccess: () => adopt(),
  });
}

/** `invite` is a pasted link or a bare token — the service extracts it. */
export function useJoinTenant() {
  const adopt = useAdoptActiveTenant();

  return useMutation<JoinTenantResponse, ApiError, { invite: string }>({
    mutationFn: ({ invite }) => joinTenant(invite),
    retry: false,
    onSuccess: () => adopt(),
  });
}
