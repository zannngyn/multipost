import { describe, expect, it } from "vitest";

import {
  OUT_OF_TENANT_LABEL,
  isPlatformContext,
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

  it("keeps the operator-facing wording in one place", () => {
    expect(OUT_OF_TENANT_LABEL).toBe("Ngoài công ty — màn quản trị MYSP");
  });
});
