import { beforeEach, describe, expect, it, vi } from "vitest";

import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * The boundary of GET /api/catalog/sync-status (docs/07 §3.3): a bad
 * `recentLimit` must become a 400 with a Vietnamese message HERE, before the
 * usecase and the database see it.
 *
 * Since M1.3b the boundary also authorises: the tenant comes from the
 * membership (viewer, tier R), so the refusals are checked BEFORE the query
 * string — a caller with no membership must not learn which filters are valid.
 *
 * The composition root is mocked because this test is about the route; the
 * usecase re-checks the range and has its own tests.
 */

const getSyncStatus = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();
const requireTenant = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { getSyncStatus, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";

let claim: { tier?: string; minRole?: string } = {};

function grantRole(role: OperatorRole): void {
  requireTenant.mockImplementation(
    (
      _session: unknown,
      cookieTenantId: string | null,
      options: { tier: string; minRole?: OperatorRole },
    ) => {
      claim = { tier: options.tier, ...(options.minRole ? { minRole: options.minRole } : {}) };
      if (cookieTenantId && cookieTenantId !== TENANT) {
        throw new AppError("TENANT_NOT_FOUND", { context: { tenant_id: cookieTenantId } });
      }
      if (options.minRole && !roleAtLeast(role, options.minRole)) {
        throw new AppError("FORBIDDEN", { context: { required_role: options.minRole } });
      }
      return Promise.resolve({ tenantId: TENANT, role, membershipVersion: 1 });
    },
  );
}

function request(query: string, cookieTenantId: string | null = TENANT): Request {
  const headers = new Headers();
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  return new Request(`http://localhost/api/catalog/sync-status${query}`, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  claim = {};
  getOperatorSession.mockResolvedValue({ email: "staff@shop.vn", accountId: "acc-1" });
  getSyncStatus.mockResolvedValue(null);
  grantRole("viewer");
});

// --- Edge cases first ---------------------------------------------------------

describe("GET /api/catalog/sync-status — authorisation", () => {
  it("401s without a session, before the query string is looked at", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await GET(request("?recentLimit=999"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    expect(getSyncStatus).not.toHaveBeenCalled();
  });

  it("404s a selector cookie pointing at a company the account is not in", async () => {
    const response = await GET(request("", OTHER_TENANT));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TENANT_NOT_FOUND" });
    expect(getSyncStatus).not.toHaveBeenCalled();
  });

  it("claims tier R + viewer, and ignores a tenantId left over in the query", async () => {
    const response = await GET(request(`?tenantId=${OTHER_TENANT}`));

    expect(response.status).toBe(200);
    expect(claim).toEqual({ tier: "R", minRole: "viewer" });
    expect(getSyncStatus).toHaveBeenCalledWith({ tenantId: TENANT, recentLimit: undefined });
  });
});

describe("GET /api/catalog/sync-status — recentLimit boundary", () => {
  // The literals mirror MAX_RECENT_RUNS = 20 in core/usecases/get-sync-status.ts.
  it.each([
    ["?recentLimit=", "empty string"],
    ["?recentLimit=abc", "not a number"],
    ["?recentLimit=0", "below the range"],
    ["?recentLimit=21", "above the range"],
    ["?recentLimit=-3", "negative"],
    ["?recentLimit=2.5", "fractional"],
  ])("rejects %s (%s) with 400 before calling the usecase", async (query) => {
    const response = await GET(request(query));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.message.length).toBeGreaterThan(0);
    expect(getSyncStatus).not.toHaveBeenCalled();
  });

  it.each([1, 5, 6, 20])("passes a valid recentLimit=%s straight through", async (limit) => {
    const response = await GET(request(`?recentLimit=${limit}`));

    expect(response.status).toBe(200);
    expect(getSyncStatus).toHaveBeenCalledWith({ tenantId: TENANT, recentLimit: limit });
  });

  it("omits recentLimit entirely when the caller does not ask for one", async () => {
    const response = await GET(request(""));

    expect(response.status).toBe(200);
    // `undefined`, not 0 or 5: the DEFAULT belongs to the usecase, not here.
    expect(getSyncStatus).toHaveBeenCalledWith({ tenantId: TENANT, recentLimit: undefined });
  });
});

describe("GET /api/catalog/sync-status — answers", () => {
  it("turns 'never synced' into a 200 empty state, not an error", async () => {
    getSyncStatus.mockResolvedValue(null);

    const response = await GET(request(""));

    expect(response.status).toBe(200);
    // Same shape as before M1.3b — the echoed tenant is now the authorised one.
    await expect(response.json()).resolves.toEqual({ state: "never_synced", tenantId: TENANT });
  });

  it("returns the run as-is, including a null issueGroups", async () => {
    getSyncStatus.mockResolvedValue({ syncRunId: "run-1", issueGroups: null, recentRuns: [] });

    const response = await GET(request(""));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "has_run",
      run: { syncRunId: "run-1", issueGroups: null, recentRuns: [] },
    });
  });
});
