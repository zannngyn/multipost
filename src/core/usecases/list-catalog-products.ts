import { AppError, type ErrorCode } from "@/core/domain/errors";
import {
  evaluateInventory,
  type InventoryBlockReason,
  type InventoryStatus,
} from "@/core/domain/inventory";
import { isTenantId } from "@/core/domain/tenant";
import type { Logger } from "@/core/ports/infra";
import type {
  CatalogProductRow,
  CatalogReadRepo,
  CatalogSignalGroup,
} from "@/core/ports/product-repo";

/**
 * E2/E3 — the "sản phẩm hợp lệ / không hợp lệ" screen: every synced product
 * with the verdict that decides whether an operator can post it. READ ONLY.
 *
 * The verdict is NOT recomputed here: `evaluateInventory` (the decision table of
 * brief section 3) stays the single source, and this usecase only adds the two
 * conditions the table does not know about — "has at least one media file" and
 * "the sheet rows for this code disagree".
 *
 * Why the totals are aggregated in SQL but folded here: the same rule must not
 * exist twice. The adapter counts products per SIGNAL BUCKET (stock/note/
 * conflict/has-media) with a GROUP BY, and this file runs the decision table
 * once per bucket. Postgres does the counting; core keeps the rules.
 *
 * Keyset pagination on `code` (ascending): the catalog is rewritten wholesale by
 * every sync, so an OFFSET page would skip or repeat rows exactly while a sync
 * runs — the moment an operator is most likely to be looking.
 */

export const DEFAULT_CATALOG_PAGE_SIZE = 50;
export const MAX_CATALOG_PAGE_SIZE = 100;

/**
 * A status filter is applied AFTER the decision table, so a page of raw rows can
 * be filtered down to nothing. Fetch a little extra per round and allow a few
 * rounds; beyond that, return what we have with a cursor instead of scanning the
 * whole catalog inside one request.
 */
const MAX_SCAN_ROUNDS = 20;
const OVERFETCH_FACTOR = 2;
const MAX_FETCH_PER_ROUND = 200;

/** Cursor is our own token: a product code, restricted to what a code can be. */
const CURSOR_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const CATALOG_STATUS_FILTERS = ["ok", "blocked"] as const;
export type CatalogStatusFilter = (typeof CATALOG_STATUS_FILTERS)[number];

