import { z } from "zod";

import {
  CatalogFieldMapSchema,
  CatalogTextSourceSchema,
  FieldMapSuggestionSchema,
  MediaProfileConfigSchema,
  StockPolicySchema,
} from "@/ui/schemas/catalog-mapping.schema";

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
  /**
   * All three may be `""` since onboarding phase 3: a tenant who uploaded a CSV
   * and keeps no photos on Drive has no Google coordinates at all, and
   * `toCatalogSourceView` answers with empty strings rather than omitting them.
   *
   * They carried `.min(1)` before, which would have rejected that tenant's whole
   * response at the runtime parse and taken the "Nguồn dữ liệu" card down for
   * exactly the customers this phase exists to serve. Emptiness is a state the
   * SCREEN renders ("chưa khai"), not a reason to refuse the answer.
   */
  driveFolderId: z.string(),
  spreadsheetId: z.string(),
  sheetName: z.string(),
  /** Built server-side; the browser never assembles a Google URL by hand. */
  driveFolderUrl: externalHttpUrl(),
  spreadsheetUrl: externalHttpUrl(),
  /**
   * The mapping this tenant DECLARED, or null when it never declared one and is
   * running on the MYSP preset (mirrors `CatalogSourceView`).
   *
   * `null` and "a map equal to the preset" are DIFFERENT answers and the
   * onboarding screen renders them differently: null means "chưa khai — an toàn
   * để điền theo gợi ý", a value means "người ta đã chỉnh tay — đừng ghi đè".
   * Nothing on this side may collapse the two by comparing with the preset.
   */
  fieldMap: CatalogFieldMapSchema.nullable(),
  /** Same contract: null = chưa khai (đang chạy `numeric`), not "khai numeric". */
  stockPolicy: StockPolicySchema.nullable(),
  /**
   * Where this tenant's photos live (onboarding phase 2). Same contract again:
   * null = chưa khai (đang chạy `code-color-seq`), not "khai code-color-seq".
   *
   * `toCatalogSourceView` (core/usecases/get-catalog-source.ts) DOES put this
   * key on the wire now — both GET and PUT /api/catalog/source answer with
   * `mediaProfile: source.mediaProfile ?? null` — so a declared layout is
   * restored here instead of being re-offered as a suggestion. The older note
   * on this field claimed the backend dropped the key; that stopped being true
   * when phase 2 landed.
   *
   * `.nullish()` rather than `.nullable()` is what is left of that history, and
   * it stays deliberately: `undefined` and `null` are read the same way ("chưa
   * khai"), so an older server that still omits the key degrades into offering
   * the recommendation instead of taking the whole "Nguồn dữ liệu" card down.
   */
  mediaProfile: MediaProfileConfigSchema.nullish(),
  /**
   * WHICH table this tenant's products are read from (onboarding phase 3).
   *
   * Same contract as the three fields above: null/absent = chưa khai = đang đọc
   * tab Google, which is what every tenant configured before phase 3 has. A
   * `file` value carries the name and the upload time, and the screen prints
   * both — a customer who edits the file on their laptop and sees no change
   * needs to be told, in those words, that the server holds a COPY.
   */
  textSource: CatalogTextSourceSchema.nullish(),
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

// --- Uploading a CSV (POST /api/catalog/file) -------------------------------

/**
 * Client-side `accept` for the file picker. CSV ONLY — a PM decision, not a gap:
 * reading `.xlsx` would mean a new dependency and nobody approved one.
 *
 * `.tsv`/`.txt` are here because that is what Excel and Google Sheets actually
 * write when a locale uses semicolons or tabs; the reader detects the separator
 * either way. MIME types alone are not enough — Windows reports a `.csv` as
 * `application/vnd.ms-excel`, so a picker filtering on type would grey out the
 * very file the operator was just told to export.
 *
 * It is a HINT and nothing more: `accept` is trivially bypassed, the server
 * reads the bytes, and the screen states the rule in words beside the button —
 * an operator who only ever meets the rule as an error was told too late.
 */
export const CATALOG_FILE_ACCEPT = ".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain";

/** Mirrors `MAX_CATALOG_TEXT_BYTES` (core/usecases/read-catalog-text). */
export const MAX_CATALOG_FILE_BYTES = 5 * 1024 * 1024;

/**
 * One deviation the reader saw, grouped. Mirrors `CatalogReadNotice`.
 *
 * NOT errors — the file WAS read. They are what stops "sao thiếu 3 dòng?" from
 * being unanswerable a week later, which is why they are shown rather than
 * counted.
 */
