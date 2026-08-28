import { beforeEach, describe, expect, it, vi } from "vitest";

import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * M1.3b — the authorisation boundary of `POST /api/posts/batches`, the one
 * action in this tool that cannot be undone: it puts a post on a real Facebook
 * Page. editor minimum, tier S (fresh membership on every call), tenant from
 * the membership, and — Bug B6 — an actor from the session.
 *
 * The assertions are about WHO and WHETHER, never about the fan-out itself:
 * `createPostBatch` owns the stock gate and the duplicate key, and has its own
 * tests. What must be proven here is that nothing reaches it unauthorised.
 */

const createPostBatch = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();
const requireTenant = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { createPostBatch, requireTenant },
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
  batchId: "6f1d0a1e-0000-4000-8000-000000000001",
  status: "queued",
  channels: [
    {
      channelId: "fbpage-a",
      postJobId: "job-1",
      status: "queued",
      queued: true,
      queueJobId: "q-1",
      errorCode: null,
      userMessage: null,
      scheduledAt: null,
    },
  ],
};

/** A body the schema accepts, minus every field a test is about to vary. */
function validBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productCode: "MGKVX6310",
    channelIds: ["fbpage-a"],
    captionByChannel: { "fbpage-a": "Giannal – MỘT NGÀY DỊU DÀNG" },
    media: [{ driveFileId: "d1", fileName: "1.jpg", kind: "image" }],
    ...extra,
  };
}

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

function post(body: unknown, cookieTenantId: string | null = TENANT): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  return new Request("http://localhost/api/posts/batches", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  claim = {};
  getOperatorSession.mockResolvedValue({ email: "staff@shop.vn", accountId: "acc-1" });
  createPostBatch.mockResolvedValue(RESULT);
  grantRole("editor");
});

// --- Edge cases first ---------------------------------------------------------

describe("POST /api/posts/batches — refusals", () => {
  it("401s without a session, and creates no job row", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await POST(post(validBody()));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    expect(requireTenant).not.toHaveBeenCalled();
    expect(createPostBatch).not.toHaveBeenCalled();
  });

  it("404s a selector cookie pointing at a company the account is not in", async () => {
    const response = await POST(post(validBody(), OTHER_TENANT));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TENANT_NOT_FOUND" });
    expect(createPostBatch).not.toHaveBeenCalled();
  });

  it("403s a VIEWER pressing Đăng — a public post is not a read", async () => {
    grantRole("viewer");

    const response = await POST(post(validBody()));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "FORBIDDEN" });
    expect(createPostBatch).not.toHaveBeenCalled();
  });

  it("claims tier S + editor — a cached membership may not authorise a publish", async () => {
    await POST(post(validBody()));

    expect(claim).toEqual({ tier: "S", minRole: "editor" });
  });

  it("authorises BEFORE validating the body: a viewer with junk gets 403, not 400", async () => {
    // Otherwise the error message tells an unauthorised caller what our schema
    // expects, and the 403 arrives only once they guess a valid shape.
    grantRole("viewer");

    const response = await POST(post({ productCode: "" }));

    expect(response.status).toBe(403);
    expect(createPostBatch).not.toHaveBeenCalled();
  });

  it("400s a body with no channel, once the caller IS allowed to publish", async () => {
    const response = await POST(post(validBody({ channelIds: [] })));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_INPUT" });
    expect(createPostBatch).not.toHaveBeenCalled();
  });
});

describe("POST /api/posts/batches — the fan-out", () => {
  it("publishes into the MEMBERSHIP tenant when the old UI still sends another", async () => {
    const response = await POST(post(validBody({ tenantId: OTHER_TENANT })));

    expect(response.status).toBe(201);
    expect(createPostBatch).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, productCode: "MGKVX6310" }),
    );
    // The forged id must not survive anywhere in the call.
    expect(createPostBatch.mock.calls[0]?.[0]).not.toMatchObject({ tenantId: OTHER_TENANT });
  });

  it("Bug B6: names the operator from the session, never from the body", async () => {
    await POST(post(validBody({ actorEmail: "someone.else@shop.vn" })));

    expect(createPostBatch).toHaveBeenCalledWith(
      expect.objectContaining({ actorEmail: "staff@shop.vn" }),
    );
  });

  it("keeps the 201 and the response shape the wizard parses", async () => {
    const response = await POST(post(validBody()));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(RESULT);
  });

  it("passes a per-channel schedule through as Dates", async () => {
    await POST(
      post(
        validBody({
          scheduledAt: "2026-08-13T02:20:00.000Z",
          scheduledAtByChannel: { "fbpage-a": "2026-08-13T03:00:00.000Z" },
        }),
      ),
    );

    const input = createPostBatch.mock.calls[0]?.[0] as {
      scheduledAt: Date;
      scheduledAtByChannel: Record<string, Date>;
    };
    expect(input.scheduledAt).toEqual(new Date("2026-08-13T02:20:00.000Z"));
    expect(input.scheduledAtByChannel["fbpage-a"]).toEqual(new Date("2026-08-13T03:00:00.000Z"));
  });

  // --- Per-run spacing: edge cases first ---------------------------------
  it.each([
    ["a negative gap", -1],
    ["a gap above 24h", 24 * 60 * 60_000 + 1],
    ["a fractional millisecond", 1.5],
    ["a numeric STRING (never coerced — \"5\" would mean 5 minutes)", "300000"],
    ["a boolean", true],
  ])("400s %s and creates no batch", async (_case, spacingMs) => {
    const response = await POST(post(validBody({ spacingMs })));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; issues?: Array<{ path: string }> };
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.issues?.some((issue) => issue.path === "spacingMs")).toBe(true);
    expect(createPostBatch).not.toHaveBeenCalled();
  });

  it("forwards a valid gap in milliseconds", async () => {
    await POST(post(validBody({ spacingMs: 300_000 })));

    expect(createPostBatch).toHaveBeenCalledWith(
      expect.objectContaining({ spacingMs: 300_000 }),
    );
  });

  it("forwards 0 — a run may switch spacing off", async () => {
    await POST(post(validBody({ spacingMs: 0 })));

    expect(createPostBatch).toHaveBeenCalledWith(expect.objectContaining({ spacingMs: 0 }));
  });

  it("forwards an explicit null (use the tenant setting)", async () => {
    await POST(post(validBody({ spacingMs: null })));

    expect(createPostBatch).toHaveBeenCalledWith(expect.objectContaining({ spacingMs: null }));
  });

  it("omits the key entirely when the body says nothing — old clients keep working", async () => {
    await POST(post(validBody()));

    expect(createPostBatch.mock.calls[0]?.[0]).not.toHaveProperty("spacingMs");
  });

  it("accepts a gap under the 5-minute recommendation (advice, not a floor)", async () => {
    const response = await POST(post(validBody({ spacingMs: 60_000 })));

    expect(response.status).toBe(201);
    expect(createPostBatch).toHaveBeenCalledWith(expect.objectContaining({ spacingMs: 60_000 }));
  });

  it("surfaces OUT_OF_STOCK as 409, not as a created batch", async () => {
    createPostBatch.mockRejectedValue(new AppError("OUT_OF_STOCK"));

    const response = await POST(post(validBody()));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "OUT_OF_STOCK" });
  });
});
