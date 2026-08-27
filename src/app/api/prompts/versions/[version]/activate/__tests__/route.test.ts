import { beforeEach, describe, expect, it, vi } from "vitest";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * M1.3b — `POST /api/prompts/versions/[version]/activate` (doc 10 §4.3): tier S,
 * admin only, tenant from the membership. Plus doc 10 B3: a version that is not
 * there answers 404, not the 500 that used to hide it.
 */

const requireTenant = vi.fn();
const activateVersion = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { requireTenant, promptTemplates: { activateVersion } },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { POST } = await import("../route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");
const { AppError } = await import("@/core/domain/errors");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = testTenantId("00000000-0000-0000-0000-0000000000ff");

function request(body: unknown = {}): Request {
  return new Request("http://localhost/api/prompts/versions/3/activate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${ACTIVE_TENANT_COOKIE}=${TENANT}`,
    },
    body: JSON.stringify(body),
  });
}

function params(version: string) {
  return { params: Promise.resolve({ version }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "admin@mysp.vn", accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "admin", membershipVersion: 3 });
  activateVersion.mockResolvedValue({ id: "tpl-3", version: 3 });
});

// --- Edge cases first ---------------------------------------------------------

describe("POST /api/prompts/versions/[version]/activate — refusals", () => {
  it("401s without a session", async () => {
    getOperatorSession.mockResolvedValue(null);

    expect((await POST(request(), params("3"))).status).toBe(401);
    expect(activateVersion).not.toHaveBeenCalled();
  });

  it("403s an editor — one call changes every caption from now on", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN"));

    expect((await POST(request(), params("3"))).status).toBe(403);
    expect(activateVersion).not.toHaveBeenCalled();
  });

  it("400s a version that is not a positive integer", async () => {
    const response = await POST(request(), params("abc"));

    expect(response.status).toBe(400);
    expect(activateVersion).not.toHaveBeenCalled();
  });

  it("404s a version that does not exist (doc 10 B3), instead of a 500", async () => {
    activateVersion.mockRejectedValue(new AppError("PROMPT_VERSION_NOT_FOUND"));

    const response = await POST(request(), params("99"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "PROMPT_VERSION_NOT_FOUND" });
  });

  it("still 500s a MISSING BUILT-IN template — that one is a deployment bug", async () => {
    activateVersion.mockRejectedValue(new AppError("PROMPT_NOT_FOUND"));

    expect((await POST(request(), params("3"))).status).toBe(500);
  });
});

describe("POST /api/prompts/versions/[version]/activate — answers", () => {
  it("claims tier S and minRole admin", async () => {
    await POST(request(), params("3"));

    expect(requireTenant).toHaveBeenCalledWith(expect.anything(), TENANT, {
      tier: "S",
      minRole: "admin",
      supportSessionId: null, // M3.3: carried by requireTenantContext
    });
  });

  it("activates inside the authorised tenant, ignoring the body's tenantId", async () => {
    const response = await POST(request({ tenantId: OTHER_TENANT }), params("3"));

    expect(response.status).toBe(200);
    expect(activateVersion).toHaveBeenCalledWith({
      tenantId: TENANT,
      task: "facebook_content",
      platform: "facebook",
      version: 3,
    });
  });
});
