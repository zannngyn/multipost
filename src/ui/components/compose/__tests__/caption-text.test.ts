import { describe, expect, it } from "vitest";

import {
  addHashtag,
  countHashtags,
  joinCaptionTags,
  splitCaptionTags,
} from "../caption-text";

/**
 * The caption block shows one caption in two fields. Everything here protects
 * the one property that matters: NOTHING may be lost between them, because what
 * is lost here is lost from a published post.
 *
 * Edge cases first (CLAUDE.md technical rule 1).
 */

describe("splitCaptionTags", () => {
  it("returns the whole text as body when there is no tag line", () => {
    expect(splitCaptionTags("Áo dài trắng, chất đũi mềm.")).toEqual({
      body: "Áo dài trắng, chất đũi mềm.",
      tags: "",
    });
  });

  it("survives an empty caption", () => {
    expect(splitCaptionTags("")).toEqual({ body: "", tags: "" });
  });

  it("leaves a hashtag inside a sentence where the operator put it", () => {
    const caption = "Mẫu #hot của tuần này.";
    expect(splitCaptionTags(caption)).toEqual({ body: caption, tags: "" });
  });

  it("takes the trailing tag line off the body", () => {
    expect(splitCaptionTags("Áo dài trắng.\n\n#ladyfashion #xuanhe")).toEqual({
      body: "Áo dài trắng.",
      tags: "#ladyfashion #xuanhe",
    });
  });

  it("joins several trailing tag lines into one", () => {
    expect(splitCaptionTags("Áo dài.\n\n#a #b\n#c")).toEqual({
      body: "Áo dài.",
      tags: "#a #b #c",
    });
  });

  it("handles a caption that is nothing but tags", () => {
    expect(splitCaptionTags("#a #b")).toEqual({ body: "", tags: "#a #b" });
  });

  it("ignores trailing blank lines", () => {
    expect(splitCaptionTags("Áo dài.\n\n#a\n\n")).toEqual({ body: "Áo dài.", tags: "#a" });
  });

  it("keeps Vietnamese tags whole", () => {
    expect(splitCaptionTags("Bài.\n\n#thờitrang #hè2026").tags).toBe("#thờitrang #hè2026");
  });
});

describe("joinCaptionTags", () => {
  it("returns the body alone when there are no tags", () => {
    expect(joinCaptionTags("Áo dài.", "")).toBe("Áo dài.");
  });

  it("returns the tags alone when there is no body", () => {
    expect(joinCaptionTags("", "#a #b")).toBe("#a #b");
  });

  it("puts one blank line between them", () => {
    expect(joinCaptionTags("Áo dài.", "#a")).toBe("Áo dài.\n\n#a");
  });

  it("round-trips: split then join gives the same caption back", () => {
    for (const caption of [
      "Áo dài trắng.\n\n#a #b",
      "#a #b",
      "Không có thẻ nào.",
      "Nhiều dòng\nvẫn giữ\n\n#a",
    ]) {
      const { body, tags } = splitCaptionTags(caption);
      expect(joinCaptionTags(body, tags)).toBe(caption);
    }
  });

  it("is stable: joining twice changes nothing", () => {
    const once = joinCaptionTags("Áo dài.", "#a #b");
    const { body, tags } = splitCaptionTags(once);
    expect(joinCaptionTags(body, tags)).toBe(once);
  });
});

describe("countHashtags", () => {
  it("counts none in an empty caption", () => {
    expect(countHashtags("")).toBe(0);
  });

  it("counts tags wherever they are", () => {
    expect(countHashtags("Mẫu #hot tuần này.\n\n#a #b")).toBe(3);
  });

  it("does not count a bare # followed by a space — that is not a tag", () => {
    expect(countHashtags("# tiêu đề · mục # 1")).toBe(0);
    expect(countHashtags("#tieude")).toBe(1);
  });
});

describe("addHashtag", () => {
  it("adds to an empty line", () => {
    expect(addHashtag("", "#a")).toBe("#a");
  });

  it("appends with a single space", () => {
    expect(addHashtag("#a", "#b")).toBe("#a #b");
  });

  it("refuses a duplicate, whatever the case", () => {
    expect(addHashtag("#Hè", "#hè")).toBe("#Hè");
  });

  it("ignores an empty tag instead of adding a stray space", () => {
    expect(addHashtag("#a", "   ")).toBe("#a");
  });
});
