import { describe, expect, it } from "vitest";

import {
  captionForChannel,
  captionsOwnerAfterCompose,
  DROPPED_OVERRIDES_NOTICE,
  droppedOverridesNotice,
  EMPTY_OWNED_CAPTIONS,
  ownedCaptionText,
  restorableDraftCaptions,
  shouldClearCaptions,
  UNOWNED_DRAFT_CAPTIONS_NOTICE,
  withCaptionOverride,
  type OwnedCaptionText,
} from "./compose-draft";

/**
 * WHERE THE RULES ARE CALLED, not just what they say.
 *
 * The three caption leaks fixed here were never a wrong rule — `shouldClearCaptions`
 * has been right all along. They were a rule that some call site did not consult:
 * `usePublishForm` kept its per-channel overrides outside the ownership check
 * entirely, and `restoreDraft` re-filled the caption fields before deciding
 * whether the draft had an owner at all. A unit test of the rule passes happily
 * through every one of those bugs.
 *
 * So this file re-plays the WIRING. `ComposeScreen` below is a hand-written
 * stand-in for the two hooks, and every line of it mirrors one line of theirs:
 *
 *   compose()         → useComposeWizard, `compose.onSuccess` / `onError`
 *   restore()         → useComposeWizard `restoreDraft` + useComposeDraft's
 *                       `publishRef.current.restore(...)` right after it
 *   typeOverride()    → usePublishForm `setCaptionOverride`
 *   settle()          → usePublishForm's render-time `ownedCaptionText` prune
 *   publish()         → usePublishForm `submit`, the loop that builds
 *                       `captionByChannel` for `createBatch`
 *
 * It is not a browser and it does not prove React re-renders. What it does prove
 * is that this ORDER of calls, with these arguments, cannot hand a caption
 * written for one product to a post of another one. There is no product row in
 * the local DB yet, so the same walk through a real browser is still unrun.
 */

const KEY_A = "MGK-A|trắng|image|-";
const KEY_B = "MGK-B|đen|image|-";
const BASE_CHANNEL = "facebook";

class ComposeScreen {
  /** `captionsOwnerRef` in useComposeWizard. */
  private captionsOwner: string | null = null;
  /** `form.captions` — the approved captions of step 2. */
  private captions: Record<string, string> = {};
  /** `overrideState` in usePublishForm. */
  private overrides: OwnedCaptionText = EMPTY_OWNED_CAPTIONS;

  /** usePublishForm's render-time prune, run after anything that can move the key. */
  private settle(): void {
    this.overrides = ownedCaptionText(this.overrides, this.captionsOwner);
  }

  /** Step 1's action. `key === null` = compose refused (hết hàng, thiếu ảnh…). */
  compose(key: string | null): void {
    if (key === null) {
      this.captionsOwner = captionsOwnerAfterCompose(this.captionsOwner, { ok: false });
      this.settle();
      return;
    }
    const hadCaptions = Object.values(this.captions).some((text) => text.trim().length > 0);
    if (shouldClearCaptions(this.captionsOwner, key, hadCaptions)) this.captions = {};
    this.captionsOwner = captionsOwnerAfterCompose(this.captionsOwner, { ok: true, key });
    this.settle();
  }

  /** Step 2 — "viết lại" or a manual edit. */
  typeCaption(text: string): void {
    this.captions = { ...this.captions, [BASE_CHANNEL]: text };
  }

  /** Step 3 — "dùng chung caption" off, one channel edited by hand. */
  typeOverride(channelId: string, text: string): void {
    this.overrides = withCaptionOverride(this.overrides, this.captionsOwner, channelId, text);
  }

  /**
   * A draft coming back.
   *
   * `composedKey` is what the RE-RUN compose answered: null when it was refused,
   * another key when the operator's own product has changed under the draft.
   *
   * `draft.productCode` is not decoration. `restoreDraft` returns EARLY when it
   * is blank (a draft saved on a half-typed step 1) and never composes at all —
   * the branch this simulation could not express before, and the branch a real
   * leak was hiding in. The order below mirrors the real one exactly: the
   * caption fields and their owner are written in ONE step, above the early
   * return, so both exits leave the same invariant behind.
   */
  restore(
    draft: {
      productCode: string;
      composeKey: string;
      captions: Record<string, string>;
      captionOverrides: Record<string, string>;
    },
    composedKey: string | null,
  ): string[] {
    const notices: string[] = [];
    const restorable = restorableDraftCaptions(draft);

    // useComposeWizard `applyCaptions(restorable.captions, restorable.ownerKey)`.
    this.captions = { ...restorable.captions };
    this.captionsOwner = restorable.ownerKey;
    if (restorable.notice !== null) notices.push(restorable.notice);

    const composedHere = draft.productCode.trim().length > 0;
    if (composedHere) this.compose(composedKey);

    // useComposeDraft `publishRef.current.restore({...})`, then the render prune.
    this.overrides = {
      ownerKey: restorable.ownerKey,
      byChannel: { ...restorable.captionOverrides },
    };
    this.settle();

    // `finish()` — runs on EVERY exit, early return included.
    const dropped = droppedOverridesNotice({
      overrides: restorable.captionOverrides,
      draftOwnerKey: restorable.ownerKey,
      currentKey: this.captionsOwner,
    });
    if (dropped !== null) notices.push(dropped);
    return notices;
  }

