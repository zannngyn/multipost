import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StepDots } from "./StepDots";

/**
 * `renderToStaticMarkup`, not testing-library: vitest runs `environment: "node"`
 * and the repo has no jsdom. Everything asserted here is in server markup.
 *
 * SHAPE CHANGE (this replaces `progress-rail-render.test.tsx`): the rail with
 * its ordinal, its bar and its named steps became the four bare dots Buffer
 * uses. What survived the change is the RULE, not the drawing — the position
 * still has to be readable without colour vision, which is why the dots are
 * hidden from assistive technology and a sentence sits beside them.
 */

/** The dots' own words — with every assistive-tech-only span stripped. */
function visibleText(html: string): string {
  return html.replace(/<span class="sr-only">[^<]*<\/span>/g, "");
}

describe("StepDots", () => {
  it("draws four dots, one per survey step", () => {
    const html = renderToStaticMarkup(<StepDots current="seller" />);
    expect(html.match(/rounded-full/g)).toHaveLength(4);
  });

  it("states the position in words, so it is never colour alone", () => {
    const html = renderToStaticMarkup(<StepDots current="count" />);
    expect(html).toContain("Bước 3/4");
  });

  it("keeps that sentence for screen readers only — Buffer shows dots alone", () => {
    const html = renderToStaticMarkup(<StepDots current="count" />);
    expect(visibleText(html)).not.toContain("Bước 3/4");
  });

  it("hides the row of dots itself, rather than announcing four unnamed circles", () => {
    const html = renderToStaticMarkup(<StepDots current="count" />);
    expect(html).toContain('aria-hidden="true"');
  });

  it("is not interactive: a dot must not offer a jump to an unasked question", () => {
    const html = renderToStaticMarkup(<StepDots current="tools" />);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });

  it("marks exactly one dot as the current one", () => {
    const html = renderToStaticMarkup(<StepDots current="tools" />);
    // The current dot is the only one on the full-strength ink.
    expect(html.match(/bg-foreground(?!\/)/g)).toHaveLength(1);
  });

  it("draws nothing on the welcome screen, which asks no question", () => {
    // Four dots above a greeting would claim a step is pending when none has
    // been reached yet (spec section 3).
    expect(renderToStaticMarkup(<StepDots current="welcome" />)).toBe("");
  });
});
