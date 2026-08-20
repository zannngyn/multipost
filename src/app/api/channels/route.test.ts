import { beforeEach, describe, expect, it, vi } from "vitest";

import { roleAtLeast } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { OperatorRole } from "@/shared/operator-access";

/**
 * The field-level half of `GET /api/channels` (doc 10 Q8.3).
 *
 * Reading the channel list is viewer / tier R, but `secretsConfigured` is a
 * fact about OUR deployment: only admin+ can paste a token, so only admin+ is
 * told whether the box can seal one. It is OMITTED below that, never sent as a
 * hard-coded `false` — a false is a lie a viewer's screen could act on.
 */

const listChannels = vi.fn();
const loadSecretsConfig = vi.fn();
const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
const getOperatorSession = vi.fn();
const requireTenant = vi.fn();

vi.mock("@/composition/container", () => ({
  getContainer: () => ({
    logger,
    config: { NODE_ENV: "test" },
    usecases: { channels: { listChannels }, requireTenant },
  }),
}));

vi.mock("@/composition/config", () => ({
  loadSecretsConfig: (...args: unknown[]) => loadSecretsConfig(...(args as [])),
}));

vi.mock("@/app/_auth/session", () => ({
  getOperatorSession: (...args: unknown[]) => getOperatorSession(...(args as [])),
}));

const { GET } = await import("./route");
const { ACTIVE_TENANT_COOKIE } = await import("@/app/_lib/active-tenant-cookie");

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";

const CHANNELS = [
  { channelId: "fbpage-a", platform: "facebook", name: "Page A", status: "active" },
];

function grantRole(role: OperatorRole): void {
  requireTenant.mockImplementation(
    (
      _session: unknown,
      cookieTenantId: string | null,
      options: { tier: string; minRole?: OperatorRole },
    ) => {
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

function get(cookieTenantId: string | null = TENANT): Request {
  const headers = new Headers();
  if (cookieTenantId) headers.set("cookie", `${ACTIVE_TENANT_COOKIE}=${cookieTenantId}`);
  return new Request("http://localhost/api/channels", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  getOperatorSession.mockResolvedValue({
    email: "staff@shop.vn",
    accountId: "acc-1",
    platformRole: null,
  });
  listChannels.mockResolvedValue(CHANNELS);
  loadSecretsConfig.mockReturnValue({});
  grantRole("viewer");
});

// --- Edge cases first ---------------------------------------------------------

describe("GET /api/channels — refusals", () => {
  it("401s without a session", async () => {
    getOperatorSession.mockResolvedValue(null);

    const response = await GET(get());

    expect(response.status).toBe(401);
    expect(listChannels).not.toHaveBeenCalled();
  });

  it("404s a selector cookie pointing at a company the account is not in", async () => {
    const response = await GET(get(OTHER_TENANT));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "TENANT_NOT_FOUND" });
    expect(listChannels).not.toHaveBeenCalled();
  });
});

describe("GET /api/channels — secretsConfigured is admin+ only (Q8.3)", () => {
  it("OMITS the field for a viewer — absent, not `false`", async () => {
    grantRole("viewer");

    const body = (await (await GET(get())).json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("secretsConfigured");
    // The channel list itself is still a viewer's business.
    expect(body.channels).toEqual(CHANNELS);
  });

  it("OMITS the field for an editor too", async () => {
    grantRole("editor");

    const body = (await (await GET(get())).json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty("secretsConfigured");
  });

  it("does not even PROBE the key for a viewer (no misleading warning in the log)", async () => {
    grantRole("viewer");

    await GET(get());

    expect(loadSecretsConfig).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sends `true` to an admin when the box can seal a credential", async () => {
    grantRole("admin");

    const body = (await (await GET(get())).json()) as Record<string, unknown>;

    expect(body.secretsConfigured).toBe(true);
  });

  it("sends `false` to an owner when TENANT_SECRETS_ENC_KEY is missing, and warns", async () => {
    grantRole("owner");
    loadSecretsConfig.mockImplementation(() => {
      throw new AppError("INVALID_INPUT", { message: "TENANT_SECRETS_ENC_KEY is missing" });
    });

    const body = (await (await GET(get())).json()) as Record<string, unknown>;

    expect(body.secretsConfigured).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("TENANT_SECRETS_ENC_KEY"),
      expect.objectContaining({ reason: "SECRETS_KEY_MISSING", tenant_id: TENANT }),
    );
  });
});

describe("GET /api/channels — the list", () => {
  it("reads the MEMBERSHIP tenant and echoes it back", async () => {
    const response = await GET(get());

    expect(response.status).toBe(200);
    expect(listChannels).toHaveBeenCalledWith({ tenantId: TENANT });
    await expect(response.json()).resolves.toMatchObject({ tenantId: TENANT });
  });
});
