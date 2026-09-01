/**
 * Per-tenant catalog mapping (onboarding phase 1).
 * Pure TypeScript: no imports, no I/O (docs/07 section 2).
 *
 * WHY: every column name in `SHEET_COLUMNS` is the internal company's own
 * Vietnamese header. An outside customer keeps their own sheet and will not
 * rename it for us, so a sync that only understands "Mã sản phẩm" dies on the
 * first row. A `CatalogFieldMap` moves the header names out of the code and
 * into `tenant_integration.config`.
 *
 * SAFETY MODEL — this file inverts the whitelist (CLAUDE.md business rule 2):
 * a column reaches `ProductContent` (and therefore a prompt/caption) ONLY when
 * the tenant mapped it onto one of the four content fields. Anything unmapped
 * is invisible to the parser, so a price column of a sheet we have never seen
 * cannot leak. The old blacklist (`FORBIDDEN_SHEET_COLUMNS`) is demoted to
 * `PRICE_COLUMN_HINTS`: an onboarding warning, never a safety mechanism.
 */

// --- Logical fields ---------------------------------------------------------

/** Fields the data layer reads from a sheet row. Order is the display order. */
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
export type CatalogField = (typeof CATALOG_FIELDS)[number];

/** The four caption-safe fields (+ `code`). Nothing else may reach a prompt. */
export const CATALOG_CONTENT_FIELDS = ["name", "description", "category", "season"] as const;
export type CatalogContentField = (typeof CATALOG_CONTENT_FIELDS)[number];

/** Without these two a row cannot be turned into a product at all. */
export const REQUIRED_CATALOG_FIELDS = ["code", "name"] as const;

/**
 * Logical field -> the tenant's column header, or null when the tenant has no
 * such column. Null is a first-class answer: "chưa map" must never be guessed.
 */
export interface CatalogFieldMap {
  readonly code: string | null;
  readonly name: string | null;
  readonly description: string | null;
  readonly category: string | null;
  readonly season: string | null;
  readonly stock: string | null;
  readonly note: string | null;
  readonly colors: string | null;
  /**
   * PHASE 2 SLOT — reserved, nothing reads it today. A column holding a Drive
   * link/folder per product, for tenants whose photos are not named `MÃ-Màu`.
   * Declared now so the stored config shape does not have to change later.
   */
  readonly mediaLink?: string | null;
}

/**
 * The internal company's tab "Mẫu 2026" (docs/05 section 2.1) as a field map.
 * This is the source of truth for `SHEET_COLUMNS`, and the default of every
 * `fieldMap` parameter — an absent map must behave exactly like before.
 */
export const MYSP_FIELD_MAP = {
  code: "Mã sản phẩm",
  name: "Tên sản phẩm",
  description: "Mô tả sản phẩm",
  category: "Chủng loại",
  season: "Mùa vụ",
  stock: "Tồn",
  note: "Lưu ý nhận sx 1c / sx hết tồn",
  colors: "Màu sắc",
  mediaLink: null,
} as const satisfies CatalogFieldMap;

/** Price columns of tab "Mẫu 2026" — kept for the onboarding hint only. */
export const MYSP_PRICE_COLUMNS: readonly string[] = [
  "Nguyên Giá (bắt buộc)",
  "Giá TMĐT",
  "Giá TMĐT làm tròn",
  "Giá KM",
];

/**
 * Header fragments that USUALLY mean money. Used to warn an operator who maps a
 * price column onto a caption field — a hint, not a gate (the gate is the
 * opt-in map itself).
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

// --- Text normalisation -----------------------------------------------------

/**
 * Header comparison form: no diacritics, lower case, single spaces, punctuation
 * turned into a separator. `"  Mã  SẢN-phẩm "` -> `"ma san pham"`.
 * Word boundaries are KEPT so `"ma"` cannot match inside `"mau"`.
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

/**
 * Value comparison form: `normalizeColumnName` without the spaces, so
 * `"Hết hàng"`, `"HET HANG"` and `"hết  hàng"` share one key.
 */
export function comparisonKey(value: unknown): string {
  return normalizeColumnName(value).replace(/ /g, "");
}

