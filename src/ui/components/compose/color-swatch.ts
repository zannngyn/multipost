/**
 * The 20px dot on a colour chip (ComposeFocus template line 70).
 *
 * These hex values are NOT palette: they are what the WORD means. "HỒNG" has to
 * look pink or the chip is decoration. They are therefore the one place in
 * `compose/**` a literal colour is allowed, and they are deliberately not
 * tokens — re-theming the screen must not repaint the colours of the clothes.
 *
 * Matching rules, in order:
 *  1. the exact canonical name (`core/domain/media-file-name` CANONICAL_COLORS,
 *     which is what `availableColors` carries);
 *  2. the FIRST word, so "XANH RÊU" still reads as a blue-green rather than
 *     falling through to grey;
 *  3. no match → `null`, and the chip draws a neutral dot with the first letter
 *     instead of an invented colour. Guessing a colour we cannot name is how a
 *     "TRẮNG" chip ends up looking black.
 *
 * Keys are the same accent-insensitive key the domain uses, so a Drive spelling
 * that never reached the canonical list still lands on the right dot.
 */

/** Same normalisation as `colorKey` in core/domain/media-file-name.ts. */
export function swatchKey(value: string): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const SWATCHES: ReadonlyMap<string, string> = new Map([
  ["TRANG", "#FFFFFF"],
  ["TRANG KEM", "#F7F1E6"],
  ["TRANG TIEU", "#EFEBE4"],
  ["KEM", "#EFE2C8"],
  ["KEM NAU", "#E4D3B4"],
  ["XANH", "#BFD7EE"],
  ["XANH NHAT", "#D6E7F5"],
  ["XANH DAM", "#2C4A6B"],
  ["XANH THAN", "#26364F"],
  ["XANH DUONG", "#4C7FC0"],
  ["XANH GHI", "#A9B7BE"],
  ["XANH XAM", "#9FB0B8"],
  ["XANH BE", "#CBD5C0"],
  ["XANH REU", "#6B7A4F"],
  ["XANH LA", "#5A9E63"],
  ["HONG", "#F0B9C8"],
  ["HONG TIM", "#D8A8CC"],
  ["HONG CAM", "#F3B39C"],
  ["HONG KEM", "#F2D5CC"],
  ["HONG NUDE", "#E6BFB2"],
  ["NAU", "#8A5A3B"],
  ["NAU VANG", "#B08249"],
  ["NAU BE", "#C4A98C"],
  ["NAU REU", "#7A6B4A"],
  ["NAU HONG", "#C08F82"],
  ["DO", "#C43B33"],
  ["DEN", "#221F1C"],
  ["DEN XAM", "#4A4643"],
  ["VANG", "#F3D48A"],
  ["VANG NHAT", "#F7E7B8"],
  ["BE", "#E3D5C0"],
  ["BE CAM", "#E9C6A6"],
  ["XAM", "#B4AFA9"],
  ["XAM DAM", "#6E6963"],
  ["TIM", "#9B7BC4"],
  ["CAM", "#E58A4B"],
  ["GHI", "#C3BFB8"],
  ["NUDE", "#E0C3B2"],
  ["COM", "#CBD98F"],
  ["TIEU", "#6B655E"],
]);

/**
 * Hex for a colour name, or null when we do not know it.
 *
 * Null is a first-class answer, not a failure: the caller draws a neutral dot
 * carrying the first letter, which is honest, while a fallback colour would be
 * a quiet lie about the photos.
 */
export function colorSwatch(name: string): string | null {
  const key = swatchKey(name);
  if (key.length === 0) return null;

  const exact = SWATCHES.get(key);
  if (exact) return exact;

  // "XANH RÊU ĐẬM" → try "XANH RÊU", then "XANH".
  const words = key.split(" ");
  for (let take = words.length - 1; take >= 1; take -= 1) {
    const partial = SWATCHES.get(words.slice(0, take).join(" "));
    if (partial) return partial;
  }

  return null;
}
