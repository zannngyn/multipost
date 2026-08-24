import {
  CATALOG_CONTENT_FIELDS,
  CATALOG_FIELDS,
  CATALOG_FIELD_LABELS,
  isPriceLikeColumn,
  MIN_DISABLED_REASON_LENGTH,
  REQUIRED_CATALOG_FIELDS,
  type CatalogField,
  type CatalogFieldMap,
  type StockPolicy,
  type StockPolicyMode,
} from "@/ui/schemas/catalog-mapping.schema";

/**
 * The mapping form as data: what the dropdowns offer, what is wrong with the
 * current selection, and how the two halves become the payload.
 *
 * Pure module (no JSX, no hooks) so every branch is testable in the node
 * environment the repo already runs — the screen only renders what it returns.
 *
 * The checks below MIRROR `validateFieldMapStructure` in the domain. They are a
 * convenience, never the gate: the server re-validates and refuses the same
 * things. What they buy is that the operator is told before a round trip, on the
 * field that is wrong.
 */

/** `null` = "không dùng cột nào". The empty string is the <select> encoding of it. */
export const UNMAPPED_OPTION_VALUE = "";
export const UNMAPPED_OPTION_LABEL = "— Không có cột này —";

export interface ColumnOption {
  value: string;
  label: string;
  /** Set when the column is already taken by another field. */
  disabled?: boolean;
}

/**
 * Options for one field's dropdown.
 *
 * A column another field already uses is shown DISABLED rather than hidden: an
 * operator looking for "Tồn" must be able to see that it is already on "Lưu ý"
 * instead of concluding the sheet has no such column. The field's own current
 * value is of course never disabled.
 *
 * Optional fields keep the "không có cột này" entry at the top; the two required
 * fields do not offer it, because clearing them is not a choice the flow can act
 * on — `validateFieldMapValues` would immediately refuse it.
 */
export function columnOptions(
  field: CatalogField,
  columns: readonly string[],
  values: CatalogFieldMap,
): ColumnOption[] {
  const taken = new Map<string, CatalogField>();
  for (const other of CATALOG_FIELDS) {
    if (other === field) continue;
    const column = values[other];
    if (typeof column === "string" && column.length > 0) taken.set(column, other);
  }

  const options: ColumnOption[] = [];
  if (!isRequiredField(field)) {
    options.push({ value: UNMAPPED_OPTION_VALUE, label: UNMAPPED_OPTION_LABEL });
  }

  for (const column of columns) {
    const owner = taken.get(column);
    options.push(
      owner
        ? {
            value: column,
            label: `${column} (đang dùng cho “${CATALOG_FIELD_LABELS[owner]}”)`,
            disabled: true,
          }
        : { value: column, label: column },
    );
  }

  // A stored map can point at a header the sheet no longer has. Dropping it
  // silently would make the form show "chưa chọn" for a mapping that IS stored,
  // so the missing column stays selectable and `validateFieldMapValues` names it.
  const current = values[field];
  if (typeof current === "string" && current.length > 0 && !columns.includes(current)) {
    options.push({ value: current, label: `${current} (không còn trên bảng tính)` });
  }

  return options;
}

export function isRequiredField(field: CatalogField): boolean {
  return REQUIRED_CATALOG_FIELDS.includes(field);
}

export interface FieldMapFormIssue {
  /** The field to put the message on. `null` = the form as a whole. */
  readonly field: CatalogField | null;
  readonly severity: "error" | "warning";
  readonly message: string;
}

/**
 * Edge cases first: an empty column list means the sheet could not be read, and
 * saying "cột X không tồn tại" eight times would bury the one real problem.
 */