export const CatalogReadNoticeSchema = z.object({
  code: z.string().min(1),
  count: z.number(),
  examples: z.array(z.string()),
  /** Vietnamese sentence, written by the adapter that read the file. */
  detail: z.string(),
});
export type CatalogReadNotice = z.infer<typeof CatalogReadNoticeSchema>;

/**
 * Mirrors `CatalogFilePreview` (core/usecases/upload-catalog-file).
 *
 * `sampleRows` stays a plain string record on purpose: these are RAW cells keyed
 * by the file's own headers, read before any mapping exists. Typing them further
 * would be inventing a meaning the file has not been given yet.
 */
export const CatalogFilePreviewSchema = z.object({
  columns: z.array(z.string()),
  /** Data rows, header excluded. */
  rowCount: z.number(),
  delimiter: z.string().nullable(),
  /** True = inferred from the bytes. Said out loud, so a wrong guess is visible. */
  delimiterDetected: z.boolean(),
  encoding: z.string().nullable(),
  notices: z.array(CatalogReadNoticeSchema),
  sampleRows: z.array(z.record(z.string(), z.string())),
  /**
   * The proposed column mapping for THIS file. A suggestion, never a save: it
   * lets the wizard show what was recognised the moment the upload lands,
   * instead of making the operator wait for the report to say the same thing.
   */
  fieldMapSuggestion: FieldMapSuggestionSchema,
});
export type CatalogFilePreview = z.infer<typeof CatalogFilePreviewSchema>;

export const UploadCatalogFileResponseSchema = z.object({
  /** The tenant's source AFTER the save — the same shape a GET returns. */
  source: CatalogSourceSchema,
  preview: CatalogFilePreviewSchema,
  /** The file this upload replaced, and whether its bytes could be removed. */
  replaced: z.object({ storageKey: z.string(), deleted: z.boolean() }).nullable(),
});
export type UploadCatalogFileResponse = z.infer<typeof UploadCatalogFileResponseSchema>;

/** "2,4 MB" / "812 KB" — decimal, the way a file manager reads. */
export function formatFileBytes(sizeBytes: number | null | undefined): string {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) return "—";
  if (sizeBytes >= 1_000_000) return `${(sizeBytes / 1_000_000).toFixed(1).replace(".", ",")} MB`;
  if (sizeBytes >= 1_000) return `${Math.round(sizeBytes / 1_000)} KB`;
  return `${sizeBytes} byte`;
}

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
  /**
   * TRUE means NOBODY checked the stock: this tenant runs
   * `stockPolicy.mode = "disabled"`.
   *
   * READ THIS BEFORE `status`. The domain deliberately keeps `status` at
   * `"in_stock"` in that mode (a fourth enum value would break every mirror of
   * this union), so `status` alone says "Còn hàng" for a code nobody counted.
   * Printing that sentence is a business-rule failure, not a cosmetic one —
   * `stockLabel()` in `ui/components/inventory/stock-check.ts` is the ONE place
   * allowed to turn these two fields into words.
   */
  stockCheckSkipped: z.boolean(),
  /** The reason the tenant wrote when turning the check off. Null otherwise. */
  stockCheckSkippedReason: z.string().nullable(),
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

/**
 * The ONE stock word this module still owns, and it is the one that has no
 * `stockCheckSkipped` reading: `low_stock` can only be produced by the numeric
 * branch, so it cannot be reached while the stock gate is off.
 *
 * The full `status -> label` table that used to live here is deliberately gone.
 * It carried `in_stock: "Còn hàng"`, and a tenant running
 * `stockPolicy.mode = "disabled"` keeps `status: "in_stock"` for codes nobody
 * counted — so any future screen that reached for the table would print exactly
 * the sentence this feature exists to prevent. Words for a stock decision come
 * from `ui/components/inventory/stock-check.ts`, which reads the flag first.
 */
export const LOW_STOCK_LABEL = "Tồn thấp";

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
 *
 * `PRODUCT_NOT_FOUND` says "dữ liệu sản phẩm", not "Sheet": since onboarding
 * phase 3 the catalog can come from a Google tab, an uploaded CSV, or a product
 * typed by hand on the compose screen, and naming one of the three would be
 * wrong for the other two. The wording is the one core and the publisher already
 * use in their own `userMessage` — one phrase for one thing, not a third.
 */
export const BLOCKED_REASON_LABELS: Record<string, string> = {
  OUT_OF_STOCK: "Hết hàng",
  MEDIA_NOT_FOUND: "Thiếu ảnh",
  /** Two rows of the SAME spreadsheet disagree — genuinely sheet-specific. */
  SHEET_ROW_INVALID: "Xung đột Sheet",
  PRODUCT_NOT_FOUND: "Không có trong dữ liệu sản phẩm",
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
