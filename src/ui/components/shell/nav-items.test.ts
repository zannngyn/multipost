import { describe, expect, it } from "vitest";

import { NAV_SECTIONS, isNavItemActive } from "@/ui/components/shell/nav-items";

describe("isNavItemActive", () => {
  it("marks the overview only on an exact match", () => {
    expect(isNavItemActive("/", "/")).toBe(true);
    expect(isNavItemActive("/products", "/")).toBe(false);
  });

  it("marks a section active on its own path", () => {
    expect(isNavItemActive("/products", "/products")).toBe(true);
  });

  it("marks a section active on a nested path", () => {
    expect(isNavItemActive("/batches/abc-123", "/batches")).toBe(true);
  });

  it("does not match a path that merely shares a prefix", () => {
    expect(isNavItemActive("/jobsomething", "/jobs")).toBe(false);
  });

  it("ignores a trailing slash", () => {
    expect(isNavItemActive("/products/", "/products")).toBe(true);
  });

  it("stops matching sub-paths when the entry is exact", () => {
    // "/channels" owns the connected Pages; "/channels/groups" is its own entry.
    expect(isNavItemActive("/channels/groups", "/channels", { exact: true })).toBe(false);
    expect(isNavItemActive("/channels", "/channels", { exact: true })).toBe(true);
    expect(isNavItemActive("/channels/groups", "/channels/groups")).toBe(true);
  });
});

describe("NAV_SECTIONS", () => {
  it("covers every operator destination exactly once", () => {
    const hrefs = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.href));
    expect(hrefs).toEqual([
      "/",
      "/compose",
      "/bulk",
      "/scheduled",
      "/jobs",
      "/products",
      "/sync",
      "/channels",
      "/channels/groups",
      "/prompts",
    ]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("marks every entry that owns another entry's prefix as exact", () => {
    const hrefs = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.href));

    for (const section of NAV_SECTIONS) {
      for (const item of section.items) {
        if (item.href === "/") continue;
        const ownsAnother = hrefs.some((href) => href.startsWith(`${item.href}/`));
        // Without this flag two nav entries light up at once and the operator
        // cannot tell which screen they are on.
        expect(ownsAnother ? item.isExact === true : true).toBe(true);
      }
    }
  });
});
