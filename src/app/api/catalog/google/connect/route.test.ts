import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";

/**
 * The start of the Google connect flow (E2 step 1, M1.3b) — same contract as
 * the Facebook twin: tenant from `requireTenant` (tier S, admin), state row
 * written before the browser leaves, cookie carries only the opaque nonce.
 */

const startGoogleConnect = vi.fn();
const issue = vi.fn();
const requireTenant = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: {
      connectGoogleDrive: { startGoogleConnect },
      oauthStates: { issue },
      requireTenant,
    },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("./route");
const { GOOGLE_OAUTH_STATE_COOKIE } = await import("../_lib/oauth-state-cookie");

const TENANT = "00000000-0000-0000-0000-000000000001";
const NONCE = "d".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "admin@example.com", accountId: "acc-1" });
  requireTenant.mockResolvedValue({ tenantId: TENANT, role: "admin", membershipVersion: 1 });
  startGoogleConnect.mockResolvedValue({
    tenantId: TENANT,
    state: NONCE,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
  });
  issue.mockResolvedValue(undefined);
});

const request = () => new Request("http://localhost/api/catalog/google/connect");

describe("GET /api/catalog/google/connect", () => {
  // --- Refusals first ---------------------------------------------------------
  it("403s a viewer — connecting a credential source is admin work", async () => {
    requireTenant.mockRejectedValue(new AppError("FORBIDDEN"));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(startGoogleConnect).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
  });

  it("keeps JSON for a missing OAuth app (operator is still on the screen)", async () => {
    startGoogleConnect.mockRejectedValue(new AppError("GOOGLE_OAUTH_NOT_CONFIGURED"));

    const response = await GET(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "GOOGLE_OAUTH_NOT_CONFIGURED" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  // --- Happy path -------------------------------------------------------------
  it("binds (tenant, account) server-side and sends only the nonce in the cookie", async () => {
    const response = await GET(request());

    expect(response.status).toBe(302);
    expect(issue).toHaveBeenCalledWith({
      nonce: NONCE,
      tenantId: TENANT,
      accountId: "acc-1",
      purpose: "google_drive",
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${GOOGLE_OAUTH_STATE_COOKIE}=${NONCE}`);
    expect(cookie).not.toContain(TENANT);
  });
});
