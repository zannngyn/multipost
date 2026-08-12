import { z } from "zod";

import { tenantIdField } from "./tenant-health.schema";

/**
 * Contracts of the "Chạy hàng loạt" screen (E10.5).
 *
 * The operator pastes a column of product codes (from the Sheet) or types them
 * one per line. Everything about turning that blob into a list of codes lives
 * HERE, not in the component: it is the part with edge cases, and it is the
 * part worth unit-testing (see bulk.schema.test.ts).
 *
 * Business rule 2 (whitelist) applies to the manual caption template too: the
 * only variables it may use are `{code}` and `{name}`. There is deliberately no
 * `{price}`, `{stock}` or `{note}` placeholder — a template cannot leak what it
 * has no way to reference.
 */

/** One run = at most this many codes. Above it the operator splits the batch. */
export const MAX_BULK_CODES = 50;

const MAX_PRODUCT_CODE_LENGTH = 64;
/** Same shape as the wizard's `productCode` field — one rule, one sentence. */
const PRODUCT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// --- Parsing the pasted codes -----------------------------------------------

export interface ParsedBulkCode {
  /** Upper-cased: the server looks products up case-insensitively anyway. */
  code: string;
  /** 1-based line of the textarea, so an error can point at it. */
  line: number;
}

export interface BulkCodeIssue {
  line: number;
  /** What the operator actually typed — echoed back so the line is findable. */
  raw: string;
  message: string;
}

export interface ParsedBulkCodes {
  codes: ParsedBulkCode[];
  /** Lines that are not a usable code. Shown per line, never swallowed. */
  invalid: BulkCodeIssue[];
  /** How many repeats were dropped — silence here looks like data loss. */
  duplicates: number;
  /** Codes typed beyond MAX_BULK_CODES (kept out of `codes`). */
  overLimit: ParsedBulkCode[];
}

/**
 * Splits a paste into codes. Newlines separate rows (a Sheet column paste) and
 * commas separate codes typed on one line; the line number of the physical row
 * is kept for every token so errors can say "dòng 7".
 *
 * Duplicates are compared case-insensitively — "mgk01" and "MGK01" are the same
 * product, and posting it twice is exactly what the duplicate lock exists to
 * prevent.
 */
export function parseBulkCodes(raw: string): ParsedBulkCodes {
  const empty: ParsedBulkCodes = { codes: [], invalid: [], duplicates: 0, overLimit: [] };
  // Edge case first: a non-string (defensive — RHF can hand over undefined).
  if (typeof raw !== "string" || raw.trim().length === 0) return empty;

  const seen = new Set<string>();
  const accepted: ParsedBulkCode[] = [];
  const invalid: BulkCodeIssue[] = [];
  let duplicates = 0;

  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    for (const token of lines[index].split(",")) {
      const value = token.trim();
      if (value.length === 0) continue;

      if (value.length > MAX_PRODUCT_CODE_LENGTH) {
        invalid.push({
          line,
          raw: value,
          message: `Mã dài quá ${MAX_PRODUCT_CODE_LENGTH} ký tự — có phải bạn dán nhầm cả tên sản phẩm?`,
        });
        continue;
      }
      if (!PRODUCT_CODE_PATTERN.test(value)) {
        invalid.push({
          line,
          raw: value,
          message: "Mã chỉ gồm chữ, số và các ký tự . _ - (ví dụ: MGKVX6310).",
        });
        continue;
      }

      const code = value.toUpperCase();
      if (seen.has(code)) {
        duplicates += 1;
        continue;
      }
      seen.add(code);
      accepted.push({ code, line });
    }
  }

  return {
    codes: accepted.slice(0, MAX_BULK_CODES),
    invalid,
    duplicates,
    overLimit: accepted.slice(MAX_BULK_CODES),
  };
}

// --- The shared caption template --------------------------------------------

/** The ONLY placeholders a manual bulk caption may use (business rule 2). */
export const CAPTION_TEMPLATE_VARIABLES = ["code", "name"] as const;
export type CaptionTemplateVariable = (typeof CAPTION_TEMPLATE_VARIABLES)[number];

const PLACEHOLDER_PATTERN = /\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}/g;

export interface CaptionTemplateValues {
  code: string;
  name: string;
}

