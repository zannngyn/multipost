import { describe, expect, it } from "vitest";

import { writeGate } from "./read-only-gate";
import { SUPPORT_MODE_READ_ONLY_REASON } from "./useReadOnlyReason";

/**
 * Edge cases first (CLAUDE.md technical rule 1). This is the rule every write
 * control on six screens now follows, so the two failures that matter are:
 *  - a control that goes dead WITHOUT saying why (core-auth-session forbids it,
 *    and it is indistinguishable from a broken screen);
 *  - a control that stays live in support mode, i.e. a button whose only
 *    possible outcome is a 403 (the anti-pattern this sweep exists to remove).
 *
 * A DOM assertion per screen is not possible here: `vitest.config.ts` runs
 * `environment: "node"` and the repo has no jsdom/testing-library, which are
 * dependencies this ticket does not authorise. So the DECISION is tested here,
 * and every screen is wired to this one function rather than re-deriving it.
 */

describe("writeGate — support mode", () => {
  it("turns a control off AND hands over the reason", () => {
    const gate = writeGate(SUPPORT_MODE_READ_ONLY_REASON);
    expect(gate.isDisabled).toBe(true);
    expect(gate.reason).toBe(SUPPORT_MODE_READ_ONLY_REASON);
  });

  it("uses the wording the operator was promised", () => {
    // The sentence leads with what it is, then how to get out of it.
    expect(SUPPORT_MODE_READ_ONLY_REASON).toContain("Chế độ hỗ trợ chỉ được xem");
    expect(SUPPORT_MODE_READ_ONLY_REASON).toContain("Thoát hỗ trợ");
  });

  it("keeps the reason even while a write of its own is in flight", () => {
    // The control stays off after that write lands, so saying why early is not
    // wrong — and the sentence must not flicker away mid-request.
    const gate = writeGate(SUPPORT_MODE_READ_ONLY_REASON, true);
    expect(gate.isDisabled).toBe(true);
    expect(gate.reason).toBe(SUPPORT_MODE_READ_ONLY_REASON);
  });
});

describe("writeGate — a normal session is not changed by one pixel", () => {
  it("leaves the control on, with nothing to say", () => {
    const gate = writeGate(null);
    expect(gate.isDisabled).toBe(false);
    expect(gate.reason).toBeNull();
  });

  it("still disables while busy — but never invents a sentence for it", () => {
    // "Đang lưu…" is already on the button; a permanent explanation next to a
    // temporary state is noise.
    const gate = writeGate(null, true);
    expect(gate.isDisabled).toBe(true);
    expect(gate.reason).toBeNull();
  });

  it("treats a blank reason as no reason, not as read-only", () => {
    // Guards the one way this could silently disable the whole app: a caller
    // handing over "" instead of null.
    for (const blank of ["", "   "]) {
      const gate = writeGate(blank);
      expect(gate.isDisabled).toBe(false);
      expect(gate.reason).toBeNull();
    }
  });
});
