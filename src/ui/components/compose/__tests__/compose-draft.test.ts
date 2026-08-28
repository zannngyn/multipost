import { describe, expect, it } from "vitest";

import { parseComposeDraftPayload, type ComposeDraftPayload } from "@/ui/schemas/post-draft.schema";

import {
  applyAlbumOrder,
  buildComposeDraftPayload,
  draftContentDiffers,
  draftContentKey,
  isDraftWorthSaving,
  pickNewerDraft,
  draftProgressStep,
  shouldClearCaptions,
  type ComposeDraftSnapshot,
} from "../compose-draft";

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
    selectedChannelIds: ["page-a"],
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
    selectedChannelIds: ["page-a"],
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
 * CHANGED with the ComposeFocus redesign (PM, 20/08/2026).
 *
 * These tests used to cover `restoreTargetStep` — "restore mà compose bị chặn →
 * ở lại bước 1". There are no steps any more: the compose screen is one page,
 * so a restore has no step to navigate to and that function no longer exists.
 *
 * What it is replaced by, and why these tests still earn their place: the
 * STORED payload keeps its `step` field (`post_draft.payload`, shared with
 * core/domain/post-draft and with rows written by earlier builds), and the
 * screen now DERIVES it from progress. The rule that used to protect the
 * restore now protects the stored row: a draft with nothing composed must never
 * claim to be further along than "san-pham", and one without a full set of
 * captions must never claim "xem-lai".
 */
describe("draftProgressStep", () => {
  it("says san-pham whenever nothing is composed, however many captions exist", () => {
    expect(draftProgressStep({ composed: false, everyCaption: true })).toBe("san-pham");
    expect(draftProgressStep({ composed: false, everyCaption: false })).toBe("san-pham");
  });

  it("says caption once a post is composed but a channel is still empty", () => {
    expect(draftProgressStep({ composed: true, everyCaption: false })).toBe("caption");
  });

  it("only says xem-lai when every channel has a caption", () => {
    expect(draftProgressStep({ composed: true, everyCaption: true })).toBe("xem-lai");
  });

  it("always produces a value the stored payload accepts", () => {
    for (const composed of [true, false]) {
      for (const everyCaption of [true, false]) {
        const stored = parseComposeDraftPayload(
          payload({ step: draftProgressStep({ composed, everyCaption }) }),
        );
        expect(stored.ok).toBe(true);
      }
    }
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
        captionOverrides: { "page-a": "" },
        albumOrder: ["a", ""],
        selectedChannelIds: ["", "page-b"],
      }),
    );
    expect(built.captions).toEqual({ tiktok: "Có nội dung" });
    expect(built.captionOverrides).toEqual({});
    expect(built.albumOrder).toEqual(["a"]);
    expect(built.selectedChannelIds).toEqual(["page-b"]);
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
