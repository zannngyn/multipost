import { z } from "zod";

/**
 * Request-side contracts of the tenant data mapping (onboarding phase 1),
 * shared by `POST /api/catalog/profile` (preview) and `PUT /api/catalog/source`
 * (save). One definition, so a preview can never accept something the save
 * would refuse.
 *
 * These schemas MIRROR `core/domain/catalog-field-map.ts`. They validate the
 * SHAPE at the boundary (CLAUDE.md technical rule 2); the domain still runs
 * `validateFieldMap` / `validateStockPolicy` afterwards, and it is the domain
 * that decides whether a map is usable. Nothing here silently repairs a value.
 */

/** Longest sheet header we accept. A longer one is a paste accident. */
const MAX_COLUMN_NAME = 200;

const ColumnRefSchema = z
  .string()
  .trim()
  .max(MAX_COLUMN_NAME, "Tên cột quá dài.")
  // Empty string means "chưa map", exactly like the domain's `null`. Normalised
  // here so the usecase never has to tell the two apart.
  .transform((value) => (value.length === 0 ? null : value))
  .nullable();

/**
 * Every logical field, `string | null`, none of them optional — the exact shape
 * of the domain's `CatalogFieldMap`.
 *
 * WHY NOT `.optional()`: the parsed object is handed straight to the usecase,
 * and `app/` may not import a type from `core/` to widen it (one-way dependency
 * law, docs/07 §2 — `.dependency-cruiser` allows only `core/domain/errors`). So
 * the wire format IS the full map, and a missing key is a 400 here rather than a
 * silent `null` the caller never asked for.
 *
 * `code`/`name` are still allowed to arrive as `null`: which fields are
 * MANDATORY is a domain rule, and `validateFieldMap` answers it with a sentence
 * naming the field. A 400 from this schema could not.
 *
 * The whole-map-or-nothing shape is also what keeps "giữ nguyên ánh xạ đang
 * lưu" (key absent) apart from "không map cột nào" (every value null).
 */
export const FieldMapBodySchema = z.object({
  code: ColumnRefSchema,
  name: ColumnRefSchema,
  description: ColumnRefSchema,
  category: ColumnRefSchema,
  season: ColumnRefSchema,
  stock: ColumnRefSchema,
  note: ColumnRefSchema,
  colors: ColumnRefSchema,
  /**
   * Phase 2: the column holding a Drive link/id per row, read by the
   * `sheet-column` media profile.
   *
   * `.optional()` is the ONE exception to the whole-map-or-nothing rule above,
   * and it is deliberate: this key did not exist when phase 1 shipped, so a
   * caller that predates it would get a 400 on a map it built correctly. Absent
   * and null mean the same thing — no link column — which is exactly what
   * `makeFieldMap` in the domain does with a missing key.
   */
  mediaLink: ColumnRefSchema.optional(),
});
export type FieldMapBody = z.infer<typeof FieldMapBodySchema>;

/**
 * Mirrors `MEDIA_PROFILE_KINDS` in `core/domain/media-profile.ts`: the four
 * shapes a tenant's Drive can have. Written out instead of imported because
 * `app/` may not import `core/` outside `core/domain/errors` (docs/07 §2).
 */
export const MEDIA_PROFILE_KINDS = [
  "sheet-column",
  "folder-per-code",
  "code-in-name",
  "code-color-seq",
] as const;

/** A tenant with more declared colour names than this pasted something. */
const MAX_COLOR_NAMES = 500;

/**
 * Mirrors `ColorVocabularyConfig`. No screen edits it today; it travels through
 * this schema because the mapping form sends the stored profile back whole, and
 * stripping the key here would delete a tenant's colour vocabulary on the first
 * save of a media profile — a data loss caused by a validator, which is the
 * worst kind.
 */
const ColorVocabularyBodySchema = z.object({
  canonical: z
    .array(z.string().trim().min(1).max(MAX_COLUMN_NAME))
    .max(MAX_COLOR_NAMES)
    .optional(),
  aliases: z
    .record(z.string().trim().min(1).max(MAX_COLUMN_NAME), z.string().trim().min(1).max(MAX_COLUMN_NAME))
    .refine(
      (value) => Object.keys(value).length <= MAX_COLOR_NAMES,
      "Khai quá nhiều cách viết màu.",
    )
    .optional(),
  includeDefaults: z.boolean().optional(),
});

/**
 * Mirrors `MediaProfile` (the CONFIG). Shape only: whether the profile is
 * USABLE is still the domain's answer (`validateMediaProfile`), and it is the
 * domain that refuses an unknown alias or an empty vocabulary.
 *
 * Note what is NOT enforced here: `sheet-column` does not require `mediaLink` on
 * the same request. The link column lives in the FIELD MAP, and a request that
 * only changes the profile legitimately leaves the map alone ("vắng = giữ
 * nguyên"). Refusing it here would make the two keys inseparable forever.
 */
export const MediaProfileBodySchema = z.object({
  kind: z.enum(MEDIA_PROFILE_KINDS, { error: "Kiểu nguồn ảnh không hợp lệ." }),
  colors: ColorVocabularyBodySchema.optional(),
});
export type MediaProfileBody = z.infer<typeof MediaProfileBodySchema>;

/** Mirrors `MIN_DISABLED_REASON_LENGTH` in the domain. */
const MIN_DISABLED_REASON_LENGTH = 10;
const MAX_DISABLED_REASON_LENGTH = 500;
const MAX_STOCK_VALUES = 50;

/**
 * The `disabled` arm carries a REQUIRED reason and is refused without one.
 *
 * This is the one rule worth restating at the boundary instead of leaving to the
 * domain: turning the stock gate off suspends CLAUDE.md business rule 3 for a
 * whole tenant, the reason is what every later screen quotes in its red banner,
 * and a request that arrives without one is not a request anybody should be able
 * to make by accident.
 */
export const StockPolicyBodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("numeric") }),
  z.object({
    mode: z.literal("textual"),
    inStockValues: z
      .array(z.string().trim().min(1).max(MAX_COLUMN_NAME))
      .min(1, "Khai ít nhất một giá trị nghĩa là còn hàng.")
      .max(MAX_STOCK_VALUES),
    outOfStockValues: z
      .array(z.string().trim().min(1).max(MAX_COLUMN_NAME))
      .min(1, "Khai ít nhất một giá trị nghĩa là hết hàng.")
      .max(MAX_STOCK_VALUES),
  }),
  z.object({
    mode: z.literal("disabled"),
    reason: z
      .string()
      .trim()
      .min(
        MIN_DISABLED_REASON_LENGTH,
        `Tắt kiểm tồn kho phải kèm lý do (ít nhất ${MIN_DISABLED_REASON_LENGTH} ký tự).`,
      )
      .max(MAX_DISABLED_REASON_LENGTH, "Lý do quá dài."),
  }),
]);
export type StockPolicyBody = z.infer<typeof StockPolicyBodySchema>;