export interface ListCatalogProductsFilter {
  /** "ok" = composable, "blocked" = everything an operator cannot post yet. */
  readonly status?: string;
  /** Free text on code or name. */
  readonly q?: string;
  /** 1..100, default 50. */
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface ListCatalogProductsInput {
  readonly tenantId: string;
  readonly filter?: ListCatalogProductsFilter;
}

export interface CatalogProductInventoryView {
  readonly status: InventoryStatus;
  readonly stock: number | null;
  /** Decision-table reason code, e.g. NOTE_SOLD_OUT. Null when not blocked. */
  readonly reason: InventoryBlockReason | null;
  /** Vietnamese, internal-only (never a caption). Null when not blocked. */
  readonly operatorMessage: string | null;
}

export interface CatalogProductBlockedReason {
  readonly code: ErrorCode;
  readonly userMessage: string;
}

export interface CatalogProductEntry {
  readonly code: string;
  readonly name: string;
  readonly category: string | null;
  readonly season: string | null;
  readonly inventory: CatalogProductInventoryView;
  readonly mediaImageCount: number;
  readonly mediaVideoCount: number;
  readonly hasConflict: boolean;
  /** Stock allows it AND it has media AND its sheet rows agree. */
  readonly composable: boolean;
  /** Null exactly when `composable` is true. */
  readonly blockedReason: CatalogProductBlockedReason | null;
}

export interface CatalogTotals {
  readonly total: number;
  readonly ok: number;
  readonly blocked: number;
}

export interface ListCatalogProductsResult {
  readonly items: readonly CatalogProductEntry[];
  /** Pass back as `filter.cursor`; null = end of the list. */
  readonly nextCursor: string | null;
  /** Counted over the SEARCH filter, not over the status filter. */
  readonly totals: CatalogTotals;
}

export interface ListCatalogProductsDeps {
  catalog: CatalogReadRepo;
  logger: Logger;
}

export function makeListCatalogProducts(deps: ListCatalogProductsDeps) {
  return async function listCatalogProducts(
    input: ListCatalogProductsInput,
  ): Promise<ListCatalogProductsResult> {
    // --- Edge cases first (CLAUDE.md technical rule 1) ---------------------
    const tenantId = str(input?.tenantId);
    if (!isTenantId(tenantId)) {
      throw new AppError("INVALID_INPUT", {
        message: "listCatalogProducts requires a tenant UUID",
        userMessage: "Mã đơn vị (tenant) không hợp lệ.",
        context: { tenant_id: tenantId || null },
      });
    }

    const filter = input?.filter ?? {};
    const limit = normaliseLimit(filter.limit, tenantId);
    const status = normaliseStatus(filter.status, tenantId);
    const search = str(filter.q);
    const cursor = decodeCatalogCursor(filter.cursor, tenantId);

    // Totals first: they describe the search result, not the page, so the
    // screen can say "12/299" even when the status filter empties the page.
    const groups = await deps.catalog.aggregateCatalog({
      tenantId,
      search: search.length > 0 ? search : undefined,
    });
    const totals = foldTotals(groups);

    const items: CatalogProductEntry[] = [];
    let afterCode = cursor;
    let nextCursor: string | null = null;
    let scannedRows = 0;
    let rounds = 0;

    while (items.length < limit && rounds < MAX_SCAN_ROUNDS) {
      rounds += 1;
      const page = await deps.catalog.listCatalog({
        tenantId,
        search: search.length > 0 ? search : undefined,
        limit: Math.min(limit * OVERFETCH_FACTOR, MAX_FETCH_PER_ROUND),
        afterCode: afterCode ?? undefined,
      });

      if (page.items.length === 0) {
        nextCursor = null;
        break;
      }

      let filledMidPage = false;
      for (const row of page.items) {
        scannedRows += 1;
        const entry = toEntry(row);
        // Advance the keyset over EVERY row read, filtered out or not: the next
        // page must resume after the last row this request consumed.
        afterCode = row.code;
        if (status !== null && matchesStatus(entry, status) === false) continue;
        items.push(entry);
        if (items.length >= limit) {
          filledMidPage = true;
          break;
        }
      }

      if (filledMidPage) {
        // More rows may follow the one that filled the page — either later in
        // this batch or in the next one.
        nextCursor = afterCode;
        break;
      }
      if (page.nextAfterCode === null) {
        nextCursor = null;
        break;
      }
      afterCode = page.nextAfterCode;
      nextCursor = afterCode;
    }

    if (rounds >= MAX_SCAN_ROUNDS && items.length < limit && nextCursor !== null) {
      // Not an error: the caller gets a short page plus a cursor. Logged so a
      // filter that keeps hitting the cap is visible instead of just "slow".
      deps.logger.warn("Catalog listing stopped at the scan cap — page returned short", {
        tenant_id: tenantId,
        status_filter: status,
        scanned_rows: scannedRows,
        returned: items.length,
        limit,
      });
    }

    deps.logger.debug("Catalog product list read", {
      tenant_id: tenantId,
      status_filter: status,
      search: search.length > 0 ? search : null,
      limit,
      returned: items.length,
      scanned_rows: scannedRows,
      totals,
      has_more: nextCursor !== null,
    });

    return { items, nextCursor, totals };
  };
}

export type ListCatalogProducts = ReturnType<typeof makeListCatalogProducts>;

// --- verdict (the ONLY place the three block reasons are ordered) -----------

/**
 * Priority is deliberate: a conflicting sheet row is fixed in the Sheet, an
 * out-of-stock code is fixed by restocking, a missing photo is fixed on Drive.
 * Showing the wrong one first sends the operator to the wrong tool.
 */
function toEntry(row: CatalogProductRow): CatalogProductEntry {
  const imageCount = toCount(row?.mediaImageCount);
  const videoCount = toCount(row?.mediaVideoCount);
  const hasMedia = imageCount + videoCount > 0;
  const hasConflict = row?.hasConflict === true;
  const code = typeof row?.code === "string" ? row.code : "";

  const inventory = evaluateInventory({
    productCode: code,
    stockRaw: typeof row?.stockRaw === "string" ? row.stockRaw : "",
    noteRaw: typeof row?.noteRaw === "string" ? row.noteRaw : "",
    hasConflict,
  });

  const composable = !inventory.blocked && hasMedia && !hasConflict;

  let blockedReason: CatalogProductBlockedReason | null = null;
  if (hasConflict) {
    blockedReason = {
      code: "SHEET_ROW_INVALID",
      userMessage: "2 dòng Sheet xung đột — sửa Sheet rồi đồng bộ lại",
    };
  } else if (inventory.blocked) {
    blockedReason = {
      code: "OUT_OF_STOCK",
      userMessage: inventory.operatorMessage ?? `Mã ${code} bị chặn vì tồn kho không hợp lệ`,
    };
  } else if (!hasMedia) {
    blockedReason = {
      code: "MEDIA_NOT_FOUND",
      userMessage: `Mã ${code} chưa có ảnh/video trên Drive`,
    };
  }

  return {
    code,
    name: typeof row?.name === "string" ? row.name : "",
    category: row?.category ?? null,
    season: row?.season ?? null,
    inventory: {
      status: inventory.status,
      stock: inventory.stock,
      reason: inventory.reason,
      operatorMessage: inventory.operatorMessage,
    },
    mediaImageCount: imageCount,
    mediaVideoCount: videoCount,
    hasConflict,
    composable,
    blockedReason,
  };
}

function matchesStatus(entry: CatalogProductEntry, status: CatalogStatusFilter): boolean {
  return status === "ok" ? entry.composable : !entry.composable;
}

/** Runs the decision table once per bucket and sums the SQL counts. */
function foldTotals(groups: readonly CatalogSignalGroup[]): CatalogTotals {
  let total = 0;
  let ok = 0;
  for (const group of groups ?? []) {
    const howMany = toCount(group?.count);
    if (howMany === 0) continue;
    total += howMany;
    const inventory = evaluateInventory({
      // The bucket has no single code; the code only shapes the message, which
      // a counter never shows.
      productCode: "",
      stockRaw: typeof group?.stockRaw === "string" ? group.stockRaw : "",
      noteRaw: typeof group?.noteRaw === "string" ? group.noteRaw : "",
      hasConflict: group?.hasConflict === true,
    });
    if (!inventory.blocked && group?.hasMedia === true && group?.hasConflict !== true) {
      ok += howMany;
    }
  }
  return { total, ok, blocked: total - ok };
}

// --- input normalisation ----------------------------------------------------

function normaliseLimit(raw: unknown, tenantId: string): number {
  if (raw === undefined || raw === null) return DEFAULT_CATALOG_PAGE_SIZE;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new AppError("INVALID_INPUT", {
      message: "limit must be a positive integer",
      userMessage: "Số dòng mỗi trang không hợp lệ.",
      context: { tenant_id: tenantId, field: "limit", value: raw },
    });
  }
  return Math.min(raw, MAX_CATALOG_PAGE_SIZE);
}

