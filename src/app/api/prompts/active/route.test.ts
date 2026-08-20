import { beforeEach, describe, expect, it, vi } from "vitest";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * M1.3b — `GET /api/prompts/active` (doc 10 §4.3): tier R, editor. It returns
 * the same full `systemPrompt`/`body` as the version list, so it carries the
 * same bar — a lower one here would make the bar on `/api/prompts` pointless.
 */

const requireTenant = vi.fn();
const getActive = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { requireTenant, promptTemplates: { getActive } },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");
const { AppError } = await import("@/core/domain/errors");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = testTenantId("00000000-0000-0000-0000-0000000000ff");

function request(query = ""): Request {
  return new Request(`http://localhost/api/prompts/active${query}`, {
    headers: { cookie: `${ACTIVE_TENANT_COOKIE}=${TENANT}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "editor@mysp.vn", accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "editor", membershipVersion: 1 });
  getActive.mockResolvedValue({ version: 2, source: "tenant", systemPrompt: "S", body: "B" });
});

// --- Edge cases first ---------------------------------------------------------

describe("GET /api/prompts/active — refusals", () => {
  it("401s without a session, and never reads a template", async () => {
    getOperatorSession.mockResolvedValue(null);

    expect((await GET(request())).status).toBe(401);
    expect(getActive).not.toHaveBeenCalled();
  });

  it("403s a viewer — prompt text is editor+ (Q8.3)", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN"));

    expect((await GET(request())).status).toBe(403);
    expect(getActive).not.toHaveBeenCalled();
  });

  it("500s a deployment with no built-in template for the task", async () => {
    getActive.mockRejectedValue(new AppError("PROMPT_NOT_FOUND"));

    expect((await GET(request())).status).toBe(500);
  });
});

describe("GET /api/prompts/active — answers", () => {
  it("claims tier R and minRole editor", async () => {
    await GET(request());

    expect(requireTenant).toHaveBeenCalledWith(expect.anything(), TENANT, {
      tier: "R",
      minRole: "editor",
    });
  });

  it("reads the authorised tenant's template, not the one named in the query", async () => {
    const response = await GET(request(`?tenantId=${OTHER_TENANT}`));

    expect(response.status).toBe(200);
    expect(getActive).toHaveBeenCalledWith({
      tenantId: TENANT,
      task: "facebook_content",
      platform: "facebook",
    });
  });
});