/** True when a header looks like money (see PRICE_COLUMN_HINTS). */
export function isPriceLikeColumn(column: unknown): boolean {
  const normalized = normalizeColumnName(column);
  if (normalized.length === 0) return false;
  const tokens = normalized.split(" ");
  return PRICE_COLUMN_HINTS.some((hint) => containsTokenSequence(tokens, hint.split(" ")) !== -1);
}

// --- Map helpers ------------------------------------------------------------

/** Fills every missing key with null — a partial map never inherits a preset. */
export function makeFieldMap(partial: Partial<CatalogFieldMap> | null | undefined): CatalogFieldMap {
  const pick = (field: keyof CatalogFieldMap): string | null => {
    const value = partial?.[field];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    code: pick("code"),
    name: pick("name"),
    description: pick("description"),
    category: pick("category"),
    season: pick("season"),
    stock: pick("stock"),
    note: pick("note"),
    colors: pick("colors"),
    mediaLink: pick("mediaLink"),
  };
}

/** Every column the map points at, in field order, without duplicates. */
export function mappedColumns(map: CatalogFieldMap): readonly string[] {
  const seen = new Set<string>();
  for (const field of CATALOG_FIELDS) {
    const column = map[field];
    if (typeof column === "string" && column.length > 0) seen.add(column);
  }
  const mediaLink = map.mediaLink;
  if (typeof mediaLink === "string" && mediaLink.length > 0) seen.add(mediaLink);
  return [...seen];
}

/** Columns allowed to reach a caption. Anything else is invisible by design. */
export function contentColumns(map: CatalogFieldMap): readonly string[] {
  return CATALOG_CONTENT_FIELDS.map((field) => map[field]).filter(
    (column): column is string => typeof column === "string" && column.length > 0,
  );
}

// --- Suggestion -------------------------------------------------------------

/** How a column was matched. `none` means the field stays unmapped. */
export const FIELD_MATCH_KINDS = ["exact", "partial", "none"] as const;
export type FieldMatchKind = (typeof FIELD_MATCH_KINDS)[number];

/** Below this a suggestion is shown but flagged for a human to confirm. */
export const SUGGESTION_REVIEW_THRESHOLD = 0.8;

/** A partial match under this score is dropped — too weak to even suggest. */
const MIN_SUGGESTION_SCORE = 0.5;

export interface FieldSuggestion {
  readonly field: CatalogField;
  /** Null when nothing matched — the operator has to pick, we do not guess. */
  readonly column: string | null;
  /** 0..1. 1 = the header is a known alias, lower = a fuzzy containment. */
  readonly confidence: number;
  readonly matchKind: FieldMatchKind;
  /** Runner-up columns, best first (max 3), so the UI can offer a dropdown. */
  readonly alternatives: readonly string[];
  /** True when a human must confirm before the map is used. */
  readonly needsReview: boolean;
}

export interface FieldMapSuggestion {
  readonly fieldMap: CatalogFieldMap;
  readonly fields: readonly FieldSuggestion[];
  /** Readable columns nothing was mapped onto (and therefore never read). */
  readonly unmappedColumns: readonly string[];
  /** Headers repeated in the sheet — reported, never guessed (docs/05 2.1). */
  readonly duplicateColumns: readonly string[];
  /** Blank/whitespace-only headers that were ignored. */
  readonly blankColumnCount: number;
  /** Unmapped columns that look like money — the onboarding warning. */
  readonly priceLikeColumns: readonly string[];
}

/**
 * Aliases per field, written the way real sheets write them. Matching is done
 * on the normalised form, so accents/case/punctuation do not matter here.
 *
 * `mediaLink` is deliberately absent: it is a phase-2 slot and a wrong guess
 * would point the photo pipeline at an arbitrary column.
 */
