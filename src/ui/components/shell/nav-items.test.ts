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
      "/prompts",
    ]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
