import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProgressRail } from "./ProgressRail";

/**
 * `renderToStaticMarkup`, not testing-library: vitest runs `environment: "node"`
 * and the repo has no jsdom. Everything asserted here is in server markup.
 *
 * SHAPE CHANGE (two-column frame): the rail used to print the current slide's
 * title, which put the same words on screen twice — once here, once in the
 * slide's <h1>. It now draws six dots and states the position in words. The
 * titles stay in the markup, but only as the dots' accessible names: a row of
 * coloured dots with no names is exactly the "colour alone" failure this rail
 * exists to prevent.
 */

const ALL_TITLES = [
  "Tạo công ty",
  "Kết nối dữ liệu",
  "Kết nối Facebook",
  "Tạo nhóm kênh",
  "Mời nhân viên",
  "Xong rồi",
] as const;

/** The rail's visible words — with every assistive-tech-only span stripped. */
function visibleText(html: string): string {
  return html.replace(/<span class="sr-only">[^<]*<\/span>/g, "");
}

describe("ProgressRail", () => {
  it("states the position in words, not only in colour", () => {
    const html = renderToStaticMarkup(<ProgressRail current="facebook" />);
    expect(visibleText(html)).toContain("Bước 3/6");
  });

  it("marks the current slide for assistive technology", () => {
    const html = renderToStaticMarkup(<ProgressRail current="facebook" />);
    expect(html).toContain('aria-current="step"');
  });

  it("marks exactly one slide as current", () => {
    const html = renderToStaticMarkup(<ProgressRail current="facebook" />);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
  });

  it("names every slide, so the dots are never colour-only", () => {
    const html = renderToStaticMarkup(<ProgressRail current="company" />);
    for (const title of ALL_TITLES) {
      expect(html).toContain(`class="sr-only">${title}`);
    }
  });

  it("says which slides are already behind, in words", () => {
    const html = renderToStaticMarkup(<ProgressRail current="facebook" />);
    expect(html).toContain('class="sr-only">Tạo công ty — đã qua');
    expect(html).toContain('class="sr-only">Kết nối dữ liệu — đã qua');
    expect(html).not.toContain('class="sr-only">Tạo nhóm kênh — đã qua');
  });

  it("no longer prints the slide title, which the slide's <h1> already carries", () => {
    // The duplicated title was one of the three visible defects that sent this
    // frame back: "Kết nối Facebook" showed in the rail AND as the heading.
    const html = renderToStaticMarkup(<ProgressRail current="facebook" />);
    for (const title of ALL_TITLES) {
      expect(visibleText(html)).not.toContain(title);
    }
  });

  it("renders a semantic list so the six dots read as one sequence", () => {
    const html = renderToStaticMarkup(<ProgressRail current="company" />);
    expect(html).toContain("<ol");
    expect(html.match(/<li/g)).toHaveLength(6);
  });
});
