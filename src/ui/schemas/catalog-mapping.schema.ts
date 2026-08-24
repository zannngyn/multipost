import { z } from "zod";

/**
 * Contracts of the "Kết nối dữ liệu" screen (onboarding phase 1).
 *
 * `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so these
 * schemas MIRROR `core/domain/catalog-field-map.ts` (CatalogFieldMap,
 * FieldSuggestion, FieldMapIssue, StockPolicy) and
 * `core/usecases/profile-catalog-source.ts` (CatalogProfileReport). Any change
 * there must be reflected here — the mirror is deliberate, and the runtime parse
 * in `http-client` is what makes a drift loud instead of silent.
 */

// --- Logical fields ---------------------------------------------------------

/** Mirrors `CATALOG_FIELDS`. Order is the display order of the mapping form. */
export const CATALOG_FIELDS = [
  "code",
  "name",
  "description",
  "category",
  "season",
  "stock",
  "note",
  "colors",
] as const;
export const CatalogFieldSchema = z.enum(CATALOG_FIELDS);
export type CatalogField = z.infer<typeof CatalogFieldSchema>;

/** Mirrors `REQUIRED_CATALOG_FIELDS` — without these no row becomes a product. */
export const REQUIRED_CATALOG_FIELDS: readonly CatalogField[] = ["code", "name"];

/**
 * Mirrors `CATALOG_CONTENT_FIELDS`: the only columns allowed to reach a prompt
 * or a caption (business rule 2). The form says so next to each one, because
 * "cột này sẽ đi vào caption" is the difference between a mapping mistake and a
 * price leaking into a public post.
 */
export const CATALOG_CONTENT_FIELDS: readonly CatalogField[] = [
  "name",
  "description",
  "category",
  "season",
];

/** Mirrors `FIELD_LABELS`. Vietnamese — an operator reads these. */
export const CATALOG_FIELD_LABELS: Record<CatalogField, string> = {
  code: "Mã sản phẩm",
  name: "Tên sản phẩm",
  description: "Mô tả",
  category: "Chủng loại",
  season: "Mùa vụ",
  stock: "Tồn kho",
  note: "Lưu ý",
  colors: "Màu sắc",
};

/** What each field is FOR — the sentence that stops a wrong column being picked. */
export const CATALOG_FIELD_HINTS: Record<CatalogField, string> = {
  code: "Khoá của mọi thứ: ảnh trên Drive được ghép vào sản phẩm qua mã này.",
  name: "Mở đầu caption. Không có tên thì dòng bị loại.",
  description: "Câu mô tả đưa vào caption. Để trống nếu bảng của bạn không có.",
  category: "Ví dụ: áo, quần, váy. Dùng cho caption và để lọc.",
  season: "Ví dụ: Xuân hè 2026. Dùng cho caption.",
  stock: "Số tồn, hoặc chữ “còn/hết” — khai ở phần kiểm tồn bên dưới.",
  note: "Ô ghi chú; giá trị “HẾT HÀNG” sẽ chặn đăng. Không bao giờ vào caption.",
  colors: "Danh sách màu trong một ô. Hệ thống tự tách và gộp biến thể.",
};

// --- Field map --------------------------------------------------------------

/**
 * Mirrors `CatalogFieldMap`. `null` = "chưa map" and is a first-class answer:
 * an unmapped column is invisible to the parser, which is exactly what keeps a
 * price column of a sheet we have never seen out of a caption.
 *
 * `mediaLink` is the phase-2 slot: the column holding a Drive link/id per row,
 * read only by the `sheet-column` media profile. `.optional()` and not merely
 * nullable, because a map stored before phase 2 has no such key at all and a
 * screen that refuses to parse an old row would lock the tenant out of the very
 * form that fixes it. Absent and null mean the same thing: "khong co cot link".
 */
export const CatalogFieldMapSchema = z.object({
  code: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  season: z.string().nullable(),
  stock: z.string().nullable(),
  note: z.string().nullable(),
  colors: z.string().nullable(),
  mediaLink: z.string().nullable().optional(),
});
export type CatalogFieldMap = z.infer<typeof CatalogFieldMapSchema>;

/** Mirrors `FieldMatchKind`. */
export const FieldMatchKindSchema = z.enum(["exact", "partial", "none"]);
export type FieldMatchKind = z.infer<typeof FieldMatchKindSchema>;

