import { describe, expect, it } from "vitest";

import { formatRemaining } from "./SupportModeBanner";

/**
 * Edge cases first. This string sits on a permanent banner about SOMEBODY
 * ELSE'S data, so the two failures that matter are printing nonsense ("còn NaN
 * phút") and printing reassurance after the session is already dead.
 */
describe("formatRemaining", () => {
  const now = Date.parse("2026-08-20T10:00:00.000Z");

  it("counts down in minutes, then in hours", () => {
    expect(formatRemaining("2026-08-20T10:42:00.000Z", now)).toBe("còn 42 phút");
    expect(formatRemaining("2026-08-20T11:00:00.000Z", now)).toBe("còn 1 giờ");
    expect(formatRemaining("2026-08-20T11:30:00.000Z", now)).toBe("còn 1 giờ 30 phút");
  });

  it("says 'dưới 1 phút' instead of rounding down to zero", () => {
    expect(formatRemaining("2026-08-20T10:00:30.000Z", now)).toBe("còn dưới 1 phút");
  });

  it("says the session is over the moment it is", () => {
    const expired = formatRemaining("2026-08-20T09:59:59.000Z", now);
    expect(expired).toContain("đã hết hạn");
    // …and tells the operator what to do about it.
    expect(expired).toContain("thoát");
    // Exactly at the expiry instant counts as over, not as "còn dưới 1 phút".
    expect(formatRemaining("2026-08-20T10:00:00.000Z", now)).toContain("đã hết hạn");
  });

  it("never prints NaN from an unreadable expiry", () => {
    const label = formatRemaining("hôm nay", now);
    expect(label).not.toContain("NaN");
    expect(label).toBe("sẽ tự hết hạn");
  });
});
