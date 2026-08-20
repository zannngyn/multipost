/**
 * Caption tone — the CLOSED vocabulary of the "tông giọng" dropdown (compose
 * step 2), shared by every layer (docs/07 §2: `shared/` is pure, imports no
 * layer, does no I/O). Same reason as `operator-access.ts`: the route's zod
 * enum (app), the prompt builder (core) and the dropdown (ui) must use ONE list,
 * and the app layer may not import `core/ai/*`.
 *
 * WHY AN ENUM AND NOT A FREE-TEXT FIELD (ADR-001 + business rule 2): a caller
 * that could send arbitrary text would be writing part of the prompt. Here the
 * client sends a KEY; the sentence the model actually reads is fixed in this
 * file, server-side, and cannot be influenced from outside.
 */

export const CAPTION_TONES = [
  "mac-dinh",
  "thoi-trang-he",
  "sang-trong",
  "than-thien",
  "sale-manh",
] as const;

export type CaptionTone = (typeof CAPTION_TONES)[number];

/** No tone chosen = today's behaviour, byte-for-byte. */
export const DEFAULT_CAPTION_TONE: CaptionTone = "mac-dinh";

/**
 * The exact sentence appended to the prompt for each tone. `mac-dinh` maps to
 * the empty string on purpose: the default must add NOTHING, so a caption
 * generated without a tone is identical to one generated before this feature.
 *
 * `sale-manh` names the ban on numbers itself. Validation stages 3 and 4 would
 * reject a price or a "-50%" anyway, but a tone that pushes the model toward
 * them would just burn escalations; the cheapest place to prevent that is the
 * instruction.
 */
export const CAPTION_TONE_INSTRUCTIONS: Readonly<Record<CaptionTone, string>> = {
  "mac-dinh": "",
  "thoi-trang-he": "Giọng tươi sáng, gợi cảm giác mùa hè, năng động.",
  "sang-trong": "Giọng sang trọng, tinh tế, nhịp câu chậm, dùng từ chỉn chu.",
  "than-thien": "Giọng thân thiện, gần gũi, như đang trò chuyện với khách quen.",
  "sale-manh":
    "Giọng thúc đẩy mua ngay, nhấn mạnh ưu đãi và sự khan hiếm — TUYỆT ĐỐI không nêu con số giá, phần trăm giảm hay bất kỳ con số nào không có trong dữ liệu sản phẩm.",
};

/** Vietnamese labels for the dropdown. Kept beside the keys so they cannot drift. */
export const CAPTION_TONE_LABELS: Readonly<Record<CaptionTone, string>> = {
  "mac-dinh": "Mặc định",
  "thoi-trang-he": "Thời trang hè",
  "sang-trong": "Sang trọng",
  "than-thien": "Thân thiện",
  "sale-manh": "Sale mạnh",
};

export function isCaptionTone(value: unknown): value is CaptionTone {
  return typeof value === "string" && (CAPTION_TONES as readonly string[]).includes(value);
}

/**
 * The sentence for a tone, or "" when there is nothing to add (default tone,
 * absent, or — defensively — a value that is not a tone at all).
 *
 * Returning "" for garbage is NOT a silent fallback: callers that receive the
 * tone from outside validate it first (the route with zod, the usecase with
 * `isCaptionTone`) and refuse an unknown value with INVALID_INPUT. This function
 * is the last line and simply refuses to put unknown text into a prompt.
 */
export function captionToneInstruction(tone: unknown): string {
  if (!isCaptionTone(tone)) return "";
  return CAPTION_TONE_INSTRUCTIONS[tone];
}
