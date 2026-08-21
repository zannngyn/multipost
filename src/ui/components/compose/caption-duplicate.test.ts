import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MAX_SHARED_WORD_RUN,
  findDuplicateCaptions,
  findSharedWordRun,
  toCompareWords,
} from "./caption-duplicate";

/**
 * D1 in the browser. The measure MUST match `core/domain/caption.ts` — a
 * warning the server disagrees with is worse than no warning: either it cries
 * wolf, or it stays quiet right up until the post is blocked.
 */

/** Nine words — one more than the threshold, so it is a violation. */
const NINE = "váy hoa nhí dáng suông chất đũi mềm mát";
/** Eight words — exactly at the threshold, which is still allowed. */
const EIGHT = "váy hoa nhí dáng suông chất đũi mềm";

describe("toCompareWords", () => {
  it("splits on punctuation and lowercases, like the server", () => {
    expect(toCompareWords("Váy hoa, nhí — đẹp!")).toEqual(["váy", "hoa", "nhí", "đẹp"]);
  });

  it("keeps digits: a repeated model number is still a repeat", () => {
    expect(toCompareWords("mã MR0SQ6114")).toEqual(["mã", "mr0sq6114"]);
  });

  it("survives an empty string", () => {
    expect(toCompareWords("")).toEqual([]);
  });
});

describe("findSharedWordRun", () => {
  it("is null for two short captions — nothing can share nine words", () => {
    expect(findSharedWordRun("Váy đẹp", "Váy đẹp")).toBeNull();
  });

  it("allows a run of exactly the threshold", () => {
    expect(findSharedWordRun(`A ${EIGHT} B`, `C ${EIGHT} D`)).toBeNull();
  });

  it("flags a run of more than the threshold", () => {
    expect(findSharedWordRun(`Mở đầu ${NINE} kết`, `Khác hẳn ${NINE} rồi`)).toBe(NINE);
  });

  it("ignores punctuation and case when comparing", () => {
    expect(findSharedWordRun(NINE.toUpperCase(), `${NINE}!`)).toBe(NINE);
  });

  it("refuses to flag everything when handed a nonsense threshold", () => {
    expect(findSharedWordRun(NINE, NINE, 0)).toBeNull();
  });

  it("uses the same threshold constant the server does", () => {
    expect(MAX_SHARED_WORD_RUN).toBe(8);
  });
});

describe("findDuplicateCaptions", () => {
  it("finds nothing among captions that differ", () => {
    expect(
      findDuplicateCaptions([
        { channelId: "lady", text: "Váy hoa nhí dáng suông, chất đũi mềm mát cả ngày" },
        { channelId: "camilla", text: "Set sơ mi kẻ phối quần ống rộng, lên dáng cực tôn" },
      ]),
    ).toEqual({});
  });

  it("skips empty captions — “chưa có caption” is a different problem", () => {
    expect(
      findDuplicateCaptions([
        { channelId: "lady", text: NINE },
        { channelId: "camilla", text: "   " },
      ]),
    ).toEqual({});
  });

  it("flags BOTH sides of a duplicate pair", () => {
    const overlaps = findDuplicateCaptions([
      { channelId: "lady", text: `Mở đầu ${NINE} kết` },
      { channelId: "camilla", text: `Khác ${NINE} rồi` },
    ]);
    expect(overlaps.lady).toEqual({ otherChannelId: "camilla", run: NINE });
    expect(overlaps.camilla).toEqual({ otherChannelId: "lady", run: NINE });
  });

  it("leaves the innocent channel alone", () => {
    const overlaps = findDuplicateCaptions([
      { channelId: "lady", text: `Mở đầu ${NINE} kết` },
      { channelId: "camilla", text: `Khác ${NINE} rồi` },
      { channelId: "devis", text: "Một bài hoàn toàn khác, không trùng chữ nào cả đâu nhé" },
    ]);
    expect(Object.keys(overlaps).sort()).toEqual(["camilla", "lady"]);
  });

  it("names one concrete neighbour per channel, not a list", () => {
    const overlaps = findDuplicateCaptions([
      { channelId: "a", text: `Một ${NINE}` },
      { channelId: "b", text: `Hai ${NINE}` },
      { channelId: "c", text: `Ba ${NINE}` },
    ]);
    expect(Object.keys(overlaps).sort()).toEqual(["a", "b", "c"]);
    expect(overlaps.a.otherChannelId).toBe("b");
  });

  it("does not flag a channel against itself", () => {
    expect(findDuplicateCaptions([{ channelId: "lady", text: NINE }])).toEqual({});
  });
});

/**
 * The mirror, guarded.
 *
 * `ui/` may not import `core/` (docs/07 §2), so this module re-states the rule.
 * A copy nobody checks is a copy that drifts — so the test READS the core file
 * as text and fails the day the server's threshold moves without this one.
 */
describe("the browser's D1 mirrors the server's", () => {
  it("uses the same threshold as core/domain/caption.ts", () => {
    const core = readFileSync(
      fileURLToPath(new URL("../../../core/domain/caption.ts", import.meta.url)),
      "utf8",
    );
    const match = /export const MAX_SHARED_WORD_RUN = (\d+);/.exec(core);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(MAX_SHARED_WORD_RUN);
  });
});
