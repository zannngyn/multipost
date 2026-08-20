"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  PROMPT_PLATFORM,
  PROMPT_TASK,
  type CreatePromptVersionResponse,
  type PromptDetail,
  type PromptVersionListResponse,
} from "@/ui/schemas/prompt.schema";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { ApiError } from "@/ui/services/api-error";
import {
  activatePromptVersion,
  createPromptVersion,
  listPromptVersions,
  promptKeys,
  type CreatePromptVersionParams,
} from "@/ui/services/prompt.api";

/**
 * Logic layer of the prompt catalog (E10.7), docs/07 §4.1.
 *
 * Both writes invalidate the version list rather than patching the cache: which
 * row is `active` is decided by the server in one transaction, and guessing it
 * locally is how a screen ends up showing two active versions.
 */

export function usePromptVersions(
  task: string = PROMPT_TASK,
  platform: string = PROMPT_PLATFORM,
) {
  const { tenantKey, isResolved } = useActiveTenant();

  return useQuery<PromptVersionListResponse, ApiError>({
    queryKey: promptKeys.versions(tenantKey, task, platform),
    queryFn: ({ signal }) => listPromptVersions({ task, platform }, signal),
    enabled: isResolved,
    // A 4xx repeats the same bad request; only transport/5xx is worth retrying.
    retry: (failureCount, error) =>
      ApiError.is(error) && error.isRetryable ? failureCount < 2 : false,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    staleTime: 30_000,
  });
}

export function useCreatePromptVersion(
  task: string = PROMPT_TASK,
  platform: string = PROMPT_PLATFORM,
) {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<
    CreatePromptVersionResponse,
    ApiError,
    Omit<CreatePromptVersionParams, "task" | "platform">
  >({
    mutationFn: (input) => createPromptVersion({ task, platform, ...input }),
    // Never auto-retried: a second call would create a second version row.
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: promptKeys.versions(tenantKey, task, platform) });
      void queryClient.invalidateQueries({ queryKey: promptKeys.active(tenantKey, task, platform) });
    },
  });
}

export function useActivatePromptVersion(
  task: string = PROMPT_TASK,
  platform: string = PROMPT_PLATFORM,
) {
  const queryClient = useQueryClient();
  const { tenantKey } = useActiveTenant();

  return useMutation<PromptDetail, ApiError, { version: number }>({
    mutationFn: ({ version }) => activatePromptVersion({ task, platform, version }),
    retry: false,
    onSettled: () => {
      // Also on failure: the version may have been activated elsewhere, and the
      // screen must show what the server has, not what it hoped for.
      void queryClient.invalidateQueries({ queryKey: promptKeys.versions(tenantKey, task, platform) });
      void queryClient.invalidateQueries({ queryKey: promptKeys.active(tenantKey, task, platform) });
    },
  });
}
