import { describe, expect, it } from "vitest";
import { legacyRedirectTarget } from "./legacy-routes";

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
