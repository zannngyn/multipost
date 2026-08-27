import { beforeEach, describe, expect, it, vi } from "vitest";

import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * M1.4 — field-level visibility of `GET /api/catalog/google/status`
 * (doc 10 §4.1 + Q8.3).
 *
 * Two rules are under test, and they pull in opposite directions:
 *   1. every member sees `state`, all three values — a viewer must be able to
 *      read "kết nối đã hết hạn" off the screen without asking anyone;
 *   2. nobody below admin sees WHICH Google account it is, what it was granted,
 *      or whether it can still read the source — and the fields are OMITTED,
 *      never blanked, so "hidden" cannot be mistaken for "not connected".
 */

const getGoogleConnection = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();
const requireTenant = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { connectGoogleDrive: { getGoogleConnection }, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("../route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";

const CONNECTED = {
  state: "connected",
  email: "kho@shop.vn",
  connectedAt: "2026-08-01T03:00:00.000Z",
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  sourceAccess: { folder: "ok", spreadsheet: "ok" },
};

const EXPIRED = {
  state: "expired",
  email: "kho@shop.vn",
  connectedAt: "2026-08-01T03:00:00.000Z",
  reason: "GOOGLE_AUTH_EXPIRED",
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

function request(cookieTenantId: string | null = TENANT): Request {
  const headers = new Headers();
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  return new Request("http://localhost/api/catalog/google/status", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  claim = {};
  getOperatorSession.mockResolvedValue({ email: "staff@shop.vn", accountId: "acc-1" });
  getGoogleConnection.mockResolvedValue(CONNECTED);
  grantRole("viewer");
});

// --- Edge cases first ---------------------------------------------------------

describe("GET /api/catalog/google/status — refusals", () => {
  it("401s without a session", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(getGoogleConnection).not.toHaveBeenCalled();
  });

  it("404s a selector cookie pointing at a company the account is not in", async () => {
    const response = await GET(request(OTHER_TENANT));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TENANT_NOT_FOUND" });
    expect(getGoogleConnection).not.toHaveBeenCalled();
  });

  it("claims tier R + viewer — the screen polls it, a member may read it", async () => {
    await GET(request());

    expect(claim).toEqual({ tier: "R", minRole: "viewer" });
  });
});

describe("GET /api/catalog/google/status — what a viewer may see", () => {
  it("gives a viewer the state and OMITS every credential field", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).toEqual({ state: "connected" });
    // Omitted, not blanked: a key present with "" would read as "not connected".
    expect(Object.keys(body)).toEqual(["state"]);
    expect(JSON.stringify(body)).not.toContain("kho@shop.vn");
  });

  it("gives an editor no more than a viewer — the ladder starts at admin", async () => {
    grantRole("editor");

    const response = await GET(request());

    await expect(response.json()).resolves.toEqual({ state: "connected" });
  });

  it("still tells a viewer the connection EXPIRED — that is why the sync stopped", async () => {
    grantRole("viewer");
    getGoogleConnection.mockResolvedValue(EXPIRED);

    const body = (await (await GET(request())).json()) as Record<string, unknown>;

    expect(body).toEqual({ state: "expired" });
    // The reason code names the credential's owner problem: admin+ only.
    expect(body).not.toHaveProperty("reason");
  });

  it("passes `not_connected` through unchanged — it has nothing to hide", async () => {
    getGoogleConnection.mockResolvedValue({ state: "not_connected" });

    await expect((await GET(request())).json()).resolves.toEqual({ state: "not_connected" });
  });
});

describe("GET /api/catalog/google/status — what an admin may see", () => {
  it("gives an admin the whole view, e-mail and scopes included", async () => {
    grantRole("admin");

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(CONNECTED);
  });

  it("gives an owner the same as an admin, including the expiry reason", async () => {
    grantRole("owner");
    getGoogleConnection.mockResolvedValue(EXPIRED);

    await expect((await GET(request())).json()).resolves.toEqual(EXPIRED);
  });

  it("never caches the answer — the role decides the shape", async () => {
    grantRole("admin");

    const response = await GET(request());

    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
