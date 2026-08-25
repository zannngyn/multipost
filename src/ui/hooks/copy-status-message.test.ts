import { describe, expect, it } from "vitest";

import { copyStatusMessage } from "./useCopyToClipboard";

/**
 * The sentence a copy button leaves behind.
 *
 * The rule under test is small and the bug it prevents is not: a button that
 * reports success for a copy the browser refused sends an operator off to paste
 * whatever was in the clipboard before.
 */
describe("copyStatusMessage", () => {
  it("says nothing at all while idle — no standing 'đã chép' from last time", () => {
    expect(copyStatusMessage("idle", "mã lô")).toBe("");
  });

  it("confirms only the state that actually copied", () => {
    expect(copyStatusMessage("copied", "mã lô")).toBe("Đã chép mã lô.");
  });

  it("names the way out on failure instead of only reporting it", () => {
    const message = copyStatusMessage("failed", "link theo dõi");

    expect(message).toContain("không cho chép tự động");
    // The value is on screen; selecting it by hand is the answer.
    expect(message).toContain("chép tay");
    expect(message).toContain("link theo dõi");
  });

  it("never dresses a failure as a success", () => {
    expect(copyStatusMessage("failed", "mã lô")).not.toContain("Đã chép");
  });
});
