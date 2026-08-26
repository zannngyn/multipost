import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProgressRail } from "./ProgressRail";

/**
 * `renderToStaticMarkup`, not testing-library: vitest runs `environment: "node"`
 * and the repo has no jsdom. Everything asserted here is in server markup.
 *
 * The rail is the one thing on screen that answers "how much is left". Colour
 * alone cannot say that, so the count is asserted as TEXT.
 */

describe("ProgressRail", () => {
  it("states the position in words, not only in colour", () => {
    const html = renderToStaticMarkup(<ProgressRail current="facebook" />);
    expect(html).toContain("Bước 3/6");
  });

  it("marks the current slide for assistive technology", () => {
    const html = renderToStaticMarkup(<ProgressRail current="facebook" />);
    expect(html).toContain('aria-current="step"');
  });

  it("names every slide so the list is readable on its own", () => {
    const html = renderToStaticMarkup(<ProgressRail current="company" />);
    for (const title of ["Tạo công ty", "Kết nối dữ liệu", "Kết nối Facebook", "Tạo nhóm kênh"]) {
      expect(html).toContain(title);
    }
  });
});
