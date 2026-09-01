import {
  CATALOG_CONTENT_FIELDS,
  CATALOG_FIELD_LABELS,
  DEFAULT_MEDIA_PROFILE_KIND,
  mediaProfileNeedsLinkColumn,
  type CatalogFieldMap,
  type CatalogProfileReport,
  type MediaProfileCandidate,
  type MediaProfileConfig,
  type MediaProfileKind,
  type MediaProfileSuggestion,
} from "@/ui/schemas/catalog-mapping.schema";

import {
  UNMAPPED_OPTION_LABEL,
  UNMAPPED_OPTION_VALUE,
  type ColumnOption,
} from "@/ui/components/onboarding/field-map-form";

/**
 * The "nguồn ảnh" half of step 3 as data: which of the four Drive layouts this
 * tenant has, which column holds a Drive link when the answer is "cột trên
 * bảng", and what is wrong with the current pair.
 *
 * Pure module (no JSX, no hooks), same contract as `field-map-form.ts`: the
 * screen renders what this returns, and every branch is testable in the node
 * environment the repo already runs.
 *
 * The checks below MIRROR the server. They are a convenience, never the gate —
 * `validateMediaProfile` in the domain refuses the same things, and the sync
 * refuses them again. What they buy is that the operator hears about it on the
 * field that is wrong instead of after a round trip.
 */

export interface MediaProfileFormState {
  readonly kind: MediaProfileKind;
  /**
   * The column holding a Drive link/id, or null.
   *
   * Kept in state even while `kind` does not read it, and sent either way. Two
   * reasons: switching layout to look at another option must not throw away a
   * column somebody picked (core-wizard: quay lui phải rẻ), and the compatibility
   * report can only SCORE the `sheet-column` candidate when it knows which
   * column to read — a tenant who cleared it would be told, wrongly, that the
   * layout does not apply to them.
   */
  readonly mediaLinkColumn: string | null;
}

/** True when this tenant declared a media profile — not "declared the default". */
export function isMediaProfileDeclared(
  stored: MediaProfileConfig | null | undefined,
): boolean {
  return stored !== null && stored !== undefined;
}

/**
 * The stored profile, back as form state; the suggestion only when nothing was
 * ever declared.
 *
 * Same rule as `stockPolicyFormFromStored` and for the same reason: `null` means
 * the tenant NEVER declared one — not "declared `code-color-seq`" — so it is the
 * one case where the screen is allowed to fill the boxes with a guess. A
 * declared profile is restored as-is, because overwriting somebody's answer with
 * our own is how a settings screen loses its credibility.
 */
export function mediaProfileFormFromStored(
  stored: MediaProfileConfig | null | undefined,
  storedMediaLinkColumn: string | null | undefined,
  suggestion: MediaProfileSuggestion | null | undefined,
): MediaProfileFormState {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  if (isMediaProfileDeclared(stored)) {
    return {
      kind: stored?.kind ?? DEFAULT_MEDIA_PROFILE_KIND,
      mediaLinkColumn: nonEmpty(storedMediaLinkColumn) ? storedMediaLinkColumn : null,
    };
  }

  // Never declared and no report to lean on (no Drive folder, Drive unreadable):
  // the default is what the tenant is running today, so it is also what the form
  // must show. Anything else would offer to "change" something to itself.
  if (!suggestion) {
    return {
      kind: DEFAULT_MEDIA_PROFILE_KIND,
      mediaLinkColumn: nonEmpty(storedMediaLinkColumn) ? storedMediaLinkColumn : null,
    };
  }

  return {
    kind: suggestion.recommended,
    // The declared column wins over the detected one even here: a stored
    // `mediaLink` was typed by a human, `suggestion.mediaLinkColumn` may be a
    // header that merely looks like links.
    mediaLinkColumn: nonEmpty(storedMediaLinkColumn)
      ? storedMediaLinkColumn
      : suggestion.mediaLinkColumn,
  };
}

/**
 * Form state -> payload.
 *
 * `colors` is carried over from the stored profile untouched. The form does not
 * edit the tenant's colour vocabulary, and rebuilding the object without it
 * would delete it as a side effect of changing where photos live — a data loss
 * nothing on screen would have announced.
 */
export function toMediaProfile(
  state: MediaProfileFormState,
  stored: MediaProfileConfig | null | undefined,
): MediaProfileConfig {
  const colors = stored?.colors;
  return colors ? { kind: state.kind, colors } : { kind: state.kind };
}

export interface MediaProfileFormIssue {
  /** Which control to put the message on. */
  readonly field: "kind" | "mediaLinkColumn";
  readonly severity: "error" | "warning";
  readonly message: string;
}

/**
 * Edge cases first: an empty column list means the sheet could not be read, and
 * the form already says so once — repeating it here would bury the real problem.
 */
