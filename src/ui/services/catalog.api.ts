import type {
  CatalogFieldMap,
  CatalogTextSourceKind,
  MediaProfileConfig,
  StockPolicy,
} from "@/ui/schemas/catalog-mapping.schema";
import {
  CatalogProductsResponseSchema,
  CatalogSourceResponseSchema,
  MAX_CATALOG_FILE_BYTES,
  PRODUCTS_DEFAULT_LIMIT,
  UploadCatalogFileResponseSchema,
  formatFileBytes,
  type CatalogProductsResponse,
  type CatalogSourceResponse,
  type ProductFilter,
  type UploadCatalogFileResponse,
} from "@/ui/schemas/catalog.schema";
import {
  RunSyncResponseSchema,
  SyncStatusResponseSchema,
  type RunSyncResponse,
  type SyncStatusResponse,
} from "@/ui/schemas/sync.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer for the catalog screens (docs/07 §4.1).
 * Read: GET /api/catalog/sync-status · /api/catalog/source ·
 * /api/catalog/products · Write: POST /api/catalog/sync.
 *
 * Nothing fails soft here: a sync that did not run must never look like a sync
 * that ran and found nothing (core-data-fetching: fail-soft is forbidden for
 * writes, and this screen IS the audit trail).
 */

/**
 * A full Drive+Sheet sync is inline in Phase 1 and walks thousands of files.
 * The client waits longer than the 15s default — but still bounded, so a dead
 * request becomes a visible error instead of a spinner that never ends.
 */
const SYNC_RUN_TIMEOUT_MS = 120_000;

/**
 * `tenantKey` is the CACHE PARTITION, not a request parameter: the server reads
 * the company from the session, but two companies must never share a cache
 * entry. It comes from `useActiveTenant()`, never from a component literal.
 */
export const catalogKeys = {
  syncStatus: (tenantKey: string) => ["catalog", tenantKey, "sync-status"] as const,
  source: (tenantKey: string) => ["catalog", tenantKey, "source"] as const,
  /** Derived from the SAME filter object the URL produced — no second source. */
  products: (tenantKey: string, filter: ProductFilter) =>
    ["catalog", tenantKey, "products", filter.status ?? "all", filter.q ?? ""] as const,
};