/** Mirrors `SUGGESTION_REVIEW_THRESHOLD` — below it a human must confirm. */
export const SUGGESTION_REVIEW_THRESHOLD = 0.8;

export const FieldSuggestionSchema = z.object({
  field: CatalogFieldSchema,
  /** Null when nothing matched — the server does not guess, and neither do we. */
  column: z.string().nullable(),
  /** 0..1. */
  confidence: z.number(),
  matchKind: FieldMatchKindSchema,
  alternatives: z.array(z.string()),
  needsReview: z.boolean(),
});
export type FieldSuggestion = z.infer<typeof FieldSuggestionSchema>;

/**
 * Mirrors `FieldMapSuggestion` (core/domain/catalog-field-map) — what
 * `suggestFieldMap` proposes for one header row.
 *
 * Distinct from `FieldMapProfile` below on purpose, even though they overlap:
 * the profile is a REPORT about a source that is configured, this is an OFFER
 * about a file that was just read. Collapsing them would let a screen print
 * "đây là ánh xạ đang chạy" over something nobody has saved.
 */
export const FieldMapSuggestionSchema = z.object({
  fieldMap: CatalogFieldMapSchema,
  fields: z.array(FieldSuggestionSchema),
  unmappedColumns: z.array(z.string()),
  duplicateColumns: z.array(z.string()),
  blankColumnCount: z.number(),
  /** Unmapped columns that look like money — the onboarding warning. */
  priceLikeColumns: z.array(z.string()),
});
export type FieldMapSuggestion = z.infer<typeof FieldMapSuggestionSchema>;

export const FieldMapIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  fields: z.array(CatalogFieldSchema),
  column: z.string().nullable(),
  /** Vietnamese sentence written by the domain, naming the tenant's own column. */
  detail: z.string(),
});
export type FieldMapIssue = z.infer<typeof FieldMapIssueSchema>;

// --- Price-like columns (the onboarding hint) --------------------------------

/**
 * Header fragments that USUALLY mean money. Mirrors `PRICE_COLUMN_HINTS` in
 * `core/domain/catalog-field-map.ts`.
 *
 * WHY THE UI CARRIES A COPY: the safety model was inverted for onboarding — a
 * column reaches a caption ONLY because a human mapped it there, so the old
 * blacklist is gone and the MAPPING FORM is the last place a mistake can be
 * caught before it is stored. The server warns too
 * (`FIELD_MAP_PRICE_LIKE_COLUMN`), but its warning arrives inside a
 * compatibility report the operator may never have run.
 *
 * A hint, never a gate: it cannot block a save, because a tenant may genuinely
 * have a column called "Gia tri su dung".
 */
export const PRICE_COLUMN_HINTS: readonly string[] = [
  "gia",
  "don gia",
  "gia ban",
  "gia von",
  "nguyen gia",
  "gia km",
  "gia tmdt",
  "chiet khau",
  "price",
  "cost",
  "amount",
  "vnd",
];

/**
 * Header comparison form: no diacritics, lower case, single spaces, punctuation
 * turned into a separator. Mirrors the domain's `normalizeColumnName`.
 * Word boundaries are KEPT, which is what stops "gia" matching inside "giao".
 */
export function normalizeColumnName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Index of `needle` inside `tokens` as a consecutive run, or -1. */
function containsTokenSequence(tokens: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > tokens.length) return -1;
  for (let start = 0; start + needle.length <= tokens.length; start += 1) {
    let match = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (tokens[start + offset] !== needle[offset]) {
        match = false;
        break;
      }
    }
    if (match) return start;
  }
  return -1;
}

/** True when a header looks like money. Whole words only — see the note above. */
export function isPriceLikeColumn(column: unknown): boolean {
  const normalized = normalizeColumnName(column);
  if (normalized.length === 0) return false;
  const tokens = normalized.split(" ");
  return PRICE_COLUMN_HINTS.some((hint) => containsTokenSequence(tokens, hint.split(" ")) !== -1);
}

// --- Stock policy -----------------------------------------------------------

export const STOCK_POLICY_MODES = ["numeric", "textual", "disabled"] as const;
export const StockPolicyModeSchema = z.enum(STOCK_POLICY_MODES);
export type StockPolicyMode = z.infer<typeof StockPolicyModeSchema>;

/** Mirrors `MIN_DISABLED_REASON_LENGTH` in the domain. */
export const MIN_DISABLED_REASON_LENGTH = 10;

