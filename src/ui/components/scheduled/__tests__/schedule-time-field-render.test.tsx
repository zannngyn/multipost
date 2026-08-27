import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ScheduleTimeField } from "../ScheduleTimeField";

/**
 * The publish-time field must stay a NATIVE datetime control.
 *
 * This is a regression lock, not a style preference. The field was once swapped
 * to a library picker that parses a typed date string; measured against that
 * parser, "1/9/2026" on a client left at en-US resolved to 9 January with no
 * error shown, and a Vietnamese-locale client could not re-parse its own
 * rendered value. Both are silent wrong answers on a SCHEDULING field.
 *
 * `renderToStaticMarkup`, like the other render tests here: vitest runs with
 * `environment: "node"` and everything asserted below is in the server HTML.
 */

const BASE = {
  id: "at",
  label: "Giờ đăng",
  value: "",
  onChange: () => {},
  nowMs: 1_787_625_586_014,
};

describe("ScheduleTimeField", () => {
  it("renders a native datetime-local input, never a parsed text field", () => {
    const html = renderToStaticMarkup(<ScheduleTimeField {...BASE} />);
    expect(html).toContain('type="datetime-local"');
    // A text input here would mean a string parser is back in the path.
    expect(html).not.toContain('type="text"');
  });

  it("bounds the window on the control itself, not only in the hint", () => {
    const html = renderToStaticMarkup(<ScheduleTimeField {...BASE} />);
    expect(html).toMatch(/min="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/);
    expect(html).toMatch(/max="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/);
  });

  it("shows WHY it is locked as visible text, because disabled swallows hover", () => {
    const html = renderToStaticMarkup(
      <ScheduleTimeField {...BASE} disabled disabledReason="Đang chạy lô, không đổi giờ được." />,
    );
    expect(html).toContain("Đang chạy lô, không đổi giờ được.");
    expect(html).toContain('aria-describedby');
    expect(html).toContain("at-locked");
  });

  it("says nothing about a lock when the field is not disabled", () => {
    const html = renderToStaticMarkup(
      <ScheduleTimeField {...BASE} disabledReason="Không nên hiện câu này." />,
    );
    expect(html).not.toContain("Không nên hiện câu này.");
  });

  it("announces a server error with role=alert", () => {
    const html = renderToStaticMarkup(
      <ScheduleTimeField {...BASE} error="Giờ đã qua rồi." />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Giờ đã qua rồi.");
    expect(html).toContain('aria-invalid="true"');
  });

  it("stays quiet before the browser clock is known", () => {
    const html = renderToStaticMarkup(
      <ScheduleTimeField {...BASE} value="2026-09-15T20:00" nowMs={0} />,
    );
    expect(html).not.toContain("Sẽ đăng lúc");
  });
});
