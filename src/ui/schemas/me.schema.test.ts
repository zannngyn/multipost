import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_TENANT_KEY,
  MeResponseSchema,
  SetActiveTenantResponseSchema,
  accountDisplayName,
  planLabel,
  tenantCacheKey,
} from "./me.schema";

/**
 * Edge cases first (CLAUDE.md technical rule 1). `/api/me` decides which company
 * every other request belongs to, so the two failures that matter are:
 *  - a payload that half-parses (the UI would work in the wrong company);
 *  - a cache key that collapses two companies into one bucket.
 */

/** Recorded from the running API (GET /api/me) — the real contract. */
const LIVE_PAYLOAD = {
  account: {
    id: "8c4e1b70-91d2-4f0a-a0f2-7d3c5e9b1a02",
    displayName: "Nguyen Van A",
    platformRole: null,
  },
  tenants: [
    {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Nhà Xe An Anh",
      slug: "an-anh",
      plan: "free",
      role: "owner",
    },
  ],
  activeTenantId: "00000000-0000-0000-0000-000000000001",
  isBootstrapAdmin: false,
};

describe("MeResponseSchema", () => {
  it("accepts the payload the API actually returns", () => {
    const parsed = MeResponseSchema.safeParse(LIVE_PAYLOAD);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.tenants[0]?.role).toBe("owner");
  });

  it("accepts a session with no account row (env bootstrap / dev bypass)", () => {
    const parsed = MeResponseSchema.safeParse({
      account: null,
      tenants: [],
      activeTenantId: null,
      isBootstrapAdmin: true,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.isBootstrapAdmin).toBe(true);
  });

  it("accepts NoMembership — belonging to nothing is a state, not an error", () => {
    const parsed = MeResponseSchema.safeParse({
      account: { id: "a1", displayName: null, platformRole: null },
      tenants: [],
      activeTenantId: null,
    });
    expect(parsed.success).toBe(true);
    // The flag is being added server-side in parallel; its absence must not
    // lock anyone out, so it defaults to the safe answer.
    expect(parsed.success && parsed.data.isBootstrapAdmin).toBe(false);
  });

  it("rejects a bootstrap flag that is present but not a boolean", () => {
    const parsed = MeResponseSchema.safeParse({ ...LIVE_PAYLOAD, isBootstrapAdmin: "yes" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a membership role the UI cannot render", () => {
    const parsed = MeResponseSchema.safeParse({
      ...LIVE_PAYLOAD,
      tenants: [{ ...LIVE_PAYLOAD.tenants[0], role: "superuser" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a company with no id — the cache key would collapse", () => {
    const parsed = MeResponseSchema.safeParse({
      ...LIVE_PAYLOAD,
      tenants: [{ ...LIVE_PAYLOAD.tenants[0], id: "" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a company with no slug", () => {
    const parsed = MeResponseSchema.safeParse({
      ...LIVE_PAYLOAD,
      tenants: [{ ...LIVE_PAYLOAD.tenants[0], slug: null }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("SetActiveTenantResponseSchema", () => {
  it("requires the company that is now active", () => {
    expect(SetActiveTenantResponseSchema.safeParse({ activeTenantId: "t-1" }).success).toBe(true);
    expect(SetActiveTenantResponseSchema.safeParse({ activeTenantId: "" }).success).toBe(false);
    expect(SetActiveTenantResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe("tenantCacheKey", () => {
  it("keeps two companies in two buckets", () => {
    expect(tenantCacheKey("t-1")).not.toBe(tenantCacheKey("t-2"));
  });

  it("gives a session with no company its own bucket, never a shared empty one", () => {
    expect(tenantCacheKey(null)).toBe(BOOTSTRAP_TENANT_KEY);
    expect(tenantCacheKey(null)).not.toBe("");
    // A tenant id is a UUID, so it can never collide with the sentinel.
    expect(tenantCacheKey("00000000-0000-0000-0000-000000000001")).not.toBe(BOOTSTRAP_TENANT_KEY);
  });
});

describe("labels", () => {
  it("never renders an empty plan or an empty operator name", () => {
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("   ")).toBe("Không rõ gói");
    expect(accountDisplayName(undefined, "a@mysp.vn")).toBe("a@mysp.vn");
    expect(
      accountDisplayName(MeResponseSchema.parse(LIVE_PAYLOAD), "a@mysp.vn"),
    ).toBe("Nguyen Van A");
  });
});