/**
 * Mirrors `StockPolicy`. The `disabled` arm carries a REQUIRED reason: turning
 * the stock gate off suspends business rule 3 for the whole tenant, so the
 * screen refuses to send one without a written reason — the same refusal the
 * domain makes, made early enough to keep the operator's typing.
 */
export const StockPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("numeric") }),
  z.object({
    mode: z.literal("textual"),
    inStockValues: z.array(z.string().trim().min(1)).min(1),
    outOfStockValues: z.array(z.string().trim().min(1)).min(1),
  }),
  z.object({
    mode: z.literal("disabled"),
    reason: z.string().trim().min(MIN_DISABLED_REASON_LENGTH),
  }),
]);
export type StockPolicy = z.infer<typeof StockPolicySchema>;

export const STOCK_POLICY_LABELS: Record<StockPolicyMode, string> = {
  numeric: "Cột tồn là SỐ",
  textual: "Cột tồn là CHỮ",
  disabled: "Không kiểm tồn kho",
};

export const STOCK_POLICY_HINTS: Record<StockPolicyMode, string> = {
  numeric:
    "Ô trống, không phải số, hoặc ≤ 0 đều bị chặn. Đây là cách hệ thống chạy mặc định.",
  textual:
    "Bạn khai những chữ nào nghĩa là còn hàng và những chữ nào nghĩa là hết hàng. Giá trị không nằm trong hai danh sách sẽ bị CHẶN, không đoán.",
  disabled:
    "Hệ thống sẽ không đọc số tồn nữa: ô trống, bằng 0 hay không phải số đều không chặn. Ô Lưu ý “HẾT HÀNG” và mã có nhiều dòng dữ liệu khác nhau thì VẪN chặn. Chỉ chọn khi tồn kho được quản lý ở nơi khác — bắt buộc ghi lý do.",
};

// --- Which table this tenant reads (onboarding phase 3) ---------------------

/**
 * Mirrors `CatalogTextConfig` (core/domain/catalog-text-config).
 *
 * ABSENT/NULL MEANS `google_sheet`, and that contract is load-bearing: every
 * tenant configured before phase 3 has no such key, and reading a missing value
 * as anything else would tell them their Google tab is gone. Nothing on this
 * side may infer `file` from any other signal.
 */
export const CATALOG_TEXT_SOURCE_KINDS = ["google_sheet", "file"] as const;
export const CatalogTextSourceKindSchema = z.enum(CATALOG_TEXT_SOURCE_KINDS);
export type CatalogTextSourceKind = z.infer<typeof CatalogTextSourceKindSchema>;

export const CatalogTextSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("google_sheet") }),
  z.object({
    kind: z.literal("file"),
    /** Opaque handle; the browser only ever echoes it, never parses it. */
    storageKey: z.string().min(1),
    /**
     * The name as the operator uploaded it. THE answer to "hệ thống đang đọc
     * file nào" — the first question a customer asks after editing the file on
     * their laptop and finding the numbers unchanged.
     */
    fileName: z.string().min(1),
    contentType: z.string().nullish(),
    sizeBytes: z.number().nullish(),
    /** ISO-8601. The other half of that answer: "tải lên lúc nào". */
    uploadedAt: z.string().nullish(),
    /** Separator the operator pinned. Absent = detected on every read. */
    delimiter: z.string().nullish(),
  }),
]);
export type CatalogTextSource = z.infer<typeof CatalogTextSourceSchema>;

export type UploadedCatalogFile = Extract<CatalogTextSource, { kind: "file" }>;

/** The uploaded file a tenant reads from, or null when they read a Google tab. */
export function uploadedCatalogFile(
  textSource: CatalogTextSource | null | undefined,
): UploadedCatalogFile | null {
  return textSource?.kind === "file" ? textSource : null;
}

/** Label for the source in one phrase, wherever a screen has to name it. */
export const CATALOG_TEXT_SOURCE_LABELS: Record<CatalogTextSourceKind, string> = {
  google_sheet: "Bảng Google Sheet",
  file: "File CSV tải lên",
};

// --- Media profile (nguồn ảnh) ----------------------------------------------

/**
 * Mirrors `MEDIA_PROFILE_KINDS` in `core/domain/media-profile.ts`. The order is
 * the server's probing order AND the display order of the radio list, so the
 * layout that asks least of the tenant is read first.
 */
