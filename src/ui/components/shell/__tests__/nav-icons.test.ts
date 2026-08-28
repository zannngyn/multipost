import { describe, expect, it } from "vitest";

import { NAV_ICONS } from "@/ui/components/shell/AppSideNav";
import { NAV_SECTIONS, flattenNavItems } from "@/ui/components/shell/nav-items";

/**
 * One icon per destination, pinned.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS: `SideNavItem.icon` is optional, so a
 * missing entry is not a type error and not a crash — it is a row with a hole
 * where every other row has a glyph. In the COLLAPSED rail the icon is the
 * entire row: a destination with no icon becomes an unlabelled, unrecognisable
 * strip of nothing, and the operator loses a screen without being told.
 *
 * The map is read from the module, not from the file's text: a test that
 * grepped for the string would pass on a commented-out entry.
 */
describe("nav icons", () => {
  const items = flattenNavItems(NAV_SECTIONS);

  it("covers every destination in the nav, hidden sections included", () => {
    // `visibleNavSections` filters by permission, so this reads the FULL tree:
    // "/platform" is invisible to most accounts and would otherwise be the one
    // entry nobody notices is broken.
    const missing = items.filter((item) => NAV_ICONS[item.href] === undefined);
    expect(missing.map((item) => item.href)).toEqual([]);
  });

  it("has no entry for a destination the nav no longer has", () => {
    // The other direction: a route removed from NAV_SECTIONS leaves a dead
    // import behind, which is how an icon map grows a tail nobody dares delete.
    const hrefs = new Set(items.map((item) => item.href));
    expect(Object.keys(NAV_ICONS).filter((href) => !hrefs.has(href))).toEqual([]);
  });

  it("maps each destination to a renderable component", () => {
    for (const item of items) {
      const icon = NAV_ICONS[item.href];
      expect(typeof icon === "function" || typeof icon === "object").toBe(true);
    }
  });
});
