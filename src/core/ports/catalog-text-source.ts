/**
 * CatalogTextSource (onboarding phase 3) — "where the product TEXT comes from",
 * with a Google tab and an uploaded CSV as the two implementations.
 * Types only, no runtime import (docs/07 section 2).
 *
 * WHY: phase 1 made a foreign SHEET readable, phase 2 made foreign PHOTOS
 * readable. A customer who does not use Google Workspace at all still had no
 * way in. This port is the bottom rung: a tenant uploads their price list as a
 * CSV and everything downstream — field map, stock policy, parser, sync — keeps
 * working, because every implementation answers with the SAME
 * `CatalogSnapshot` (columns / duplicateColumns / rows keyed by column name).
 *
 * Contract for implementers:
 * - `canRead` answers "is this ref mine at all?" (a sheet ref is not the file
 *   adapter's business and vice versa). It must not throw: a caller may ask
 *   every source. A ref it accepts but cannot USE fails in `readCatalog`, with
 *   a Vietnamese message that says what to do about it.
 * - Nothing is guessed in silence. Whatever had to be inferred (the delimiter,
 *   the encoding, the tab) is reported in `format`, and every deviation
 *   (ragged rows, dropped blank lines, duplicate headers) in `notices` — an
 *   operator must be able to see how their file was understood.
 * - Data problems are NOTICES; a source that cannot be read at all is an
 *   AppError with `tenant_id` in its context — `SHEET_ERROR` for a spreadsheet,
 *   `INVALID_INPUT` + a `reason` for an uploaded file (see the adapter).
 * - Bytes are validated at the adapter (size cap, binary sniff, encoding)
 *   BEFORE anything is parsed: an uploaded file is external data (technical
 *   rule 2).
 *
 * SCOPE (PM decision, 24/08/2026): CSV is the ONLY uploaded format. Reading an
 * .xlsx would mean a new dependency and that was refused, so the file adapter
 * must instead RECOGNISE a workbook and tell the operator how to export a CSV.
 * The port stays format-agnostic because the two live implementations (a Google
 * tab and an uploaded file) must be interchangeable for the field map — not
 * because a third one is planned.
 */

import type { CatalogRow, CatalogSnapshot } from "@/core/domain/catalog-snapshot";
import type { TenantId } from "@/core/domain/tenant-context";

export type { CatalogRow, CatalogSnapshot };

/** A tab of a Google Spreadsheet — the phase 1/2 source. */
export interface CatalogSheetRef {
  readonly kind: "google_sheet";
  readonly spreadsheetId: string;
  /** Tab name, e.g. "Mẫu 2026". */
  readonly sheetName: string;
}

/**
 * A CSV file the tenant handed us. Bytes rather than a storage handle: the
 * caller (upload route or blob store) already has them, and keeping I/O out of
 * the ref is what lets `core` describe this at all.
 */
export interface CatalogFileRef {
  readonly kind: "file";
  /** Original name — diagnostics + format hint. Never trusted on its own. */
  readonly fileName: string;
  /** Declared MIME type; null when the client did not say. Also just a hint. */
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
  /**
   * Operator override for a text file, e.g. ";" when detection got it wrong.
   * Absent = detect and REPORT what was detected.
   */
  readonly delimiter?: string;
  /** Kept for diagnostics when the file came out of a named tab. Unused by CSV. */
  readonly sheetName?: string | null;
}

export type CatalogSourceRef = CatalogSheetRef | CatalogFileRef;

export interface ReadCatalogTextInput {
  readonly tenantId: TenantId;
  readonly ref: CatalogSourceRef;
}

/** Every deviation an implementation may report. */
export const CATALOG_READ_NOTICE_CODES = [
  /** Header repeated; only the first column is read. */
  "DUPLICATE_COLUMN",
  /** Rows whose width differs from the header's. */
  "RAGGED_ROW",
  /** A quoted cell was never closed — the tail of the file is one cell. */
  "UNTERMINATED_QUOTE",
  /** `"` inside an unquoted cell, kept literally. */
  "STRAY_QUOTE",
  /** All-empty rows removed from the end of the file. */
  "TRAILING_EMPTY_ROWS",
  /** Blank rows skipped BEFORE the header row (Excel title blocks). */
  "LEADING_EMPTY_ROWS",
  /** Excel's `sep=;` directive line was honoured and dropped. */
  "SEPARATOR_DIRECTIVE",
  /** The delimiter was inferred rather than declared. */
  "DELIMITER_DETECTED",
  /** No header row could be read. */
  "NO_HEADER_ROW",
] as const;
export type CatalogReadNoticeCode = (typeof CATALOG_READ_NOTICE_CODES)[number];

export interface CatalogReadNotice {
  readonly code: CatalogReadNoticeCode;
  /** How many times it happened (1 for one-off notices). */
  readonly count: number;
  /** Up to a few row numbers / column names, so the operator can go look. */
  readonly examples: readonly string[];
  /** Sentence for the operator — Vietnamese (CLAUDE.md rule 6). */
  readonly detail: string;
}

/** How the bytes/tab were understood. Shown, never assumed. */
export interface CatalogReadFormat {
  /** Implementation id, e.g. "google-sheet", "csv-file". */
  readonly source: string;
  /** Field separator for a text file; null for a spreadsheet. */
  readonly delimiter: string | null;
  /** Text encoding for a file; null for a spreadsheet. */
  readonly encoding: string | null;
  /** True when delimiter/encoding were INFERRED from the bytes. */
  readonly detected: boolean;
}

export interface CatalogTextResult {
  readonly snapshot: CatalogSnapshot;
  readonly format: CatalogReadFormat;
  readonly notices: readonly CatalogReadNotice[];
}

export interface CatalogTextSource {
  /** Stable id used in logs and in `CatalogReadFormat.source`. */
  readonly id: string;
  /** True when this implementation can read that ref. Must not throw. */
  canRead(ref: CatalogSourceRef): boolean;
  readCatalog(input: ReadCatalogTextInput): Promise<CatalogTextResult>;
}
