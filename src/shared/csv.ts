/**
 * CSV reading, hand written (CLAUDE.md: no new dependency).
 * Pure text -> grid: no I/O, no layer import, so both the catalog-file adapter
 * and the sample-data fixture read a file exactly the same way.
 *
 * What real customer files do, and what this therefore handles:
 * - a delimiter that is NOT a comma: Excel writes `;` under a Vietnamese/EU
 *   locale, and Google Sheets can export tab separated. The delimiter is
 *   DETECTED and reported, never assumed (a wrong guess yields one giant
 *   column, which reads as "cột nào cũng thiếu" downstream);
 * - quoted fields containing the delimiter, `""` escaped quotes and newlines;
 * - a UTF-8 BOM (Excel "CSV UTF-8" always writes one) and UTF-16 BOMs
 *   (Excel "Unicode Text"), CRLF / CR / LF, empty cells, no trailing newline;
 * - a file that is not text at all (an .xlsx renamed) — reported by the caller
 *   through `looksBinary`, never parsed into nonsense.
 *
 * Everything that is not obviously right is reported as an ISSUE instead of
 * being fixed silently (business rule 5): the caller decides what blocks.
 */

/** Separators worth testing. Order is the tie-break order. */
export const CSV_DELIMITERS = [",", ";", "\t", "|"] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

export const DEFAULT_CSV_DELIMITER: CsvDelimiter = ",";

/** Text encodings this reader understands, all BOM-detected. */
export const CSV_ENCODINGS = ["utf-8", "utf-16le", "utf-16be"] as const;
export type CsvEncoding = (typeof CSV_ENCODINGS)[number];

export function isCsvDelimiter(value: unknown): value is CsvDelimiter {
  return typeof value === "string" && (CSV_DELIMITERS as readonly string[]).includes(value);
}

// --- Bytes -> text ----------------------------------------------------------

export interface CsvDecodeResult {
  readonly text: string;
  readonly encoding: CsvEncoding;
  readonly hadBom: boolean;
  /**
   * U+FFFD characters produced while decoding. Anything above zero means the
   * file is not UTF-8 (a Windows-1258 export, typically): the caller refuses it
   * instead of importing mojibake as product names.
   */
  readonly replacementCount: number;
}

const BOM_UTF8 = [0xef, 0xbb, 0xbf];
const BOM_UTF16LE = [0xff, 0xfe];
const BOM_UTF16BE = [0xfe, 0xff];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * True when the bytes are a container format, not text. Two signatures cover
 * every spreadsheet a customer can rename to `.csv`:
 * `PK\x03\x04` = zip = .xlsx/.ods, `\xD0\xCF\x11\xE0` = OLE = legacy .xls.
 * A NUL byte in the first KB is the general "this is binary" tell.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return true;
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return true;
  const limit = Math.min(bytes.length, 1024);
  for (let i = 0; i < limit; i += 1) {
    // UTF-16 text is full of NULs; its BOM is checked first so it never lands here.
    if (bytes[i] === 0x00) return !startsWith(bytes, BOM_UTF16LE) && !startsWith(bytes, BOM_UTF16BE);
  }
  return false;
}

/** Zip signature only — used to tell "Excel workbook" from "some binary". */
export function looksLikeZipArchive(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
}

/**
 * Decodes bytes to text, honouring a BOM. UTF-8 is the assumption when there is
 * none — the only sane default — and a decoding failure is COUNTED rather than
 * thrown, so the caller can say "file này không phải UTF-8" with a number.
 */
export function decodeCsvText(bytes: Uint8Array): CsvDecodeResult {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return { text: "", encoding: "utf-8", hadBom: false, replacementCount: 0 };
  }

  let encoding: CsvEncoding = "utf-8";
  let hadBom = false;
  let body = bytes;

  if (startsWith(bytes, BOM_UTF8)) {
    hadBom = true;
    body = bytes.subarray(BOM_UTF8.length);
  } else if (startsWith(bytes, BOM_UTF16LE)) {
    hadBom = true;
    encoding = "utf-16le";
    body = bytes.subarray(BOM_UTF16LE.length);
  } else if (startsWith(bytes, BOM_UTF16BE)) {
    hadBom = true;
    encoding = "utf-16be";
    body = bytes.subarray(BOM_UTF16BE.length);
  }

  const text = decodeWith(encoding, body);
  let replacementCount = 0;
  for (const char of text) {
    if (char === "�") replacementCount += 1;
  }
  return { text, encoding, hadBom, replacementCount };
}

/**
 * `utf-16be` needs a full-ICU runtime. Rather than depend on the build flavour,
 * fall back to swapping the byte pairs and decoding as little endian.
 */
