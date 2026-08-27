import { describe, expect, it, vi } from "vitest";

import { DEFAULT_STOCK_POLICY, MYSP_FIELD_MAP } from "@/core/domain/catalog-field-map";

import type { CatalogConfigRepo, CatalogSourceConfig } from "@/core/ports/drive-source";
import type {
  GoogleDriveBrowser,
  GoogleOAuthConnection,
  GoogleOAuthRepo,
  GoogleSourceAccessState,
  SaveGoogleConnectionInput,
  SaveGoogleSourceAccessInput,
} from "@/core/ports/google-oauth";
import type { Clock, Logger } from "@/core/ports/infra";

import { makeConnectGoogleDrive } from "../connect-google-drive";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * E2 — "Kết nối Google Drive". Edge cases first (CLAUDE.md technical rule 1):
 * CSRF, a cancelled consent, a consent that hands back no refresh token, a
 * revoke Google refuses. The happy path is the last test of each block.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const STATE = "a".repeat(64);
const NOW = Date.UTC(2026, 7, 19, 3, 0, 0);

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

const clock: Clock = { now: () => new Date(NOW), nowMs: () => NOW };

function makeRepo(overrides: Partial<GoogleOAuthRepo> = {}) {
  const saved: SaveGoogleConnectionInput[] = [];
  const access: SaveGoogleSourceAccessInput[] = [];
  const repo: GoogleOAuthRepo = {
    findConnection: vi.fn(async () => null),
    findRefreshToken: vi.fn(async () => null),
    saveConnection: vi.fn(async (input: SaveGoogleConnectionInput) => {
      saved.push(input);
    }),
    deleteConnection: vi.fn(async () => ({ removed: true })),
    markConnectionExpired: vi.fn(async () => {}),
    saveSourceAccess: vi.fn(async (input: SaveGoogleSourceAccessInput) => {
      access.push(input);
    }),
    ...overrides,
  };
  return { repo, saved, access };
}

const SOURCE: CatalogSourceConfig = {
  driveFolderId: "folder-1",
  spreadsheetId: "sheet-1",
  sheetName: "Mẫu 2026",
};

function makeCatalogConfig(source: CatalogSourceConfig | null = SOURCE): CatalogConfigRepo {
  return {
    findCatalogConfig: vi.fn(async () => source),
    findStockPolicy: vi.fn(async () => DEFAULT_STOCK_POLICY),
    findFieldMap: vi.fn(async () => MYSP_FIELD_MAP),
    findCatalogSource: vi.fn(async () => source),
    saveCatalogSource: vi.fn(async () => ({ previous: null })),
  };
}

function makeBrowser(
  check: () => Promise<GoogleSourceAccessState> = async () => "ok",
): GoogleDriveBrowser {
  return {
    listFolders: vi.fn(async () => ({ items: [], nextPageToken: null, breadcrumb: [] })),
    listSpreadsheets: vi.fn(async () => ({ items: [], nextPageToken: null })),
    listSheetTabs: vi.fn(async () => []),
    checkSourceAccess: vi.fn(check),
  };
}

function makeClient(overrides: Partial<Parameters<typeof makeConnectGoogleDrive>[0]["client"]> = {}) {
  return {
    buildAuthorizeUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth?state=x"),
    exchangeCode: vi.fn(async () => ({
      refreshToken: "refresh-token-value",
      email: "shop@gmail.com",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    })),
    revoke: vi.fn(async () => {}),
    ...overrides,
  };
}

function build(options: {
  repo?: GoogleOAuthRepo;
  client?: ReturnType<typeof makeClient>;
  invalidate?: (tenantId: string) => void;
  logger?: Logger;
  newState?: () => string;
  catalogConfig?: CatalogConfigRepo;
  browser?: GoogleDriveBrowser;
} = {}) {
  const logger = options.logger ?? makeLogger();
  return makeConnectGoogleDrive({
    oauth: options.repo ?? makeRepo().repo,
    client: options.client ?? makeClient(),
    authCache: { invalidate: options.invalidate ?? vi.fn() },
    catalogConfig: options.catalogConfig ?? makeCatalogConfig(null),
    browser: options.browser ?? makeBrowser(),
    clock,
    logger,
    newState: options.newState ?? (() => STATE),
  });
}