/**
 * An unknown status must not quietly mean "no filter": the operator would read
 * a full list as a filtered one and conclude nothing is blocked.
 */
function normaliseStatus(raw: unknown, tenantId: string): CatalogStatusFilter | null {
  const value = str(raw);
  if (value.length === 0) return null;
  if ((CATALOG_STATUS_FILTERS as readonly string[]).includes(value)) {
    return value as CatalogStatusFilter;
  }
  throw new AppError("INVALID_INPUT", {
    message: `Unknown catalog status filter "${value}"`,
    userMessage: `Bộ lọc trạng thái "${value}" không hợp lệ.`,
    context: { tenant_id: tenantId, field: "status", value },
  });
}

/**
 * The cursor travels through a URL, so it is untrusted. Garbage is
 * INVALID_INPUT, never "start over" — silently restarting a page loop is how an
 * operator ends up believing a product disappeared.
 */
export function decodeCatalogCursor(
  raw: string | null | undefined,
  tenantId?: string,
): string | null {
  const value = str(raw);
  if (value.length === 0) return null;
  if (!CURSOR_PATTERN.test(value)) {
    throw new AppError("INVALID_INPUT", {
      message: "Malformed catalog cursor",
      userMessage: "Con trỏ phân trang không hợp lệ — hãy tải lại danh sách.",
      context: { tenant_id: tenantId ?? null, field: "cursor", value: value.slice(0, 64) },
    });
  }
  return value;
}

function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  // Postgres returns bigint aggregates as strings through some drivers.
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  return 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
