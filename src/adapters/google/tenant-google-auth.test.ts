import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GoogleOAuthRepo } from "@/core/ports/google-oauth";
import type { Logger } from "@/core/ports/infra";

/**
 * Which identity reads a tenant's Drive (E2).
 *
 * THE test of this file is the last block: a revoked refresh token must become
 * GOOGLE_AUTH_EXPIRED *before* any listing runs. If it ever came back as an
 * empty listing, the catalog sync would read it as "every product was deleted".
 */

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        constructor(public readonly options: unknown) {}
        setCredentials = vi.fn();
        getAccessToken = vi.fn(async () => ({ token: "access-1" }));
      },
      JWT: class {},
    },
  },
}));

const { makeTenantGoogleAuth, AUTH_CACHE_TTL_MS } = await import("./tenant-google-auth");

const TENANT = "00000000-0000-0000-0000-000000000001";

function makeLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function makeRepo(refreshToken: string | null, overrides: Partial<GoogleOAuthRepo> = {}) {
  const repo: GoogleOAuthRepo = {
    findConnection: vi.fn(async () => null),
    findRefreshToken: vi.fn(async () => refreshToken),
    saveConnection: vi.fn(async () => {}),
    deleteConnection: vi.fn(async () => ({ removed: false })),
    markConnectionExpired: vi.fn(async () => {}),
    saveSourceAccess: vi.fn(async () => {}),
    ...overrides,
  };
  return repo;
}

const serviceAccountClient = { kind: "service-account" };

