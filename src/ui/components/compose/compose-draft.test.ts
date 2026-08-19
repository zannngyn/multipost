import { describe, expect, it } from "vitest";

import { parseComposeDraftPayload, type ComposeDraftPayload } from "@/ui/schemas/post-draft.schema";

import {
  applyAlbumOrder,
  buildComposeDraftPayload,
  captionForChannel,
  DROPPED_OVERRIDES_NOTICE,
  droppedOverridesNotice,
  captionsOwnerAfterCompose,
  captionTextStillOwned,
  draftContentDiffers,
  draftContentKey,
  draftRetryAction,
  EMPTY_OWNED_CAPTIONS,
  isDraftWorthSaving,
  needsSecondDiscard,
  ownedCaptionText,
  pickNewerDraft,
  restorableDraftCaptions,
  restoreTargetStep,
  saveAftermath,
  shouldClearCaptions,
  UNOWNED_DRAFT_CAPTIONS_NOTICE,
  withCaptionOverride,
  type ComposeDraftSnapshot,
  type OwnedCaptionText,
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
 * Contract test 1b: WHO the captions on screen belong to.
 *
 * `shouldClearCaptions` can only protect the operator if its first argument is
 * right, and the answer is not "what was composed last" — a refused compose
 * empties steps 2 and 3 while leaving the caption fields untouched. The
 * regression below is the sequence that used to put a caption written for one
 * product under another one.
 */
describe("captionsOwnerAfterCompose", () => {
  const KEY_A = "MGKVX6310|trắng|image|-";
  const KEY_B = "MG0AD6112|trắng|image|-";

  it("hands the captions to the post that was just composed", () => {
    expect(captionsOwnerAfterCompose(null, { ok: true, key: KEY_A })).toBe(KEY_A);
    expect(captionsOwnerAfterCompose(KEY_A, { ok: true, key: KEY_B })).toBe(KEY_B);
  });

  it("KEEPS the owner when compose is refused — the captions are still in the form", () => {
    expect(captionsOwnerAfterCompose(KEY_A, { ok: false })).toBe(KEY_A);
  });

  it("has nothing to keep when no caption belonged to anything yet", () => {
    expect(captionsOwnerAfterCompose(null, { ok: false })).toBeNull();
  });

  it("REGRESSION: compose A bị chặn → tra B → caption của A bị xoá", () => {
    // 1. A draft of product A is restored: the captions in the form are A's.
    let owner = captionsOwnerAfterCompose(null, { ok: true, key: KEY_A });
    expect(owner).toBe(KEY_A);

    // 2. Composing A is refused (hết hàng). Steps 2 and 3 become unreachable,
    //    but the caption fields still hold the text written for A.
    owner = captionsOwnerAfterCompose(owner, { ok: false });
    expect(owner).toBe(KEY_A);

    // 3. The operator now types code B and looks it up. Forgetting the owner at
    //    step 2 made this answer FALSE — and A's caption stayed under B, one
    //    approval away from being published as B.
    expect(shouldClearCaptions(owner, KEY_B, true)).toBe(true);

    // 4. Once B is composed the (now empty) fields belong to B.
    expect(captionsOwnerAfterCompose(owner, { ok: true, key: KEY_B })).toBe(KEY_B);
  });

  it("REGRESSION: the same sequence KEEPS the captions when A is looked up again", () => {
    const owner = captionsOwnerAfterCompose(
      captionsOwnerAfterCompose(null, { ok: true, key: KEY_A }),
      { ok: false },
    );
    expect(shouldClearCaptions(owner, KEY_A, true)).toBe(false);
  });
});

/**
 * Contract test 1c: a save that answers "đã lưu" after the operator deleted the
 * draft. Aborting the request does not stop a handler the server already
 * started, so the row can come back behind the DELETE.
 */
describe("needsSecondDiscard", () => {
  it("does nothing for a save that belongs to the current screen", () => {
    expect(needsSecondDiscard({ staleGeneration: false, storedSinceDiscard: false })).toBe(false);
    expect(needsSecondDiscard({ staleGeneration: false, storedSinceDiscard: true })).toBe(false);
  });

  it("deletes again when a pre-discard save resurrected the row", () => {
    expect(needsSecondDiscard({ staleGeneration: true, storedSinceDiscard: false })).toBe(true);
  });

  it("leaves the row alone once newer content has been stored over it", () => {
    // One row per (tenant, owner, kind): the newer save already overwrote the
    // resurrected content, so deleting now would destroy live work.
    expect(needsSecondDiscard({ staleGeneration: true, storedSinceDiscard: true })).toBe(false);
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

const KEY_A = "MGK-A|trắng|image|-";
const KEY_B = "MGK-B|đen|image|-";

describe("captionTextStillOwned", () => {
  it("refuses text with no owner — an absent owner is not a match", () => {
    expect(captionTextStillOwned(null, null)).toBe(false);
    expect(captionTextStillOwned(null, KEY_A)).toBe(false);
  });

  it("refuses an EMPTY owner, which is what the leaking build wrote", () => {
    expect(captionTextStillOwned("", "")).toBe(false);
    expect(captionTextStillOwned("", KEY_A)).toBe(false);
  });

  it("keeps text under the very key it was typed for", () => {
    expect(captionTextStillOwned(KEY_A, KEY_A)).toBe(true);
    expect(captionTextStillOwned(KEY_A, KEY_B)).toBe(false);
  });
});

describe("ownedCaptionText", () => {
  const typedForA: OwnedCaptionText = { ownerKey: KEY_A, byChannel: { "fanpage-x": "Của mã A" } };

  it("drops overrides the moment another product is composed", () => {
    expect(ownedCaptionText(typedForA, KEY_B)).toEqual({ ownerKey: KEY_B, byChannel: {} });
  });

  it("drops overrides when nothing is composed any more", () => {
    expect(ownedCaptionText(typedForA, null)).toEqual({ ownerKey: null, byChannel: {} });
  });

  it("drops overrides restored from a draft that recorded no owner", () => {
    const unowned: OwnedCaptionText = { ownerKey: "", byChannel: { "fanpage-x": "Vô chủ" } };
    expect(ownedCaptionText(unowned, KEY_A).byChannel).toEqual({});
  });

  it("keeps them under their own key", () => {
    expect(ownedCaptionText(typedForA, KEY_A)).toBe(typedForA);
  });

  /**
   * The publish hook calls this DURING RENDER and writes the result back into
   * its own state. A new object for an unchanged value would loop forever.
   */
  it("returns the same object when nothing has to change, and settles in one step", () => {
    expect(ownedCaptionText(EMPTY_OWNED_CAPTIONS, null)).toBe(EMPTY_OWNED_CAPTIONS);

    const once = ownedCaptionText(typedForA, KEY_B);
    expect(ownedCaptionText(once, KEY_B)).toBe(once);
  });
});

describe("withCaptionOverride", () => {
  it("stamps the edit with the product on screen", () => {
    const next = withCaptionOverride(EMPTY_OWNED_CAPTIONS, KEY_A, "fanpage-x", "Bản riêng A");
    expect(next).toEqual({ ownerKey: KEY_A, byChannel: { "fanpage-x": "Bản riêng A" } });
  });

  it("does not let an edit under B carry A's other channels along", () => {
    const forA = withCaptionOverride(EMPTY_OWNED_CAPTIONS, KEY_A, "fanpage-x", "Bản riêng A");
    const forB = withCaptionOverride(forA, KEY_B, "fanpage-y", "Bản riêng B");

    expect(forB.byChannel).toEqual({ "fanpage-y": "Bản riêng B" });
    expect(forB.ownerKey).toBe(KEY_B);
  });
});

/**
 * THE gate: the value handed to `createBatch`. Every case here is a caption that
 * must NOT be able to reach Facebook under the wrong product.
 */
describe("captionForChannel", () => {
  const overridesForA: OwnedCaptionText = {
    ownerKey: KEY_A,
    byChannel: { "fanpage-x": "Áo dài TRẮNG mã A" },
  };

  it("refuses an override typed for another product, even with sharing off", () => {
    expect(
      captionForChannel({
        channelId: "fanpage-x",
        baseCaption: "Áo dài ĐEN mã B",
        shareCaption: false,
        overrides: overridesForA,
        currentKey: KEY_B,
      }),
    ).toBe("Áo dài ĐEN mã B");
  });

  it("refuses an override when nothing is composed", () => {
    expect(
      captionForChannel({
        channelId: "fanpage-x",
        baseCaption: "",
        shareCaption: false,
        overrides: overridesForA,
        currentKey: null,
      }),
    ).toBe("");
  });

  it("uses the override under its own product", () => {
    expect(
      captionForChannel({
        channelId: "fanpage-x",
        baseCaption: "Áo dài TRẮNG mã A",
        shareCaption: false,
        overrides: overridesForA,
        currentKey: KEY_A,
      }),
    ).toBe("Áo dài TRẮNG mã A");
  });

  it("ignores overrides entirely while sharing is on", () => {
    expect(
      captionForChannel({
        channelId: "fanpage-x",
        baseCaption: "  Caption đã duyệt  ",
        shareCaption: true,
        overrides: overridesForA,
        currentKey: KEY_A,
      }),
    ).toBe("Caption đã duyệt");
  });

  it("returns empty for a box the operator cleared, so submit reports it missing", () => {
    expect(
      captionForChannel({
        channelId: "fanpage-x",
        baseCaption: "Caption đã duyệt",
        shareCaption: false,
        overrides: { ownerKey: KEY_A, byChannel: { "fanpage-x": "   " } },
        currentKey: KEY_A,
      }),
    ).toBe("");
  });

  it("falls back to the approved caption for a channel never edited", () => {
    expect(
      captionForChannel({
        channelId: "fanpage-y",
        baseCaption: "Caption đã duyệt",
        shareCaption: false,
        overrides: overridesForA,
        currentKey: KEY_A,
      }),
    ).toBe("Caption đã duyệt");
  });
});

describe("restorableDraftCaptions", () => {
  it("drops captions a draft records no owner for, and says so", () => {
    const result = restorableDraftCaptions({
      composeKey: "",
      captions: { facebook: "Caption của mã cũ" },
      captionOverrides: { "fanpage-x": "Bản riêng của mã cũ" },
    });

    expect(result.ownerKey).toBeNull();
    expect(result.captions).toEqual({});
    expect(result.captionOverrides).toEqual({});
    expect(result.notice).toBe(UNOWNED_DRAFT_CAPTIONS_NOTICE);
  });

  it("says nothing when an ownerless draft had no captions to drop", () => {
    const result = restorableDraftCaptions({
      composeKey: "   ",
      captions: {},
      captionOverrides: {},
    });
    expect(result.notice).toBeNull();
    expect(result.ownerKey).toBeNull();
  });

  it("keeps an owned draft whole", () => {
    const result = restorableDraftCaptions({
      composeKey: KEY_A,
      captions: { facebook: "Caption A", tiktok: "   " },
      captionOverrides: { "fanpage-x": "Bản riêng A" },
    });

    expect(result.ownerKey).toBe(KEY_A);
    // Blank entries are not content the operator chose.
    expect(result.captions).toEqual({ facebook: "Caption A" });
    expect(result.captionOverrides).toEqual({ "fanpage-x": "Bản riêng A" });
    expect(result.notice).toBeNull();
  });
});

describe("droppedOverridesNotice", () => {
  const overrides = { "fanpage-x": "Bản riêng mã A" };

  it("says nothing when the draft carried no per-channel edit", () => {
    expect(
      droppedOverridesNotice({ overrides: {}, draftOwnerKey: KEY_A, currentKey: KEY_B }),
    ).toBeNull();
  });

  it("says nothing while the edits are still under their own product", () => {
    expect(
      droppedOverridesNotice({ overrides, draftOwnerKey: KEY_A, currentKey: KEY_A }),
    ).toBeNull();
  });

  it("announces the drop when another product was composed", () => {
    expect(
      droppedOverridesNotice({ overrides, draftOwnerKey: KEY_A, currentKey: KEY_B }),
    ).toBe(DROPPED_OVERRIDES_NOTICE);
  });

  it("announces the drop when nothing is composed at all", () => {
    expect(
      droppedOverridesNotice({ overrides, draftOwnerKey: KEY_A, currentKey: null }),
    ).toBe(DROPPED_OVERRIDES_NOTICE);
  });
});

describe("saveAftermath", () => {
  it("treats an ABORTED save from a discarded generation as a possible row", () => {
    // "Xoá nháp" aborts the PUT, so it REJECTS. The handler on the server may
    // still have committed behind the DELETE.
    expect(
      saveAftermath({
        settlement: { outcome: "failed", aborted: true },
        staleGeneration: true,
      }),
    ).toEqual({ applyToScreen: false, reportError: false, resurrectedRow: true });
  });

  it("treats a FAILED save from a discarded generation the same way", () => {
    expect(
      saveAftermath({
        settlement: { outcome: "failed", aborted: false },
        staleGeneration: true,
      }).resurrectedRow,
    ).toBe(true);
  });

  it("treats a save that answered 2xx after the discard as a resurrection", () => {
    expect(
      saveAftermath({ settlement: { outcome: "saved" }, staleGeneration: true }),
    ).toEqual({ applyToScreen: false, reportError: false, resurrectedRow: true });
  });

  it("never reports a stale save on screen — that draft is gone", () => {
    expect(
      saveAftermath({ settlement: { outcome: "failed", aborted: false }, staleGeneration: true })
        .reportError,
    ).toBe(false);
  });

  it("applies a save the screen still wants", () => {
    expect(saveAftermath({ settlement: { outcome: "saved" }, staleGeneration: false })).toEqual({
      applyToScreen: true,
      reportError: false,
      resurrectedRow: false,
    });
  });

  it("reports a real failure, and stays quiet about our own abort", () => {
    expect(
      saveAftermath({ settlement: { outcome: "failed", aborted: false }, staleGeneration: false })
        .reportError,
    ).toBe(true);
    expect(
      saveAftermath({ settlement: { outcome: "failed", aborted: true }, staleGeneration: false })
        .reportError,
    ).toBe(false);
  });

  /** The two rules meet here: this is the pair that fires the second DELETE. */
  it("feeds needsSecondDiscard: an aborted stale save with nothing stored since", () => {
    const aftermath = saveAftermath({
      settlement: { outcome: "failed", aborted: true },
      staleGeneration: true,
    });
    expect(
      needsSecondDiscard({
        staleGeneration: aftermath.resurrectedRow,
        storedSinceDiscard: false,
      }),
    ).toBe(true);
  });
});

describe("draftRetryAction", () => {
  it("does nothing when there is no failure on screen", () => {
    expect(draftRetryAction({ phase: "saved", errorAction: "discard" })).toBe("none");
    expect(draftRetryAction({ phase: "idle", errorAction: "save" })).toBe("none");
  });

  it("repeats the DELETE after a failed delete — never a save", () => {
    expect(draftRetryAction({ phase: "error", errorAction: "discard" })).toBe("discard");
  });

  it("repeats the save after a failed save", () => {
    expect(draftRetryAction({ phase: "error", errorAction: "save" })).toBe("save");
  });
});
