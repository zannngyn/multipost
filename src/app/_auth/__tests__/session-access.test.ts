import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canManageAccess } from "../operator-session";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * THE revocation guard, M1.2 edition: the session is a stateless JWT, so the
 * only thing that can end a banned operator's access is this per-request read
 * of the ACCOUNT tables (identity → account → membership). If it is ever
 * removed or bypassed these tests fail, and "Chặn" goes back to being a button
 * that lies.
 */

const DEMO_TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

const authMock = vi.fn();

/** Structural mirror of OperatorAccountState (app tests may not import core). */
type AccountLike = {
  accountId: string;
  status: "active" | "suspended";
  platformRole: "support" | "super_admin" | null;
  displayName: string | null;
  activeMemberships: { tenantId: string; role: "owner" | "admin" | "editor" | "viewer"; version: number }[];
};

const resolveMock = vi.fn<(email: string) => Promise<AccountLike | null>>();
const grantBootstrapRoleMock = vi.fn<(accountId: string, email: string) => Promise<boolean>>();

vi.mock("../auth", () => ({ auth: () => authMock() }));

vi.mock("@/composition/container", () => ({
  ACCESS_REGISTRY_TENANT_ID: DEMO_TENANT,
  getContainer: () => ({
    usecases: {
      operatorAccounts: { resolve: resolveMock, grantBootstrapRole: grantBootstrapRoleMock },
    },
  }),
}));

const ENV = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  AUTH_ALLOWED_DOMAINS: "mysp.vn",
  AUTH_BOOTSTRAP_ADMINS: "boss@mysp.vn",
  AUTH_FACEBOOK_ALLOWED_USER_IDS: "992710700450296",
  SESSION_SECRET: "x".repeat(40),
};

function member(overrides: Partial<AccountLike> = {}): AccountLike {
  return {
    accountId: "acc-1",
    status: "active",
    platformRole: null,
    displayName: "Worker",
    activeMemberships: [{ tenantId: DEMO_TENANT, role: "editor", version: 1 }],
    ...overrides,
  };
}

async function loadSession() {
  // Imported fresh per test: auth.config caches the parsed env per module load.
  const sessionModule = await import("../session");
  return sessionModule.getOperatorSession;
}

