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
    expect(isNavItemActive("/productsomething", "/products")).toBe(false);
  });

  it("ignores a trailing slash", () => {
    expect(isNavItemActive("/products/", "/products")).toBe(true);
  });

  it("stops matching sub-paths when the entry is exact", () => {
    // Made-up paths on purpose: pinning the OPTION's behaviour to a real route
    // is how a test starts asserting the shape of a 404 once that route moves.
    // The real entry that uses it is covered below.
    expect(isNavItemActive("/parent/child", "/parent", { exact: true })).toBe(false);
    expect(isNavItemActive("/parent", "/parent", { exact: true })).toBe(true);
    expect(isNavItemActive("/parent/child", "/parent/child")).toBe(true);
  });

  it("lights exactly one row inside the platform group (M3.4)", () => {
    const platform = NAV_SECTIONS.find((section) => section.title === "Nền tảng");
    const items = platform?.items ?? [];
    expect(items).toHaveLength(2);

    // The whole point of `isExact` on "/platform": standing on the appearance
    // screen must not light "Công ty khách" too.
    const litOnAppearance = items.filter((item) =>
      isNavItemActive("/platform/appearance", item.href, { exact: item.isExact }),
    );
    expect(litOnAppearance.map((item) => item.href)).toEqual(["/platform/appearance"]);

    const litOnRoot = items.filter((item) =>
      isNavItemActive("/platform", item.href, { exact: item.isExact }),
    );
    expect(litOnRoot.map((item) => item.href)).toEqual(["/platform"]);
  });
});

describe("NAV_SECTIONS", () => {
  it("has the wave-1 IA plus onboarding and appearance: 5 visible groups, 12 destinations, platform gated", () => {
    const sections = visibleNavSections({ hasPlatformRole: true });
    expect(sections.map((s) => s.title)).toEqual([
      "Bàn làm việc",
      "Đăng bài",
      "Theo dõi",
      "Dữ liệu",
      "Cài đặt",
      "Nền tảng",
    ]);
    expect(sections.flatMap((s) => s.items.map((i) => i.href))).toEqual([
      // "/" is the public landing page since aadd9fb; the signed-in dashboard
      // lives at /overview.
      "/overview",
      "/compose",
      "/bulk",
      "/posts",
      "/products",
      "/sync",
      // Onboarding phase 1: teaching MYSP the shape of a customer's own
      // spreadsheet is a "Dữ liệu" job, and it is a destination of its own
      // rather than a tab of /sync — a salesperson opens it during a call.
      "/data-mapping",
      "/channels",
      "/prompts",
      "/members",
      "/platform",
      "/platform/appearance",
    ]);
  });

  it("no longer routes retired destinations", () => {
    const hrefs = flattenNavItems().map((i) => i.href);
    for (const legacy of ["/scheduled", "/jobs", "/channels/groups", "/access"]) {
      expect(hrefs).not.toContain(legacy);
    }
  });

  it("flattens to one searchable entry per destination, keeping its section", () => {
    const flat = flattenNavItems();
    const hrefs = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.href));

    // One destination, one entry: a duplicate href would light two rows at once
    // and show the same result twice in the command palette.
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(flat).toHaveLength(hrefs.length);
    expect(flat.map((item) => item.href)).toEqual(hrefs);
    expect(flat).toContainEqual({ href: "/sync", label: "Đồng bộ dữ liệu", section: "Dữ liệu" });
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
    expect(titles).toContain("Cài đặt");
    expect(titles).toContain("Bàn làm việc");
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
