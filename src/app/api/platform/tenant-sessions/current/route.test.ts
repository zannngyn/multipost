import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M3.3 — leaving the visited tenant: idempotent, cookie cleared on every exit,
 * and DELIBERATELY not behind requirePlatformAdmin (a demoted staffer must
 * still be able to leave — the account match in the repo is the guard).
 */

const close = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { supportSessions: { close } },
  }),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { DELETE } = await import("./route");
const { SUPPORT_SESSION_COOKIE } = await import("@/app/_lib/support-session-cookie");

const SESSION_ID = "99999999-8888-7777-6666-555555555555";

const request = (cookie?: string) => {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("cookie", cookie);
  return new Request("http://localhost/api/platform/tenant-sessions/current", {
    method: "DELETE",
    headers,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({ email: "staff@mysp.vn", accountId: "acc-staff" });
  close.mockResolvedValue({ revoked: true, already: false });
});

describe("DELETE /api/platform/tenant-sessions/current", () => {
  // --- Refusals first ---------------------------------------------------------
  it("401s without an account-backed session", async () => {
    getOperatorSession.mockResolvedValue(null);
    const response = await DELETE(request(`${SUPPORT_SESSION_COOKIE}=${SESSION_ID}`));
    expect(response.status).toBe(401);
    expect(close).not.toHaveBeenCalled();
  });

  // --- Exits ------------------------------------------------------------------
  it("closes the OWN session from the cookie and clears the cookie", async () => {
    const response = await DELETE(request(`${SUPPORT_SESSION_COOKIE}=${SESSION_ID}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: true, already: false });
    expect(close).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      accountId: "acc-staff",
      actorEmail: "staff@mysp.vn",
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SUPPORT_SESSION_COOKIE}=;`);
    expect(cookie).toContain("Max-Age=0");
  });

  it("stays a 200 no-op without a cookie — leaving twice is not an error", async () => {
    close.mockResolvedValue({ revoked: false, already: true });
    const response = await DELETE(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ already: true });
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null }));
    // The cookie is cleared regardless — a stale pointer must not linger.
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