describe("startGoogleConnect", () => {
  it("refuses a tenant id that is not a UUID before minting a nonce", async () => {
    const client = makeClient();
    await expect(build({ client }).startGoogleConnect({ tenantId: testTenantId("nope") })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(client.buildAuthorizeUrl).not.toHaveBeenCalled();
  });

  it("refuses a state too short to be a CSRF nonce", async () => {
    const client = makeClient();
    const usecase = build({ client, newState: () => "short" });
    await expect(usecase.startGoogleConnect({ tenantId: TENANT })).rejects.toMatchObject({
      code: "INTERNAL",
    });
    expect(client.buildAuthorizeUrl).not.toHaveBeenCalled();
  });

  it("surfaces the adapter's 'no OAuth app configured' error as-is", async () => {
    const client = makeClient({
      buildAuthorizeUrl: vi.fn(() => {
        throw Object.assign(new Error("missing"), {
          _tag: "AppError",
          code: "GOOGLE_OAUTH_NOT_CONFIGURED",
        });
      }),
    });
    await expect(build({ client }).startGoogleConnect({ tenantId: TENANT })).rejects.toMatchObject({
      code: "GOOGLE_OAUTH_NOT_CONFIGURED",
    });
  });

  it("returns the consent URL and the nonce the callback will re-check", async () => {
    const result = await build().startGoogleConnect({ tenantId: TENANT });
    expect(result).toEqual({
      tenantId: TENANT,
      state: STATE,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=x",
    });
  });
});

describe("completeGoogleConnect", () => {
  it("refuses when the state cookie is gone (expired or blocked)", async () => {
    const client = makeClient();
    await expect(
      build({ client }).completeGoogleConnect({
        tenantId: TENANT,
        code: "code-1",
        state: STATE,
        expectedState: "",
      }),
    ).rejects.toMatchObject({
      code: "GOOGLE_CONNECT_STATE_INVALID",
      context: { reason: "STATE_MISSING" },
    });
    expect(client.exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses a state that does not match the one we issued", async () => {
    const client = makeClient();
    await expect(
      build({ client }).completeGoogleConnect({
        tenantId: TENANT,
        code: "code-1",
        state: "b".repeat(64),
        expectedState: STATE,
      }),
    ).rejects.toMatchObject({
      code: "GOOGLE_CONNECT_STATE_INVALID",
      context: { reason: "STATE_MISMATCH" },
    });
    expect(client.exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses when Google sent no authorization code", async () => {
    const client = makeClient();
    await expect(
      build({ client }).completeGoogleConnect({
        tenantId: TENANT,
        code: "  ",
        state: STATE,
        expectedState: STATE,
      }),
    ).rejects.toMatchObject({
      code: "GOOGLE_CONNECT_STATE_INVALID",
      context: { reason: "CODE_MISSING" },
    });
    expect(client.exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses a consent that returns no refresh token instead of storing a one-hour connection", async () => {
    const { repo } = makeRepo();
    const client = makeClient({
      exchangeCode: vi.fn(async () => ({ refreshToken: "", email: "a@b.c", scopes: [] })),
    });

    await expect(
      build({ repo, client }).completeGoogleConnect({
        tenantId: TENANT,
        code: "code-1",
        state: STATE,
        expectedState: STATE,
      }),
    ).rejects.toMatchObject({
      code: "GOOGLE_AUTH_EXPIRED",
      context: { reason: "REFRESH_TOKEN_MISSING" },
    });
    expect(repo.saveConnection).not.toHaveBeenCalled();
  });

  it("stores the connection, drops the cached client and never returns the token", async () => {
    const { repo, saved } = makeRepo();
    const invalidate = vi.fn();
    const view = await build({ repo, invalidate }).completeGoogleConnect({
      tenantId: TENANT,
      code: "code-1",
      state: STATE,
      expectedState: STATE,
      actorEmail: "Operator@Example.com",
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      tenantId: TENANT,
      refreshToken: "refresh-token-value",
      email: "shop@gmail.com",
      connectedAt: new Date(NOW).toISOString(),
      actorEmail: "operator@example.com",
    });
    expect(invalidate).toHaveBeenCalledWith(TENANT);
    expect(view).toEqual({
      state: "connected",
      email: "shop@gmail.com",
      connectedAt: new Date(NOW).toISOString(),
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      // No source configured yet — the normal state of a first connect.
      sourceAccess: "no_source",
    });
    expect(JSON.stringify(view)).not.toContain("refresh-token-value");
  });
});

describe("completeGoogleConnect — can the NEW account read the OLD source?", () => {
  /**
   * The scenario that made this whole check necessary: a tenant running on the
   * Service Account connects a personal Google account. The sheet is theirs, the
   * photo folder is not — and Drive reports an invisible folder as an EMPTY one.
   */
  it("records drive_unreadable and still connects — picking a new source is the normal next step", async () => {
    const { repo, access } = makeRepo();
    const browser = makeBrowser(async () => "drive_unreadable");

    const view = await build({
      repo,
      browser,
      catalogConfig: makeCatalogConfig(),
    }).completeGoogleConnect({
      tenantId: TENANT,
      code: "code-1",
      state: STATE,
      expectedState: STATE,
    });

    expect(view).toMatchObject({ state: "connected", sourceAccess: "drive_unreadable" });
    expect(browser.checkSourceAccess).toHaveBeenCalledWith({
      tenantId: TENANT,
      driveFolderId: "folder-1",
      spreadsheetId: "sheet-1",
    });
    expect(access).toEqual([
      { tenantId: TENANT, state: "drive_unreadable", checkedAt: new Date(NOW).toISOString() },
    ]);
  });

  it("checks with the NEW identity: the cached client is dropped before the probe runs", async () => {
    const order: string[] = [];
    const { repo } = makeRepo();
    const browser = makeBrowser(async () => {
      order.push("probe");
      return "ok";
    });

    await build({
      repo,
      browser,
      catalogConfig: makeCatalogConfig(),
      invalidate: () => order.push("invalidate"),
    }).completeGoogleConnect({
      tenantId: TENANT,
      code: "code-1",
      state: STATE,
      expectedState: STATE,
    });

    expect(order).toEqual(["invalidate", "probe"]);
  });

  it("reports unknown (never ok) when the probe itself fails, and connects anyway", async () => {
    const { repo, access } = makeRepo();
    const browser = makeBrowser(async () => {
      throw new Error("drive is down");
    });

    const view = await build({
      repo,
      browser,
      catalogConfig: makeCatalogConfig(),
    }).completeGoogleConnect({
      tenantId: TENANT,
      code: "code-1",
      state: STATE,
      expectedState: STATE,
    });

    expect(view).toMatchObject({ state: "connected", sourceAccess: "unknown" });
    expect(access[0]?.state).toBe("unknown");
  });

  it("still connects when the result cannot be stored — the connection is what matters", async () => {
    const { repo } = makeRepo({
      saveSourceAccess: vi.fn(async () => {
        throw new Error("db is down");
      }),
    });
    const logger = makeLogger();

    const view = await build({
      repo,
      logger,
      browser: makeBrowser(),
      catalogConfig: makeCatalogConfig(),
    }).completeGoogleConnect({
      tenantId: TENANT,
      code: "code-1",
      state: STATE,
      expectedState: STATE,
    });

    expect(view).toMatchObject({ state: "connected", sourceAccess: "ok" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "SOURCE_ACCESS_NOT_STORED" }),
    );
  });

  it("does not probe Drive at all when the tenant has no source yet", async () => {
    const { repo, access } = makeRepo();
    const browser = makeBrowser();

    const view = await build({
      repo,
      browser,
      catalogConfig: makeCatalogConfig(null),
    }).completeGoogleConnect({
      tenantId: TENANT,
      code: "code-1",
      state: STATE,
      expectedState: STATE,
    });

    expect(view).toMatchObject({ sourceAccess: "no_source" });
    expect(browser.checkSourceAccess).not.toHaveBeenCalled();
    expect(access[0]?.state).toBe("no_source");
  });
});

describe("getGoogleConnection", () => {
  it("answers not_connected for a tenant that never connected", async () => {
    const { repo } = makeRepo();
    await expect(build({ repo }).getGoogleConnection({ tenantId: TENANT })).resolves.toEqual({
      state: "not_connected",
    });
  });

  it("answers expired (not not_connected) when the refresh token was revoked", async () => {
    const connection: GoogleOAuthConnection = {
      email: "shop@gmail.com",
      scopes: ["drive.readonly"],
      connectedAt: "2026-08-19T03:00:00.000Z",
      connectedByUserId: null,
      status: "error",
      sourceAccess: null,
    };
    const { repo } = makeRepo({ findConnection: vi.fn(async () => connection) });

    await expect(build({ repo }).getGoogleConnection({ tenantId: TENANT })).resolves.toEqual({
      state: "expired",
      email: "shop@gmail.com",
      connectedAt: "2026-08-19T03:00:00.000Z",
      reason: "GOOGLE_AUTH_EXPIRED",
    });
  });

  it("answers connected with the granted scopes", async () => {
    const connection: GoogleOAuthConnection = {
      email: "shop@gmail.com",
      scopes: ["a", "b"],
      connectedAt: "2026-08-19T03:00:00.000Z",
      connectedByUserId: "user-1",
      status: "active",
      sourceAccess: { state: "drive_unreadable", checkedAt: "2026-08-19T03:05:00.000Z" },
    };
    const { repo } = makeRepo({ findConnection: vi.fn(async () => connection) });

    await expect(build({ repo }).getGoogleConnection({ tenantId: TENANT })).resolves.toEqual({
      state: "connected",
      email: "shop@gmail.com",
      connectedAt: "2026-08-19T03:00:00.000Z",
      scopes: ["a", "b"],
      // Read from the row: /status must never spend a Drive call per poll.
      sourceAccess: "drive_unreadable",
    });
  });
});

describe("disconnectGoogle", () => {
  it("still disconnects locally when Google refuses the revoke", async () => {
    const { repo } = makeRepo({ findRefreshToken: vi.fn(async () => "refresh-token-value") });
    const client = makeClient({
      revoke: vi.fn(async () => {
        throw new Error("google is down");
      }),
    });
    const logger = makeLogger();
    const invalidate = vi.fn();

    const view = await build({ repo, client, logger, invalidate }).disconnectGoogle({
      tenantId: TENANT,
    });

    expect(view).toEqual({ state: "not_connected" });
    expect(repo.deleteConnection).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith(TENANT);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("revoke"),
      expect.objectContaining({ reason: "REVOKE_FAILED" }),
    );
  });

  it("is idempotent: no stored token means no revoke call and still not_connected", async () => {
    const { repo } = makeRepo({
      findRefreshToken: vi.fn(async () => null),
      deleteConnection: vi.fn(async () => ({ removed: false })),
    });
    const client = makeClient();

    await expect(build({ repo, client }).disconnectGoogle({ tenantId: TENANT })).resolves.toEqual({
      state: "not_connected",
    });
    expect(client.revoke).not.toHaveBeenCalled();
  });
});