export async function fetchSyncStatus(signal?: AbortSignal): Promise<SyncStatusResponse> {
  return apiRequest("/api/catalog/sync-status", {
    schema: SyncStatusResponseSchema,
    signal,
    malformedMessage:
      "Dữ liệu trạng thái đồng bộ không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export async function fetchCatalogSource(signal?: AbortSignal): Promise<CatalogSourceResponse> {
  return apiRequest("/api/catalog/source", {
    schema: CatalogSourceResponseSchema,
    signal,
    malformedMessage:
      "Thông tin nguồn dữ liệu không đúng định dạng. Hãy báo quản trị viên kiểm tra cấu hình đơn vị.",
  });
}

export interface UpdateCatalogSourceParams {
  /**
   * A pasted browser link or a bare id — the server parses both.
   *
   * THREE DISTINCT REQUESTS, and collapsing any two is a data-loss bug:
   *   absent -> keep whatever is stored (decided by the repo, under its lock),
   *   value  -> parse it and replace,
   *   ""     -> clear it (legal only for a tenant reading an uploaded file).
   *
   * Optional because the mapping wizard must NOT send them. It reads them from a
   * GET taken minutes earlier, outside any transaction, so echoing them back
   * would revert a folder another admin moved while the wizard sat open — the
   * lost update, with a window measured in minutes (N1). Only the two screens
   * whose whole job IS changing the source send them.
   */
  driveFolder?: string;
  spreadsheet?: string;
  sheetName?: string;
  /**
   * Onboarding phase 1 — sent only by the mapping step. ABSENT means "giữ
   * nguyên cái đang lưu" all the way down to the repo, so the sync screen's
   * "Đổi nguồn" form does not have to know a mapping exists, and cannot wipe it.
   */
  fieldMap?: CatalogFieldMap | null;
  stockPolicy?: StockPolicy | null;
  /**
   * Onboarding phase 2 — where this tenant's photos live. Same "absent = giữ
   * nguyên cái đang lưu" contract as the two above, so the sync screen's "Đổi
   * nguồn" form cannot wipe a layout it has never heard of.
   */
  mediaProfile?: MediaProfileConfig | null;
  /**
   * The header row the map was built against, when the caller has one (the
   * mapping step does — it filled its dropdowns from it).
   *
   * Given it, the server refuses a map pointing at a column that does not exist
   * instead of discovering it at the next sync. Omitted means "tôi không có
   * danh sách cột", which is NOT the same as an empty list: an empty array would
   * tell the server it checked against zero columns, and the domain would skip
   * the check while believing it ran.
   */
  sheetColumns?: readonly string[] | null;
  /**
   * Which table this tenant reads ALREADY, when the caller knows (phase 3).
   *
   * It changes nothing about the request — it only tells the guard below whether
   * the Google coordinates are required, so a CSV tenant fixing a column mapping
   * is not stopped in the browser. Absent = `google_sheet`.
   */
  textSourceKind?: CatalogTextSourceKind | null;
  /**
   * Switch the tenant BACK to reading a Google tab (onboarding phase 3).
   *
   * Send it only from a screen where the operator deliberately chose a
   * spreadsheet — "Đổi nguồn" and the Drive picker. A mapping save must leave it
   * out: absent means "giữ nguyên nguồn đang lưu" all the way down, and sending
   * it there would repoint a tenant's whole catalog as a side effect of fixing a
   * column.
   *
   * Only `google_sheet` exists here on purpose. Switching TO a file goes through
   * `uploadCatalogFile`, which is what produces the storage key; a browser has
   * no business minting one.
   */
  textConfig?: { kind: "google_sheet" } | null;
}

/**
 * Replaces the tenant's Drive/Sheet source. Never retried automatically: a
 * write that half-applied must not be repeated behind the operator's back.
 */
export async function updateCatalogSource(
  params: UpdateCatalogSourceParams,
  signal?: AbortSignal,
): Promise<CatalogSourceResponse> {
  /*
   * `undefined` is preserved as `undefined` — never flattened to `""`. The two
   * mean opposite things to the server ("giữ nguyên" vs "xoá"), and defaulting
   * to an empty string here would turn every mapping save into a request to
   * blank the tenant's Drive folder.
   */
  const driveFolder = params.driveFolder?.trim();
  const spreadsheet = params.spreadsheet?.trim();
  const sheetName = params.sheetName?.trim();

  /*
   * Guards: a round trip would only return the same 400 we can raise here.
   *
   * Only for a caller that is SENDING coordinates — a mapping save omits them
   * entirely and has nothing to check. Since onboarding phase 3 a tenant may
   * read an uploaded CSV and keep nothing on Drive at all, so guarding
   * unconditionally would make this client refuse a request the API accepts.
   *
   * KNOWN GAP, harmless today, wrong the day somebody widens it: this check is
   * ALL-OR-NOTHING and therefore STRICTER than the server. It demands all three
   * boxes as soon as any one of them is sent, while `updateCatalogSource` reads
   * each key on its own and merges the ones that were left out. A future screen
   * offering "đổi mỗi thư mục Drive" would send one key, satisfy the server, and
   * be refused HERE with a 400 the API never asked for.
   *
   * Not fixed now because nothing can reach it: both source screens
   * (`CatalogSourceForm`, `GoogleDrivePicker`) submit all three together. Fix it
   * by checking each coordinate only when that coordinate was sent — do not just
   * delete the guard, it is what keeps a half-filled "Đổi nguồn" form from
   * spending a round trip to be told the obvious.
   */
  /*
   * The kind this tenant will read AFTER the save — what is being switched to,
   * or what is already stored. Reading only the stored kind would let this
   * client wave through a switch-to-Google with an empty spreadsheet box, which
   * the server then refuses; reading only the new one would demand coordinates
   * from a CSV tenant who is merely fixing a column. It mirrors `effectiveKind`
   * inside `updateCatalogSource`, deliberately.
   */
  const effectiveKind = params.textConfig?.kind ?? params.textSourceKind ?? "google_sheet";
  const readsGoogleSheet = effectiveKind === "google_sheet";
  const sendsCoordinates =
    driveFolder !== undefined || spreadsheet !== undefined || sheetName !== undefined;
  if (
    sendsCoordinates &&
    readsGoogleSheet &&
    (!driveFolder?.length || !spreadsheet?.length || !sheetName?.length)
  ) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "updateCatalogSource requires driveFolder, spreadsheet and sheetName",
      userMessage: "Điền đủ thư mục Drive, bảng Sheet và tên tab trước khi lưu.",
    });
  }

  return apiRequest("/api/catalog/source", {
    method: "PUT",
    body: {
      // Omitted, not blanked: a key that is absent asks the server to keep what
      // it has. See the props' note — this is the N1 fix.
      ...(driveFolder === undefined ? {} : { driveFolder }),
      ...(spreadsheet === undefined ? {} : { spreadsheet }),
      ...(sheetName === undefined ? {} : { sheetName }),
      // Omitted, not null: `null` would read as "xoá ánh xạ đang lưu".
      ...(params.fieldMap ? { fieldMap: params.fieldMap } : {}),
      ...(params.stockPolicy ? { stockPolicy: params.stockPolicy } : {}),
      ...(params.mediaProfile ? { mediaProfile: params.mediaProfile } : {}),
      // Omitted unless the operator actually switched source: absent is what
      // means "giữ nguyên nguồn đang lưu" (see the prop's note).
      ...(params.textConfig ? { textConfig: params.textConfig } : {}),
      // Sent only when it is a real list — never `[]`, see the prop's note.
      ...(params.sheetColumns && params.sheetColumns.length > 0
        ? { sheetColumns: params.sheetColumns }
        : {}),
    },
    schema: CatalogSourceResponseSchema,
    signal,
    malformedMessage:
      "Kết quả lưu nguồn dữ liệu không đúng định dạng. Hãy tải lại trang để xem nguồn đang được dùng.",
  });
}