export const MEDIA_PROFILE_KINDS = [
  "sheet-column",
  "folder-per-code",
  "code-in-name",
  "code-color-seq",
] as const;
export const MediaProfileKindSchema = z.enum(MEDIA_PROFILE_KINDS);
export type MediaProfileKind = z.infer<typeof MediaProfileKindSchema>;

/** Mirrors `DEFAULT_MEDIA_PROFILE` — what an undeclared tenant runs on today. */
export const DEFAULT_MEDIA_PROFILE_KIND: MediaProfileKind = "code-color-seq";

/**
 * Mirrors `ColorVocabularyConfig`. The form does not edit it, but a saved
 * profile has to carry it back unchanged: dropping the key would wipe a tenant's
 * colour vocabulary as a side effect of moving their photos.
 */
export const ColorVocabularyConfigSchema = z.object({
  canonical: z.array(z.string()).optional(),
  aliases: z.record(z.string(), z.string()).optional(),
  includeDefaults: z.boolean().optional(),
});

/**
 * Mirrors `MediaProfile` — the CONFIG, not the report section of the same name.
 * The server keeps both and aliases this one `MediaProfileConfig`; so do we.
 */
export const MediaProfileConfigSchema = z.object({
  kind: MediaProfileKindSchema,
  colors: ColorVocabularyConfigSchema.optional(),
});
export type MediaProfileConfig = z.infer<typeof MediaProfileConfigSchema>;

/** Mirrors `MEDIA_PROFILE_LABELS`. Vietnamese — an operator reads these. */
export const MEDIA_PROFILE_KIND_LABELS: Record<MediaProfileKind, string> = {
  "sheet-column": "Link ảnh nằm trên một cột của bảng tính",
  "folder-per-code": "Mỗi mã sản phẩm một thư mục con trên Drive",
  "code-in-name": "Mã sản phẩm nằm đâu đó trong tên file",
  "code-color-seq": "Tên file theo mẫu MÃ-Màu (số).ext",
};

/** What each layout asks of the tenant's Drive, in one sentence. */
export const MEDIA_PROFILE_KIND_HINTS: Record<MediaProfileKind, string> = {
  "sheet-column":
    "Mỗi dòng của bảng có một ô chứa link hoặc ID Drive. Tên file đặt thế nào cũng được.",
  "folder-per-code":
    "Thư mục ảnh có các thư mục con đặt tên bằng mã sản phẩm; tên file bên trong đặt tuỳ ý.",
  "code-in-name":
    "Mã nằm ở bất kỳ đâu trong tên file, phân cách bằng gạch, gạch dưới, dấu cách hay dấu chấm.",
  "code-color-seq":
    "Cách hệ thống đang chạy mặc định: mã đứng đầu, rồi tên màu, rồi số thứ tự — ví dụ MG0AD6112-TRẮNG (1).jpg.",
};

/**
 * THE trade-off of `sheet-column`, stated everywhere that option appears.
 *
 * Colour is parsed out of the FILE NAME, and this layout never looks at file
 * names: every asset comes back without a colour. A tenant who picks it can
 * still post, but "đăng riêng từng màu" stops existing for them — and that is
 * not something anybody should discover after a sync.
 */
export const SHEET_COLUMN_COLOR_LOSS =
  "Chọn cách này là MẤT hoàn toàn việc lọc ảnh theo màu: hệ thống lấy ảnh theo link trên bảng nên không đọc tên file, mọi ảnh về chung một nhóm “không phân màu”. Bạn vẫn đăng được, nhưng không tách được bài theo từng màu.";

/** True when the layout needs a column of Drive links (`fieldMap.mediaLink`). */
export function mediaProfileNeedsLinkColumn(kind: MediaProfileKind): boolean {
  return kind === "sheet-column";
}

/** True when the file NAME still carries a colour for this layout. */
export function mediaProfileKeepsColor(kind: MediaProfileKind): boolean {
  return kind === "code-color-seq";
}

/** Mirrors `MediaProfileCandidate`: one of the four kinds, scored on the sample. */
export const MediaProfileCandidateSchema = z.object({
  kind: MediaProfileKindSchema,
  /** Operator-facing name, written by the server. */
  label: z.string(),
  /** False when the sample cannot answer for this kind; `note` says what is missing. */
  applicable: z.boolean(),
  note: z.string().nullable(),
  assets: z.number(),
  rejected: z.number(),
  /** Sheet codes that would get at least one photo — the number that decides. */
  codesMatched: z.number(),
  /** `codesMatched / codes in the sheet`, 0..1. */
  score: z.number(),
});
export type MediaProfileCandidate = z.infer<typeof MediaProfileCandidateSchema>;

