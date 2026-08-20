import { beforeEach, describe, expect, it, vi } from "vitest";

import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * M1.3b — the authorisation boundary of `/api/catalog/source`.
 *
 * What is being proved: the tenant comes from the MEMBERSHIP, never from the
 * request, and PUT (tier S, admin) refuses before it parses a payload. A
 * `tenantId` an old UI build still sends must be ignored in silence, not
 * rejected — the UI only lands in M1.4 (docs/11 §3.2).
 */

const getCatalogSource = vi.fn();
const updateCatalogSource = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();
const requireTenant = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { getCatalogSource, updateCatalogSource, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET, PUT } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
/** The company the caller is NOT a member of — the forged selector. */
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";

const SOURCE = { driveFolderId: "folder-1", spreadsheetId: "sheet-1", sheetName: "Mẫu 2026" };

/** Captured so a test can assert WHICH claim the route made (tier + minRole). */
let claim: { tier?: string; minRole?: string } = {};

/**
 * Stands in for the real gate: same order of refusals (doc 10 §3), so a route
 * declaring the wrong `minRole` fails here instead of in production.
 */
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

function get(query = "", cookieTenantId: string | null = TENANT): Request {
  const headers = new Headers();
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  return new Request(`http://localhost/api/catalog/source${query}`, { headers });
}

function put(body: unknown, cookieTenantId: string | null = TENANT): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  return new Request("http://localhost/api/catalog/source", {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  driveFolder: "https://drive.google.com/drive/folders/folder-1",
  spreadsheet: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
  sheetName: "Mẫu 2026",
};

beforeEach(() => {
  vi.clearAllMocks();
  claim = {};
  getOperatorSession.mockResolvedValue({ email: "boss@shop.vn", accountId: "acc-1" });
  getCatalogSource.mockResolvedValue(SOURCE);
  updateCatalogSource.mockResolvedValue(SOURCE);
  grantRole("admin");
});

// --- Edge cases first ---------------------------------------------------------

describe("PUT /api/catalog/source — refusals", () => {
  it("401s without a session, before the body is read", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await PUT(put(VALID_BODY));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    expect(requireTenant).not.toHaveBeenCalled();
    expect(updateCatalogSource).not.toHaveBeenCalled();
  });

  it("404s a selector cookie pointing at a company the account is not in", async () => {
    const response = await PUT(put(VALID_BODY, OTHER_TENANT));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TENANT_NOT_FOUND" });
    expect(updateCatalogSource).not.toHaveBeenCalled();
  });

  it("403s an editor: changing the source is admin work (doc 10 §4.1)", async () => {
    grantRole("editor");

    const response = await PUT(put(VALID_BODY));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    expect(updateCatalogSource).not.toHaveBeenCalled();
  });

  it("claims tier S + admin — the membership is never served from a cache", async () => {
    await PUT(put(VALID_BODY));

    expect(claim).toEqual({ tier: "S", minRole: "admin" });
  });

  it("400s a body missing the sheet name, and writes nothing", async () => {
    const response = await PUT(put({ ...VALID_BODY, sheetName: "  " }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_INPUT" });
    expect(updateCatalogSource).not.toHaveBeenCalled();
  });
});

describe("PUT /api/catalog/source — the write", () => {
  it("uses the membership tenant and the session e-mail, ignoring both in the body", async () => {
    const response = await PUT(put({ ...VALID_BODY, tenantId: OTHER_TENANT, actorEmail: "evil@x" }));

    expect(response.status).toBe(200);
    expect(updateCatalogSource).toHaveBeenCalledWith({
      tenantId: TENANT,
      driveFolder: VALID_BODY.driveFolder,
      spreadsheet: VALID_BODY.spreadsheet,
      sheetName: VALID_BODY.sheetName,
      actorEmail: "boss@shop.vn",
    });
  });

  it("keeps the response shape, echoing the AUTHORISED tenant", async () => {
    const response = await PUT(put(VALID_BODY));

    await expect(response.json()).resolves.toEqual({
      state: "configured",
      tenantId: TENANT,
      source: SOURCE,
    });
  });
});

describe("GET /api/catalog/source", () => {
  it("401s without a session", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await GET(get());

    expect(response.status).toBe(401);
    expect(getCatalogSource).not.toHaveBeenCalled();
  });

  it("404s a forged selector cookie", async () => {
    const response = await GET(get("", OTHER_TENANT));

    expect(response.status).toBe(404);
    expect(getCatalogSource).not.toHaveBeenCalled();
  });

  it("claims tier R + viewer, and reads the membership tenant", async () => {
    grantRole("viewer");

    const response = await GET(get(`?tenantId=${OTHER_TENANT}`));

    expect(response.status).toBe(200);
    expect(claim).toEqual({ tier: "R", minRole: "viewer" });
    // The query string still carries a tenant id from the old UI: ignored.
    expect(getCatalogSource).toHaveBeenCalledWith({ tenantId: TENANT });
  });

  it("keeps 'not_configured' a 200 empty state — never the 404 of a missing membership", async () => {
    getCatalogSource.mockResolvedValue(null);

    const response = await GET(get());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "not_configured",
      tenantId: TENANT,
    });
  });
});
