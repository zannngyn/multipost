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
