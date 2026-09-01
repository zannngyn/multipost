import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The rule that keeps "Chọn kênh đăng" on screen once the list is expanded.
 *
 * THE BUG THIS CLOSES: with 33 Pages connected, pressing "Xem thêm 28 page" and
 * then ticking a Page near the bottom blanked the whole modal — a cream card
 * with nothing in it. Nothing had crashed: all 33 rows were still in the DOM.
 * The modal had scrolled ITSELF away.
 *
 * The chain, because none of the three links is wrong on its own:
 *   1. every row's checkbox is `peer sr-only`, and `.sr-only` is
 *      `position: absolute`;
 *   2. the scroll body around them had no `position`, so the containing block
 *      of all 33 of them was `DialogContent` (`position: fixed`) — they escaped
 *      the body's clipping and pushed 1517px of scrollable overflow onto the
 *      dialog itself (`scrollHeight` 2210 vs `clientHeight` 693);
 *   3. clicking a row focuses its hidden checkbox, and the browser scrolls a
 *      freshly focused element into view — which scrolled the DIALOG, not the
 *      list. `overflow: hidden` still scrolls programmatically, so there was no
 *      scrollbar and no way back.
 *
 * Collapsed to 5 rows the overflow is ~0, which is why this only ever showed up
 * on a tenant with many Pages.
 *
 * WHY SOURCE AND NOT MARKUP: this is CSS positioning. `vitest.config.ts` runs
 * `environment: "node"` with no jsdom and no layout, so a rendered-HTML test
 * would stay green with the bug fully present (same structural answer as
 * `ChannelGroupPicker ↔ groupToggleViews wiring` in
 * `channel-group-picker-render.test.tsx`). What CAN be pinned is the class
 * contract that makes the geometry impossible.
 */
describe("ChannelPickerDialog scroll containment", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../ChannelPickerDialog.tsx", import.meta.url)),
    "utf8",
  );

  /** Every `className="…"` literal in the component. */
  function classLists(): string[] {
    return [...SOURCE.matchAll(/className="([^"]*)"/g)].map((match) => match[1]);
  }

  it("still hides its checkboxes with `sr-only`", () => {
    // The guard below only matters while the rows carry absolutely positioned
    // inputs. If they ever stop, this test should be re-read, not deleted.
    expect(classLists().some((list) => /\bpeer sr-only\b/.test(list))).toBe(true);
  });

  it("makes every scroll container the containing block for them", () => {
    const scrollers = classLists().filter((list) => /\boverflow-y-auto\b/.test(list));

    expect(scrollers.length).toBeGreaterThan(0);
    for (const scroller of scrollers) {
      // Without `relative` the sr-only inputs anchor to the fixed dialog
      // instead, and focusing one scrolls the dialog off its own frame.
      expect(scroller).toMatch(/\brelative\b/);
    }
  });

  it("never lets the dialog frame itself become scrollable", () => {
    // `overflow-hidden` is a scroll container: it takes no scrollbar but it
    // DOES move under `scrollIntoView`. `overflow-clip` creates no scroll
    // container at all, so no focus can ever displace the frame.
    //
    // Read from the class lists, not the whole file: the comment next to the
    // fix names the class it replaced, and a raw source scan would fail on the
    // very sentence that explains why the fix is there.
    expect(classLists().filter((list) => /\boverflow-hidden\b/.test(list))).toEqual([]);
  });
});
