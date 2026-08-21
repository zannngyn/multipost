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
});
