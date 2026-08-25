import { z } from "zod";

/**
 * Contract of "Nhập tay thông tin sản phẩm" — onboarding phase 3, the bottom
 * rung: a tenant with no Google Sheet and no importable file still has to be
 * able to publish, so the operator types the product on the compose screen.
 *
 * `ui/` may not import `core/` (one-way dependency law, docs/07 §2), so this
 * MIRRORS `core/domain/manual-product.ts`. The mirror is deliberately narrow —
 * six fields and their ceilings, nothing else — and the server re-validates with
 * `ManualProductSchema`, which is a `z.strictObject`: a seventh key is a loud
 * 400, never a silent strip.
 *
 * THE TWO RULES THIS FILE ENCODES
 *
 * 1. WHITELIST (business rule 2). `MANUAL_PRODUCT_CONTENT_FIELDS` are the only
 *    four fields that may reach a prompt or a caption, and this schema has no
 *    other free-text box for a reason: an "extra notes" field would be exactly
 *    the hole through which a price reaches a caption. Do not add one.
 *
 * 2. STOCK (business rule 3). `stockRaw` is NOT required here, and that is not
 *    an oversight — it is the honest shape:
 *      - leaving it empty makes the SERVER block the post (STOCK_EMPTY), and
 *        the form says so before a single field is filled in;
 *      - the one legitimate way to post without a stock number is a tenant that
 *        declared `stockPolicy.mode = "disabled"`, and this form cannot know
 *        whether that is the case.
 *    A client-side `min(1)` would therefore lock a legitimate tenant out of a
 *    path the server allows. The warning is loud; the gate stays on the server.
 */

/** Mirrors `LIMITS` in core/domain/manual-product.ts. */
export const MANUAL_PRODUCT_LIMITS = {
  name: 200,
  description: 2000,
  category: 100,
  season: 100,
  stock: 32,
  note: 200,
} as const;

/**
 * The FOUR caption-safe fields (brief §2.2). Named as a list because two places
 * need it: the form layout, and the test that asserts nothing else was added.
 */
export const MANUAL_PRODUCT_CONTENT_FIELDS = [
  "name",
  "description",
  "category",
  "season",
] as const;

/** The two operational fields — internal, never near a caption. */
export const MANUAL_PRODUCT_OPERATIONAL_FIELDS = ["stockRaw", "noteRaw"] as const;

export const MANUAL_PRODUCT_FIELDS = [
  ...MANUAL_PRODUCT_CONTENT_FIELDS,
  ...MANUAL_PRODUCT_OPERATIONAL_FIELDS,
] as const;

export type ManualProductField = (typeof MANUAL_PRODUCT_FIELDS)[number];

/** Server issue paths land on their own box; anything else stays in the notice. */
export function isManualProductField(path: string): path is ManualProductField {
  return (MANUAL_PRODUCT_FIELDS as readonly string[]).includes(path);
}

/**
 * Form values. Every field is a plain string — `""` rather than `null` — so the
 * defaults have the SAME type as the values (core-form-architecture §dirty:
 * `null` / `""` / `undefined` are three different things and mixing them makes a
 * form dirty the moment it opens).
 */
export const ManualProductFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Nhập tên sản phẩm — caption luôn mở đầu bằng tên này.")
    .max(MANUAL_PRODUCT_LIMITS.name, `Tên sản phẩm tối đa ${MANUAL_PRODUCT_LIMITS.name} ký tự.`),
  description: z
    .string()
    .trim()
    .max(
      MANUAL_PRODUCT_LIMITS.description,
      `Mô tả tối đa ${MANUAL_PRODUCT_LIMITS.description} ký tự.`,
    ),
  category: z
    .string()
    .trim()
    .max(MANUAL_PRODUCT_LIMITS.category, `Chủng loại tối đa ${MANUAL_PRODUCT_LIMITS.category} ký tự.`),
  season: z
    .string()
    .trim()
    .max(MANUAL_PRODUCT_LIMITS.season, `Mùa vụ tối đa ${MANUAL_PRODUCT_LIMITS.season} ký tự.`),
  /** See rule 2 in the file docblock: no `min(1)` here, on purpose. */
  stockRaw: z
    .string()
    .trim()
    .max(MANUAL_PRODUCT_LIMITS.stock, `Số tồn tối đa ${MANUAL_PRODUCT_LIMITS.stock} ký tự.`),
  noteRaw: z
    .string()
    .trim()
    .max(MANUAL_PRODUCT_LIMITS.note, `Lưu ý tối đa ${MANUAL_PRODUCT_LIMITS.note} ký tự.`),
});

