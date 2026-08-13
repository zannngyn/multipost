import { z } from "zod";

/**
 * Contracts of the "Nguồn dữ liệu" card and the "Sản phẩm" screen.
 *
 * `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so these
 * MIRROR the results of `getCatalogSource` / `listCatalogProducts`. The runtime
 * parse in `http-client` is what turns a drift into a loud error instead of a
 * silently empty table.
 *
 * Business rule 2 (whitelist): `inventory` and `blockedReason` are INTERNAL
 * operator fields. This screen is an internal tool and shows them on purpose;
 * they must never be copied into a caption or a post preview.
 */

// --- Source (GET /api/catalog/source) ---------------------------------------

/**
 * A link that is safe to put in `href`. `z.url()` alone is NOT enough: it
 * accepts `javascript:` and `data:` URLs, which would turn a compromised or
 * buggy server response into script execution in the operator's tab
 * (core-frontend-security). Only http(s) reaches the DOM.
 */
const externalHttpUrl = () =>
  z
    .url()
    .refine(
      (value) => /^https?:\/\//i.test(value),
      "Đường dẫn phải bắt đầu bằng http:// hoặc https://",
    );

export const CatalogSourceSchema = z.object({
  driveFolderId: z.string().min(1),
  spreadsheetId: z.string().min(1),
  sheetName: z.string().min(1),
  /** Built server-side; the browser never assembles a Google URL by hand. */
  driveFolderUrl: externalHttpUrl(),
  spreadsheetUrl: externalHttpUrl(),
});
export type CatalogSource = z.infer<typeof CatalogSourceSchema>;

/**
 * "Not configured" is a valid answer, not a failure — same shape as the sync
 * status endpoint, so both cards read the same way.
 */
export const CatalogSourceResponseSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("not_configured"),
    tenantId: z.string().min(1),
  }),
  z.object({
    state: z.literal("configured"),
    tenantId: z.string().min(1),
    source: CatalogSourceSchema,
  }),
]);
export type CatalogSourceResponse = z.infer<typeof CatalogSourceResponseSchema>;

/**
 * Form behind "Đổi nguồn" (PUT /api/catalog/source).
 *
 * It deliberately does NOT try to validate the shape of a Drive URL: the server
 * owns that parser (a link, a bare id and a `?usp=sharing` tail all mean the
 * same folder), and a second, looser copy here would either reject something
 * the server accepts or accept something it rejects. This schema only catches
 * what costs a round trip: empty fields and paste accidents.
 */
export const MAX_SOURCE_REF_LENGTH = 512;

export const CatalogSourceFormSchema = z.object({
  driveFolder: z
    .string()
    .trim()
    .min(1, "Nhập link hoặc ID thư mục Drive.")
    .max(MAX_SOURCE_REF_LENGTH, "Link thư mục Drive quá dài (tối đa 512 ký tự)."),
  spreadsheet: z
    .string()
    .trim()
    .min(1, "Nhập link hoặc ID bảng Google Sheet.")
    .max(MAX_SOURCE_REF_LENGTH, "Link bảng Sheet quá dài (tối đa 512 ký tự)."),
  sheetName: z
    .string()
    .trim()
    .min(1, "Nhập tên tab chứa bảng sản phẩm, ví dụ: Mẫu 2026.")
    .max(128, "Tên tab quá dài (tối đa 128 ký tự)."),
});
export type CatalogSourceFormValues = z.infer<typeof CatalogSourceFormSchema>;

/** Field names the server may report issues on — used to place them inline. */
export const CATALOG_SOURCE_FIELDS = ["driveFolder", "spreadsheet", "sheetName"] as const;
export type CatalogSourceField = (typeof CATALOG_SOURCE_FIELDS)[number];

export function isCatalogSourceField(path: string): path is CatalogSourceField {
  return (CATALOG_SOURCE_FIELDS as readonly string[]).includes(path);
}

/** "1bA48sjugz…kp4v" — an id is 30+ chars of noise; show enough to compare. */
export function shortenId(id: string, keep = 6): string {
  const trimmed = id.trim();
  if (trimmed.length <= keep * 2 + 1) return trimmed;
  return `${trimmed.slice(0, keep)}…${trimmed.slice(-keep)}`;
}

// --- Products (GET /api/catalog/products) -----------------------------------

export const PRODUCT_FILTER_STATUSES = ["ok", "blocked"] as const;
export const ProductFilterStatusSchema = z.enum(PRODUCT_FILTER_STATUSES);
export type ProductFilterStatus = z.infer<typeof ProductFilterStatusSchema>;

