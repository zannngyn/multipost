import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describeAction, type ComposeActionState } from "./compose-action";

/**
 * The one action on the compose screen. Every case here is a sentence an
 * operator reads while a button is dim — the point of the function is that the
 * two can never drift apart.
 */

function state(overrides: Partial<ComposeActionState> = {}): ComposeActionState {
  return {
    readOnlyReason: null,
    hasChannels: true,
    hasComposed: true,
    channels: 2,
    missingCaptionChannels: [],
    canSubmit: true,
    ...overrides,
  };
}

describe("describeAction", () => {
  it("refuses everything in support mode, with the support sentence", () => {
    const result = describeAction(
      state({ readOnlyReason: "Đang trong phiên hỗ trợ — chỉ đọc." }),
    );
    expect(result.enabled).toBe(false);
    expect(result.note).toContain("phiên hỗ trợ");
  });

  it("puts support mode ahead of every other reason", () => {
    const result = describeAction(
      state({
        readOnlyReason: "Đang trong phiên hỗ trợ — chỉ đọc.",
        hasChannels: false,
        hasComposed: false,
        channels: 0,
        canSubmit: false,
      }),
    );
    expect(result.note).toContain("phiên hỗ trợ");
  });

  it("sends the operator to the Kênh screen when no Page is connected", () => {
    const result = describeAction(state({ hasChannels: false }));
    expect(result.enabled).toBe(false);
    expect(result.note).toContain("màn Kênh");
  });

  it("asks for a product before anything else about this post", () => {
    const result = describeAction(state({ hasComposed: false }));
    expect(result.note).toBe("Tra một mã sản phẩm trước.");
  });

  it("asks for a channel when none is ticked", () => {
    const result = describeAction(state({ channels: 0 }));
    expect(result.note).toBe("Chọn ít nhất một kênh.");
  });

  it("NAMES the single channel that has no caption", () => {
    const result = describeAction(state({ missingCaptionChannels: ["Camilla"] }));
    expect(result.enabled).toBe(false);
    expect(result.note).toBe("Camilla chưa có caption.");
  });

  it("names every channel when several are missing a caption", () => {
    const result = describeAction(
      state({ missingCaptionChannels: ["Camilla", "Devis"] }),
    );
    expect(result.enabled).toBe(false);
    expect(result.note).toContain("Camilla, Devis");
  });

  it("counts what is about to happen once nothing is missing", () => {
    expect(describeAction(state())).toEqual({ enabled: true, note: "2 kênh · 1 bài" });
  });

  it("still dims the button while the publish form says no (a request in flight)", () => {
    const result = describeAction(state({ canSubmit: false }));
    expect(result.enabled).toBe(false);
    expect(result.note).toBe("2 kênh · 1 bài");
  });
});

/**
 * The M3.3 wiring, as a structural test.
 *
 * `vitest.config.ts` runs `environment: "node"` and the repo has no jsdom or
 * testing-library; adding either is a dependency decision this ticket does not
 * authorise. So the DECISION is tested above, on the pure function, and the
 * WIRING is asserted here — the regression that actually happens is a new write
 * button landing on this screen without the gate, and nobody noticing until a
 * support session hits a 403.
 *
 * (`components/read-only-sweep.test.ts` deliberately excludes `compose/**`
 * while this screen was being rebuilt; this is the compose half of it.)
 */
