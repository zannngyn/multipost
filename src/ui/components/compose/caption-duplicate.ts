/**
 * D1, checked in the browser: two captions of the same post must not share a
 * run of more than eight consecutive words.
 *
 * MIRRORS `core/domain/caption.ts` (`MAX_SHARED_WORD_RUN`, `toWords`,
 * `findSharedWordRun`) word for word. `ui/` may not import `core/` (docs/07 §2)
 * — the same intentional mirroring as `ui/schemas/compose.schema.ts`. If the
 * threshold moves there, it moves here, and the tests on both sides say so.
 *
 * // PENDING(D1) — threshold provisional until PM decides the real measure.
 *
 * THIS IS AN EARLY WARNING, NOT A GATE. The server's validator is what refuses
 * a caption at publish time; running the same measure here means the operator
 * finds out while the "Viết lại" button is still in front of them, instead of
 * finding out from a blocked post job. Nothing here blocks anything.
 */

/** Mirrors `MAX_SHARED_WORD_RUN` in core/domain/caption.ts. */
export const MAX_SHARED_WORD_RUN = 8;

/** Mirrors `normalizeForCompare` + `toWords`: lowercase, Unicode-aware split. */
export function toCompareWords(value: string): string[] {
  return (value ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/**
 * The offending run shared by two captions, or null when they are different
 * enough. Same n-gram method as the server, so both sides agree on the verdict.
 */
export function findSharedWordRun(
  left: string,
  right: string,
  maxRun: number = MAX_SHARED_WORD_RUN,
): string | null {
  // Guard: a non-positive threshold would flag every pair.
  if (maxRun < 1) return null;

  const runLength = maxRun + 1;
  const leftWords = toCompareWords(left);
  const rightWords = toCompareWords(right);
  if (leftWords.length < runLength || rightWords.length < runLength) return null;

  const seen = new Set<string>();
  for (let index = 0; index + runLength <= leftWords.length; index += 1) {
    seen.add(leftWords.slice(index, index + runLength).join(" "));
  }
  for (let index = 0; index + runLength <= rightWords.length; index += 1) {
    const gram = rightWords.slice(index, index + runLength).join(" ");
    if (seen.has(gram)) return gram;
  }
  return null;
}

export interface CaptionOverlap {
  /** The other channel this one repeats. */
  readonly otherChannelId: string;
  /** The words they share, quoted back to the operator. */
  readonly run: string;
}

/**
 * Every channel whose caption repeats another channel's, with the run they
 * share — what the tabs draw a warning from after a fan-out.
 *
 * Both sides of a pair are reported: an operator looking at tab B must be told
 * B is a duplicate, not only be told so on tab A. Each channel keeps the FIRST
 * overlap found; naming one concrete neighbour is what makes the warning
 * actionable, and listing all of them would just be noise on a five-page post.
 *
 * Empty captions are skipped — "chưa có caption" is a different problem, and
 * the action bar already names those channels.
 */
export function findDuplicateCaptions(
  entries: readonly { channelId: string; text: string }[],
  maxRun: number = MAX_SHARED_WORD_RUN,
): Record<string, CaptionOverlap> {
  const usable = entries.filter((entry) => entry.text.trim().length > 0);
  const overlaps: Record<string, CaptionOverlap> = {};

  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const run = findSharedWordRun(usable[i].text, usable[j].text, maxRun);
      if (!run) continue;
      if (!overlaps[usable[i].channelId]) {
        overlaps[usable[i].channelId] = { otherChannelId: usable[j].channelId, run };
      }
      if (!overlaps[usable[j].channelId]) {
        overlaps[usable[j].channelId] = { otherChannelId: usable[i].channelId, run };
      }
    }
  }

  return overlaps;
}
