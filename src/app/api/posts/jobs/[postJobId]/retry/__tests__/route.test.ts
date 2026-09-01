import { beforeEach, describe, expect, it, vi } from "vitest";

import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * M1.3b — the authorisation boundary of `POST /api/posts/jobs/:id/retry`.
 *
 * "Chạy lại" republishes for real, so it sits at the same height as the first
 * publish: editor minimum, tier S, tenant and actor from the session. The body
 * is now empty — the only field it carried was `tenantId`.
 *
 * The job id in the URL is deliberately NOT a tenant check of its own: the
 * usecase is tenant-scoped, so a job of another tenant is simply not found.
 */

const retryPostJob = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();
const requireTenant = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { retryPostJob, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { POST } = await import("../route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";
const JOB_ID = "6f1d0a1e-0000-4000-8000-000000000001";

const RESULT = {
  postJobId: JOB_ID,
  batchId: "batch-1",
  channelId: "fbpage-a",
  productCode: "MGKVX6310",
  previousStatus: "failed",
  status: "queued",
  queueJobId: "q-2",
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

function post(
  postJobId = JOB_ID,
  cookieTenantId: string | null = TENANT,
  body?: unknown,
): [Request, { params: Promise<{ postJobId: string }> }] {
  const headers = new Headers();
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  return [
    new Request(`http://localhost/api/posts/jobs/${postJobId}/retry`, init),
    { params: Promise.resolve({ postJobId }) },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  claim = {};
  getOperatorSession.mockResolvedValue({ email: "staff@shop.vn", accountId: "acc-1" });
  retryPostJob.mockResolvedValue(RESULT);
  grantRole("editor");
});

// --- Edge cases first ---------------------------------------------------------

describe("POST /api/posts/jobs/[postJobId]/retry — refusals", () => {
  it("401s without a session, and re-queues nothing", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await POST(...post());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    expect(requireTenant).not.toHaveBeenCalled();
    expect(retryPostJob).not.toHaveBeenCalled();
  });

  it("404s a selector cookie pointing at a company the account is not in", async () => {
    const response = await POST(...post(JOB_ID, OTHER_TENANT));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TENANT_NOT_FOUND" });
    expect(retryPostJob).not.toHaveBeenCalled();
  });

  it("403s a VIEWER pressing Chạy lại — it publishes, so it is not a read", async () => {
    grantRole("viewer");

    const response = await POST(...post());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    expect(retryPostJob).not.toHaveBeenCalled();
  });

  it("claims tier S + editor — the same height as the first publish", async () => {
    await POST(...post());

    expect(claim).toEqual({ tier: "S", minRole: "editor" });
  });

  it("authorises before parsing the URL: a viewer with a bad id gets 403, not 400", async () => {
    grantRole("viewer");

    const response = await POST(...post("not-a-uuid"));

    expect(response.status).toBe(403);
    expect(retryPostJob).not.toHaveBeenCalled();
  });

  it("400s a malformed job id once the caller IS allowed", async () => {
    const response = await POST(...post("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_INPUT" });
    expect(retryPostJob).not.toHaveBeenCalled();
  });

  it("passes INVALID_JOB_TRANSITION through as 409 — a published post stays published", async () => {
    retryPostJob.mockRejectedValue(new AppError("INVALID_JOB_TRANSITION"));

    const response = await POST(...post());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_JOB_TRANSITION" });
  });
});

describe("POST /api/posts/jobs/[postJobId]/retry — the re-run", () => {
  it("re-queues in the MEMBERSHIP tenant, ignoring a body from the old UI", async () => {
    const response = await POST(...post(JOB_ID, TENANT, { tenantId: OTHER_TENANT }));

    expect(response.status).toBe(200);
    expect(retryPostJob).toHaveBeenCalledWith({
      tenantId: TENANT,
      postJobId: JOB_ID,
      actorEmail: "staff@shop.vn",
    });
  });

  it("works with no body at all (the M1.4 UI sends none)", async () => {
    const response = await POST(...post());

    expect(response.status).toBe(200);
    expect(retryPostJob).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, postJobId: JOB_ID }),
    );
  });

  it("names the operator from the session in the log line", async () => {
    await POST(...post());

    expect(logger.info).toHaveBeenCalledWith(
      "Post job re-queued from the operator UI",
      expect.objectContaining({ tenant_id: TENANT, actor_email: "staff@shop.vn" }),
    );
  });

  it("keeps the response shape the job log parses", async () => {
    const response = await POST(...post());

    await expect(response.json()).resolves.toEqual(RESULT);
  });
});
