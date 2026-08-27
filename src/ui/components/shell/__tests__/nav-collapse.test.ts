import { describe, expect, it } from "vitest";

import {
  NAV_COLLAPSED_COOKIE,
  NAV_WIDTH_STORAGE_KEY,
  buildNavCollapsedCookie,
  dropStaleCollapsedWidth,
  isNavCollapsedCookie,
  type NavWidthStorage,
} from "@/ui/components/shell/nav-collapse";

/** Minimal in-memory stand-in for localStorage (the test env is node). */
function fakeStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  const removed: string[] = [];
  const storage: NavWidthStorage = {
    getItem: (key) => map.get(key) ?? null,
    removeItem: (key) => {
      removed.push(key);
      map.delete(key);
    },
  };
  return { storage, removed, has: (key: string) => map.has(key) };
}

describe("isNavCollapsedCookie", () => {
  it("reads a missing or empty cookie as expanded", () => {
    expect(isNavCollapsedCookie(undefined)).toBe(false);
    expect(isNavCollapsedCookie(null)).toBe(false);
    expect(isNavCollapsedCookie("")).toBe(false);
  });

  it("reads a value it does not recognise as expanded", () => {
    // Hand-edited in devtools, or written by an older build.
    expect(isNavCollapsedCookie("true")).toBe(false);
    expect(isNavCollapsedCookie("yes")).toBe(false);
    expect(isNavCollapsedCookie(" 1")).toBe(false);
    expect(isNavCollapsedCookie("10")).toBe(false);
  });

  it("reads an explicit 0 as expanded", () => {
    expect(isNavCollapsedCookie("0")).toBe(false);
  });

  it("reads 1 as collapsed", () => {
    expect(isNavCollapsedCookie("1")).toBe(true);
  });
});

describe("buildNavCollapsedCookie", () => {
  it("writes both states explicitly, so expanding clears a collapsed cookie", () => {
    expect(buildNavCollapsedCookie(true, { secure: false })).toContain(
      `${NAV_COLLAPSED_COOKIE}=1`,
    );
    expect(buildNavCollapsedCookie(false, { secure: false })).toContain(
      `${NAV_COLLAPSED_COOKIE}=0`,
    );
  });

  it("omits Secure off https, where the browser would drop the cookie", () => {
    expect(buildNavCollapsedCookie(true, { secure: false })).not.toContain("Secure");
    expect(buildNavCollapsedCookie(true, { secure: true })).toContain("Secure");
  });

  it("scopes the cookie to the whole app and survives a browser restart", () => {
    const cookie = buildNavCollapsedCookie(true, { secure: false });
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toMatch(/Max-Age=\d+/);
  });
});

describe("dropStaleCollapsedWidth", () => {
  it("does nothing when the nav is collapsed — width 0 belongs there", () => {
    const { storage, removed } = fakeStorage({ [NAV_WIDTH_STORAGE_KEY]: "0" });
    dropStaleCollapsedWidth(storage, true);
    expect(removed).toEqual([]);
  });

  it("does nothing when nothing was persisted", () => {
    const { storage, removed } = fakeStorage();
    dropStaleCollapsedWidth(storage, false);
    expect(removed).toEqual([]);
  });

  it("keeps a real width the operator dragged", () => {
    const { storage, removed } = fakeStorage({ [NAV_WIDTH_STORAGE_KEY]: "248" });
    dropStaleCollapsedWidth(storage, false);
    expect(removed).toEqual([]);
  });

  it("keeps a value neither this code nor Astryx can parse", () => {
    const { storage, removed } = fakeStorage({ [NAV_WIDTH_STORAGE_KEY]: "not-json" });
    dropStaleCollapsedWidth(storage, false);
    expect(removed).toEqual([]);
  });

  it("keeps a JSON value that is not a number", () => {
    const { storage, removed } = fakeStorage({ [NAV_WIDTH_STORAGE_KEY]: '"0"' });
    dropStaleCollapsedWidth(storage, false);
    expect(removed).toEqual([]);
  });

  it("drops the width 0 left by the pre-cookie build when the cookie says expanded", () => {
    const { storage, removed, has } = fakeStorage({ [NAV_WIDTH_STORAGE_KEY]: "0" });
    dropStaleCollapsedWidth(storage, false);
    expect(removed).toEqual([NAV_WIDTH_STORAGE_KEY]);
    expect(has(NAV_WIDTH_STORAGE_KEY)).toBe(false);
  });

  it("is safe to run twice (StrictMode renders the initialiser more than once)", () => {
    const { storage } = fakeStorage({ [NAV_WIDTH_STORAGE_KEY]: "0" });
    dropStaleCollapsedWidth(storage, false);
    expect(() => dropStaleCollapsedWidth(storage, false)).not.toThrow();
  });
});
