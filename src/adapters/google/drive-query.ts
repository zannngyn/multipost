/**
 * Drive v3 query building. Shared by every caller of `files.list` in this
 * adapter — the picker AND the catalog sync — because two copies of an escape
 * rule are two chances for one of them to be wrong.
 * https://developers.google.com/workspace/drive/api/guides/search-files
 */

/**
 * Drive query literals are single-quoted; a value may legitimately contain a
 * quote or a backslash. Backslash FIRST, or the escape of the quote would then
 * itself be escaped.
 */
export function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