  /** `composeKey` of the next autosave — useComposeDraft's `wizard.captionsKey ?? ""`. */
  storedComposeKey(): string {
    return this.captionsOwner ?? "";
  }

  /** What `submit` would hand to `createBatch`. */
  publish(channelIds: readonly string[], shareCaption: boolean): Record<string, string> {
    const baseCaption = (this.captions[BASE_CHANNEL] ?? "").trim();
    const captionByChannel: Record<string, string> = {};
    for (const channelId of channelIds) {
      captionByChannel[channelId] = captionForChannel({
        channelId,
        baseCaption,
        shareCaption,
        overrides: this.overrides,
        currentKey: this.captionsOwner,
      });
    }
    return captionByChannel;
  }

  /** What autosave would store — the draft must not carry a stale override either. */
  storedOverrides(): Record<string, string> {
    return { ...this.overrides.byChannel };
  }
}

describe("caption ownership, as the screen actually calls it", () => {
  it("does not publish mã A's per-channel override under mã B", () => {
    const screen = new ComposeScreen();

    // 1. Compose A, approve a caption, edit one channel by hand.
    screen.compose(KEY_A);
    screen.typeCaption("Áo dài TRẮNG mã A");
    screen.typeOverride("fanpage-x", "Bản riêng cho fanpage X — mã A");

    // 2. Back to step 1, another code, look it up.
    screen.compose(KEY_B);
    // 3. Write B's caption and publish with sharing OFF.
    screen.typeCaption("Áo dài ĐEN mã B");

    const published = screen.publish(["fanpage-x", "fanpage-y"], false);
    expect(published["fanpage-x"]).toBe("Áo dài ĐEN mã B");
    expect(published["fanpage-y"]).toBe("Áo dài ĐEN mã B");
    expect(screen.storedOverrides()).toEqual({});
  });

  it("still publishes the override the operator wrote for THIS product", () => {
    const screen = new ComposeScreen();
    screen.compose(KEY_A);
    screen.typeCaption("Áo dài TRẮNG mã A");
    screen.typeOverride("fanpage-x", "Bản riêng cho fanpage X — mã A");

    expect(screen.publish(["fanpage-x", "fanpage-y"], false)).toEqual({
      "fanpage-x": "Bản riêng cho fanpage X — mã A",
      "fanpage-y": "Áo dài TRẮNG mã A",
    });
  });

  it("keeps the override when the NEXT lookup is refused — nothing new was composed", () => {
    const screen = new ComposeScreen();
    screen.compose(KEY_A);
    screen.typeCaption("Áo dài TRẮNG mã A");
    screen.typeOverride("fanpage-x", "Bản riêng cho fanpage X — mã A");

    // Hết hàng: step 2 and 3 are emptied, but what is on screen still belongs
    // to mã A, so the operator's work is not thrown away.
    screen.compose(null);

    expect(screen.publish(["fanpage-x"], false)).toEqual({
      "fanpage-x": "Bản riêng cho fanpage X — mã A",
    });
  });

  it("drops a restored override when compose came back with another product", () => {
    const screen = new ComposeScreen();
    const notices = screen.restore(
      {
        productCode: "MGK-A",
        composeKey: KEY_A,
        captions: { [BASE_CHANNEL]: "Áo dài TRẮNG mã A" },
        captionOverrides: { "fanpage-x": "Bản riêng cho fanpage X — mã A" },
      },
      // The operator had already changed the code before the draft landed.
      KEY_B,
    );
    screen.typeCaption("Áo dài ĐEN mã B");

    expect(screen.publish(["fanpage-x"], false)).toEqual({ "fanpage-x": "Áo dài ĐEN mã B" });
    expect(screen.storedOverrides()).toEqual({});
    // Dropped, and SAID — the operator opened step 3 expecting their own text.
    expect(notices).toContain(DROPPED_OVERRIDES_NOTICE);
  });

  it("restores an override untouched when the same product composes again", () => {
    const screen = new ComposeScreen();
    const notices = screen.restore(
      {
        productCode: "MGK-A",
        composeKey: KEY_A,
        captions: { [BASE_CHANNEL]: "Áo dài TRẮNG mã A" },
        captionOverrides: { "fanpage-x": "Bản riêng cho fanpage X — mã A" },
      },
      KEY_A,
    );

    expect(notices).toEqual([]);
    expect(screen.publish(["fanpage-x"], false)).toEqual({
      "fanpage-x": "Bản riêng cho fanpage X — mã A",
    });
  });

  /**
   * REGRESSION — FAIL-4. A draft saved after the operator emptied the product
   * code box: `restoreDraft` returns early and never composes. The owner used to
   * be stamped BELOW that return, so mã A's caption came back owned by nobody.
   */
  describe("a draft saved with the product code cleared", () => {
    const draft = {
      productCode: "",
      composeKey: KEY_A,
      captions: { [BASE_CHANNEL]: "Áo dài TRẮNG mã A" },
      captionOverrides: { "fanpage-x": "Bản riêng cho fanpage X — mã A" },
    };

    it("brings the caption back still owned by mã A", () => {
      const screen = new ComposeScreen();
      const notices = screen.restore(draft, null);

      // Nothing was composed, so nothing was dropped and nothing is announced.
      expect(notices).toEqual([]);
      expect(screen.storedComposeKey()).toBe(KEY_A);
    });

    it("refuses that caption under the NEXT code the operator looks up", () => {
      const screen = new ComposeScreen();
      screen.restore(draft, null);

      // The operator types mã B and looks it up — the leak's second half.
      screen.compose(KEY_B);

      expect(screen.publish(["fanpage-x"], true)).toEqual({ "fanpage-x": "" });
      expect(screen.publish(["fanpage-x"], false)).toEqual({ "fanpage-x": "" });
      expect(screen.storedOverrides()).toEqual({});
    });

    it("does not overwrite an owned draft with an empty composeKey", () => {
      const screen = new ComposeScreen();
      screen.restore(draft, null);
      // The other half of the same bug: the autosave right after the restore
      // used to stamp `composeKey: ""` over a draft that HAD an owner, so the
      // next reload dropped the caption as ownerless. Either leak it or lose it.
      expect(screen.storedComposeKey()).not.toBe("");
    });
  });

  /**
   * The row an OLDER build wrote: captions, and `composeKey: ""` because the
   * owner was never recorded. Those rows are in the database today.
   */
  it("refuses to publish captions from a draft that records no owner", () => {
    const screen = new ComposeScreen();
    const notices = screen.restore(
      {
        productCode: "MGK-A",
        composeKey: "",
        captions: { [BASE_CHANNEL]: "Caption viết cho mã nào không rõ" },
        captionOverrides: { "fanpage-x": "Bản riêng không rõ của mã nào" },
      },
      KEY_B,
    );

    expect(notices).toEqual([UNOWNED_DRAFT_CAPTIONS_NOTICE]);
    // Nothing to publish: step 2 is empty and `submit` reports the channel as
    // missing a caption instead of sending the orphan text.
    expect(screen.publish(["fanpage-x"], false)).toEqual({ "fanpage-x": "" });
    expect(screen.publish(["fanpage-x"], true)).toEqual({ "fanpage-x": "" });
    expect(screen.storedOverrides()).toEqual({});
  });

  it("does not warn about an ownerless draft that had no captions in it", () => {
    const screen = new ComposeScreen();
    const notices = screen.restore(
      { productCode: "MGK-A", composeKey: "", captions: {}, captionOverrides: {} },
      KEY_B,
    );
    expect(notices).toEqual([]);
  });

  it("sends the approved caption to every channel while sharing is on", () => {
    const screen = new ComposeScreen();
    screen.compose(KEY_A);
    screen.typeCaption("Áo dài TRẮNG mã A");
    screen.typeOverride("fanpage-x", "Bản riêng bị bỏ qua khi bật dùng chung");

    expect(screen.publish(["fanpage-x", "fanpage-y"], true)).toEqual({
      "fanpage-x": "Áo dài TRẮNG mã A",
      "fanpage-y": "Áo dài TRẮNG mã A",
    });
  });
});