/** Mirrors `InventoryDecision.status` (core/domain/inventory). */
export const InventoryStatusSchema = z.enum(["in_stock", "low_stock", "blocked"]);
export type InventoryStatus = z.infer<typeof InventoryStatusSchema>;

export const ProductInventorySchema = z.object({
  status: InventoryStatusSchema,
  /** Null when the Sheet cell is empty or not a number — NOT zero. */
  stock: z.number().nullable(),
  reason: z.string().nullable(),
  /** Vietnamese, written by the domain. Internal only. */
  operatorMessage: z.string().nullable(),
});
export type ProductInventory = z.infer<typeof ProductInventorySchema>;

export const CatalogProductSchema = z.object({
  code: z.string().min(1),
  name: z.string(),
  category: z.string().nullable(),
  season: z.string().nullable(),
  inventory: ProductInventorySchema,
  mediaImageCount: z.number(),
  mediaVideoCount: z.number(),
  /** The Sheet has two rows for this code with different values. */
  hasConflict: z.boolean(),
  /** Decided by the SERVER — the UI never infers "đăng được" from the parts. */
  composable: z.boolean(),
  blockedReason: z
    .object({ code: z.string().min(1), userMessage: z.string().min(1) })
    .nullable(),
});
export type CatalogProduct = z.infer<typeof CatalogProductSchema>;

export const CatalogProductTotalsSchema = z.object({
  total: z.number(),
  ok: z.number(),
  blocked: z.number(),
});
export type CatalogProductTotals = z.infer<typeof CatalogProductTotalsSchema>;

export const CatalogProductsResponseSchema = z.object({
  items: z.array(CatalogProductSchema),
  /** Opaque; `null` means this was the last page. */
  nextCursor: z.string().nullable(),
  totals: CatalogProductTotalsSchema,
});
export type CatalogProductsResponse = z.infer<typeof CatalogProductsResponseSchema>;

// --- Filter (URL is the source of truth, core-data-list-query) --------------

export const PRODUCTS_DEFAULT_LIMIT = 50;

export interface ProductFilter {
  /** `null` = every product (the default, which is NOT written to the URL). */
  status: ProductFilterStatus | null;
  /** `null` = no search. */
  q: string | null;
}

/** Parses `?status=&q=`; an invalid value falls back to the default. */
export function parseProductFilter(params: URLSearchParams): ProductFilter {
  const status = ProductFilterStatusSchema.safeParse(params.get("status"));
  const q = params.get("q")?.trim() ?? "";
  return {
    status: status.success ? status.data : null,
    q: q.length > 0 ? q : null,
  };
}

/**
 * THE single query-string builder for the product list (core-data-list-query
 * rule 2). Defaults are omitted so a shared link stays clean.
 */
export function productSearchParams(filter: ProductFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.q) params.set("q", filter.q);
  return params;
}

// --- Labels ------------------------------------------------------------------

export const INVENTORY_STATUS_LABELS: Record<InventoryStatus, string> = {
  in_stock: "Còn hàng",
  low_stock: "Tồn thấp",
  blocked: "Bị chặn",
};

export type InventoryTone = "success" | "warning" | "danger";

export const INVENTORY_STATUS_TONES: Record<InventoryStatus, InventoryTone> = {
  in_stock: "success",
  low_stock: "warning",
  blocked: "danger",
};

/**
 * Short label for the blocked row, from the SERVER's error code. Unknown codes
 * keep their code visible rather than being flattened into "Bị chặn" — an
 * operator must be able to tell two different problems apart.
 */
export const BLOCKED_REASON_LABELS: Record<string, string> = {
  OUT_OF_STOCK: "Hết hàng",
  MEDIA_NOT_FOUND: "Thiếu ảnh",
  SHEET_ROW_INVALID: "Xung đột Sheet",
  PRODUCT_NOT_FOUND: "Không có trên Sheet",
};

export function blockedReasonLabel(code: string): string {
  return BLOCKED_REASON_LABELS[code] ?? code;
}

/** "104 sản phẩm" with Vietnamese digit grouping. */
export function formatCount(value: number): string {
  return value.toLocaleString("vi-VN");
}

/** "12 ảnh · 1 video" — media at a glance, without a second column each. */
export function formatMediaCounts(imageCount: number, videoCount: number): string {
  if (imageCount === 0 && videoCount === 0) return "chưa có file";
  const parts: string[] = [];
  if (imageCount > 0) parts.push(`${formatCount(imageCount)} ảnh`);
  if (videoCount > 0) parts.push(`${formatCount(videoCount)} video`);
  return parts.join(" · ");
}