export function validateMediaProfileForm(
  state: MediaProfileFormState,
  columns: readonly string[],
  fieldMap: CatalogFieldMap,
): MediaProfileFormIssue[] {
  const issues: MediaProfileFormIssue[] = [];
  const column = nonEmpty(state.mediaLinkColumn) ? state.mediaLinkColumn : null;

  if (mediaProfileNeedsLinkColumn(state.kind) && column === null) {
    issues.push({
      field: "mediaLinkColumn",
      severity: "error",
      message:
        "Chọn cột chứa link (hoặc ID) ảnh trên Drive — cách này lấy ảnh từ ô đó, không đọc tên file, nên thiếu cột thì không có ảnh nào.",
    });
  }

  if (column !== null && columns.length > 0 && !columns.includes(column)) {
    issues.push({
      field: "mediaLinkColumn",
      severity: mediaProfileNeedsLinkColumn(state.kind) ? "error" : "warning",
      message: `Không còn cột “${column}” trên bảng tính — cột đã bị đổi tên hoặc xoá. Chọn lại cột chứa link ảnh.`,
    });
  }

  /*
   * Business rule 2, the photo edition: a Drive link is not caption material.
   * The same column can legitimately be mapped twice by the server (`mediaLink`
   * is outside `CATALOG_FIELDS`, so nothing there calls it a duplicate), which
   * means this is the only place the operator can be told that the link column
   * they just chose is also the column feeding their captions.
   *
   * `warning`, not `error`: it is the operator's sheet and their choice — but it
   * must never happen silently.
   */
  if (column !== null) {
    for (const field of CATALOG_CONTENT_FIELDS) {
      if (fieldMap[field] !== column) continue;
      issues.push({
        field: "mediaLinkColumn",
        severity: "warning",
        message: `Cột “${column}” đang được gán cho “${CATALOG_FIELD_LABELS[field]}” — nội dung cột đó đi thẳng vào caption, nghĩa là link Drive sẽ hiện ra với khách. Chọn cột khác cho một trong hai.`,
      });
    }
  }

  return issues;
}

/** Only the issues that must stop a save. A warning never does. */
export function blockingMediaIssues(
  issues: readonly MediaProfileFormIssue[],
): readonly MediaProfileFormIssue[] {
  return issues.filter((issue) => issue.severity === "error");
}

/** The message to attach to the link picker, or null. Errors win over warnings. */
export function mediaIssueFor(
  issues: readonly MediaProfileFormIssue[],
  field: MediaProfileFormIssue["field"],
): MediaProfileFormIssue | null {
  return (
    issues.find((issue) => issue.field === field && issue.severity === "error") ??
    issues.find((issue) => issue.field === field) ??
    null
  );
}

// --- Reading the candidates -------------------------------------------------

/**
 * The denominator of every "X/Y mã" on this screen: the codes the SHEET
 * produced, which is what the server scored the four layouts against.
 *
 * `crossCheck` is null exactly when there is no media section to compare with,
 * so the fallback is never the number shown next to a candidate — it is there so
 * the function has no branch that returns a wrong total.
 */
export function codesInSheet(report: CatalogProfileReport): number {
  return report.crossCheck?.codesInSheet ?? report.sheet.productsParsed;
}

export function candidateFor(
  suggestion: MediaProfileSuggestion | null | undefined,
  kind: MediaProfileKind,
): MediaProfileCandidate | null {
  if (!suggestion) return null;
  return suggestion.candidates.find((candidate) => candidate.kind === kind) ?? null;
}

/**
 * The evidence line under one layout: how many product codes it would give a
 * photo to, on the sample the server actually walked.
 *
 * A layout the sample could not answer for keeps its own reason (`note`) instead
 * of a zero — "0 mã" and "chưa chấm được" are different facts, and printing the
 * first for the second is how an operator rules out the layout that was right.
 */
export function candidateSummary(
  candidate: MediaProfileCandidate | null,
  codesTotal: number,
): string {
  if (!candidate) {
    return "Chưa chấm được cách này: báo cáo chưa đọc được thư mục ảnh của đơn vị.";
  }
  if (!candidate.applicable) {
    return candidate.note ?? "Mẫu đã quét chưa trả lời được cho cách này.";
  }
  if (codesTotal <= 0) {
    return `Thử trên mẫu: lấy được ${formatCount(candidate.assets)} file, nhưng bảng tính chưa có mã nào để đối chiếu.`;
  }
  return `Thử trên mẫu: ${formatCount(candidate.codesMatched)}/${formatCount(codesTotal)} mã có ảnh (${formatCount(candidate.assets)} file dùng được).`;
}

/**
 * Options for the "cột chứa link ảnh" picker.
 *
 * Deliberately NOT `columnOptions()` from the field map: `mediaLink` lives
 * outside `CATALOG_FIELDS`, so a column already used by another field is a
 * warning here (see `validateMediaProfileForm`), not something to grey out —
 * greying it out would hide the very pairing the operator has to see.
 *
 * A stored column the sheet no longer has stays selectable and labelled, for the
 * same reason it does in the field map: dropping it would show "chưa chọn" for
 * something that IS stored.
 */
export function mediaLinkOptions(
  columns: readonly string[],
  current: string | null,
): ColumnOption[] {
  const options: ColumnOption[] = [
    { value: UNMAPPED_OPTION_VALUE, label: UNMAPPED_OPTION_LABEL },
  ];
  for (const column of columns) options.push({ value: column, label: column });

  if (nonEmpty(current) && !columns.includes(current)) {
    options.push({ value: current, label: `${current} (không còn trên bảng tính)` });
  }

  return options;
}

/** Vietnamese digit grouping, same as the report's `formatCount`. */
function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("vi-VN") : "—";
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
