import { describe, expect, it } from "vitest";

import nextConfig from "../../../../next.config";
import { LEGACY_ROUTES, legacyRedirectTarget } from "./legacy-routes";

describe("legacyRedirectTarget", () => {
  it("maps the four retired routes and keeps the query string", () => {
    expect(legacyRedirectTarget("/scheduled", "channel=c1&view=calendar")).toBe(
      "/posts?tab=scheduled&channel=c1&view=calendar",
    );
    expect(legacyRedirectTarget("/jobs", "status=failed")).toBe("/posts?tab=log&status=failed");
    expect(legacyRedirectTarget("/channels/groups", "")).toBe("/channels?tab=groups");
    expect(legacyRedirectTarget("/access", "status=approved")).toBe(
      "/members?tab=history&status=approved",
    );
  });
  it("tolerates a leading '?' and drops a stale tab carried by the old address", () => {
    expect(legacyRedirectTarget("/scheduled", "?channel=c1")).toBe(
      "/posts?tab=scheduled&channel=c1",
    );
    // A bookmark of `/scheduled?tab=log` used to arrive as `?tab=scheduled&tab=log`
    // — two answers to one question, and the hub reads whichever comes first.
    expect(legacyRedirectTarget("/scheduled", "tab=log&status=failed")).toBe(
      "/posts?tab=scheduled&status=failed",
    );
  });

  it("returns null for live routes", () => {
    expect(legacyRedirectTarget("/posts", "")).toBeNull();
    expect(legacyRedirectTarget("/jobsomething", "")).toBeNull();
  });

  /**
   * A pathname is untrusted input. Read with plain indexing, the table inherits
   * Object.prototype and answers "constructor" with a function — which used to
   * come back out as the target "undefined?tab=undefined", i.e. a redirect to a
   * route that does not exist.
   */
  it("returns null for keys inherited from Object.prototype", () => {
    expect(legacyRedirectTarget("__proto__", "")).toBeNull();
    expect(legacyRedirectTarget("constructor", "")).toBeNull();
    expect(legacyRedirectTarget("toString", "status=failed")).toBeNull();
    expect(legacyRedirectTarget("hasOwnProperty", "")).toBeNull();
  });
});

/**
 * The edge layer and the page layer must name the same four addresses.
 *
 * `next.config.ts` cannot import this table (it is loaded outside the app's
 * module graph, without the `@/` alias), so the two are spelled separately —
 * and a table spelled twice drifts. This is the seam that fails when it does:
 * a route added to one side and forgotten on the other either 404s at the edge
 * or silently loses its second line of defence.
 */
describe("next.config redirects() ↔ the legacy table", () => {
  it("redirects every retired address, to the same hub and tab, as a 307", async () => {
    const redirects = await nextConfig.redirects?.();
    expect(redirects, "next.config.ts no longer declares redirects()").toBeDefined();

    const bySource = <T extends { source: string }>(rules: T[]) =>
      [...rules].sort((a, b) => a.source.localeCompare(b.source));
    const expected = Object.entries(LEGACY_ROUTES).map(([source, { base, tab }]) => ({
      source,
      destination: `${base}?tab=${tab}`,
      // `permanent: false` → 307. A 308 is cached by the browser for good, which
      // is a promise an IA that is still moving cannot keep.
      permanent: false,
    }));
    // Order is the config author's business, not the contract's.
    expect(bySource(redirects ?? [])).toEqual(bySource(expected));
  });
});