const FIELD_ALIASES: Record<CatalogField, readonly string[]> = {
  code: [
    "mã",
    "mã sp",
    "mã sản phẩm",
    "mã hàng",
    "mã hàng hoá",
    "mã mẫu",
    "mã vật tư",
    "sku",
    "code",
    "item code",
    "product code",
    "product id",
    "mã sku",
  ],
  name: [
    "tên",
    "tên sp",
    "tên sản phẩm",
    "tên hàng",
    "tên hàng hoá",
    "tên mẫu",
    "name",
    "product name",
    "item name",
    "tên gọi",
  ],
  description: [
    "mô tả",
    "mô tả sản phẩm",
    "mô tả chi tiết",
    "mota",
    "diễn giải",
    "chi tiết",
    "chi tiết sản phẩm",
    "description",
    "desc",
    "detail",
    "details",
  ],
  category: [
    "chủng loại",
    "loại",
    "loại sản phẩm",
    "nhóm",
    "nhóm hàng",
    "phân loại",
    "ngành hàng",
    "dòng sản phẩm",
    "category",
    "type",
    "product type",
  ],
  season: ["mùa", "mùa vụ", "mùa hàng", "season", "collection", "bộ sưu tập"],
  stock: [
    "tồn",
    "tồn kho",
    "số lượng",
    "số lượng tồn",
    "sl",
    "sl tồn",
    "kho",
    "stock",
    "in stock",
    "qty",
    "quantity",
    "available",
    "on hand",
  ],
  note: ["lưu ý", "ghi chú", "chú thích", "note", "notes", "remark", "remarks", "comment"],
  colors: ["màu", "màu sắc", "mau", "color", "colour", "colors", "colours"],
};

const NORMALIZED_ALIASES: Record<CatalogField, readonly string[]> = (() => {
  const table = {} as Record<CatalogField, readonly string[]>;
  for (const field of CATALOG_FIELDS) {
    table[field] = [...new Set(FIELD_ALIASES[field].map(normalizeColumnName))].filter(
      (alias) => alias.length > 0,
    );
  }
  return table;
})();

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

/**
 * Score of one (field, column) pair.
 *
 * An exact alias wins outright (1). A containment ("Lưu ý nhận sx 1c / sx hết
 * tồn" contains "lưu ý") scores by how much of the header the alias covers plus
 * a bonus for opening it, which is what keeps that header on `note` instead of
 * on `stock` — it also ends with "tồn".
 */
function scoreColumn(field: CatalogField, normalizedColumn: string): {
  score: number;
  kind: FieldMatchKind;
} {
  if (normalizedColumn.length === 0) return { score: 0, kind: "none" };
  const aliases = NORMALIZED_ALIASES[field];
  if (aliases.includes(normalizedColumn)) return { score: 1, kind: "exact" };

  const tokens = normalizedColumn.split(" ");
  let best = 0;
  for (const alias of aliases) {
    const aliasTokens = alias.split(" ");
    const at = containsTokenSequence(tokens, aliasTokens);
    if (at === -1) continue;
    const coverage = aliasTokens.length / tokens.length;
    const score = Math.min(0.9, 0.5 + 0.3 * coverage + (at === 0 ? 0.1 : 0));
    if (score > best) best = score;
  }
  return best >= MIN_SUGGESTION_SCORE ? { score: best, kind: "partial" } : { score: 0, kind: "none" };
}

/**
 * Proposes a map for a sheet nobody has configured yet. Never throws: an empty
 * or nonsense header row yields a map full of nulls, which `validateFieldMap`
 * then reports as "thiếu cột bắt buộc".
 *
 * One column is used by at most one field; assignment is greedy on the score,
 * so a header that fits two fields lands on the better one.
 */