function readCompose(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("support mode is wired into the compose screen", () => {
  it("the screen reads the reason", () => {
    const source = readCompose("./ComposeFocus.tsx");
    expect(source).toContain("useReadOnlyReason");
    expect(source).toMatch(/useReadOnlyReason\(\)/);
  });

  it("hands it to every write surface on the screen", () => {
    const source = readCompose("./ComposeFocus.tsx");
    // Đăng luôn / Hẹn lịch, sinh caption, lưu nhóm kênh.
    expect(source).toMatch(/<ComposeActionBar[\s\S]*?readOnlyReason=\{readOnlyReason\}/);
    expect(source).toMatch(/<CaptionBlock[\s\S]*?readOnlyReason=\{readOnlyReason\}/);
    expect(source).toMatch(/<ChannelPickerDialog[\s\S]*?readOnlyReason=\{readOnlyReason\}/);
  });

  it("the action bar actually disables on it, not just receives it", () => {
    const source = readCompose("./ComposeActionBar.tsx");
    expect(source).toContain("disabled={primaryDisabled || blocked}");
  });

  it("caption generation is treated as a write", () => {
    const source = readCompose("./CaptionBlock.tsx");
    expect(source).toMatch(/disabled=\{captions\.isPending \|\| Boolean\(readOnlyReason\)\}/);
  });
});

/**
 * Structural guard for the bug that failed review: the caption box must take
 * its value from the same pair of functions the payload does, and must never
 * gate that on how many channels happen to be ticked.
 *
 * Behaviour is covered in `caption-targets.test.ts` (the reviewer's exact
 * sequence). This only stops the CONDITION creeping back into the component,
 * which no pure test can see.
 */
describe("the caption editor reads the published string", () => {
  it("derives the active channel through the shared rule", () => {
    const source = readCompose("./CaptionBlock.tsx");
    expect(source).toContain("activeCaptionChannel({");
    expect(source).toMatch(/const value = activeId \? resolveCaption\(captionSources, activeId\)/);
  });

  it("does not decide WHICH caption to show by counting channels", () => {
    const source = readCompose("./CaptionBlock.tsx");

    // The channel count may decide whether the tab strip is DRAWN…
    expect(source).toMatch(/const showTabs = activeId !== null && selectedIds\.length > 1;/);

    // …but nothing between choosing the channel and reading its caption may
    // look at it. That was the bug: a count in this stretch of code made the
    // editor show the shared caption while the payload used the channel's own.
    const from = source.indexOf("const activeId = activeCaptionChannel({");
    const to = source.indexOf("function writeCaption(");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const derivation = source
      .slice(from, to)
      .replace(/const showTabs = .*/, "")
      // Comments explain the rule; only the code has to obey it.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "");
    expect(derivation).not.toContain("selectedIds.length");
  });

  it("the preview asks the same rule instead of re-deriving it", () => {
    const source = readCompose("./ComposeFocus.tsx");
    expect(source).toContain("activeCaptionChannel({");
    expect(source).toContain("publish.captionFor(previewChannelId)");
  });
});

/**
 * The order of the left card (PM, 21/08/2026): a caption is written per
 * Fanpage, so "đăng lên đâu" is asked BEFORE there is anything to write.
 */
describe("channels are chosen before the caption is written", () => {
  it("puts the channel block above the caption block", () => {
    const source = readCompose("./ComposeFocus.tsx");
    const channels = source.indexOf("<ChannelChoice");
    const caption = source.indexOf("<CaptionBlock");
    expect(channels).toBeGreaterThan(-1);
    expect(caption).toBeGreaterThan(-1);
    expect(channels).toBeLessThan(caption);
  });

  it("gives the caption block a way to open the picker for its empty state", () => {
    const source = readCompose("./ComposeFocus.tsx");
    expect(source).toMatch(/<CaptionBlock[\s\S]*?onOpenPicker=\{/);
  });

  it("the caption block says what to do next instead of going quiet", () => {
    const source = readCompose("./CaptionBlock.tsx");
    // An empty state with a CTA, not a disabled box (core-feedback-states).
    expect(source).toContain("selectedIds.length === 0 ? (");
    expect(source).toContain("Chọn kênh đăng trước để viết caption");
    expect(source).toMatch(/onClick=\{onOpenPicker\}/);
  });

  it("the switch reads as “caption riêng”, over the stored shareCaption", () => {
    const source = readCompose("./CaptionBlock.tsx");
    expect(source).toContain("Caption riêng từng kênh");
    expect(source).toContain("perChannel={!publish.shareCaption}");
  });

  it("offers one press for every ticked Page, and keeps the per-tab rewrite", () => {
    const source = readCompose("./CaptionBlock.tsx");
    expect(source).toContain("Viết caption cho ${selectedIds.length} trang");
    expect(source).toContain("Viết lại trang này");
    expect(source).toContain("fanOut.run(selectedIds)");
  });
});