export const MediaProfileSuggestionSchema = z.object({
  recommended: MediaProfileKindSchema,
  /** 0..1, halved when a runner-up scores as well — a tie means "để người chọn". */
  confidence: z.number(),
  /** All four, best first. */
  candidates: z.array(MediaProfileCandidateSchema),
  /** Column the links were read from (mapped or detected). Null when none. */
  mediaLinkColumn: z.string().nullable(),
  /** True when the Drive sample included sub-folders. */
  recursive: z.boolean(),
});
export type MediaProfileSuggestion = z.infer<typeof MediaProfileSuggestionSchema>;

// --- Compatibility report ---------------------------------------------------

export const IssueGroupSummarySchema = z.object({
  /** Machine reason, English (MISSING_CODE, NO_PRODUCT_CODE…). */
  reason: z.string(),
  count: z.number(),
  examples: z.array(z.string()),
  /** Vietnamese sentence for the operator. */
  detail: z.string(),
});
export type IssueGroupSummary = z.infer<typeof IssueGroupSummarySchema>;

export const SheetProfileSchema = z.object({
  columns: z.array(z.string()),
  duplicateColumns: z.array(z.string()),
  totalRows: z.number(),
  emptyRows: z.number(),
  productsParsed: z.number(),
  rowsRejected: z.number(),
  rejectionGroups: z.array(IssueGroupSummarySchema),
  duplicateCodes: z.number(),
  conflictingCodes: z.array(z.string()),
});
export type SheetProfile = z.infer<typeof SheetProfileSchema>;

export const FieldMapProfileSchema = z.object({
  fieldMap: CatalogFieldMapSchema,
  /** `tenant` = the map we sent, `suggested` = inferred from the header row. */
  source: z.enum(["tenant", "suggested"]),
  fields: z.array(FieldSuggestionSchema),
  unmappedColumns: z.array(z.string()),
  priceLikeColumns: z.array(z.string()),
  issues: z.array(FieldMapIssueSchema),
});
export type FieldMapProfile = z.infer<typeof FieldMapProfileSchema>;

export const MediaProfileSchema = z.object({
  sampled: z.number(),
  cap: z.number(),
  /** True when the folder holds more files than the sample — numbers are estimates. */
  capped: z.boolean(),
  nameParsed: z.number(),
  nameRejected: z.number(),
  /** 0..1. */
  parseRate: z.number(),
  strictNames: z.number(),
  withoutExtension: z.number(),
  duplicateNames: z.number(),
  distinctCodes: z.number(),
  issueGroups: z.array(IssueGroupSummarySchema),
});
export type MediaProfile = z.infer<typeof MediaProfileSchema>;

export const CrossCheckProfileSchema = z.object({
  codesInSheet: z.number(),
  codesInDrive: z.number(),
  codesInBoth: z.number(),
  codesOnlyInSheet: z.number(),
  codesOnlyInDrive: z.number(),
  blockedByInventory: z.number(),
  /** THE number the whole screen exists for. */
  postableNow: z.number(),
  postableSample: z.array(z.string()),
  /** True when `postableNow` was produced WITHOUT a stock check. */
  stockCheckSkipped: z.boolean(),
});
export type CrossCheckProfile = z.infer<typeof CrossCheckProfileSchema>;

