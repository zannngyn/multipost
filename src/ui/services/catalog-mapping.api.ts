import {
  CatalogProfileResponseSchema,
  type CatalogFieldMap,
  type CatalogProfileResponse,
  type MediaProfileConfig,
  type StockPolicy,
} from "@/ui/schemas/catalog-mapping.schema";

import { apiRequest } from "./http-client";

/**
 * Data layer of the "Kết nối dữ liệu" screen (docs/07 §4.1).
 * Read: POST /api/catalog/profile. Write: PUT /api/catalog/source (in
 * `catalog.api.ts`, because it is the same endpoint the sync screen saves with —
 * two callers, one contract).
 *
 * POST for a read on purpose: the report is parameterised by a whole field map,
 * which does not belong in a query string (web-wizard: dữ liệu không đi qua URL).
 * It stores nothing, so it is still safe to fire twice.
 */

/**
 * The report reads the whole sheet and samples up to 1,000 Drive files while a
 * human waits. Longer than the 15s default — but still bounded, so a dead
 * request becomes a visible error instead of a spinner that never ends.
 */
const PROFILE_TIMEOUT_MS = 90_000;

/**
 * `tenantKey` is the CACHE PARTITION, not a request parameter: the server reads
 * the company from the session, but two companies must never share a cache
 * entry. It comes from `useActiveTenant()`, never from a component literal.
 */
export const catalogMappingKeys = {
  profile: (tenantKey: string) => ["catalog", tenantKey, "profile"] as const,
};

export interface ProfileCatalogSourceParams {
  /**
   * The map the operator is editing. Omitted on the first run so the server
   * infers one from the header row — which is what makes the report useful
   * before anything is configured.
   */
  fieldMap?: CatalogFieldMap | null;
  /** Omitted = `numeric`, the safe default (stock is still checked). */
  stockPolicy?: StockPolicy | null;
  /**
   * The photo layout being previewed. Omitted = `code-color-seq`, the internal
   * convention — which keeps a report nobody configured showing exactly the
   * numbers it always showed.
   *
   * It only changes the `media` section and the headline; the four candidates
   * are scored on every run regardless, because THEY are what the operator
   * chooses from.
   */
  mediaProfile?: MediaProfileConfig | null;
}

export async function profileCatalogSource(
  params: ProfileCatalogSourceParams = {},
  signal?: AbortSignal,
): Promise<CatalogProfileResponse> {
  return apiRequest("/api/catalog/profile", {
    method: "POST",
    body: {
      fieldMap: params.fieldMap ?? null,
      stockPolicy: params.stockPolicy ?? null,
      mediaProfile: params.mediaProfile ?? null,
    },
    schema: CatalogProfileResponseSchema,
    signal,
    timeoutMs: PROFILE_TIMEOUT_MS,
    malformedMessage:
      "Báo cáo tương thích trả về không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}
