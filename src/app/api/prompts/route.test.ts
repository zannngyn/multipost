import { beforeEach, describe, expect, it, vi } from "vitest";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * M1.3b — the boundary contract of `/api/prompts` (doc 10 §4.3).
 *
 * Two different bars on one file: GET is tier R / editor because the list
 * carries the full prompt text, POST is tier S / admin because a version
 * created with `activate: true` rewrites every caption the tenant produces
 * afterwards. Both take the tenant from the membership, never from the query
 * string or the body.
 */

const requireTenant = vi.fn();
const listVersions = vi.fn();
const createVersion = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { requireTenant, promptTemplates: { listVersions, createVersion } },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET, POST } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");
const { AppError } = await import("@/core/domain/errors");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = testTenantId("00000000-0000-0000-0000-0000000000ff");
const COOKIE = `${ACTIVE_TENANT_COOKIE}=${TENANT}`;

const CREATE_BODY = {
  name: "Giọng Tết",
  systemPrompt: "SYSTEM",
  body: "{{product.name}}",
  changelog: "đổi giọng",
};

function getRequest(query = ""): Request {
  return new Request(`http://localhost/api/prompts${query}`, { headers: { cookie: COOKIE } });
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/prompts", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: COOKIE },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "admin@mysp.vn", accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "admin", membershipVersion: 3 });
  listVersions.mockResolvedValue({ versions: [], effective: { version: 1 }, nextVersion: 2 });
  createVersion.mockResolvedValue({ template: { version: 2 }, warnings: [] });
});

// --- Edge cases first ---------------------------------------------------------

describe("GET /api/prompts — refusals", () => {
  it("401s without a session, and never reads a template", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await GET(getRequest());

    expect(response.status).toBe(401);
    expect(listVersions).not.toHaveBeenCalled();
  });

  it("403s a viewer: the list carries the full prompt text (Q8.3)", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN"));

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    expect(listVersions).not.toHaveBeenCalled();
  });

  it("404s a company the account is not a member of", async () => {
    requireTenant.mockRejectedValue(new AppError("TENANT_NOT_FOUND"));

    expect((await GET(getRequest())).status).toBe(404);
  });

  it("400s an unknown task instead of silently listing the default one", async () => {
    const response = await GET(getRequest("?task=instagram_reels"));

    expect(response.status).toBe(400);
    expect(listVersions).not.toHaveBeenCalled();
  });
});

describe("GET /api/prompts — answers", () => {
  it("claims tier R and minRole editor", async () => {
    await GET(getRequest());

    expect(requireTenant).toHaveBeenCalledWith(expect.anything(), TENANT, {
      tier: "R",
      minRole: "editor",
    });
  });

  it("ignores a tenantId in the query string and answers for the authorised one", async () => {
    const response = await GET(getRequest(`?tenantId=${OTHER_TENANT}`));

    expect(listVersions).toHaveBeenCalledWith({
      tenantId: TENANT,
      task: "facebook_content",
      platform: "facebook",
    });
    // Response shape unchanged for the UI — but the echoed tenant is the
    // authorised one, not what the caller asked for.
    await expect(response.json()).resolves.toMatchObject({ tenantId: TENANT });
  });
});

describe("POST /api/prompts — refusals", () => {
  it("403s an editor: creating a version can activate it in the same call (Q8.2)", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN"));

    const response = await POST(postRequest({ ...CREATE_BODY, activate: true }));

    expect(response.status).toBe(403);
    expect(createVersion).not.toHaveBeenCalled();
  });

  it("401s without a session, before the body is read", async () => {
    getOperatorSession.mockResolvedValue(null);

    expect((await POST(postRequest(CREATE_BODY))).status).toBe(401);
    expect(createVersion).not.toHaveBeenCalled();
  });

  it("400s a body missing the changelog — a version without a reason is unauditable", async () => {
    const response = await POST(postRequest({ ...CREATE_BODY, changelog: "" }));

    expect(response.status).toBe(400);
    expect(createVersion).not.toHaveBeenCalled();
  });
});

describe("POST /api/prompts — answers", () => {
  it("claims tier S and minRole admin", async () => {
    await POST(postRequest(CREATE_BODY));

    expect(requireTenant).toHaveBeenCalledWith(expect.anything(), TENANT, {
      tier: "S",
      minRole: "admin",
    });
  });

  it("writes the version under the authorised tenant, signed by the session", async () => {
    const response = await POST(postRequest({ ...CREATE_BODY, tenantId: OTHER_TENANT }));

    expect(response.status).toBe(201);
    expect(createVersion).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, createdBy: "admin@mysp.vn" }),
    );
  });
});