beforeEach(() => {
  vi.resetModules();
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEV_FAKE_SESSION", "");
  authMock.mockReset();
  resolveMock.mockReset();
  resolveMock.mockResolvedValue(null);
  grantBootstrapRoleMock.mockReset();
  grantBootstrapRoleMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// --- Edge cases first -------------------------------------------------------

describe("getOperatorSession — no usable session", () => {
  it("answers null when there is no session at all", async () => {
    authMock.mockResolvedValue(null);
    const getOperatorSession = await loadSession();
    await expect(getOperatorSession("test")).resolves.toBeNull();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("answers null when the session carries no e-mail", async () => {
    authMock.mockResolvedValue({ user: { name: "A" } });
    const getOperatorSession = await loadSession();
    await expect(getOperatorSession("test")).resolves.toBeNull();
  });
});

describe("getOperatorSession — the account tables decide", () => {
  it("ends the session of an operator whose account was suspended while signed in", async () => {
    authMock.mockResolvedValue({ user: { email: "worker@gmail.com", name: "Worker" } });
    resolveMock.mockResolvedValue(member({ status: "suspended" }));

    const getOperatorSession = await loadSession();

    await expect(getOperatorSession("layout:(app)")).resolves.toBeNull();
    expect(resolveMock).toHaveBeenCalledWith("worker@gmail.com");
  });

  it("treats an unknown address as no session", async () => {
    authMock.mockResolvedValue({ user: { email: "worker@gmail.com", name: null } });
    const getOperatorSession = await loadSession();

    resolveMock.mockResolvedValue(null);
    await expect(getOperatorSession("test")).resolves.toBeNull();
  });

  /**
   * CHANGED AT M2.4 (was: null). A membership-less account is the NoMembership
   * state — a real signed-in person in the lobby (docs/09 §3.8). The session is
   * valid with role null; requireTenant answers 409 for anything tenant-scoped.
   */
  it("gives a membership-less account a VALID lobby session (M2.4)", async () => {
    authMock.mockResolvedValue({ user: { email: "worker@gmail.com", name: "Worker" } });
    resolveMock.mockResolvedValue(member({ activeMemberships: [] }));

    const getOperatorSession = await loadSession();
    const session = await getOperatorSession("test");

    expect(session).toMatchObject({ accountId: "acc-1", role: null, isBootstrapAdmin: false });
    expect(canManageAccess(session)).toBe(false);
  });

  it("lets a member in, carrying the demo-tenant role and the account id", async () => {
    authMock.mockResolvedValue({ user: { email: "worker@gmail.com", name: "Worker" } });
    resolveMock.mockResolvedValue(member());

    const getOperatorSession = await loadSession();

    await expect(getOperatorSession("test")).resolves.toEqual({
      email: "worker@gmail.com",
      name: "Worker",
      isDevFake: false,
      role: "editor",
      isBootstrapAdmin: false,
      accountId: "acc-1",
      platformRole: null,
    });
  });

  it("carries a null legacy role for a member of ANOTHER tenant only", async () => {
    authMock.mockResolvedValue({ user: { email: "worker@gmail.com", name: "Worker" } });
    resolveMock.mockResolvedValue(
      member({
        activeMemberships: [
          { tenantId: testTenantId("00000000-0000-0000-0000-0000000000ff"), role: "owner", version: 1 },
        ],
      }),
    );

    const getOperatorSession = await loadSession();
    const session = await getOperatorSession("test");

    expect(session).toMatchObject({ role: null, accountId: "acc-1" });
    expect(canManageAccess(session)).toBe(false);
  });
});

describe("getOperatorSession — env bootstrap admins (M3.1: the DB decides once a row exists)", () => {
  it("RESCUE DOOR unchanged: no account row → session on env authority alone", async () => {
    authMock.mockResolvedValue({ user: { email: "boss@mysp.vn", name: "Boss" } });
    resolveMock.mockResolvedValue(null);
    const getOperatorSession = await loadSession();

    const session = await getOperatorSession("test");
    expect(session).toMatchObject({
      email: "boss@mysp.vn",
      isBootstrapAdmin: true,
      role: null,
      accountId: null,
    });
    expect(canManageAccess(session)).toBe(true);
    expect(grantBootstrapRoleMock).not.toHaveBeenCalled(); // nothing to promote
  });

  /**
   * NEW BEHAVIOUR (M3.1, closes N9): once the row exists, the DATABASE is the
   * source of truth — a suspended bootstrap admin is OUT, env or no env.
   */
  it("N9: a SUSPENDED bootstrap admin with an account row gets NO session", async () => {
    authMock.mockResolvedValue({ user: { email: "boss@mysp.vn", name: "Boss" } });
    resolveMock.mockResolvedValue(
      member({ accountId: "acc-boss", status: "suspended", platformRole: "super_admin" }),
    );
    const getOperatorSession = await loadSession();

    await expect(getOperatorSession("test")).resolves.toBeNull();
    expect(grantBootstrapRoleMock).not.toHaveBeenCalled();
  });

  /** NEW (M3.1): env seeds the DB exactly once — the promote hook. */
  it("promotes a bootstrap admin with a NULL platform_role and carries super_admin", async () => {
    authMock.mockResolvedValue({ user: { email: "boss@mysp.vn", name: "Boss" } });
    resolveMock.mockResolvedValue(member({ accountId: "acc-boss", platformRole: null }));
    const getOperatorSession = await loadSession();

    const session = await getOperatorSession("test");

    expect(grantBootstrapRoleMock).toHaveBeenCalledWith("acc-boss", "boss@mysp.vn");
    expect(session).toMatchObject({ isBootstrapAdmin: true, platformRole: "super_admin" });
  });

  it("keeps the DB's platform_role verbatim when it is already set", async () => {
    authMock.mockResolvedValue({ user: { email: "boss@mysp.vn", name: "Boss" } });
    resolveMock.mockResolvedValue(member({ accountId: "acc-boss", platformRole: "support" }));
    const getOperatorSession = await loadSession();

    await expect(getOperatorSession("test")).resolves.toMatchObject({
      accountId: "acc-boss",
      platformRole: "support",
    });
    expect(grantBootstrapRoleMock).not.toHaveBeenCalled(); // not null → no re-grant
  });

  it("lets an allow-listed Facebook id in through its synthetic address", async () => {
    authMock.mockResolvedValue({
      user: { email: "fb-992710700450296@facebook.local", name: "Boss FB" },
    });
    const getOperatorSession = await loadSession();

    await expect(getOperatorSession("test")).resolves.toMatchObject({ isBootstrapAdmin: true });
  });

  it("does not mistake another Facebook id for the allow-listed one", async () => {
    authMock.mockResolvedValue({ user: { email: "fb-111@facebook.local", name: "Stranger" } });
    resolveMock.mockResolvedValue(null);

    const getOperatorSession = await loadSession();

    await expect(getOperatorSession("test")).resolves.toBeNull();
    expect(resolveMock).toHaveBeenCalled();
  });
});

/**
 * The B1 regression guard, unchanged in spirit: AUTH_ALLOWED_DOMAINS covers an
 * open-ended set of people, so it must never produce a session that is both
 * admin and unblockable.
 */
describe("getOperatorSession — a domain match is not a grant", () => {
  /**
   * CHANGED AT M2.4 (was: null session). A domain match without a membership
   * now holds a LOBBY session — but still zero authority: no role, no admin
   * rights, and requireTenant refuses every tenant-scoped call. The B1 claim
   * ("a domain grants nothing") holds in its post-M2.4 form.
   */
  it("gives a domain match with no membership a lobby session with NO authority", async () => {
    authMock.mockResolvedValue({ user: { email: "colleague@mysp.vn", name: "Colleague" } });
    resolveMock.mockResolvedValue(member({ activeMemberships: [] }));

    const getOperatorSession = await loadSession();
    const session = await getOperatorSession("test");

    expect(session).toMatchObject({ role: null, isBootstrapAdmin: false });
    expect(canManageAccess(session)).toBe(false);
  });

  it("gives an approved domain match the membership role — and no admin rights", async () => {
    authMock.mockResolvedValue({ user: { email: "colleague@mysp.vn", name: "Colleague" } });
    resolveMock.mockResolvedValue(member());

    const getOperatorSession = await loadSession();
    const session = await getOperatorSession("test");

    expect(session).toMatchObject({ role: "editor", isBootstrapAdmin: false });
    expect(canManageAccess(session)).toBe(false);
  });

  it("can suspend a domain match — the whole point of B1", async () => {
    authMock.mockResolvedValue({ user: { email: "colleague@mysp.vn", name: "Colleague" } });
    resolveMock.mockResolvedValue(member({ status: "suspended" }));

    const getOperatorSession = await loadSession();
    await expect(getOperatorSession("test")).resolves.toBeNull();
  });
});
