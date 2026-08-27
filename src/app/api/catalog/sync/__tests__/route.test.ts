import { beforeEach, describe, expect, it, vi } from "vitest";

import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * M1.3b — the authorisation boundary of `POST /api/catalog/sync`.
 *
 * A sync spends the tenant's Drive/Sheets quota and rewrites the whole catalog,
 * so: editor minimum, tier S (fresh membership), and the tenant comes from the
 * membership — a `tenantId` in the body is ignored, and no body at all is fine
 * (the field is gone; docs/11 §3.2).
 */

const syncCatalog = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();
const requireTenant = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { syncCatalog, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { POST } = await import("../route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";

const RESULT = {
  syncRunId: "run-1",
  status: "success",
  counts: { products: 3, media: 9 },
  issues: [],
  issueGroups: null,
  schemaDrift: null,
};

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

/** `body === undefined` = the M1.4 UI, which sends nothing at all. */
function post(body?: unknown, cookieTenantId: string | null = TENANT): Request {
  const headers = new Headers();
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  if (body === undefined) return new Request("http://localhost/api/catalog/sync", { method: "POST", headers });

  headers.set("content-type", "application/json");
  return new Request("http://localhost/api/catalog/sync", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  claim = {};
  getOperatorSession.mockResolvedValue({ email: "staff@shop.vn", accountId: "acc-1" });
  syncCatalog.mockResolvedValue(RESULT);
  grantRole("editor");
});

// --- Edge cases first ---------------------------------------------------------

describe("POST /api/catalog/sync — refusals", () => {
  it("401s without a session, and never spends Drive quota", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await POST(post());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    expect(requireTenant).not.toHaveBeenCalled();
    expect(syncCatalog).not.toHaveBeenCalled();
  });

  it("404s a selector cookie pointing at a company the account is not in", async () => {
    const response = await POST(post(undefined, OTHER_TENANT));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TENANT_NOT_FOUND" });
    expect(syncCatalog).not.toHaveBeenCalled();
  });

  it("403s a viewer: a sync costs money and rewrites the catalog", async () => {
    grantRole("viewer");

    const response = await POST(post());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    expect(syncCatalog).not.toHaveBeenCalled();
  });

  it("claims tier S + editor — no cached membership may authorise a sync", async () => {
    await POST(post());

    expect(claim).toEqual({ tier: "S", minRole: "editor" });
  });

  it("passes SYNC_SOURCE_EMPTY through as 409, not as a success", async () => {
    syncCatalog.mockRejectedValue(new AppError("SYNC_SOURCE_EMPTY"));

    const response = await POST(post());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "SYNC_SOURCE_EMPTY" });
  });
});

describe("POST /api/catalog/sync — the run", () => {
  it("syncs the membership tenant when the old UI still sends another one", async () => {
    const response = await POST(post({ tenantId: OTHER_TENANT }));

    expect(response.status).toBe(200);
    expect(syncCatalog).toHaveBeenCalledWith({ tenantId: TENANT });
  });

  it("accepts a request with no body at all", async () => {
    const response = await POST(post());

    expect(response.status).toBe(200);
    expect(syncCatalog).toHaveBeenCalledWith({ tenantId: TENANT });
  });

  it("keeps the response shape the sync screen parses", async () => {
    const response = await POST(post());

    await expect(response.json()).resolves.toEqual(RESULT);
  });
});
