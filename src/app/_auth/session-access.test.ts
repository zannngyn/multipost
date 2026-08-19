import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canManageAccess } from "./operator-session";

/**
 * THE regression guard of E1.4: blocking someone must end their access.
 *
 * The session is a stateless JWT, so `auth()` keeps returning a perfectly valid
 * user for a blocked operator until the token expires. The only thing that can
 * stop them is this per-request status read — if it is ever removed or bypassed
 * these tests fail, and "Chặn" goes back to being a button that lies.
 */

const authMock = vi.fn();
/**
 * Mirrors `OperatorAccessState` structurally. The app layer (tests included)
 * may not import `core/usecases` — docs/07 §2, enforced by eslint.
 */
type AccessStateLike = {
  status: "approved" | "pending" | "blocked" | "unknown";
  role: "owner" | "admin" | "editor" | "viewer" | null;
  displayName: string | null;
};

const readStateMock = vi.fn<(tenantId: string, email: string) => Promise<AccessStateLike>>();

vi.mock("./auth", () => ({ auth: () => authMock() }));

vi.mock("@/composition/container", () => ({
  ACCESS_REGISTRY_TENANT_ID: "00000000-0000-0000-0000-000000000001",
  getContainer: () => ({
    usecases: { operatorAccess: { readState: readStateMock } },
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

async function loadSession() {
  // Imported fresh per test: auth.config caches the parsed env per module load.
  const sessionModule = await import("./session");
  return sessionModule.getOperatorSession;
}

beforeEach(() => {
  vi.resetModules();
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEV_FAKE_SESSION", "");
  authMock.mockReset();
  readStateMock.mockReset();
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
    expect(readStateMock).not.toHaveBeenCalled();
  });

  it("answers null when the session carries no e-mail", async () => {
    authMock.mockResolvedValue({ user: { name: "A" } });
    const getOperatorSession = await loadSession();
    await expect(getOperatorSession("test")).resolves.toBeNull();
  });
});

describe("getOperatorSession — the registry decides", () => {
  it("ends the session of an operator who was blocked while signed in", async () => {
    authMock.mockResolvedValue({ user: { email: "worker@gmail.com", name: "Worker" } });
    readStateMock.mockResolvedValue({ status: "blocked", role: null, displayName: "Worker" });

    const getOperatorSession = await loadSession();

    await expect(getOperatorSession("layout:(app)")).resolves.toBeNull();
    expect(readStateMock).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000001",
      "worker@gmail.com",
    );
  });

  it("treats pending and unknown as no session too", async () => {
    authMock.mockResolvedValue({ user: { email: "worker@gmail.com", name: null } });
    const getOperatorSession = await loadSession();

    readStateMock.mockResolvedValue({ status: "pending", role: null, displayName: null });
    await expect(getOperatorSession("test")).resolves.toBeNull();

    readStateMock.mockResolvedValue({ status: "unknown", role: null, displayName: null });
    await expect(getOperatorSession("test")).resolves.toBeNull();
  });

  it("lets an approved operator in, carrying the role", async () => {
    authMock.mockResolvedValue({ user: { email: "worker@gmail.com", name: "Worker" } });
    readStateMock.mockResolvedValue({ status: "approved", role: "editor", displayName: "Worker" });

    const getOperatorSession = await loadSession();

    await expect(getOperatorSession("test")).resolves.toEqual({
      email: "worker@gmail.com",
      name: "Worker",
      isDevFake: false,
      role: "editor",
      isBootstrapAdmin: false,
    });
  });
});

describe("getOperatorSession — env bootstrap admins", () => {
  it("lets an address from AUTH_BOOTSTRAP_ADMINS in with an EMPTY registry, without a query", async () => {
    authMock.mockResolvedValue({ user: { email: "boss@mysp.vn", name: "Boss" } });
    const getOperatorSession = await loadSession();

    const session = await getOperatorSession("test");
    expect(session).toMatchObject({ email: "boss@mysp.vn", isBootstrapAdmin: true, role: null });
    expect(canManageAccess(session)).toBe(true);
    expect(readStateMock).not.toHaveBeenCalled();
  });

  it("lets an allow-listed Facebook id in through its synthetic address", async () => {
    authMock.mockResolvedValue({
      user: { email: "fb-992710700450296@facebook.local", name: "Boss FB" },
    });
    const getOperatorSession = await loadSession();

    await expect(getOperatorSession("test")).resolves.toMatchObject({ isBootstrapAdmin: true });
    expect(readStateMock).not.toHaveBeenCalled();
  });

  it("does not mistake another Facebook id for the allow-listed one", async () => {
    authMock.mockResolvedValue({ user: { email: "fb-111@facebook.local", name: "Stranger" } });
    readStateMock.mockResolvedValue({ status: "pending", role: null, displayName: null });

    const getOperatorSession = await loadSession();

    await expect(getOperatorSession("test")).resolves.toBeNull();
    expect(readStateMock).toHaveBeenCalled();
  });
});

/**
 * The B1 regression guard. AUTH_ALLOWED_DOMAINS covers an open-ended set of
 * people ("anyone with a company address"), so it must never produce a session
 * that is both admin and unblockable. Reading it as a grant is what these three
 * tests exist to prevent.
 */
describe("getOperatorSession — a domain match is not a grant", () => {
  it("sends a domain match through the registry, and refuses it while pending", async () => {
    authMock.mockResolvedValue({ user: { email: "colleague@mysp.vn", name: "Colleague" } });
    readStateMock.mockResolvedValue({ status: "pending", role: null, displayName: null });

    const getOperatorSession = await loadSession();

    await expect(getOperatorSession("test")).resolves.toBeNull();
    expect(readStateMock).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000001",
      "colleague@mysp.vn",
    );
  });

  it("gives an approved domain match the role from the registry — and no admin rights", async () => {
    authMock.mockResolvedValue({ user: { email: "colleague@mysp.vn", name: "Colleague" } });
    readStateMock.mockResolvedValue({ status: "approved", role: "editor", displayName: null });

    const getOperatorSession = await loadSession();
    const session = await getOperatorSession("test");

    expect(session).toMatchObject({ role: "editor", isBootstrapAdmin: false });
    expect(canManageAccess(session)).toBe(false);
  });

  it("can block a domain match — the whole point of B1", async () => {
    authMock.mockResolvedValue({ user: { email: "colleague@mysp.vn", name: "Colleague" } });
    readStateMock.mockResolvedValue({ status: "blocked", role: null, displayName: null });

    const getOperatorSession = await loadSession();
    await expect(getOperatorSession("test")).resolves.toBeNull();
  });
});
