import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRedirectOrigin } from "./redirect-origin";

/**
 * The last hop of an OAuth callback.
 *
 * Written after a live failure on staging: the Drive credential was stored
 * correctly and the operator was then redirected to `https://0.0.0.0:3000/sync`
 * — the container's own bind, arriving as the request Host through the tunnel —
 * where the browser answered ERR_SSL_PROTOCOL_ERROR. The work had succeeded;
 * only the redirect was wrong, which is why nothing in the logs looked broken.
 */

function logger() {
  return { warn: vi.fn(), error: vi.fn() };
}

const REQUEST_FROM_INSIDE_THE_CONTAINER = new URL("https://0.0.0.0:3000/api/catalog/google/callback");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveRedirectOrigin", () => {
  it("ignores the request Host and answers the deployment's public origin", () => {
    vi.stubEnv("AUTH_URL", "https://mysp-stg.vannt.asia");
    const log = logger();

    const origin = resolveRedirectOrigin(REQUEST_FROM_INSIDE_THE_CONTAINER, log, "ROUTE");

    expect(origin).toBe("https://mysp-stg.vannt.asia");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("keeps only the origin when AUTH_URL carries a path", () => {
    vi.stubEnv("AUTH_URL", "https://mysp-stg.vannt.asia/some/path");

    expect(resolveRedirectOrigin(REQUEST_FROM_INSIDE_THE_CONTAINER, logger(), "ROUTE")).toBe(
      "https://mysp-stg.vannt.asia",
    );
  });

  // --- The fallback, and why it is loud --------------------------------------
  it("falls back to the request origin rather than throwing on a missing AUTH_URL", () => {
    // This runs on the ONLY exit these routes have: a throw here would put a
    // 500 on top of whatever else went wrong, mid-navigation.
    vi.stubEnv("AUTH_URL", "");
    const log = logger();

    const origin = resolveRedirectOrigin(REQUEST_FROM_INSIDE_THE_CONTAINER, log, "ROUTE");

    expect(origin).toBe("https://0.0.0.0:3000");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[1]).toMatchObject({
      error_code: "APP_ORIGIN_UNAVAILABLE",
      route: "ROUTE",
    });
  });

  it("treats a malformed AUTH_URL the same way, and says so", () => {
    vi.stubEnv("AUTH_URL", "not-a-url");
    const log = logger();

    expect(resolveRedirectOrigin(REQUEST_FROM_INSIDE_THE_CONTAINER, log, "ROUTE")).toBe(
      "https://0.0.0.0:3000",
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
