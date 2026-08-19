import { describe, expect, it } from "vitest";

import { parseComposeDraftPayload, type ComposeDraftPayload } from "@/ui/schemas/post-draft.schema";

import {
  applyAlbumOrder,
  buildComposeDraftPayload,
  draftContentDiffers,
  draftContentKey,
  isDraftWorthSaving,
  pickNewerDraft,
  restoreTargetStep,
  shouldClearCaptions,
  type ComposeDraftSnapshot,
} from "./compose-draft";

/**
 * Edge cases first (CLAUDE.md technical rule 1): the ways a restore can be
 * wrong, then the round trip.
 */

function payload(overrides: Partial<ComposeDraftPayload> = {}): ComposeDraftPayload {
  return {
    step: "caption",
    composeKey: "MGKVX6310|trắng|image|-",
    productCode: "MGKVX6310",
    color: "TRẮNG",
    mediaKind: "image",
    videoTarget: "facebook_video",
    source: "drive",
    captions: { facebook: "Áo dài trắng" },
    captionOverrides: {},
    albumOrder: ["a", "b"],
    selectedChannelIds: ["fanpage-a"],
    shareCaption: true,
    schedule: { mode: "now", value: "" },
    savedAt: "2026-08-17T03:00:00.000Z",
    ...overrides,
  };
}

function snapshot(overrides: Partial<ComposeDraftSnapshot> = {}): ComposeDraftSnapshot {
  return {
    step: "caption",
    composeKey: "MGKVX6310|trắng|image|-",
    productCode: "MGKVX6310",
    color: "TRẮNG",
    mediaKind: "image",
    videoTarget: "facebook_video",
    source: "drive",
    captions: { facebook: "Áo dài trắng" },
    captionOverrides: {},
    albumOrder: ["a", "b"],
    selectedChannelIds: ["fanpage-a"],
    shareCaption: true,
    schedule: { mode: "now", value: "" },
    ...overrides,
  };
}

describe("pickNewerDraft", () => {
  it("returns null when neither copy exists", () => {
    expect(pickNewerDraft(null, null)).toBeNull();
  });

  it("uses whichever copy exists on its own", () => {
    expect(pickNewerDraft(payload(), null)).toEqual({ payload: payload(), source: "server" });
    expect(pickNewerDraft(null, payload())).toEqual({ payload: payload(), source: "local" });
  });

  it("prefers the newer savedAt, whichever side it is on", () => {
    const older = payload({ savedAt: "2026-08-17T03:00:00.000Z", productCode: "OLD" });
    const newer = payload({ savedAt: "2026-08-17T03:05:00.000Z", productCode: "NEW" });

    expect(pickNewerDraft(older, newer)?.source).toBe("local");
    expect(pickNewerDraft(newer, older)?.source).toBe("server");
  });

  it("prefers the SERVER on an exact tie — it is the source of truth", () => {
    const picked = pickNewerDraft(payload({ productCode: "SERVER" }), payload({ productCode: "LOCAL" }));
    expect(picked?.source).toBe("server");
    expect(picked?.payload.productCode).toBe("SERVER");
  });

  it("treats an unparseable savedAt as the oldest instead of throwing", () => {
    const broken = payload({ savedAt: "hôm qua" });
    expect(pickNewerDraft(broken, payload())?.source).toBe("local");
    expect(pickNewerDraft(payload(), broken)?.source).toBe("server");
  });
});

/**
 * Contract test 1: "composeKey lệch → xoá caption".
 *
 * The decision lives in a pure function precisely so it can be proven here —
 * the repo has no React testing library and none may be added (CLAUDE.md), and
 * a rule this consequential must not rest on "the code looks right".
 */
describe("shouldClearCaptions", () => {
  const KEY_A = "MGKVX6310|trắng|image|-";
  const KEY_B = "MG0AD6112|trắng|image|-";

  it("clears when the composed product changed and captions were typed", () => {
    expect(shouldClearCaptions(KEY_A, KEY_B, true)).toBe(true);
  });

  it("keeps captions when the very same post is composed again", () => {
    expect(shouldClearCaptions(KEY_A, KEY_A, true)).toBe(false);
  });

  it("keeps captions when only the media kind stays but the colour changes", () => {
    expect(shouldClearCaptions(KEY_A, "MGKVX6310|đen|image|-", true)).toBe(true);
  });

  it("does nothing when there is no caption to lose", () => {
    expect(shouldClearCaptions(KEY_A, KEY_B, false)).toBe(false);
  });

  it("does nothing on the first compose of a session (no previous identity)", () => {
    expect(shouldClearCaptions(null, KEY_B, true)).toBe(false);
    expect(shouldClearCaptions("", KEY_B, true)).toBe(false);
  });
});

/**
 * Contract test 2: "restore mà compose bị chặn → ở lại bước 1".
 */
describe("restoreTargetStep", () => {
  it("stays on step 1 when compose was refused, whatever the draft said", () => {
    for (const draftStep of ["san-pham", "caption", "xem-lai"] as const) {
      expect(restoreTargetStep({ composed: false, draftStep, everyCaption: true })).toBe(
        "san-pham",
      );
    }
  });

  it("returns to the step the draft was on when compose succeeded", () => {
    expect(restoreTargetStep({ composed: true, draftStep: "caption", everyCaption: false })).toBe(
      "caption",
    );
    expect(restoreTargetStep({ composed: true, draftStep: "xem-lai", everyCaption: true })).toBe(
      "xem-lai",
    );
  });

  it("holds step 3 back until every channel has a caption", () => {
    expect(restoreTargetStep({ composed: true, draftStep: "xem-lai", everyCaption: false })).toBe(
      "caption",
    );
  });
});

