import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ScheduleTimeField } from "../ScheduleTimeField";

/**
 * The publish-time field must never PARSE A TYPED DATE STRING.
 *
 * This is a regression lock, not a style preference. The field was once a
 * library picker that parsed what the operator typed; measured against that
 * parser, "1/9/2026" on a client left at en-US resolved to 9 January with no
 * error shown, and a Vietnamese-locale client could not re-parse its own
 * rendered value. Both are silent wrong answers on a SCHEDULING field.
 *
 * The field is now a calendar + clock picker (one tap per part, plus numeric
 * hour/minute boxes). That keeps the lock — a day is CHOSEN, never spelled —
 * so the assertions below moved with it: no free-text control anywhere, the
 * window published on the element that owns it instead of on a native
 * `min`/`max`, and the invalid state on the trigger that replaced the input.
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
  it("offers a picker, never a text field a date could be typed into", () => {
    const html = renderToStaticMarkup(<ScheduleTimeField {...BASE} />);
    // A text input here would mean a string parser is back in the path. The
    // only inputs the picker owns are the numeric hour and minute boxes.
    expect(html).not.toContain('type="text"');
    expect(html).not.toContain('type="date"');
    // The two triggers that replaced the native control. `combobox` and not a
    // bare button: the role is what makes aria-invalid below legal, and it is
    // what tells a screen reader this thing carries a value.
    expect(html.match(/role="combobox"/g)).toHaveLength(2);
    expect(html).toContain('id="at"');
  });

  it("bounds the window on the control itself, not only in the hint", () => {
    const html = renderToStaticMarkup(<ScheduleTimeField {...BASE} />);
    // Same helper the validator uses, so the calendar cannot offer a day the
    // error message would then reject.
    expect(html).toMatch(/data-min="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/);
    expect(html).toMatch(/data-max="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/);
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
