import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProgressRail } from "./ProgressRail";

/**
 * `renderToStaticMarkup`, not testing-library: vitest runs `environment: "node"`
 * and the repo has no jsdom. Everything asserted here is in server markup.
 *
 * SHAPE CHANGE (survey flow): the six setup slides became four survey steps
 * plus a welcome screen that asks nothing. The rail draws FOUR dots, states the
 * position in words, and draws nothing at all on the welcome screen. The step
 * names stay in the markup, but only as the dots' accessible names: a row of
 * coloured dots with no names is exactly the "colour alone" failure this rail
 * exists to prevent.
 */

const ALL_TITLES = [
  "Kiểu bán hàng",
  "Công cụ đang dùng",
  "Số trang đang quản lý",
  "Kênh tập trung",
] as const;

/** The rail's visible words — with every assistive-tech-only span stripped. */
function visibleText(html: string): string {
  return html.replace(/<span class="sr-only">[^<]*<\/span>/g, "");
}

describe("ProgressRail", () => {
  it("states the position in words, not only in colour", () => {
    const html = renderToStaticMarkup(<ProgressRail current="count" />);
    expect(visibleText(html)).toContain("Bước 3/4");
  });

  it("marks the current step for assistive technology", () => {
    const html = renderToStaticMarkup(<ProgressRail current="count" />);
    expect(html).toContain('aria-current="step"');
  });

  it("marks exactly one step as current", () => {
    const html = renderToStaticMarkup(<ProgressRail current="count" />);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
  });

  it("names every step, so the dots are never colour-only", () => {
    const html = renderToStaticMarkup(<ProgressRail current="seller" />);
    for (const title of ALL_TITLES) {
      expect(html).toContain(`class="sr-only">${title}`);
    }
  });

  it("says which steps are already behind, in words", () => {
    const html = renderToStaticMarkup(<ProgressRail current="count" />);
    expect(html).toContain('class="sr-only">Kiểu bán hàng — đã qua');
    expect(html).toContain('class="sr-only">Công cụ đang dùng — đã qua');
    expect(html).not.toContain('class="sr-only">Kênh tập trung — đã qua');
  });

  it("no longer prints the step title, which the step's <h1> already carries", () => {
    // The duplicated title was one of the three visible defects that sent this
    // frame back: the same words showed in the rail AND as the heading.
    const html = renderToStaticMarkup(<ProgressRail current="count" />);
    for (const title of ALL_TITLES) {
      expect(visibleText(html)).not.toContain(title);
    }
  });

  it("renders a semantic list so the four dots read as one sequence", () => {
    const html = renderToStaticMarkup(<ProgressRail current="seller" />);
    expect(html).toContain("<ol");
    expect(html.match(/<li/g)).toHaveLength(4);
  });

  it("draws nothing on the welcome screen, which asks no question", () => {
    // Four empty dots above a greeting would claim a step is pending when none
    // has been reached yet (spec section 3).
    expect(renderToStaticMarkup(<ProgressRail current="welcome" />)).toBe("");
  });
});
