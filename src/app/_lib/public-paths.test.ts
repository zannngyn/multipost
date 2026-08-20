import { describe, expect, it } from "vitest";

import { isPublicPath } from "./public-paths";

/**
 * The session guard's allowlist. The case this file exists for: the bare
 * `/api/media` PREFIX once swallowed the session-backed
 * `/api/media/preview/**` into the public set by accident — only the exact
 * tier-P shape (`/api/media/<one-segment>`) may skip the guard.
 */

describe("isPublicPath — the media boundary", () => {
  // --- (a) tier P stays public: Meta's fetcher carries no cookie -------------
  it("keeps /api/media/<one-segment> public", () => {
    expect(isPublicPath("/api/media/abc123")).toBe(true);
    expect(isPublicPath("/api/media/upload_9f2ab")).toBe(true);
  });

  // --- (b) the session-backed preview goes through the guard -----------------
  it("does NOT let /api/media/preview/** skip the guard", () => {
    expect(isPublicPath("/api/media/preview/abc123")).toBe(false);
    expect(isPublicPath("/api/media/preview")).toBe(false);
  });

  it("does not let the bare collection or deeper nestings through either", () => {
    expect(isPublicPath("/api/media")).toBe(false);
    expect(isPublicPath("/api/media/abc/def")).toBe(false);
  });
});

describe("isPublicPath — the rest of the allowlist", () => {
  it("keeps the sign-in door and the auth/health prefixes public", () => {
    expect(isPublicPath("/signin")).toBe(true);
    expect(isPublicPath("/api/auth/callback/google")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
  });

  it("does not mistake lookalike prefixes", () => {
    expect(isPublicPath("/signin-help")).toBe(false);
    expect(isPublicPath("/api/authx")).toBe(false);
  });

  it("guards everything else", () => {
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/api/posts/batches")).toBe(false);
    expect(isPublicPath("/join/sometoken")).toBe(false);
  });
});