export function validateFieldMapValues(
  values: CatalogFieldMap,
  columns: readonly string[],
): FieldMapFormIssue[] {
  const issues: FieldMapFormIssue[] = [];

  for (const field of REQUIRED_CATALOG_FIELDS) {
    if (nonEmpty(values[field])) continue;
    issues.push({
      field,
      severity: "error",
      message: `Chọn cột cho “${CATALOG_FIELD_LABELS[field]}” — thiếu cột này thì không đọc được dòng nào.`,
    });
  }

  const byColumn = new Map<string, CatalogField[]>();
  for (const field of CATALOG_FIELDS) {
    const column = values[field];
    if (!nonEmpty(column)) continue;
    const list = byColumn.get(column) ?? [];
    list.push(field);
    byColumn.set(column, list);
  }
  for (const [column, fields] of byColumn) {
    if (fields.length < 2) continue;
    for (const field of fields) {
      issues.push({
        field,
        severity: "error",
        message: `Cột “${column}” đang được gán cho ${fields
          .map((other) => `“${CATALOG_FIELD_LABELS[other]}”`)
          .join(", ")} — mỗi cột chỉ dùng cho một trường.`,
      });
    }
  }

  if (columns.length > 0) {
    for (const field of CATALOG_FIELDS) {
      const column = values[field];
      if (!nonEmpty(column) || columns.includes(column)) continue;
      issues.push({
        field,
        severity: "error",
        message: `Không còn cột “${column}” trên bảng tính — cột đã bị đổi tên hoặc xoá. Chọn lại cột cho “${CATALOG_FIELD_LABELS[field]}”.`,
      });
    }
  }

  /*
   * THE LAST FENCE of business rule 2, and the reason this check is here and not
   * only on the server.
   *
   * Onboarding inverted the price protection: there is no blacklist any more, a
   * column reaches a prompt ONLY because a human mapped it onto one of the four
   * caption fields. The domain does warn (`FIELD_MAP_PRICE_LIKE_COLUMN`), but
   * that warning travels inside a compatibility report the operator may never
   * have run — so without this, "Giá bán buôn" could be dropped into “Mô tả” and
   * saved with nothing on screen having said a word.
   *
   * `warning`, not `error`: it is a guess about a header, and a tenant may
   * legitimately have a column whose name only looks like money. It must be
   * impossible for it to block a save — see `blockingIssues` at the call site.
   */
  for (const field of CATALOG_CONTENT_FIELDS) {
    const column = values[field];
    if (!nonEmpty(column) || !isPriceLikeColumn(column)) continue;
    issues.push({
      field,
      severity: "warning",
      message: `Cột “${column}” trông như cột GIÁ nhưng đang gán cho “${CATALOG_FIELD_LABELS[field]}” — nội dung cột này sẽ đi thẳng vào caption và hiện ra với khách. Kiểm tra lại trước khi lưu.`,
    });
  }

  return issues;
}

/**
 * A caption field currently pointed at a column whose HEADER looks like money.
 *
 * Business rule 2 is a hard rule and a price in a public caption is real damage,
 * so this is more than a yellow line: the form makes the operator confirm each
 * one deliberately before it will save (see `FieldMapForm`).
 *
 * It stays a CONFIRMATION rather than a refusal because the match is a guess
 * about a header — a tenant may genuinely have "Giá trị sử dụng" — and refusing
 * would lock those tenants out of mapping their own data. The gate is a speed
 * bump with a name on it, not a wall.
 */
export interface PriceLikeAssignment {
  readonly field: CatalogField;
  readonly column: string;
}

export function priceLikeCaptionAssignments(
  values: CatalogFieldMap,
): readonly PriceLikeAssignment[] {
  const found: PriceLikeAssignment[] = [];
  for (const field of CATALOG_CONTENT_FIELDS) {
    const column = values[field];
    if (!nonEmpty(column) || !isPriceLikeColumn(column)) continue;
    found.push({ field, column });
  }
  return found;
}

/**
 * Identity of WHAT was confirmed, so a tick cannot travel to a different column.
 *
 * Confirming "Giá bán" for Mô tả and then pointing Mô tả at "Giá vốn" must ask
 * again: the operator vouched for one column, not for the checkbox. Sorted, so
 * the same set in a different order is the same confirmation and does not
 * re-prompt for nothing.
 */
export function priceConfirmationKey(
  assignments: readonly PriceLikeAssignment[],
): string {
  return assignments
    .map((entry) => `${entry.field}\u001f${entry.column.trim().toLowerCase()}`)
    .sort()
    .join("\u001e");
}

/** Only the issues that must stop a save. A warning never does. */
export function blockingIssues(
  issues: readonly FieldMapFormIssue[],
): readonly FieldMapFormIssue[] {
  return issues.filter((issue) => issue.severity === "error");
}

/** The advisory half, shown as soon as a column is picked — not on submit. */
export function warningIssues(
  issues: readonly FieldMapFormIssue[],
): readonly FieldMapFormIssue[] {
  return issues.filter((issue) => issue.severity === "warning");
}

/** The message to attach to one field, or null. Errors win over warnings. */
export function issueForField(
  issues: readonly FieldMapFormIssue[],
  field: CatalogField,
): FieldMapFormIssue | null {
  return (
    issues.find((issue) => issue.field === field && issue.severity === "error") ??
    issues.find((issue) => issue.field === field) ??
    null
  );
}

// --- Stock policy -----------------------------------------------------------