export function suggestFieldMap(columns: readonly string[] | null | undefined): FieldMapSuggestion {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  const list = Array.isArray(columns) ? columns : [];
  const usable: string[] = [];
  const duplicates: string[] = [];
  let blankColumnCount = 0;
  const seen = new Set<string>();

  for (const raw of list) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      blankColumnCount += 1;
      continue;
    }
    const column = raw.trim();
    if (seen.has(column)) {
      if (!duplicates.includes(column)) duplicates.push(column);
      continue;
    }
    seen.add(column);
    usable.push(column);
  }

  const normalized = usable.map(normalizeColumnName);
  const candidates: Array<{ field: CatalogField; columnIndex: number; score: number; kind: FieldMatchKind }> = [];
  for (const field of CATALOG_FIELDS) {
    for (const [columnIndex, normalizedColumn] of normalized.entries()) {
      const { score, kind } = scoreColumn(field, normalizedColumn);
      if (kind === "none") continue;
      candidates.push({ field, columnIndex, score, kind });
    }
  }

  // Deterministic order: best score, then field order, then sheet order.
  const fieldOrder = new Map<CatalogField, number>(CATALOG_FIELDS.map((f, i) => [f, i]));
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      (fieldOrder.get(a.field) ?? 0) - (fieldOrder.get(b.field) ?? 0) ||
      a.columnIndex - b.columnIndex,
  );

  const chosen = new Map<CatalogField, { columnIndex: number; score: number; kind: FieldMatchKind }>();
  const takenColumns = new Set<number>();
  for (const candidate of candidates) {
    if (chosen.has(candidate.field) || takenColumns.has(candidate.columnIndex)) continue;
    chosen.set(candidate.field, candidate);
    takenColumns.add(candidate.columnIndex);
  }

  const fields: FieldSuggestion[] = CATALOG_FIELDS.map((field) => {
    const pick = chosen.get(field);
    const alternatives = candidates
      .filter((c) => c.field === field && c.columnIndex !== pick?.columnIndex)
      .slice(0, 3)
      .map((c) => usable[c.columnIndex] as string);

    if (!pick) {
      return {
        field,
        column: null,
        confidence: 0,
        matchKind: "none" as const,
        alternatives,
        needsReview: true,
      };
    }
    const confidence = Math.round(pick.score * 100) / 100;
    return {
      field,
      column: usable[pick.columnIndex] as string,
      confidence,
      matchKind: pick.kind,
      alternatives,
      needsReview: confidence < SUGGESTION_REVIEW_THRESHOLD,
    };
  });

  const fieldMap = makeFieldMap(
    Object.fromEntries(fields.map((f) => [f.field, f.column])) as Partial<CatalogFieldMap>,
  );
  const unmappedColumns = usable.filter((_, index) => !takenColumns.has(index));

  return {
    fieldMap,
    fields,
    unmappedColumns,
    duplicateColumns: duplicates,
    blankColumnCount,
    priceLikeColumns: unmappedColumns.filter(isPriceLikeColumn),
  };
}

// --- Validation -------------------------------------------------------------

export const FIELD_MAP_ISSUE_CODES = [
  /** `code` or `name` has no column — no row can be parsed. */
  "FIELD_MAP_REQUIRED_MISSING",
  /** A mapped header does not exist in the sheet (renamed/removed). */
  "FIELD_MAP_COLUMN_NOT_FOUND",
  /** Two fields point at the same header. */
  "FIELD_MAP_COLUMN_REUSED",
  /** A caption field points at a header that looks like money. */
  "FIELD_MAP_PRICE_LIKE_COLUMN",
] as const;
export type FieldMapIssueCode = (typeof FIELD_MAP_ISSUE_CODES)[number];

export interface FieldMapIssue {
  readonly code: FieldMapIssueCode;
  /** `error` blocks a sync; `warning` is shown and the sync continues. */
  readonly severity: "error" | "warning";
  /** Fields the issue is about (two of them for a reused column). */
  readonly fields: readonly CatalogField[];
  readonly column: string | null;
  /** Sentence for the OPERATOR — Vietnamese, names the tenant's own column. */
  readonly detail: string;
}

/**
 * Checks that only depend on the map itself. Split out because a sync already
 * reports missing columns as schema drift and must not say it twice.
 */