export interface ListCatalogProductsParams {
  filter: ProductFilter;
  cursor?: string | null;
  limit?: number;
}

export async function listCatalogProducts(
  params: ListCatalogProductsParams,
  signal?: AbortSignal,
): Promise<CatalogProductsResponse> {
  const query = new URLSearchParams();
  if (params.filter.status) query.set("status", params.filter.status);
  if (params.filter.q) query.set("q", params.filter.q);
  if (params.cursor) query.set("cursor", params.cursor);
  query.set("limit", String(params.limit ?? PRODUCTS_DEFAULT_LIMIT));

  return apiRequest(`/api/catalog/products?${query.toString()}`, {
    schema: CatalogProductsResponseSchema,
    signal,
    malformedMessage:
      "Danh sách sản phẩm trả về không đúng định dạng. Hãy báo quản trị viên kiểm tra máy chủ.",
  });
}

export async function runCatalogSync(signal?: AbortSignal): Promise<RunSyncResponse> {
  return apiRequest("/api/catalog/sync", {
    method: "POST",
    // No body: the company comes from the session, and there is nothing else
    // to say. The route still accepts (and ignores) a legacy body.
    body: {},
    schema: RunSyncResponseSchema,
    signal,
    timeoutMs: SYNC_RUN_TIMEOUT_MS,
    malformedMessage:
      "Kết quả đồng bộ không đúng định dạng. Đồng bộ có thể đã chạy — hãy tải lại trạng thái để kiểm tra.",
  });
}

export interface UploadCatalogFileParams {
  file: File;
  /** Separator the operator pinned. Absent = let the reader detect it. */
  delimiter?: string | null;
}

/**
 * Onboarding phase 3 — hand the tenant's product table to the server as a CSV.
 *
 * Multipart, so the browser sets the boundary itself; `apiRequest` passes a
 * FormData body through without touching the headers.
 *
 * The two guards below are UX, never security: `accept` on the picker and these
 * checks exist so an operator learns the rule before spending a minute
 * uploading, and the server re-reads the actual bytes regardless (an .xlsx
 * renamed to .csv gets past both of these and is still refused, by name).
 *
 * Never retried automatically: this REPLACES the tenant's product source, and a
 * write that half-applied must not be repeated behind their back.
 */
export async function uploadCatalogFile(
  params: UploadCatalogFileParams,
  signal?: AbortSignal,
): Promise<UploadCatalogFileResponse> {
  const file = params?.file;

  if (!(file instanceof File) || file.size === 0) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "uploadCatalogFile requires a non-empty file",
      userMessage: "Chưa chọn file, hoặc file rỗng (0 byte) — hãy xuất lại file rồi thử lại.",
    });
  }

  if (file.size > MAX_CATALOG_FILE_BYTES) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: "uploadCatalogFile received a file over the byte cap",
      // Names the limit AND the real size (core-file-upload §thông báo lỗi):
      // "File không hợp lệ" leaves the operator with nothing to act on.
      userMessage: `File nặng ${formatFileBytes(file.size)}, vượt giới hạn ${formatFileBytes(
        MAX_CATALOG_FILE_BYTES,
      )} — xoá bớt cột/dòng không cần rồi xuất lại.`,
    });
  }

  const form = new FormData();
  form.set("file", file);
  const delimiter = params.delimiter?.trim() ?? "";
  if (delimiter.length > 0) form.set("delimiter", delimiter);

  return apiRequest("/api/catalog/file", {
    method: "POST",
    body: form,
    schema: UploadCatalogFileResponseSchema,
    signal,
    // Uploading bytes AND reading them (the server parses before it stores) is
    // slower than a JSON round trip; the default 15s would abort a legitimate
    // 5 MB price list on a slow connection.
    timeoutMs: 120_000,
    malformedMessage:
      "Kết quả tải bảng dữ liệu lên không đúng định dạng. Hãy tải lại trang để xem nguồn đang được dùng.",
  });
}