export type ManualProductFormValues = z.infer<typeof ManualProductFormSchema>;

/** Explicit, so a new form field cannot become a new request field by accident. */
export const EMPTY_MANUAL_PRODUCT: ManualProductFormValues = {
  name: "",
  description: "",
  category: "",
  season: "",
  stockRaw: "",
  noteRaw: "",
};

/**
 * The request body, built key by key from a literal — never `{...values}`.
 *
 * Spreading would mean that the day somebody adds a seventh box to the form,
 * the seventh key silently starts travelling to a `z.strictObject` that answers
 * 400 for the whole post. Listing the six makes the whitelist a compile-time
 * fact of this function instead of a property of whatever the form happens to
 * hold.
 *
 * Empty strings are sent as empty strings, not dropped: the server reads `""`
 * for `stockRaw` as "chưa khai số tồn" and blocks, which is exactly the outcome
 * the form warned about. Dropping the key would produce the same verdict by a
 * less obvious route, and `description: ""` becomes `null` server-side anyway.
 */
export function toManualProductPayload(values: ManualProductFormValues): {
  name: string;
  description: string;
  category: string;
  season: string;
  stockRaw: string;
  noteRaw: string;
} {
  return {
    name: values.name.trim(),
    description: values.description.trim(),
    category: values.category.trim(),
    season: values.season.trim(),
    stockRaw: values.stockRaw.trim(),
    noteRaw: values.noteRaw.trim(),
  };
}

export type ManualProductPayload = ReturnType<typeof toManualProductPayload>;

/**
 * Typed product data, BOUND to the code it was typed for.
 *
 * The binding is not bookkeeping, it is a safety rule. `code` is not one of the
 * six fields (it comes from the compose input), so a bare `ManualProductFormValues`
 * kept in state would follow the operator to the NEXT code they type — and a
 * lookup for a code that does exist in the synced catalog would arrive carrying
 * a typed product, which the server refuses as MANUAL_PRODUCT_CONFLICT. The
 * operator would read "mã này đã có sẵn trong dữ liệu đồng bộ" about a form they
 * thought they had left behind.
 */
export interface ManualProductEntry {
  /** Normalised the same way the server normalises it: trimmed, upper-case. */
  readonly productCode: string;
  readonly values: ManualProductFormValues;
}

/** `MGKVX6310` from ` mgkvx6310 `. Same shape as the server's normalisation. */
export function normalizeManualProductCode(productCode: string): string {
  return productCode.trim().toUpperCase();
}

export function manualProductEntry(
  productCode: string,
  values: ManualProductFormValues,
): ManualProductEntry {
  return { productCode: normalizeManualProductCode(productCode), values };
}

/**
 * The typed product to send with a lookup of `productCode` — or `null`, which
 * means "tra mã trong dữ liệu đã đồng bộ".
 *
 * Returns a value rather than throwing: a code that no longer matches is not an
 * error, it is an operator who moved on to another product.
 */
export function manualProductForCode(
  entry: ManualProductEntry | null,
  productCode: string,
): ManualProductFormValues | null {
  if (!entry) return null;
  if (entry.productCode.length === 0) return null;
  return entry.productCode === normalizeManualProductCode(productCode) ? entry.values : null;
}

/**
 * Identity of a typed product, for the caption-invalidation key.
 *
 * A manual post keeps the same code while its TEXT changes, so `productCode |
 * color | mediaKind | videoTarget` alone cannot tell "same post" from "same code,
 * rewritten product". Only the four caption-safe fields go in: changing the
 * stock number or the note does not change a single word of the caption, and
 * throwing away an approved caption over it would be a fake invalidation.
 */
export function manualProductCaptionKey(values: ManualProductFormValues | null): string {
  if (!values) return "";
  // U+001F (unit separator) rather than a printable one: it cannot appear in
  // a typed field, so "ab" + "c" can never collide with "a" + "bc".
  return MANUAL_PRODUCT_CONTENT_FIELDS.map((field) =>
    values[field].trim().replace(/\s+/g, " ").toLowerCase(),
  ).join("\u001f");
}