export function validateFieldMapStructure(
  map: CatalogFieldMap | null | undefined,
): readonly FieldMapIssue[] {
  const issues: FieldMapIssue[] = [];
  const safeMap = makeFieldMap(map ?? undefined);

  for (const field of REQUIRED_CATALOG_FIELDS) {
    if (safeMap[field] !== null) continue;
    issues.push({
      code: "FIELD_MAP_REQUIRED_MISSING",
      severity: "error",
      fields: [field],
      column: null,
      detail: `Chưa chọn cột cho trường bắt buộc '${FIELD_LABELS[field]}' — không đọc được dòng nào cho tới khi khai báo.`,
    });
  }

  const byColumn = new Map<string, CatalogField[]>();
  for (const field of CATALOG_FIELDS) {
    const column = safeMap[field];
    if (column === null) continue;
    const list = byColumn.get(column) ?? [];
    list.push(field);
    byColumn.set(column, list);
  }
  for (const [column, fields] of byColumn) {
    if (fields.length < 2) continue;
    issues.push({
      code: "FIELD_MAP_COLUMN_REUSED",
      severity: "error",
      fields,
      column,
      detail: `Cột '${column}' đang được gán cho ${fields.length} trường (${fields
        .map((field) => FIELD_LABELS[field])
        .join(", ")}) — mỗi cột chỉ được dùng cho một trường.`,
    });
  }

  for (const field of CATALOG_CONTENT_FIELDS) {
    const column = safeMap[field];
    if (column === null || !isPriceLikeColumn(column)) continue;
    issues.push({
      code: "FIELD_MAP_PRICE_LIKE_COLUMN",
      severity: "warning",
      fields: [field],
      column,
      detail: `Cột '${column}' trông như cột giá nhưng đang được gán cho '${FIELD_LABELS[field]}' — nội dung này sẽ đi vào caption. Kiểm tra lại trước khi đăng.`,
    });
  }

  return issues;
}

/**
 * Full check against a real header row. Returns values, never throws — the
 * caller decides whether an `error` blocks (sync) or is shown (onboarding).
 */
export function validateFieldMap(
  map: CatalogFieldMap | null | undefined,
  columns: readonly string[] | null | undefined,
): readonly FieldMapIssue[] {
  const issues = [...validateFieldMapStructure(map)];
  const safeMap = makeFieldMap(map ?? undefined);
  const available = new Set(
    (Array.isArray(columns) ? columns : [])
      .filter((column): column is string => typeof column === "string")
      .map((column) => column.trim())
      .filter((column) => column.length > 0),
  );

  // No header row at all: reporting eight "cột không tồn tại" would bury the
  // real problem, which the caller already knows about.
  if (available.size === 0) return issues;

  for (const field of CATALOG_FIELDS) {
    const column = safeMap[field];
    if (column === null || available.has(column)) continue;
    issues.push({
      code: "FIELD_MAP_COLUMN_NOT_FOUND",
      severity: REQUIRED_CATALOG_FIELDS.includes(field as (typeof REQUIRED_CATALOG_FIELDS)[number])
        ? "error"
        : "warning",
      fields: [field],
      column,
      detail: `Không tìm thấy cột '${column}' (đang gán cho '${FIELD_LABELS[field]}') trong bảng tính — cột đã bị đổi tên hoặc xoá.`,
    });
  }

  return issues;
}

/** Operator-facing field names (Vietnamese) used in the messages above. */
export const FIELD_LABELS: Record<CatalogField, string> = {
  code: "Mã sản phẩm",
  name: "Tên sản phẩm",
  description: "Mô tả",
  category: "Chủng loại",
  season: "Mùa vụ",
  stock: "Tồn kho",
  note: "Lưu ý",
  colors: "Màu sắc",
};

// --- Stock policy -----------------------------------------------------------

export const STOCK_POLICY_MODES = ["numeric", "textual", "disabled"] as const;
export type StockPolicyMode = (typeof STOCK_POLICY_MODES)[number];

/** The internal company's sheet: `Tồn` is an integer or empty (docs/05 2.2). */
export interface NumericStockPolicy {
  readonly mode: "numeric";
}

/** Tenants who write "Còn hàng" / "Hết" instead of a number. */
export interface TextualStockPolicy {
  readonly mode: "textual";
  /** Values that mean "may post". Compared without case/accents/punctuation. */
  readonly inStockValues: readonly string[];
  /** Values that mean "do not post". */
  readonly outOfStockValues: readonly string[];
}

/**
 * Tenants who do not track stock on the sheet at all.
 *
 * This suspends CLAUDE.md business rule 3 for the tenant, so it is deliberately
 * awkward: the reason is REQUIRED, every decision carries `stockCheckSkipped`
 * so the UI can show it in red, and no code path may infer this mode.
 */
export interface DisabledStockPolicy {
  readonly mode: "disabled";
  /** Why the tenant is allowed to post without a stock check. Required. */
  readonly reason: string;
}

export type StockPolicy = NumericStockPolicy | TextualStockPolicy | DisabledStockPolicy;

/** What every existing tenant gets when nothing is configured. */
export const DEFAULT_STOCK_POLICY: StockPolicy = { mode: "numeric" };

