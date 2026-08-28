import { describe, expect, it } from "vitest";

import {
  OAUTH_RETURN_COOKIE,
  buildOauthReturnCookie,
  readOauthReturn,
  resolveReturnScreen,
} from "../oauth-return-cookie";

/**
 * Both OAuth callbacks hardcoded where the browser lands. The onboarding
 * slideshow needs them to land back on IT, without losing the behaviour every
 * other entry point relies on.
 *
 * The cookie is the whole mechanism, so its edge cases are the whole risk.
 */

function requestWithCookie(value: string): Request {
  return new Request("https://example.test/api/catalog/google/callback", {
    headers: { cookie: value },
  });
}

describe("buildOauthReturnCookie", () => {
  it("is Lax so it survives the top-level redirect back from the provider", () => {
    // Strict would drop the cookie on the cross-site navigation home and every
    // onboarding connect would silently land on the old screen.
    expect(buildOauthReturnCookie("onboarding", { secure: true })).toContain("SameSite=Lax");
  });

  it("is HttpOnly and scoped to the whole site", () => {
    const cookie = buildOauthReturnCookie("onboarding", { secure: true });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
  });

  it("omits Secure off production so a plain-http dev box still works", () => {
    // Same reason `buildGoogleStateCookie` does it: a Secure cookie is invisible
    // over http and every connect would fail on the round trip.
    expect(buildOauthReturnCookie("onboarding", { secure: false })).not.toContain("Secure");
  });

  it("expires the cookie when cleared", () => {
    expect(buildOauthReturnCookie(null, { secure: true })).toContain("Max-Age=0");
  });
});

describe("readOauthReturn", () => {
  it("reads the flag when present", () => {
    expect(readOauthReturn(requestWithCookie(`${OAUTH_RETURN_COOKIE}=onboarding`))).toBe(
      "onboarding",
    );
  });

  it("reads it from among other cookies", () => {
    expect(readOauthReturn(requestWithCookie(`a=1; ${OAUTH_RETURN_COOKIE}=onboarding; b=2`))).toBe(
      "onboarding",
    );
  });

  it("returns null for an unknown value rather than trusting it", () => {
    expect(
      readOauthReturn(requestWithCookie(`${OAUTH_RETURN_COOKIE}=https://evil.test`)),
    ).toBeNull();
  });

  it("returns null when there is no cookie header at all", () => {
    expect(readOauthReturn(new Request("https://example.test/x"))).toBeNull();
  });
});

describe("resolveReturnScreen", () => {
  it("keeps the historic screen when the flow did not start in onboarding", () => {
    expect(
      resolveReturnScreen({
        request: new Request("https://example.test/x"),
        defaultScreen: "/sync",
        onboardingStep: "data",
        query: "google=connected",
      }),
    ).toBe("/sync?google=connected");
  });

  it("routes back into the slideshow when it did", () => {
    expect(
      resolveReturnScreen({
        request: requestWithCookie(`${OAUTH_RETURN_COOKIE}=onboarding`),
        defaultScreen: "/sync",
        onboardingStep: "data",
        query: "google=connected",
      }),
    ).toBe("/onboarding?step=data&google=connected");
  });

  it("routes the CANCELLED and ERROR branches back too", () => {
    // A cancelled connect that dropped the operator on /sync mid-slideshow is
    // the bug this whole mechanism exists to prevent.
    expect(
      resolveReturnScreen({
        request: requestWithCookie(`${OAUTH_RETURN_COOKIE}=onboarding`),
        defaultScreen: "/sync",
        onboardingStep: "data",
        query: "google=error&reason=STATE_MISMATCH",
      }),
    ).toBe("/onboarding?step=data&google=error&reason=STATE_MISMATCH");
  });
});
