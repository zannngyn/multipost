import { describe, expect, it } from "vitest";

import { isTenantIndependentPath } from "./tenant-independent-paths";

/**
 * Edge cases first. This rule decides whether `TenantBoundary` steps aside, so
 * a match that is too WIDE would let a tenant-scoped screen render with no
 * company established, and one too NARROW would lock a platform admin with no
 * membership out of the only screen they came for.
 */
describe("isTenantIndependentPath", () => {
  it("lets the platform screen and its sub-paths through", () => {
    expect(isTenantIndependentPath("/platform")).toBe(true);
    expect(isTenantIndependentPath("/platform/")).toBe(true);
    expect(isTenantIndependentPath("/platform/tenants/abc")).toBe(true);
  });

  it("keeps every tenant-scoped screen behind the boundary", () => {
    // Live routes since the wave-1 IA: "/channels/groups" and "/access" are now
    // redirects into "/channels?tab=groups" and "/members?tab=history", so the
    // two hubs are what this rule has to keep behind the boundary. Both hubs
    // are listed below, so nothing lost its cover.
    for (const path of ["/", "/members", "/sync", "/channels", "/posts"]) {
      expect(isTenantIndependentPath(path)).toBe(false);
    }
  });

  it("is segment-aware: a look-alike prefix must not slip past", () => {
    // The classic hole: startsWith("/platform") would open this one up.
    expect(isTenantIndependentPath("/platformx")).toBe(false);
    expect(isTenantIndependentPath("/platform-admin")).toBe(false);
  });

  it("survives an empty or odd pathname instead of throwing", () => {
    expect(isTenantIndependentPath("")).toBe(false);
    expect(isTenantIndependentPath("/")).toBe(false);
  });
});
