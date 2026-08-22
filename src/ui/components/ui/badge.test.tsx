import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Badge, type BadgeTone } from "@/ui/components/ui/badge";

/**
 * WHICH tint each tone paints — the promise every screen leans on when it maps
 * a domain status to a tone.
 *
 * This is the ONE place that names utility classes. It used to be asserted from
 * `bulk-progress-table-render.test.tsx`, where it made a screen test fail on an
 * internal Badge change and still only reached the four tones that screen
 * happened to use. Screens now pin the tone they ask for (their decision);
 * Badge pins what a tone looks like (its decision).
 *
 * The rules being locked: The 10% Tint Rule (an outcome is a 10% wash, never a
 * saturated block) and The Ink Hairline Rule (1px border, no coloured slab).
 * `info` is deliberately NOT tinted — Fact Blue does not join the dye game.
 */

const TONES: readonly BadgeTone[] = ["neutral", "success", "warning", "danger", "info"];

function classOf(tone: BadgeTone): string {
  const html = renderToStaticMarkup(<Badge tone={tone}>Nhãn</Badge>);
  return html.match(/class="([^"]*)"/)?.[1] ?? "";
}

describe("Badge tones", () => {
  it("washes each outcome at 10%, never as a solid block", () => {
    expect(classOf("success")).toContain("bg-success/10");
    expect(classOf("warning")).toContain("bg-warning/10");
    expect(classOf("danger")).toContain("bg-destructive/10");
  });

  it("keeps the two non-outcome tones out of the dye game", () => {
    // Neutral is the muted surface, info a plain one: neither says "something
    // happened", so neither may borrow an outcome colour.
    for (const tone of ["neutral", "info"] as const) {
      expect(classOf(tone)).not.toMatch(/bg-(success|warning|destructive)\//);
    }
  });

  it("carries every colour on a token, never on a literal", () => {
    // core-design-tokens: a hex in here would be invisible to theming and to
    // the dark palette.
    for (const tone of TONES) {
      expect(classOf(tone)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(classOf(tone)).not.toMatch(/\[(rgb|hsl|#)/);
    }
  });

  it("gives every tone its own appearance", () => {
    // A screen that maps eight statuses onto five tones is relying on this: if
    // two tones rendered alike, "Bỏ qua" and "Lỗi" would be one thing on screen.
    expect(new Set(TONES.map(classOf)).size).toBe(TONES.length);
  });

  it("stays a hairline pill, whatever the tone", () => {
    for (const tone of TONES) {
      const className = classOf(tone);
      expect(className).toContain("rounded-full");
      expect(className).toContain("border");
      // `border-2`/`border-l-4` is the slab this system refuses.
      expect(className).not.toMatch(/border-(2|4|8|[lrtxy]-)/);
    }
  });

  it("lets a caller add classes without losing the tone", () => {
    const html = renderToStaticMarkup(
      <Badge tone="success" className="ml-2">
        Nhãn
      </Badge>,
    );

    expect(html).toContain("ml-2");
    expect(html).toContain("bg-success/10");
  });
});
