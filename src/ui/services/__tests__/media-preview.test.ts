import { describe, expect, it } from "vitest";

import { mediaPreviewUrl } from "../media-preview";

/**
 * Edge cases first (CLAUDE.md §1): every branch that would otherwise put a
 * broken `<img src>` on screen is pinned here before the happy path.
 */
describe("mediaPreviewUrl", () => {
  it("returns null for an id that is missing, empty or only whitespace", () => {
    expect(mediaPreviewUrl(null)).toBeNull();
    expect(mediaPreviewUrl(undefined)).toBeNull();
    expect(mediaPreviewUrl("")).toBeNull();
    expect(mediaPreviewUrl("   ")).toBeNull();
  });

  it("trims the id instead of building a path with a space in it", () => {
    expect(mediaPreviewUrl("  1AbC  ")).toBe("/api/media/preview/1AbC");
  });

  it("escapes anything that would break out of the path segment", () => {
    expect(mediaPreviewUrl("a/b")).toBe("/api/media/preview/a%2Fb");
    expect(mediaPreviewUrl("a b?c=1")).toBe("/api/media/preview/a%20b%3Fc%3D1");
    expect(mediaPreviewUrl("../secret")).toBe("/api/media/preview/..%2Fsecret");
  });

  it("builds the session-authenticated path for a normal Drive id", () => {
    expect(mediaPreviewUrl("1AbCdEf-Gh_2")).toBe("/api/media/preview/1AbCdEf-Gh_2");
  });

  it("works for an uploaded asset id too — same route, same shape", () => {
    expect(mediaPreviewUrl("upload_01JX")).toBe("/api/media/preview/upload_01JX");
  });

  it("never carries a query string — a preview link must not be a bearer token", () => {
    const url = mediaPreviewUrl("1AbC");
    expect(url).not.toBeNull();
    expect(url).not.toContain("?");
    expect(url?.toLowerCase()).not.toContain("sig");
  });
});
