/**
 * Splitting one caption into the two lines the ComposeFocus design shows
 * (template 96–99): the body, and the hashtag line under it in blue.
 *
 * There is still exactly ONE caption. Facebook receives a single string, the
 * draft stores a single string, and the publish payload sends a single string —
 * so the split is a VIEW, applied on the way into the two fields and undone on
 * the way out. That is the whole reason these functions are pure and tested:
 * anything that loses a character here loses it from a published post.
 *
 * The rule: the hashtag line is the trailing run of lines that contain nothing
 * but hashtags. A hashtag in the middle of a sentence stays where the operator
 * put it — it is part of the sentence, not part of the tag list.
 */

/** A word starting with `#`, in any script (Vietnamese included). */
const HASHTAG = /#[\p{L}\p{N}_]+/gu;

/** True when the line has content and every token on it is a hashtag. */
function isTagLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return trimmed.split(/\s+/).every((token) => /^#[\p{L}\p{N}_]+$/u.test(token));
}

export interface SplitCaption {
  /** Everything above the tag line, as typed. */
  readonly body: string;
  /** The tags, normalised to one space-separated line. "" when there are none. */
  readonly tags: string;
}

export function splitCaptionTags(caption: string): SplitCaption {
  const text = typeof caption === "string" ? caption : "";
  const lines = text.split("\n");

  // Trailing blank lines belong to neither field.
  let index = lines.length - 1;
  while (index >= 0 && lines[index].trim().length === 0) index -= 1;

  // The last line with content must be a tag line, or there is no tag line.
  if (index < 0 || !isTagLine(lines[index])) return { body: text, tags: "" };

  // Walk back over tag lines, and over a blank line only when another tag line
  // sits above it ("#a\n\n#b" is one tag block; "abc\n\n#b" is not).
  let firstTagLine = index;
  while (index >= 0) {
    if (isTagLine(lines[index])) {
      firstTagLine = index;
      index -= 1;
      continue;
    }
    if (lines[index].trim().length === 0 && index > 0 && isTagLine(lines[index - 1])) {
      index -= 1;
      continue;
    }
    break;
  }

  const tags = lines
    .slice(firstTagLine)
    .join(" ")
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .join(" ");

  return { body: lines.slice(0, firstTagLine).join("\n").replace(/\s+$/, ""), tags };
}

/**
 * Puts the two fields back together. One blank line between them, which is how
 * the caption came out of the writer and how it reads on Facebook.
 */
export function joinCaptionTags(body: string, tags: string): string {
  const trimmedBody = (body ?? "").replace(/\s+$/, "");
  const trimmedTags = (tags ?? "").trim();
  if (trimmedTags.length === 0) return trimmedBody;
  if (trimmedBody.length === 0) return trimmedTags;
  return `${trimmedBody}\n\n${trimmedTags}`;
}

/** How many hashtags are in the WHOLE caption — the number the counter shows. */
export function countHashtags(caption: string): number {
  return ((caption ?? "").match(HASHTAG) ?? []).length;
}

/**
 * Adds one tag to the tag line, refusing a duplicate.
 *
 * Case-insensitive, because `#Hè` and `#hè` are one tag to Facebook and two to
 * a naive comparison — and an operator clicking the same chip twice must not
 * end up with it twice in the post.
 */
export function addHashtag(tags: string, tag: string): string {
  const clean = (tag ?? "").trim();
  if (clean.length === 0) return tags;
  const existing = (tags ?? "").trim();
  const already = existing
    .split(/\s+/)
    .some((token) => token.toLowerCase() === clean.toLowerCase());
  if (already) return existing;
  return existing.length === 0 ? clean : `${existing} ${clean}`;
}
