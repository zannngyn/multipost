import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { OperatorRole, PlatformRole } from "@/shared/operator-access";

/**
 * The field-level half of `GET /api/posts/worker-health` (doc 10 Q8.3).
 *
 * BREAKING, agreed with ui-web: the tenant-facing body no longer carries
 * `workersOnline`. That number counts the replicas of the SHARED fleet — poll
 * it from any tenant and you learn how much of the platform is running — while
 * the banner only ever needed "is anybody consuming?". The exact count comes
 * back only for a session with a `platformRole`.
 */

const getWorkerHealth = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();
const requireTenant = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { getWorkerHealth, requireTenant },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";
const CHECKED_AT = new Date("2026-08-20T03:00:00.000Z");

/** What the usecase returns; the route projects a subset of it. */
function health(overrides: Record<string, unknown> = {}) {
  return {
    workersOnline: 3,
    queueReachable: true,
    untouchedQueuedJobs: 0,
    oldestUntouchedWaitMs: null,
    checkedAt: CHECKED_AT,
    ...overrides,
  };
}

function signIn(platformRole: PlatformRole | null): void {
  getOperatorSession.mockResolvedValue({
    email: "staff@shop.vn",
    accountId: "acc-1",
    platformRole,
  });
}

function grantRole(role: OperatorRole): void {
  requireTenant.mockImplementation((_session: unknown, cookieTenantId: string | null) => {
    if (cookieTenantId && cookieTenantId !== TENANT) {
      throw new AppError("TENANT_NOT_FOUND", { context: { tenant_id: cookieTenantId } });
    }
    return Promise.resolve({ tenantId: TENANT, role, membershipVersion: 1 });
  });
}

function get(cookieTenantId: string | null = TENANT): Request {
  const headers = new Headers();
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  return new Request("http://localhost/api/posts/worker-health", { headers });
}

async function body(cookieTenantId: string | null = TENANT): Promise<Record<string, unknown>> {
  return (await (await GET(get(cookieTenantId))).json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  signIn(null);
  getWorkerHealth.mockResolvedValue(health());
  grantRole("viewer");
});

// --- Edge cases first ---------------------------------------------------------

describe("GET /api/posts/worker-health — refusals", () => {
  it("401s without a session, and probes nothing", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await GET(get());

    expect(response.status).toBe(401);
    expect(getWorkerHealth).not.toHaveBeenCalled();
  });

  it("404s a selector cookie pointing at a company the account is not in (Bug B7)", async () => {
    const response = await GET(get(OTHER_TENANT));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TENANT_NOT_FOUND" });
    expect(getWorkerHealth).not.toHaveBeenCalled();
  });
});

describe("GET /api/posts/worker-health — workersOnline is platform-only (Q8.3)", () => {
  it("never sends the replica COUNT to a tenant caller, whatever their role", async () => {
    for (const role of ["viewer", "editor", "admin", "owner"] as const) {
      grantRole(role);
      const answer = await body();
      expect(answer, `role ${role}`).not.toHaveProperty("workersOnline");
      expect(answer.workersAvailable, `role ${role}`).toBe(true);
    }
  });

  it("adds the count back for platform support", async () => {
    signIn("support");

    const answer = await body();

    expect(answer.workersOnline).toBe(3);
    expect(answer.workersAvailable).toBe(true);
  });

  it("adds the count back for a super_admin", async () => {
    signIn("super_admin");

    await expect(body()).resolves.toMatchObject({ workersOnline: 3 });
  });

  it("says workersAvailable:false when the fleet is empty", async () => {
    getWorkerHealth.mockResolvedValue(health({ workersOnline: 0 }));

    await expect(body()).resolves.toMatchObject({ workersAvailable: false });
  });

  it("keeps queueReachable:false visible to everyone — the silence this route ended", async () => {
    // An unreachable broker reports 0 workers. `workersAvailable:false` alone
    // would read as "nobody is working"; the operator must be able to tell that
    // apart from "we could not even ask".
    getWorkerHealth.mockResolvedValue(health({ workersOnline: 0, queueReachable: false }));

    const answer = await body();

    expect(answer.queueReachable).toBe(false);
    expect(answer.workersAvailable).toBe(false);
  });
});

describe("GET /api/posts/worker-health — the rest of the body", () => {
  it("keeps the tenant-scoped counters and the ISO checkedAt", async () => {
    getWorkerHealth.mockResolvedValue(
      health({ untouchedQueuedJobs: 4, oldestUntouchedWaitMs: 900_000 }),
    );

    const answer = await body();

    expect(answer).toEqual({
      queueReachable: true,
      untouchedQueuedJobs: 4,
      oldestUntouchedWaitMs: 900_000,
      checkedAt: CHECKED_AT.toISOString(),
      workersAvailable: true,
    });
  });

  it("asks about the MEMBERSHIP tenant", async () => {
    await GET(get());

    expect(getWorkerHealth).toHaveBeenCalledWith({ tenantId: TENANT });
  });
});