function build(options: {
  refreshToken?: string | null;
  repo?: GoogleOAuthRepo;
  logger?: Logger;
  getAccessToken?: () => Promise<{ token: string | null }>;
  serviceAccountAuth?: () => never;
  /** Fake clock for the cache TTL; defaults to a frozen "now". */
  nowMs?: () => number;
}) {
  const repo = options.repo ?? makeRepo(options.refreshToken ?? null);
  const oauthClient = {
    setCredentials: vi.fn(),
    getAccessToken:
      options.getAccessToken ?? vi.fn(async () => ({ token: "access-1" })),
  };
  const auth = makeTenantGoogleAuth({
    logger: options.logger ?? makeLogger(),
    oauth: repo,
    readCredentials: () => ({ clientId: "id", clientSecret: "secret" }),
    serviceAccountAuth:
      options.serviceAccountAuth ?? (() => serviceAccountClient as never),
    makeOAuthClient: () => oauthClient as never,
    nowMs: options.nowMs ?? (() => 0),
  });
  return { auth, repo, oauthClient };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("forTenant", () => {
  it("refuses an empty tenant id", async () => {
    const { auth, repo } = build({});
    await expect(auth.forTenant("  ")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(repo.findRefreshToken).not.toHaveBeenCalled();
  });

  it("falls back to the Service Account when the tenant never connected", async () => {
    const { auth } = build({ refreshToken: null });
    await expect(auth.forTenant(TENANT)).resolves.toBe(serviceAccountClient);
  });

  it("builds the Service Account once and caches it per tenant", async () => {
    const serviceAccountAuth = vi.fn(() => serviceAccountClient as never);
    const { auth, repo } = build({ refreshToken: null, serviceAccountAuth });

    await auth.forTenant(TENANT);
    await auth.forTenant(TENANT);

    expect(serviceAccountAuth).toHaveBeenCalledTimes(1);
    expect(repo.findRefreshToken).toHaveBeenCalledTimes(1);
  });

  it("refuses to use a stored connection when the OAuth app credentials are gone", async () => {
    const repo = makeRepo("refresh-1");
    const auth = makeTenantGoogleAuth({
      logger: makeLogger(),
      oauth: repo,
      readCredentials: () => ({ clientId: null, clientSecret: null }),
      serviceAccountAuth: () => serviceAccountClient as never,
    });

    await expect(auth.forTenant(TENANT)).rejects.toMatchObject({
      code: "GOOGLE_OAUTH_NOT_CONFIGURED",
      context: { missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] },
    });
  });

  it("uses the tenant's own connection and caches the client", async () => {
    const { auth, repo, oauthClient } = build({ refreshToken: "refresh-1" });

    await expect(auth.forTenant(TENANT)).resolves.toBe(oauthClient);
    await auth.forTenant(TENANT);
    expect(repo.findRefreshToken).toHaveBeenCalledTimes(1);
    // Refreshed once, up front: a dead grant must fail before any listing.
    expect(oauthClient.getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("re-reads the connection after invalidate (a reconnect must not reuse the old account)", async () => {
    const { auth, repo } = build({ refreshToken: "refresh-1" });
    await auth.forTenant(TENANT);
    auth.invalidate(TENANT);
    await auth.forTenant(TENANT);
    expect(repo.findRefreshToken).toHaveBeenCalledTimes(2);
  });

  /**
   * `invalidate()` only reaches the process that calls it. The worker is a
   * different process, so without an expiry a disconnect on the web would keep
   * the worker syncing under the old identity until somebody restarted it.
   */
  it("re-reads the connection once the cache entry expires, without any invalidate", async () => {
    let now = 0;
    const { auth, repo } = build({ refreshToken: "refresh-1", nowMs: () => now });

    await auth.forTenant(TENANT);
    now += AUTH_CACHE_TTL_MS - 1;
    await auth.forTenant(TENANT);
    expect(repo.findRefreshToken).toHaveBeenCalledTimes(1);

    now += 2;
    await auth.forTenant(TENANT);
    expect(repo.findRefreshToken).toHaveBeenCalledTimes(2);
  });

  it("expires the Service-Account entry too: a tenant that connects elsewhere must be noticed", async () => {
    let now = 0;
    const repo = makeRepo(null);
    const { auth } = build({ repo, nowMs: () => now });

    await expect(auth.forTenant(TENANT)).resolves.toBe(serviceAccountClient);
    now += AUTH_CACHE_TTL_MS + 1;
    await auth.forTenant(TENANT);

    expect(repo.findRefreshToken).toHaveBeenCalledTimes(2);
  });
});

describe("forTenant — a dead grant must never look like an empty Drive", () => {
  it("turns invalid_grant into GOOGLE_AUTH_EXPIRED and parks the integration", async () => {
    const repo = makeRepo("refresh-1");
    const { auth } = build({
      repo,
      getAccessToken: vi.fn(async () => {
        throw { response: { data: { error: "invalid_grant" }, status: 400 } };
      }),
    });

    await expect(auth.forTenant(TENANT)).rejects.toMatchObject({
      code: "GOOGLE_AUTH_EXPIRED",
      context: { tenant_id: TENANT, reason: "REFRESH_REJECTED" },
    });
    expect(repo.markConnectionExpired).toHaveBeenCalledWith(TENANT, "REFRESH_REJECTED");
  });

  it("does NOT park the integration on a network blip — that is retryable", async () => {
    const repo = makeRepo("refresh-1");
    const { auth } = build({
      repo,
      getAccessToken: vi.fn(async () => {
        throw Object.assign(new Error("socket hang up"), { code: 503 });
      }),
    });

    await expect(auth.forTenant(TENANT)).rejects.toMatchObject({
      code: "DRIVE_ERROR",
      context: { reason: "TOKEN_REFRESH_FAILED", retryable: true },
    });
    expect(repo.markConnectionExpired).not.toHaveBeenCalled();
  });

  it("keeps the original failure even when the status update itself fails", async () => {
    const logger = makeLogger();
    const repo = makeRepo("refresh-1", {
      markConnectionExpired: vi.fn(async () => {
        throw new Error("db is down");
      }),
    });
    const { auth } = build({
      repo,
      logger,
      getAccessToken: vi.fn(async () => {
        throw { response: { data: { error: "invalid_grant" } } };
      }),
    });

    await expect(auth.forTenant(TENANT)).rejects.toMatchObject({ code: "GOOGLE_AUTH_EXPIRED" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "MARK_EXPIRED_FAILED" }),
    );
  });

  it("treats an empty access token as a dead grant rather than proceeding", async () => {
    const repo = makeRepo("refresh-1");
    const { auth } = build({ repo, getAccessToken: vi.fn(async () => ({ token: null })) });

    await expect(auth.forTenant(TENANT)).rejects.toMatchObject({ code: "GOOGLE_AUTH_EXPIRED" });
    expect(repo.markConnectionExpired).toHaveBeenCalledWith(TENANT, "ACCESS_TOKEN_EMPTY");
  });
});

describe("reportAuthFailure", () => {
  it("answers null for a Service-Account tenant: a 403 there is a sharing problem", async () => {
    const repo = makeRepo(null);
    const { auth } = build({ repo });
    await auth.forTenant(TENANT);

    await expect(
      auth.reportAuthFailure(TENANT, { response: { data: { error: "invalid_grant" } } }),
    ).resolves.toBeNull();
    expect(repo.markConnectionExpired).not.toHaveBeenCalled();
  });

  it("answers null for an error that is not an auth failure", async () => {
    const { auth } = build({ refreshToken: "refresh-1" });
    await auth.forTenant(TENANT);

    await expect(
      auth.reportAuthFailure(TENANT, Object.assign(new Error("rate limit"), { code: 429 })),
    ).resolves.toBeNull();
  });

  it("turns a mid-listing 401 of a connected tenant into GOOGLE_AUTH_EXPIRED", async () => {
    const repo = makeRepo("refresh-1");
    const { auth } = build({ repo });
    await auth.forTenant(TENANT);

    const mapped = await auth.reportAuthFailure(TENANT, { code: 401 });
    expect(mapped).toMatchObject({ code: "GOOGLE_AUTH_EXPIRED" });
    expect(repo.markConnectionExpired).toHaveBeenCalledWith(TENANT, "HTTP_UNAUTHORIZED");
  });
});
