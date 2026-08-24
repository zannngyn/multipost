import { describe, expect, it } from "vitest";

import { flattenNavItems } from "@/ui/components/shell/nav-items";
import {
  OUT_OF_TENANT_LABEL,
  PLATFORM_ROOT,
  isPlatformContext,
  shouldShowOutOfTenantBadge,
} from "@/ui/components/shell/platform-context";

describe("isPlatformContext", () => {
  // Edge cases first: the shell renders this on every route change, including
  // the ones where Next has no pathname to give yet.
  it("says no when there is no pathname", () => {
    expect(isPlatformContext(null)).toBe(false);
    expect(isPlatformContext(undefined)).toBe(false);
    expect(isPlatformContext("")).toBe(false);
  });

  it("does not match a route that merely starts with the same letters", () => {
    expect(isPlatformContext("/platformer")).toBe(false);
    expect(isPlatformContext("/platform-admin")).toBe(false);
  });

  it("does not match a nested route of another section", () => {
    expect(isPlatformContext("/products/platform")).toBe(false);
    expect(isPlatformContext("/")).toBe(false);
    expect(isPlatformContext("/members")).toBe(false);
  });

  it("matches /platform and everything under it, trailing slash or not", () => {
    expect(isPlatformContext("/platform")).toBe(true);
    expect(isPlatformContext("/platform/")).toBe(true);
    expect(isPlatformContext("/platform/tenants")).toBe(true);
    expect(isPlatformContext("/platform/tenants/abc-123")).toBe(true);
  });

  // The badge and the nav must point at the SAME path. Move the nav entry and
  // this goes red, instead of the badge quietly never appearing again.
  it("is locked to the path the nav actually links to", () => {
    expect(flattenNavItems().some((item) => item.href === PLATFORM_ROOT)).toBe(true);
  });

  it("keeps the operator-facing wording in one place", () => {
    expect(OUT_OF_TENANT_LABEL).toBe("Ngoài công ty — màn quản trị MYSP");
  });
});

/**
 * The badge's whole condition. It used to be two `if`s inside the component,
 * where the only way to check them was to render a client component with a
 * router and a query client — so nobody did.
 */
describe("shouldShowOutOfTenantBadge", () => {
  it("stays quiet on every screen that IS about the current company", () => {
    expect(shouldShowOutOfTenantBadge({ pathname: "/", platformRole: "super_admin" })).toBe(false);
    expect(shouldShowOutOfTenantBadge({ pathname: "/members", platformRole: "support" })).toBe(
      false,
    );
    // Not a platform route, however much it looks like one.
    expect(shouldShowOutOfTenantBadge({ pathname: "/platformer", platformRole: "support" })).toBe(
      false,
    );
  });

  it("stays quiet for an account that cannot open the platform screens", () => {
    // They would get PlatformForbidden at this URL: the badge would describe a
    // screen they cannot see.
    expect(shouldShowOutOfTenantBadge({ pathname: "/platform", platformRole: null })).toBe(false);
    expect(shouldShowOutOfTenantBadge({ pathname: "/platform", platformRole: "" })).toBe(false);
  });

  it("stays quiet while /api/me is still loading", () => {
    // `undefined` is "not known yet". Painting the badge now and removing it a
    // moment later is the flicker the nav rule avoids too.
    expect(shouldShowOutOfTenantBadge({ pathname: "/platform", platformRole: undefined })).toBe(
      false,
    );
  });

  it("survives a route change with no pathname yet", () => {
    expect(shouldShowOutOfTenantBadge({ pathname: null, platformRole: "super_admin" })).toBe(false);
    expect(shouldShowOutOfTenantBadge({ pathname: undefined, platformRole: "support" })).toBe(false);
  });

  it("shows on the platform screens for an account that holds a role", () => {
    expect(shouldShowOutOfTenantBadge({ pathname: "/platform", platformRole: "super_admin" })).toBe(
      true,
    );
    expect(
      shouldShowOutOfTenantBadge({ pathname: "/platform/tenants/abc", platformRole: "support" }),
    ).toBe(true);
  });
});
