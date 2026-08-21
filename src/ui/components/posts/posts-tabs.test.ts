import { describe, expect, it } from "vitest";

import { DEFAULT_POSTS_TAB, parsePostsTab } from "@/ui/components/posts/posts-tabs";

describe("parsePostsTab", () => {
  // Edge cases first: `?tab=` is untrusted input, and every one of these used
  // to be a URL an operator could hit by editing the address bar.
  it("falls back to the default tab for anything that is not a tab", () => {
    expect(parsePostsTab(undefined)).toBe(DEFAULT_POSTS_TAB);
    expect(parsePostsTab(null)).toBe(DEFAULT_POSTS_TAB);
    expect(parsePostsTab("")).toBe(DEFAULT_POSTS_TAB);
    expect(parsePostsTab("Log")).toBe(DEFAULT_POSTS_TAB);
    expect(parsePostsTab(["log", "scheduled"])).toBe(DEFAULT_POSTS_TAB);
    expect(parsePostsTab("__proto__")).toBe(DEFAULT_POSTS_TAB);
  });

  it("keeps the two real tabs", () => {
    expect(parsePostsTab("scheduled")).toBe("scheduled");
    expect(parsePostsTab("log")).toBe("log");
  });
});
