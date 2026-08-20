import { describe, expect, it } from "vitest";

import {
  channelCaptionState,
  inheritedCaptionChannelIds,
  missingCaptionChannelIds,
  overridesThatDifferFromBase,
  resolveCaption,
  sameTarget,
  seedOverridesFromBase,
  SHARED_TARGET,
  type CaptionSources,
} from "./caption-targets";

/**
 * "Mỗi kênh một caption" (brief §7.2). These tests protect the answer to one
 * question: what text is about to be published to THIS Fanpage? A wrong answer
 * is a wrong post, so the edge cases come first.
 */

function sources(overrides: Partial<CaptionSources> = {}): CaptionSources {
  return {
    shareCaption: false,
    base: "Caption chung",
    overrides: {},
    ...overrides,
  };
}

describe("resolveCaption", () => {
  it("gives every channel the shared caption while “dùng chung” is on", () => {
    const state = sources({ shareCaption: true, overrides: { lady: "Riêng của Lady" } });
    expect(resolveCaption(state, "lady")).toBe("Caption chung");
  });

  it("gives a channel its own text when it has one", () => {
    const state = sources({ overrides: { lady: "Riêng của Lady" } });
    expect(resolveCaption(state, "lady")).toBe("Riêng của Lady");
  });

  it("falls back to the shared caption for a channel nobody wrote for", () => {
    // The fallback is why a ticked channel can never be silently captionless.
    expect(resolveCaption(sources(), "camilla")).toBe("Caption chung");
  });

  it("treats a whitespace-only override as no text at all", () => {
    const state = sources({ overrides: { lady: "   " } });
    expect(resolveCaption(state, "lady")).toBe("Caption chung");
  });

  it("answers empty when there is neither an override nor a shared caption", () => {
    expect(resolveCaption(sources({ base: "" }), "lady")).toBe("");
  });
});

describe("channelCaptionState", () => {
  it("is empty when nothing anywhere would fill this channel", () => {
    expect(channelCaptionState(sources({ base: "" }), "lady")).toBe("empty");
  });

  it("is inherited when it would publish the shared caption", () => {
    expect(channelCaptionState(sources(), "lady")).toBe("inherited");
  });

  it("is own once the channel has its own text", () => {
    const state = sources({ overrides: { lady: "Riêng" } });
    expect(channelCaptionState(state, "lady")).toBe("own");
  });

  it("is inherited for every channel while “dùng chung” is on", () => {
    const state = sources({ shareCaption: true, overrides: { lady: "Riêng" } });
    expect(channelCaptionState(state, "lady")).toBe("inherited");
  });

  it("is own when the channel has text and the shared caption is empty", () => {
    const state = sources({ base: "", overrides: { lady: "Riêng" } });
    expect(channelCaptionState(state, "lady")).toBe("own");
  });
});

describe("missingCaptionChannelIds", () => {
  const selected = ["lady", "camilla"];

  it("finds nothing while a shared caption covers everyone", () => {
    expect(missingCaptionChannelIds(sources(), selected)).toEqual([]);
  });

  it("names the channel that has no text of its own and no shared one", () => {
    const state = sources({ base: "", overrides: { lady: "Riêng" } });
    expect(missingCaptionChannelIds(state, selected)).toEqual(["camilla"]);
  });

  it("names every channel when there is no caption at all", () => {
    expect(missingCaptionChannelIds(sources({ base: "" }), selected)).toEqual(selected);
  });

  it("ignores channels that are not ticked", () => {
    expect(missingCaptionChannelIds(sources({ base: "" }), [])).toEqual([]);
  });
});

describe("inheritedCaptionChannelIds", () => {
  it("is empty in “dùng chung” — there is nothing to warn about", () => {
    const state = sources({ shareCaption: true });
    expect(inheritedCaptionChannelIds(state, ["lady", "camilla"])).toEqual([]);
  });

  it("names the channels still repeating the shared caption", () => {
    const state = sources({ overrides: { lady: "Riêng" } });
    expect(inheritedCaptionChannelIds(state, ["lady", "camilla"])).toEqual(["camilla"]);
  });
});

describe("seedOverridesFromBase", () => {
  it("gives every ticked channel the caption that was on screen", () => {
    const next = seedOverridesFromBase({}, ["lady", "camilla"], "Caption chung");
    expect(next).toEqual({ lady: "Caption chung", camilla: "Caption chung" });
  });

  it("never overwrites a channel that already has its own text", () => {
    const next = seedOverridesFromBase({ lady: "Riêng" }, ["lady", "camilla"], "Caption chung");
    expect(next.lady).toBe("Riêng");
    expect(next.camilla).toBe("Caption chung");
  });

  it("seeds nothing from an empty caption — five empty boxes is not a seed", () => {
    expect(seedOverridesFromBase({}, ["lady"], "   ")).toEqual({});
  });

  it("does not mutate the record it was given", () => {
    const before = { lady: "Riêng" };
    seedOverridesFromBase(before, ["camilla"], "Caption chung");
    expect(before).toEqual({ lady: "Riêng" });
  });
});

describe("overridesThatDifferFromBase", () => {
  it("finds nothing to lose when no channel was edited", () => {
    expect(overridesThatDifferFromBase(sources(), ["lady"])).toEqual([]);
  });

  it("finds nothing when the override is a copy of the shared caption", () => {
    const state = sources({ overrides: { lady: "Caption chung" } });
    expect(overridesThatDifferFromBase(state, ["lady"])).toEqual([]);
  });

  it("names the channels whose own text would be destroyed", () => {
    const state = sources({ overrides: { lady: "Riêng", camilla: "Khác nữa" } });
    expect(overridesThatDifferFromBase(state, ["lady", "camilla"])).toEqual(["lady", "camilla"]);
  });
});

describe("sameTarget", () => {
  it("is false when nothing has been asked for yet", () => {
    expect(sameTarget(undefined, SHARED_TARGET)).toBe(false);
  });

  it("matches the shared target with itself", () => {
    expect(sameTarget(SHARED_TARGET, SHARED_TARGET)).toBe(true);
  });

  it("matches one channel only with itself", () => {
    const lady = { kind: "channel", channelId: "lady" } as const;
    expect(sameTarget(lady, lady)).toBe(true);
    expect(sameTarget(lady, { kind: "channel", channelId: "camilla" })).toBe(false);
    expect(sameTarget(lady, SHARED_TARGET)).toBe(false);
  });
});
