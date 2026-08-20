import { describe, expect, it } from "vitest";

import {
  NAV_SECTIONS,
  visibleNavSections,
  flattenNavItems,
  isNavItemActive,
  toSearchKey,
} from "@/ui/components/shell/nav-items";

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
      "/members",
      "/access",
      "/platform",
    ]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("flattens to one searchable entry per destination, keeping its section", () => {
    const flat = flattenNavItems();
    const hrefs = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.href));

    expect(flat).toHaveLength(hrefs.length);
    expect(flat.map((item) => item.href)).toEqual(hrefs);
    expect(flat).toContainEqual({ href: "/sync", label: "Đồng bộ dữ liệu", section: "Dữ liệu" });
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

describe("toSearchKey", () => {
  it("drops tone marks so an unaccented query still matches", () => {
    expect(toSearchKey("Đồng bộ dữ liệu")).toBe("dong bo du lieu");
    expect(toSearchKey("Bài đã hẹn")).toBe("bai da hen");
  });

  it("folds đ and Đ, which NFD leaves whole", () => {
    expect(toSearchKey("Đ")).toBe("d");
    expect(toSearchKey("đăng")).toBe("dang");
  });

  it("handles text with no diacritics and the empty string", () => {
    expect(toSearchKey("Mẫu prompt")).toBe("mau prompt");
    expect(toSearchKey("")).toBe("");
  });

  it("leaves no combining mark behind on any nav label", () => {
    for (const item of flattenNavItems()) {
      expect(toSearchKey(item.label)).toMatch(/^[a-z0-9 ]*$/);
    }
  });
});

/**
 * M3.2 / ticket N3. The rule: a section nobody may open is not shown at all —
 * and, just as important, is not shown for one frame while `/api/me` loads,
 * because an item that blinks into existence is an item somebody clicks
 * (core-auth-session §menu chờ biết quyền mới render).
 */
describe("visibleNavSections", () => {
  it("hides the platform section from an ordinary operator", () => {
    const titles = visibleNavSections({ hasPlatformRole: false }).map((section) => section.title);
    expect(titles).not.toContain("Nền tảng");
    // …and nothing else disappears with it.
    expect(titles).toContain("Cấu hình");
    expect(titles).toContain("Vận hành");
  });

  it("shows it to an account that holds a platform role", () => {
    const titles = visibleNavSections({ hasPlatformRole: true }).map((section) => section.title);
    expect(titles).toContain("Nền tảng");
  });

  it("hides it while the role is still unknown — the default is the safe one", () => {
    // The caller passes `false` until /api/me answers; this asserts that the
    // safe direction is the one that hides, not the one that flashes.
    const hidden = visibleNavSections({ hasPlatformRole: false });
    const shown = visibleNavSections({ hasPlatformRole: true });
    expect(hidden.length).toBe(shown.length - 1);
  });

  it("keeps the platform destinations out of the command palette too", () => {
    // Hiding a section from the sidebar but leaving it findable in the palette
    // would be hiding nothing at all.
    const hrefs = flattenNavItems(visibleNavSections({ hasPlatformRole: false })).map(
      (item) => item.href,
    );
    expect(hrefs).not.toContain("/platform");
    expect(
      flattenNavItems(visibleNavSections({ hasPlatformRole: true })).map((item) => item.href),
    ).toContain("/platform");
  });
});