export const CatalogProfileReportSchema = z.object({
  tenantId: z.string().min(1),
  /**
   * `""` when the report was produced from an UPLOADED FILE — there is no
   * spreadsheet to name.
   *
   * These two carried `.min(1)` until onboarding phase 3, and that was not a
   * harmless tightening: the server answers 200 with a perfectly good report for
   * a CSV tenant, and a `.min(1)` here would have rejected the whole response at
   * the runtime parse. The wizard would then show its error state for a source
   * that reads fine — the "silently empty screen" this mirror exists to prevent,
   * arriving through the mirror itself.
   */
  spreadsheetId: z.string(),
  sheetName: z.string(),
  /**
   * WHICH source these numbers describe. Null = the Google tab named above.
   * Read this before printing any sentence about where to go and fix the data:
   * it is the only thing that stops a file report being read as a sheet one.
   */
  textSource: CatalogTextSourceSchema.nullish(),
  driveFolderId: z.string().nullable(),
  stockPolicyMode: StockPolicyModeSchema,
  sheet: SheetProfileSchema,
  fieldMap: FieldMapProfileSchema,
  /** Null when no folder was given, or when Drive could not be read. */
  media: MediaProfileSchema.nullable(),
  /**
   * Null whenever `media` is null — the four kinds are scored on Drive files.
   *
   * This key is why the mirror had to be widened: `z.object` STRIPS what it does
   * not declare, so the server computed the whole comparison and the screen
   * received an object without it. A missing mirror is not a missing feature
   * anybody can see — it is a silently empty screen.
   */
  mediaProfileSuggestion: MediaProfileSuggestionSchema.nullable(),
  /** Null whenever `media` is null — there is nothing to cross-check. */
  crossCheck: CrossCheckProfileSchema.nullable(),
  topIssues: z.array(IssueGroupSummarySchema),
  /** Caveats about the report itself (sampling, Drive unreadable…). */
  warnings: z.array(z.string()),
});
export type CatalogProfileReport = z.infer<typeof CatalogProfileReportSchema>;

/**
 * "Chưa cấu hình nguồn" is a normal answer, not an error: the wizard's first
 * step has not been finished yet. A discriminated union forces the screen to
 * handle it as an EMPTY state instead of a red box nobody can act on.
 */
export const CatalogProfileResponseSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_configured"), tenantId: z.string().min(1) }),
  z.object({ state: z.literal("profiled"), report: CatalogProfileReportSchema }),
]);
export type CatalogProfileResponse = z.infer<typeof CatalogProfileResponseSchema>;

// --- Reading the report out loud --------------------------------------------

/** "72%" from 0.718. Rounded, because the report itself is a sample. */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) return "—";
  return `${Math.round(ratio * 100)}%`;
}

export type ConfidenceBand = "high" | "review" | "none";

/**
 * How much of a suggestion the operator has to check. Three bands, not a bar:
 * "0.83" means nothing to somebody mapping a spreadsheet, and a percentage next
 * to a column name reads as a score for the column, not for our guess.
 */
export function confidenceBand(suggestion: FieldSuggestion): ConfidenceBand {
  if (suggestion.column === null) return "none";
  return suggestion.confidence >= SUGGESTION_REVIEW_THRESHOLD ? "high" : "review";
}

export const CONFIDENCE_LABELS: Record<ConfidenceBand, string> = {
  high: "Khớp rõ",
  review: "Cần xem lại",
  none: "Chưa chọn được",
};

export const CONFIDENCE_HINTS: Record<ConfidenceBand, string> = {
  high: "Tên cột khớp với một tên hệ thống đã biết.",
  review: "Chỉ khớp một phần — mở danh sách và kiểm tra lại cột này.",
  none: "Không có cột nào giống — bạn phải tự chọn.",
};

// --- Reading the media suggestion out loud ----------------------------------

export type MediaConfidenceBand = "high" | "medium" | "low" | "none";

/**
 * How much of the server's recommendation the operator still has to judge.
 *
 * Bands, not the raw number, for the same reason `confidenceBand` exists: "0.62"
 * printed next to a layout name reads as a score for the LAYOUT, not for our
 * guess about it. The evidence stays on every row as "ghép được X/Y mã".
 */
export function mediaConfidenceBand(confidence: number): MediaConfidenceBand {
  if (!Number.isFinite(confidence) || confidence <= 0) return "none";
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

export const MEDIA_CONFIDENCE_LABELS: Record<MediaConfidenceBand, string> = {
  high: "Rõ ràng",
  medium: "Khá chắc",
  low: "Chưa chắc",
  none: "Không chấm được",
};

export const MEDIA_CONFIDENCE_HINTS: Record<MediaConfidenceBand, string> = {
  high: "Một cách ăn đứt các cách còn lại trên chính dữ liệu của bạn.",
  medium: "Cách này nhỉnh hơn, nhưng có cách khác bám sát — xem số ở từng dòng rồi quyết.",
  low: "Các cách cho kết quả sát nhau, hoặc đều ghép được ít mã — đọc kỹ số ở từng dòng.",
  none:
    "Không cách nào ghép được mã nào từ mẫu đã quét. Thường là do sai thư mục ảnh, chưa chia sẻ quyền, hoặc mã trên bảng không xuất hiện ở đâu trong thư mục.",
};