/**
 * The three modes as ONE form state, so switching mode does not throw away what
 * was typed for another mode (core-wizard: quay lui phải rẻ).
 */
export interface StockPolicyFormState {
  mode: StockPolicyMode;
  /** Free text, one value per line or separated by commas. */
  inStockText: string;
  outOfStockText: string;
  disabledReason: string;
}

/**
 * What a tenant that never declared a policy starts from. The two lists are
 * EXAMPLES, pre-filled so "chế độ chữ" is not an empty pair of boxes — they are
 * only ever sent if the operator actually switches to that mode.
 */
export const DEFAULT_STOCK_POLICY_FORM: StockPolicyFormState = {
  mode: "numeric",
  inStockText: "còn hàng, còn, sẵn hàng",
  outOfStockText: "hết hàng, hết, ngừng bán",
  disabledReason: "",
};

/**
 * The stored policy, back as form state.
 *
 * `null` means the tenant NEVER declared one — not "declared numeric" — so it
 * lands on the defaults above, examples and all. A declared policy restores its
 * own values: re-typing the ten words a customer agreed on last week, or the
 * reason they wrote for turning the stock gate off, is how a settings screen
 * teaches people not to open it.
 *
 * The arms not in use keep their defaults, so switching mode to look at another
 * option and switching back does not wipe what was restored.
 */
export function stockPolicyFormFromStored(
  policy: StockPolicy | null | undefined,
): StockPolicyFormState {
  if (!policy) return DEFAULT_STOCK_POLICY_FORM;

  if (policy.mode === "textual") {
    return {
      ...DEFAULT_STOCK_POLICY_FORM,
      mode: "textual",
      inStockText: policy.inStockValues.join(", "),
      outOfStockText: policy.outOfStockValues.join(", "),
    };
  }

  if (policy.mode === "disabled") {
    return { ...DEFAULT_STOCK_POLICY_FORM, mode: "disabled", disabledReason: policy.reason };
  }

  return { ...DEFAULT_STOCK_POLICY_FORM, mode: "numeric" };
}

/** Splits "còn hàng, còn\nsẵn" into three values. Blank entries are dropped. */
export function parseValueList(text: string): string[] {
  if (typeof text !== "string") return [];
  const seen = new Set<string>();
  const values: string[] = [];
  for (const raw of text.split(/[,\n;]/)) {
    const value = raw.trim();
    if (value.length === 0) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values;
}

export type StockPolicyResult =
  | { ok: true; policy: StockPolicy }
  | { ok: false; issues: readonly string[] };

/**
 * Form state -> payload, with the domain's own refusals restated in Vietnamese.
 *
 * `disabled` is the branch this whole function exists for: it suspends business
 * rule 3 for the tenant, so it is deliberately the hardest one to submit — a
 * written reason of at least ten characters, or nothing is sent at all.
 */
export function toStockPolicy(state: StockPolicyFormState): StockPolicyResult {
  if (state.mode === "numeric") return { ok: true, policy: { mode: "numeric" } };

  if (state.mode === "disabled") {
    const reason = state.disabledReason.trim();
    if (reason.length < MIN_DISABLED_REASON_LENGTH) {
      return {
        ok: false,
        issues: [
          `Ghi lý do tắt kiểm tồn kho (ít nhất ${MIN_DISABLED_REASON_LENGTH} ký tự). Lý do này vào nhật ký và hiện kèm cảnh báo đỏ trên mọi màn hình có tồn kho.`,
        ],
      };
    }
    return { ok: true, policy: { mode: "disabled", reason } };
  }

  const inStockValues = parseValueList(state.inStockText);
  const outOfStockValues = parseValueList(state.outOfStockText);
  const issues: string[] = [];

  if (inStockValues.length === 0) {
    issues.push("Khai ít nhất một giá trị nghĩa là CÒN hàng (ví dụ: còn hàng).");
  }
  if (outOfStockValues.length === 0) {
    issues.push("Khai ít nhất một giá trị nghĩa là HẾT hàng (ví dụ: hết hàng).");
  }

  const inKeys = new Set(inStockValues.map(comparisonKey));
  const ambiguous = outOfStockValues.filter((value) => inKeys.has(comparisonKey(value)));
  if (ambiguous.length > 0) {
    issues.push(
      `Giá trị “${ambiguous.join("”, “")}” vừa được khai là còn hàng vừa là hết hàng — sửa lại để hệ thống không phải đoán.`,
    );
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, policy: { mode: "textual", inStockValues, outOfStockValues } };
}

/** Mirrors the domain's `comparisonKey`: no accents, no case, no punctuation. */
function comparisonKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function nonEmpty(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