export const STOCK_POLICY_ISSUE_CODES = [
  "STOCK_POLICY_MODE_INVALID",
  /** `textual` with an empty in-stock or out-of-stock list. */
  "STOCK_POLICY_VALUES_EMPTY",
  /** The same value declared as both in stock and out of stock. */
  "STOCK_POLICY_VALUE_AMBIGUOUS",
  /** `disabled` without a written reason. */
  "STOCK_POLICY_REASON_MISSING",
] as const;
export type StockPolicyIssueCode = (typeof STOCK_POLICY_ISSUE_CODES)[number];

export interface StockPolicyIssue {
  readonly code: StockPolicyIssueCode;
  readonly detail: string;
}

/** Shortest reason we accept for turning the stock gate off. */
const MIN_DISABLED_REASON_LENGTH = 10;

/** Returns values, never throws. An empty array means the policy is usable. */
export function validateStockPolicy(
  policy: StockPolicy | null | undefined,
): readonly StockPolicyIssue[] {
  // --- Edge cases first ----------------------------------------------------
  const mode = policy?.mode;
  if (typeof mode !== "string" || !STOCK_POLICY_MODES.includes(mode as StockPolicyMode)) {
    return [
      {
        code: "STOCK_POLICY_MODE_INVALID",
        detail: `Chế độ kiểm tồn không hợp lệ (${String(mode ?? "trống")}) — chỉ nhận: ${STOCK_POLICY_MODES.join(", ")}.`,
      },
    ];
  }

  if (mode === "disabled") {
    const reason = typeof (policy as DisabledStockPolicy).reason === "string"
      ? (policy as DisabledStockPolicy).reason.trim()
      : "";
    if (reason.length < MIN_DISABLED_REASON_LENGTH) {
      return [
        {
          code: "STOCK_POLICY_REASON_MISSING",
          detail:
            "Tắt kiểm tồn kho phải kèm lý do (ít nhất 10 ký tự) — lý do này được ghi vào nhật ký và hiển thị cảnh báo trên mọi bài.",
        },
      ];
    }
    return [];
  }

  if (mode === "numeric") return [];

  const textual = policy as TextualStockPolicy;
  const issues: StockPolicyIssue[] = [];
  const inStock = cleanValues(textual.inStockValues);
  const outOfStock = cleanValues(textual.outOfStockValues);

  if (inStock.length === 0 || outOfStock.length === 0) {
    issues.push({
      code: "STOCK_POLICY_VALUES_EMPTY",
      detail:
        "Chế độ tồn kho dạng chữ cần khai đủ hai danh sách: giá trị nghĩa là CÒN hàng và giá trị nghĩa là HẾT hàng.",
    });
  }

  const inKeys = new Set(inStock.map(comparisonKey));
  const ambiguous = outOfStock.filter((value) => inKeys.has(comparisonKey(value)));
  if (ambiguous.length > 0) {
    issues.push({
      code: "STOCK_POLICY_VALUE_AMBIGUOUS",
      detail: `Giá trị '${ambiguous.join("', '")}' vừa được khai là còn hàng vừa là hết hàng — sửa lại để hệ thống không phải đoán.`,
    });
  }

  return issues;
}

function cleanValues(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export const STOCK_TEXT_MATCHES = ["in_stock", "out_of_stock", "unknown"] as const;
export type StockTextMatch = (typeof STOCK_TEXT_MATCHES)[number];

/**
 * Matches a written stock cell against the tenant's vocabulary, ignoring case,
 * accents and punctuation. `unknown` is the safe answer — the caller blocks.
 */
export function matchStockText(policy: TextualStockPolicy, raw: unknown): StockTextMatch {
  const key = comparisonKey(raw);
  if (key.length === 0) return "unknown";
  // Out of stock is checked FIRST: "hết hàng" beats "hàng" if a tenant declared
  // both, same as the note rule (out of stock always wins).
  if (cleanValues(policy?.outOfStockValues).some((value) => comparisonKey(value) === key)) {
    return "out_of_stock";
  }
  if (cleanValues(policy?.inStockValues).some((value) => comparisonKey(value) === key)) {
    return "in_stock";
  }
  return "unknown";
}
