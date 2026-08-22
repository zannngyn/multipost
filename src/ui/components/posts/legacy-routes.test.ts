import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import nextConfig from "../../../../next.config";
import { withTabParam } from "@/ui/components/navigation/tab-param";
import { LEGACY_ROUTES, legacyRedirectQuery, legacyRedirectTarget } from "./legacy-routes";

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
      // Built with the same helper the app uses, never a hand-written `tab=`:
      // spelling the parameter here would be a third copy of a name that
      // already has an owner, and the copy that fails last when it moves.
      destination: `${base}?${withTabParam("", tab)}`,
      // `permanent: false` → 307. A 308 is cached by the browser for good, which
      // is a promise an IA that is still moving cannot keep.
      permanent: false,
    }));
    // Order is the config author's business, not the contract's.
    expect(bySource(redirects ?? [])).toEqual(bySource(expected));
  });

  /**
   * The THIRD copy of the same four addresses: one page each, the defence in
   * depth for a build served without the config. A table entry with no page is
   * a promise the module docblock makes and nothing keeps.
   */
  it("has a redirect page behind every entry in the table", () => {
    for (const source of Object.keys(LEGACY_ROUTES)) {
      const page = fileURLToPath(new URL(`../../../app/(app)${source}/page.tsx`, import.meta.url));

      expect(existsSync(page), `${source} has no page.tsx behind it`).toBe(true);
      // …and it must be the SAME table: a page redirecting to a hand-written
      // path would drift from the edge rule the moment a tab is renamed.
      const contents = readFileSync(page, "utf8");
      expect(contents, `${source} does not consult the legacy table`).toContain(
        `legacyRedirectTarget("${source}"`,
      );
      expect(contents, `${source} drops repeated query parameters`).toContain(
        "legacyRedirectQuery(",
      );
    }
  });
});

/**
 * A repeated parameter is a real address, not a curiosity: a multi-select
 * filter writes one, and support threads paste them. The edge redirect carries
 * every value; the page layer has to agree, or the same link means two
 * different things depending on which layer answered it.
 */
describe("legacyRedirectQuery", () => {
  it("keeps every value of a repeated parameter, in order", () => {
    expect(legacyRedirectQuery({ status: ["failed", "blocked"] })).toBe(
      "status=failed&status=blocked",
    );
  });

  it("keeps a plain value and skips a key Next reports as absent", () => {
    expect(legacyRedirectQuery({ status: "failed", channel: undefined })).toBe("status=failed");
  });

  it("has nothing to say about an empty query", () => {
    expect(legacyRedirectQuery({})).toBe("");
    expect(legacyRedirectQuery({ ch: [] })).toBe("");
  });

  it("encodes rather than trusting the value", () => {
    expect(legacyRedirectQuery({ q: "màu & size" })).toBe("q=m%C3%A0u+%26+size");
  });

  it("survives the whole trip: repeats reach the new hub", () => {
    expect(
      legacyRedirectTarget("/jobs", legacyRedirectQuery({ status: ["failed", "blocked"] })),
    ).toBe("/posts?tab=log&status=failed&status=blocked");
  });
});