describe("applyAlbumOrder", () => {
  const media = [
    { driveFileId: "a", fileName: "1.jpg" },
    { driveFileId: "b", fileName: "2.jpg" },
    { driveFileId: "c", fileName: "3.jpg" },
  ];

  it("does nothing when the draft carried no arrangement", () => {
    expect(applyAlbumOrder(media, [])).toEqual({ album: null, notice: null });
  });

  it("does nothing when compose came back with no media", () => {
    expect(applyAlbumOrder([], ["a"])).toEqual({ album: null, notice: null });
  });

  it("drops the order — with a reason — when a saved file is gone", () => {
    const result = applyAlbumOrder(media, ["a", "zzz", "b"]);
    expect(result.album).toBeNull();
    expect(result.notice).toContain("thứ tự");
  });

  it("drops the order when Drive has a file the draft never saw", () => {
    const result = applyAlbumOrder(media, ["a", "b"]);
    expect(result.album).toBeNull();
    expect(result.notice).not.toBeNull();
  });

  it("re-applies a complete arrangement, cover first", () => {
    const result = applyAlbumOrder(media, ["c", "a", "b"]);
    expect(result.notice).toBeNull();
    expect(result.album?.map((asset) => asset.driveFileId)).toEqual(["c", "a", "b"]);
  });
});

describe("buildComposeDraftPayload", () => {
  it("produces a payload the boundary schema accepts", () => {
    const built = buildComposeDraftPayload(snapshot(), Date.parse("2026-08-17T03:00:00.000Z"));
    const parsed = parseComposeDraftPayload(built);
    expect(parsed.ok).toBe(true);
    expect(built.savedAt).toBe("2026-08-17T03:00:00.000Z");
  });

  it("copies ONLY the whitelisted fields — extra state cannot leak in", () => {
    const dirty = {
      ...snapshot(),
      // Whatever else a caller passes is not part of the snapshot contract.
      inventory: { stock: 0 },
      mediaUrl: "https://drive/x",
    } as unknown as ComposeDraftSnapshot;

    const built = buildComposeDraftPayload(dirty, Date.parse("2026-08-17T03:00:00.000Z"));
    expect(Object.keys(built)).not.toContain("inventory");
    expect(Object.keys(built)).not.toContain("mediaUrl");
    expect(parseComposeDraftPayload(built).ok).toBe(true);
  });

  it("drops blank captions, blank overrides and empty ids", () => {
    const built = buildComposeDraftPayload(
      snapshot({
        captions: { facebook: "   ", tiktok: "Có nội dung" },
        captionOverrides: { "fanpage-a": "" },
        albumOrder: ["a", ""],
        selectedChannelIds: ["", "fanpage-b"],
      }),
    );
    expect(built.captions).toEqual({ tiktok: "Có nội dung" });
    expect(built.captionOverrides).toEqual({});
    expect(built.albumOrder).toEqual(["a"]);
    expect(built.selectedChannelIds).toEqual(["fanpage-b"]);
  });

  it("falls back to the current clock when handed a broken one", () => {
    const built = buildComposeDraftPayload(snapshot(), Number.NaN);
    expect(Number.isFinite(Date.parse(built.savedAt))).toBe(true);
  });
});

describe("isDraftWorthSaving", () => {
  const blank = payload({
    productCode: "",
    composeKey: "",
    color: "",
    captions: {},
    captionOverrides: {},
    albumOrder: [],
    selectedChannelIds: [],
    schedule: { mode: "now", value: "" },
  });

  it("says no for a screen nobody has touched", () => {
    expect(isDraftWorthSaving(blank)).toBe(false);
  });

  it("says yes as soon as anything real is on screen", () => {
    expect(isDraftWorthSaving({ ...blank, productCode: "MGK01" })).toBe(true);
    expect(isDraftWorthSaving({ ...blank, captions: { facebook: "Áo" } })).toBe(true);
    expect(isDraftWorthSaving({ ...blank, captionOverrides: { a: "Áo" } })).toBe(true);
    expect(isDraftWorthSaving({ ...blank, albumOrder: ["a"] })).toBe(true);
    expect(isDraftWorthSaving({ ...blank, selectedChannelIds: ["a"] })).toBe(true);
    expect(
      isDraftWorthSaving({ ...blank, schedule: { mode: "scheduled", value: "" } }),
    ).toBe(true);
  });

  it("ignores whitespace-only captions", () => {
    expect(isDraftWorthSaving({ ...blank, captions: { facebook: "   " } })).toBe(false);
  });
});

describe("draftContentDiffers", () => {
  it("treats a first save as a change", () => {
    expect(draftContentDiffers(null, payload())).toBe(true);
  });

  it("ignores savedAt — otherwise autosave would fire forever", () => {
    const a = payload({ savedAt: "2026-08-17T03:00:00.000Z" });
    const b = payload({ savedAt: "2026-08-17T09:99:00.000Z" });
    expect(draftContentDiffers(a, b)).toBe(false);
    expect(draftContentKey(a)).toBe(draftContentKey(b));
  });

  it("sees a real edit", () => {
    expect(draftContentDiffers(payload(), payload({ productCode: "MGK-OTHER" }))).toBe(true);
    expect(draftContentDiffers(payload(), payload({ step: "xem-lai" }))).toBe(true);
    expect(
      draftContentDiffers(payload(), payload({ schedule: { mode: "scheduled", value: "x" } })),
    ).toBe(true);
  });
});
