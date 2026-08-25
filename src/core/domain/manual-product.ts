/**
 * Manual product (onboarding phase 3) — the absolute bottom rung: a tenant with
 * no Google Sheet AND no importable file still has to be able to post, so the
 * operator types the product on the compose screen.
 *
 * THREE THINGS THIS FILE EXISTS TO GUARANTEE:
 *
 * 1. Whitelist (business rule 2). The schema is STRICT: exactly the four
 *    caption fields plus the two operational ones. An extra key is a loud
 *    rejection, not a silent strip — a typed product must not be a hole through
 *    which a price reaches a prompt.
 * 2. Stock (business rule 3). A manual product carries `stockRaw`/`noteRaw`
 *    exactly like a synced row and is judged by the SAME decision table. There
 *    is no "manual products skip the gate" branch anywhere: leaving the stock
 *    field empty produces STOCK_EMPTY and blocks, which is what an operator who
 *    does not know their stock deserves to see. The only legitimate way to post
 *    without a stock number stays the tenant-level `stockPolicy.disabled`, which
 *    is written down, reasoned and flagged on every post.
 * 3. Provenance. `origin: "manual"` travels with the product into the database
 *    and into every log line, so "where did this post's data come from?" has an
 *    answer months later.
 */

import { z } from "zod";

import { AppError } from "./errors";
import { normalizeProductCode } from "./media-file-name";
import type { Product } from "./product";

/** Longest values accepted from a form. Generous, but not unbounded. */
const LIMITS = {
  name: 200,
  description: 2000,
  category: 100,
  season: 100,
  stock: 32,
  note: 200,
} as const;

/**
 * Exactly the fields an operator may type. `code` is not here: it comes from
 * the compose input, which is also what the media lookup and the duplicate lock
 * key on — two places to type a code is one place to mistype it.
 */
export const ManualProductSchema = z.strictObject({
  name: z.string().trim().min(1, "Nhập tên sản phẩm.").max(LIMITS.name, "Tên sản phẩm quá dài."),
  description: z.string().trim().max(LIMITS.description, "Mô tả quá dài.").nullish(),
  category: z.string().trim().max(LIMITS.category, "Chủng loại quá dài.").nullish(),
  season: z.string().trim().max(LIMITS.season, "Mùa vụ quá dài.").nullish(),
  /**
   * What the operator declares as stock, verbatim — a number for a `numeric`
   * tenant, one of the declared words for a `textual` one. Read by the same
   * `evaluateInventory` as a sheet cell, including "empty means blocked".
   */
  stockRaw: z.string().trim().max(LIMITS.stock, "Số tồn quá dài.").nullish(),
  /** The `Lưu ý` equivalent. "HẾT HÀNG" here blocks, as it does on a sheet. */
  noteRaw: z.string().trim().max(LIMITS.note, "Lưu ý quá dài.").nullish(),
});

export type ManualProductInput = z.input<typeof ManualProductSchema>;

/**
 * Validates the typed fields and builds a Product carrying `origin: "manual"`.
 * Throws AppError('INVALID_INPUT') — the same verdict any other malformed
 * compose call gets, with the field issues in the context for the API layer.
 */
export function buildManualProduct(productCode: string, input: unknown): Product {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  const code = normalizeProductCode(typeof productCode === "string" ? productCode : "");
  if (!/^[A-Z0-9-]{4,20}$/.test(code)) {
    throw new AppError("INVALID_INPUT", {
      message: `Manual product refused: '${String(productCode)}' is not a usable product code`,
      userMessage:
        "Mã sản phẩm chỉ nhận 4-20 ký tự chữ HOA, số hoặc '-' — sửa lại mã rồi thử lại.",
      context: { product_code: String(productCode ?? ""), reason: "MANUAL_PRODUCT_CODE_INVALID" },
    });
  }

  const parsed = ManualProductSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    }));
    throw new AppError("INVALID_INPUT", {
      message: "Manual product refused by the schema",
      // An unknown key is the interesting case: it means somebody tried to send
      // a field the caption whitelist never approved.
      userMessage: `Thông tin sản phẩm nhập tay chưa hợp lệ: ${issues
        .map((issue) => `${issue.path} — ${issue.message}`)
        .join("; ")}`,
      context: { product_code: code, reason: "MANUAL_PRODUCT_INVALID", issues },
    });
  }

  const value = parsed.data;
  return {
    content: {
      code,
      name: value.name,
      description: emptyToNull(value.description),
      category: emptyToNull(value.category),
      season: emptyToNull(value.season),
    },
    operational: {
      stockRaw: value.stockRaw ?? "",
      noteRaw: value.noteRaw ?? "",
      // Colours come from the files attached to the post, never from a text box.
      colorsRaw: "",
    },
    hasConflict: false,
    // No sheet row produced this one — that is exactly what `origin` records.
    sourceRows: [],
    origin: "manual",
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