/**
 * Substitutes `{code}` / `{name}` client-side. An unknown placeholder is left
 * exactly as typed instead of being blanked: silently deleting text an operator
 * wrote is worse than showing them a literal `{gia}` they can see and fix (the
 * form warns about it before the run starts).
 */
export function renderCaptionTemplate(template: string, values: CaptionTemplateValues): string {
  if (typeof template !== "string" || template.length === 0) return "";

  const code = typeof values?.code === "string" ? values.code : "";
  const name = typeof values?.name === "string" ? values.name : "";

  return template.replace(PLACEHOLDER_PATTERN, (match, variable: string) => {
    if (variable === "code") return code;
    if (variable === "name") return name;
    return match;
  });
}

/** Placeholders outside the whitelist — reported to the operator, not stripped. */
export function findUnknownTemplateVariables(template: string): string[] {
  if (typeof template !== "string" || template.length === 0) return [];

  const allowed = new Set<string>(CAPTION_TEMPLATE_VARIABLES);
  const unknown = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    if (!allowed.has(match[1])) unknown.add(match[1]);
  }
  return [...unknown];
}

// --- The form ---------------------------------------------------------------

export const BULK_CAPTION_MODES = ["ai", "template"] as const;
export type BulkCaptionMode = (typeof BULK_CAPTION_MODES)[number];

export const BULK_CAPTION_MODE_LABELS: Record<BulkCaptionMode, string> = {
  ai: "AI viết cho từng mã",
  template: "Caption tay dùng chung một mẫu",
};

export const BulkRunFormSchema = z
  .object({
    tenantId: tenantIdField(),
    codesText: z.string().min(1, "Nhập ít nhất một mã sản phẩm."),
    captionMode: z.enum(BULK_CAPTION_MODES),
    captionTemplate: z.string(),
  })
  .superRefine((values, ctx) => {
    const parsed = parseBulkCodes(values.codesText);

    if (parsed.codes.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["codesText"],
        message: "Không đọc được mã hợp lệ nào. Mỗi dòng một mã, ví dụ: MGKVX6310.",
      });
    }
    if (parsed.invalid.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["codesText"],
        message: `Có ${parsed.invalid.length} dòng không phải mã hợp lệ — sửa hoặc xoá các dòng được đánh dấu bên dưới.`,
      });
    }
    if (parsed.overLimit.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["codesText"],
        message: `Mỗi lần chạy tối đa ${MAX_BULK_CODES} mã. Bạn đang nhập ${parsed.codes.length + parsed.overLimit.length} mã — hãy chia thành nhiều lượt.`,
      });
    }

    if (values.captionMode !== "template") return;
    if (values.captionTemplate.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["captionTemplate"],
        message: "Nhập mẫu caption dùng chung, hoặc chuyển sang để AI viết.",
      });
    }
  });

export type BulkRunFormValues = z.infer<typeof BulkRunFormSchema>;

// --- Per-row progress -------------------------------------------------------

export const BULK_ROW_STATUSES = [
  "pending",
  "composing",
  "captioning",
  "creating",
  "done",
  "skipped",
  "error",
  "cancelled",
] as const;
export type BulkRowStatus = (typeof BULK_ROW_STATUSES)[number];

export const BULK_ROW_STATUS_LABELS: Record<BulkRowStatus, string> = {
  pending: "Chờ tới lượt",
  composing: "Đang tra sản phẩm",
  captioning: "Đang lấy caption",
  creating: "Đang tạo lô",
  done: "Đã tạo lô",
  skipped: "Bỏ qua",
  error: "Lỗi",
  cancelled: "Đã dừng",
};

/** Mirrors the `BadgeTone` union of ui/components/ui/badge. */
export const BULK_ROW_STATUS_TONES: Record<
  BulkRowStatus,
  "neutral" | "success" | "warning" | "danger" | "info"
> = {
  pending: "neutral",
  composing: "info",
  captioning: "info",
  creating: "info",
  done: "success",
  // A rule said no (hết hàng, thiếu ảnh) — not a crash.
  skipped: "warning",
  error: "danger",
  cancelled: "neutral",
};

/** Business refusals from `compose-post`: skip this code, keep the run going. */
export const BULK_SKIP_ERROR_CODES: readonly string[] = [
  "OUT_OF_STOCK",
  "MEDIA_NOT_FOUND",
  "PRODUCT_NOT_FOUND",
];

export function isBulkSkipCode(code: string): boolean {
  return BULK_SKIP_ERROR_CODES.includes(code);
}