function decodeWith(encoding: CsvEncoding, body: Uint8Array): string {
  try {
    return new TextDecoder(encoding).decode(body);
  } catch (error) {
    if (encoding !== "utf-16be") throw error;
    const swapped = new Uint8Array(body.length);
    for (let i = 0; i + 1 < body.length; i += 2) {
      swapped[i] = body[i + 1];
      swapped[i + 1] = body[i];
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
}

// --- Text -> grid -----------------------------------------------------------

export const CSV_ISSUE_CODES = [
  /** A quoted field was never closed — everything after it is one field. */
  "UNTERMINATED_QUOTE",
  /** A record has more/fewer fields than the header row. */
  "RAGGED_ROW",
  /** A `"` inside an unquoted field; kept literally, but worth saying. */
  "STRAY_QUOTE",
] as const;
export type CsvIssueCode = (typeof CSV_ISSUE_CODES)[number];

export interface CsvIssue {
  readonly code: CsvIssueCode;
  /** 1-based RECORD number (what a spreadsheet shows as the row). */
  readonly recordNumber: number;
  /** English detail for logs; the adapter writes the operator sentence. */
  readonly detail: string;
}

export interface CsvParseResult {
  readonly rows: readonly (readonly string[])[];
  readonly delimiter: CsvDelimiter;
  /** False = the delimiter was supplied by the caller, not sniffed. */
  readonly delimiterDetected: boolean;
  readonly issues: readonly CsvIssue[];
  /** All-empty records dropped from the END of the file (Excel writes them). */
  readonly trailingEmptyRows: number;
  /** All-empty records dropped BEFORE the header row. */
  readonly leadingEmptyRows: number;
  /** Delimiter taken from Excel's `sep=;` first line, when there was one. */
  readonly separatorDirective: CsvDelimiter | null;
  /**
   * Line number of `rows[0]` in the ORIGINAL file. Anything skipped above the
   * header (the `sep=` line, blank rows) is counted here so every row number
   * still points at the line the operator will open.
   */
  readonly firstRowNumber: number;
}

export interface CsvParseOptions {
  /** Skip detection and force one. Anything else than a known delimiter is ignored. */
  readonly delimiter?: string;
}

/**
 * Parses the whole text. The state machine is deliberately explicit: an "if it
 * looks like a quote, strip it" shortcut is what turns `"Áo, dài"` into two
 * products.
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): CsvParseResult {
  const forced = isCsvDelimiter(options?.delimiter) ? (options.delimiter as CsvDelimiter) : null;

  // --- Edge cases first -----------------------------------------------------
  if (typeof text !== "string" || text.length === 0) {
    return {
      rows: [],
      delimiter: forced ?? DEFAULT_CSV_DELIMITER,
      delimiterDetected: forced === null,
      issues: [],
      trailingEmptyRows: 0,
      leadingEmptyRows: 0,
      separatorDirective: null,
      firstRowNumber: 1,
    };
  }

  // Excel writes `sep=;` above the header when the file was saved on a locale
  // whose list separator is not a comma. It is an instruction, not data.
  const directive = readSeparatorDirective(text);
  const body = directive.rest;

  const delimiter = forced ?? directive.delimiter ?? detectCsvDelimiter(body).delimiter;
  const scan = scanRecords(body, delimiter);

  // Blank records above the header (a title block, an empty first line) and
  // below the last row (what Excel appends) are the writer's noise, not data.
  // Only the ENDS are trimmed: a blank line in the middle keeps its row number
  // so an operator can find it.
  let start = 0;
  while (start < scan.rows.length && isEmptyRecord(scan.rows[start])) start += 1;
  let end = scan.rows.length;
  while (end > start && isEmptyRecord(scan.rows[end - 1])) end -= 1;

  const leadingEmptyRows = start;
  const trailingEmptyRows = scan.rows.length - end;
  const rows = scan.rows.slice(start, end);
  /** Lines consumed before `rows[0]`: the directive plus the blank ones. */
  const rowOffset = directive.lineCount + leadingEmptyRows;

  const issues = [
    ...scan.issues.map((issue) => ({
      ...issue,
      recordNumber: issue.recordNumber + directive.lineCount,
    })),
    ...raggedRowIssues(rows, rowOffset),
  ];

  return {
    rows,
    delimiter,
    delimiterDetected: forced === null && directive.delimiter === null,
    issues,
    trailingEmptyRows,
    leadingEmptyRows,
    separatorDirective: directive.delimiter,
    firstRowNumber: rowOffset + 1,
  };
}

/**
 * Reads Excel's `sep=<char>` first line. Returns the rest untouched when there
 * is none — and also when the declared separator is not one this reader knows,
 * because obeying `sep=X` blindly would split a whole file on a letter.
 */
function readSeparatorDirective(text: string): {
  delimiter: CsvDelimiter | null;
  rest: string;
  lineCount: number;
} {
  const match = /^sep=(.)\r?\n/i.exec(text);
  if (!match) return { delimiter: null, rest: text, lineCount: 0 };
  const declared = match[1];
  if (!isCsvDelimiter(declared)) return { delimiter: null, rest: text, lineCount: 0 };
  return { delimiter: declared, rest: text.slice(match[0].length), lineCount: 1 };
}

export interface CsvDelimiterDetection {
  readonly delimiter: CsvDelimiter;
  /** False = nothing separated anything; the default was used. */
  readonly detected: boolean;
  /** Score per candidate, for logs and for the onboarding screen. */
  readonly scores: Readonly<Record<CsvDelimiter, number>>;
}

/** Records sampled for detection — enough to see a pattern, cheap on 5 MB. */
const DETECTION_SAMPLE_RECORDS = 20;
const DETECTION_SAMPLE_CHARS = 64 * 1024;

/**
 * Picks the delimiter that yields the most CONSISTENT table, then the widest
 * one. Consistency first is what stops a comma-in-a-quoted-cell from winning
 * over the real `;`.
 */
export function detectCsvDelimiter(text: string): CsvDelimiterDetection {
  const sample = typeof text === "string" ? text.slice(0, DETECTION_SAMPLE_CHARS) : "";
  const scores = {} as Record<CsvDelimiter, number>;
  let best: { delimiter: CsvDelimiter; score: number } | null = null;

  for (const candidate of CSV_DELIMITERS) {
    const rows = scanRecords(sample, candidate, DETECTION_SAMPLE_RECORDS).rows.filter(
      (row) => !isEmptyRecord(row),
    );
    const header = rows[0];
    if (!header || header.length < 2) {
      scores[candidate] = 0;
      continue;
    }
    const consistent = rows.filter((row) => row.length === header.length).length;
    // Consistency dominates; width only breaks ties between equally clean reads.
    const score = (consistent / rows.length) * 100 + Math.min(header.length, 50);
    scores[candidate] = Math.round(score * 100) / 100;
    if (!best || score > best.score) best = { delimiter: candidate, score };
  }

  if (!best) return { delimiter: DEFAULT_CSV_DELIMITER, detected: false, scores };
  return { delimiter: best.delimiter, detected: true, scores };
}

interface ScanResult {
  rows: string[][];
  issues: CsvIssue[];
}

/**
 * The state machine. `maxRecords` exists for delimiter detection, which must
 * not walk a 5 MB file four times.
 */
function scanRecords(text: string, delimiter: string, maxRecords = Number.POSITIVE_INFINITY): ScanResult {
  const rows: string[][] = [];
  const issues: CsvIssue[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  /** Record number where the currently open quote started. */
  let quoteOpenedAt = 0;
  let recordNumber = 1;
  /** True once a quote closed in this field: trailing junk is then unusual. */
  let quoteClosed = false;
  let sawStrayQuote = false;

  const endField = (): void => {
    row.push(field);
    field = "";
    quoteClosed = false;
  };
  const endRecord = (): void => {
    endField();
    rows.push(row);
    row = [];
    recordNumber += 1;
    sawStrayQuote = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    if (rows.length >= maxRecords) break;
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        quoteClosed = true;
        continue;
      }
      field += char;
      continue;
    }

    if (char === '"') {
      if (field.length === 0 && !quoteClosed) {
        inQuotes = true;
        quoteOpenedAt = recordNumber;
        continue;
      }
      // A quote in the middle of a bare field: keep it, say it once per record.
      if (!sawStrayQuote) {
        sawStrayQuote = true;
        issues.push({
          code: "STRAY_QUOTE",
          recordNumber,
          detail: 'A `"` appears inside an unquoted field; kept as a literal character',
        });
      }
      field += char;
      continue;
    }

    if (char === delimiter) {
      endField();
      continue;
    }

    if (char === "\r") {
      // CRLF and lone CR (old Excel for Mac) both end the record.
      if (text[i + 1] === "\n") i += 1;
      endRecord();
      continue;
    }
    if (char === "\n") {
      endRecord();
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    issues.push({
      code: "UNTERMINATED_QUOTE",
      recordNumber: quoteOpenedAt,
      detail: "A quoted field opened here was never closed before the end of the file",
    });
  }

  // A file ending with a newline must NOT produce a phantom last record.
  if (rows.length < maxRecords && (field.length > 0 || row.length > 0)) {
    row.push(field);
    rows.push(row);
  }

  return { rows, issues };
}

function isEmptyRecord(row: readonly string[] | undefined): boolean {
  if (!row) return true;
  return row.every((cell) => cell.trim().length === 0);
}

/** Rows whose width differs from the header's — reported, never padded away. */
function raggedRowIssues(rows: readonly (readonly string[])[], rowOffset: number): CsvIssue[] {
  const header = rows[0];
  if (!header) return [];
  const issues: CsvIssue[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.length === header.length || isEmptyRecord(row)) continue;
    issues.push({
      code: "RAGGED_ROW",
      recordNumber: rowOffset + index + 1,
      detail: `Row has ${row.length} field(s) while the header has ${header.length}`,
    });
  }
  return issues;
}
