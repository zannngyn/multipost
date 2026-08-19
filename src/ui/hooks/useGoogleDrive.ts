"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback } from "react";

import {
  GOOGLE_DRIVE_ROOT_ID,
  GOOGLE_NOT_CONNECTED_CODE,
  type DriveFolderPage,
  type DriveSpreadsheetPage,
  type GoogleConnection,
  type SpreadsheetTabs,
} from "@/ui/schemas/google-drive.schema";
import { ApiError } from "@/ui/services/api-error";
import {
  disconnectGoogle,
  fetchGoogleConnection,
  fetchSpreadsheetTabs,
  googleDriveKeys,
  listDriveFolders,
  listDriveSpreadsheets,
} from "@/ui/services/google-drive.api";

/**
 * Logic layer of the Google Drive connection block (docs/07 §4.1): fetch
 * policy and cache keys live here, transport does not.
 */

/**
 * A 4xx repeats the same bad request, so it is never retried — with ONE extra
 * rule for this feature: 409 GOOGLE_NOT_CONNECTED is not a transport problem
 * at all, it is the answer "the token is gone". Retrying it would hide the one
 * thing the operator must see.
 */
function retryPolicy(failureCount: number, error: ApiError): boolean {
  if (!ApiError.is(error)) return false;
  if (error.code === GOOGLE_NOT_CONNECTED_CODE) return false;
  return error.isRetryable ? failureCount < 2 : false;
}

const retryDelay = (attempt: number) => Math.min(1_000 * 2 ** attempt, 5_000);

/**
 * What the panel receives. Named so the component can take the whole query
 * without re-deriving its type from the hook (and without a `ReturnType`
 * import cycle through the component file).
 */
export type GoogleConnectionQuery = UseQueryResult<GoogleConnection, ApiError>;

/** `tenantId === null` = no tenant picked yet (idle), so nothing is fetched. */
export function useGoogleConnection(tenantId: string | null): GoogleConnectionQuery {
  return useQuery<GoogleConnection, ApiError>({
    queryKey: googleDriveKeys.status(tenantId ?? "none"),
    queryFn: ({ signal }) => fetchGoogleConnection(tenantId ?? "", signal),
    enabled: tenantId !== null,
    retry: retryPolicy,
    retryDelay,
    /**
     * Short on purpose: a token can be revoked from Google's own settings page
     * at any moment, and this screen is where that has to become visible.
     */
    staleTime: 15_000,
  });
}

export interface DriveFoldersOptions {
  tenantId: string;
  parentId: string;
  /** Already debounced by the caller — this hook does not time anything. */
  q: string;
  enabled: boolean;
}

/**
 * One page of subfolders. Drive paginates with an opaque `pageToken`, so "Tải
 * thêm" appends; there is deliberately no "nhảy tới trang 7" — a page token
 * cannot do it.
 */
export function useDriveFolders({ tenantId, parentId, q, enabled }: DriveFoldersOptions) {
  return useInfiniteQuery<DriveFolderPage, ApiError>({
    queryKey: googleDriveKeys.folders(tenantId, parentId || GOOGLE_DRIVE_ROOT_ID, q),
    queryFn: ({ pageParam, signal }) =>
      listDriveFolders(
        {
          tenantId,
          parentId,
          pageToken: typeof pageParam === "string" ? pageParam : null,
          q,
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextPageToken,
    enabled: enabled && tenantId.length > 0,
    retry: retryPolicy,
    retryDelay,
    // Drive folders barely move during one picking session.
    staleTime: 60_000,
  });
}

export interface DriveSpreadsheetsOptions {
  tenantId: string;
  q: string;
  enabled: boolean;
}

export function useDriveSpreadsheets({ tenantId, q, enabled }: DriveSpreadsheetsOptions) {
  return useInfiniteQuery<DriveSpreadsheetPage, ApiError>({
    queryKey: googleDriveKeys.spreadsheets(tenantId, q),
    queryFn: ({ pageParam, signal }) =>
      listDriveSpreadsheets(
        { tenantId, pageToken: typeof pageParam === "string" ? pageParam : null, q },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextPageToken,
    enabled: enabled && tenantId.length > 0,
    retry: retryPolicy,
    retryDelay,
    staleTime: 60_000,
  });
}

/** `spreadsheetId === null` = nothing picked yet, so nothing is fetched. */
export function useSpreadsheetTabs(tenantId: string, spreadsheetId: string | null) {
  return useQuery<SpreadsheetTabs, ApiError>({
    queryKey: googleDriveKeys.tabs(tenantId, spreadsheetId ?? "none"),
    queryFn: ({ signal }) =>
      fetchSpreadsheetTabs({ tenantId, spreadsheetId: spreadsheetId ?? "" }, signal),
    enabled: spreadsheetId !== null && tenantId.length > 0,
    retry: retryPolicy,
    retryDelay,
    staleTime: 60_000,
  });
}

/**
 * Removes the stored Google token. On success every cached folder/spreadsheet
 * page for this tenant is dropped: keeping them would let the picker show a
 * tree the server can no longer read.
 */
export function useDisconnectGoogle(tenantId: string | null) {
  const queryClient = useQueryClient();

  return useMutation<GoogleConnection, ApiError, void>({
    mutationFn: () => disconnectGoogle(tenantId ?? ""),
    retry: false,
    onSuccess: (result) => {
      queryClient.setQueryData(googleDriveKeys.status(tenantId ?? "none"), result);
    },
    onSettled: () => {
      // Prefix key: status, every folder page, every spreadsheet page, tabs.
      void queryClient.invalidateQueries({ queryKey: googleDriveKeys.all(tenantId ?? "none") });
    },
  });
}

/**
 * Forces the connection status to be re-read — used when a browse call answers
 * 409 GOOGLE_NOT_CONNECTED, so the card stops claiming the tenant is connected.
 */
export function useRefreshGoogleConnection(tenantId: string | null) {
  const queryClient = useQueryClient();

  // Stable identity: callers put it in an effect dependency list, and a new
  // function every render would turn that effect into a refetch loop.
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: googleDriveKeys.status(tenantId ?? "none") });
  }, [queryClient, tenantId]);
}

/** True when an error means "the tenant has no usable Google token any more". */
export function isNotConnectedError(error: unknown): boolean {
  return ApiError.is(error) && error.code === GOOGLE_NOT_CONNECTED_CODE;
}
