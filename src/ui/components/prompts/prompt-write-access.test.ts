import { describe, expect, it } from "vitest";

import {
  firstRunDescription,
  promptWriteAccess,
  showsCreatePanel,
} from "@/ui/components/prompts/prompt-write-access";

const SUPPORT_REASON = "Chế độ hỗ trợ chỉ được xem.";

describe("promptWriteAccess", () => {
  it("treats absent and blank reasons as writes-allowed", () => {
    for (const value of [null, undefined, "", "   "]) {
      const access = promptWriteAccess(value);
      expect(access.isReadOnly).toBe(false);
      expect(access.reason).toBeNull();
    }
  });

  it("carries the reason when the session is read-only", () => {
    const access = promptWriteAccess(`  ${SUPPORT_REASON}  `);
    expect(access.isReadOnly).toBe(true);
    expect(access.reason).toBe(SUPPORT_REASON);
  });
});

describe("showsCreatePanel", () => {
  // The regression this file exists for: gating the panel on a flag that also
  // means "busy" unmounted the form mid-submit and threw away the typed text.
  it("keeps the panel mounted while a save of its own is in flight", () => {
    expect(showsCreatePanel({ formOpen: true, isReadOnly: false, isBusy: true })).toBe(true);
    expect(showsCreatePanel({ formOpen: true, isReadOnly: false, isBusy: false })).toBe(true);
  });

  it("never depends on busy — only on open and read-only", () => {
    for (const formOpen of [true, false]) {
      for (const isReadOnly of [true, false]) {
        const busy = showsCreatePanel({ formOpen, isReadOnly, isBusy: true });
        const idle = showsCreatePanel({ formOpen, isReadOnly, isBusy: false });
        expect(busy).toBe(idle);
      }
    }
  });

  it("hides the panel in a read-only session, open or not", () => {
    expect(showsCreatePanel({ formOpen: true, isReadOnly: true, isBusy: false })).toBe(false);
    expect(showsCreatePanel({ formOpen: false, isReadOnly: true, isBusy: false })).toBe(false);
  });

  it("hides the panel when nothing asked for it", () => {
    expect(showsCreatePanel({ formOpen: false, isReadOnly: false, isBusy: false })).toBe(false);
  });
});

describe("firstRunDescription", () => {
  it("invites a writable session to create a version", () => {
    const copy = firstRunDescription(promptWriteAccess(null));
    expect(copy).toContain("Tạo phiên bản riêng");
    expect(copy).not.toContain("chỉ xem");
  });

  it("says why instead, and only when the session really is read-only", () => {
    expect(firstRunDescription(promptWriteAccess(SUPPORT_REASON))).toContain(SUPPORT_REASON);
  });

  it("still explains itself when read-only arrives without a sentence", () => {
    // Not reachable through `promptWriteAccess`, but the copy must never be a
    // dangling "…mặc định đi kèm sản phẩm. undefined".
    const copy = firstRunDescription({ isReadOnly: true, reason: null });
    expect(copy).toContain("chỉ xem");
    expect(copy).not.toContain("undefined");
  });
});
