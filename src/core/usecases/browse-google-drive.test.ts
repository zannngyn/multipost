import { describe, expect, it, vi } from "vitest";

import type {
  GoogleDriveBrowser,
  GoogleOAuthConnection,
  GoogleOAuthRepo,
} from "@/core/ports/google-oauth";
import type { Logger } from "@/core/ports/infra";

import { makeBrowseGoogleDrive } from "./browse-google-drive";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * E2 — the in-app Drive picker. The gate is the point of this usecase: nothing
 * may reach Drive on behalf of a tenant that has no live Google connection.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

const ACTIVE: GoogleOAuthConnection = {
  email: "shop@gmail.com",
  scopes: [],
  connectedAt: "2026-08-19T03:00:00.000Z",
  connectedByUserId: null,
  status: "active",
  sourceAccess: null,
};

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

function makeBrowser(): GoogleDriveBrowser & {
  listFolders: ReturnType<typeof vi.fn>;
  listSpreadsheets: ReturnType<typeof vi.fn>;
  listSheetTabs: ReturnType<typeof vi.fn>;
} {
  return {
    listFolders: vi.fn(async () => ({
      items: [{ id: "1abc", name: "Ảnh sản phẩm" }],
      nextPageToken: null,
      breadcrumb: [{ id: "root", name: "Drive của tôi" }],
    })),
    listSpreadsheets: vi.fn(async () => ({ items: [], nextPageToken: null })),
    listSheetTabs: vi.fn(async () => ["Mẫu 2026"]),
    checkSourceAccess: vi.fn(async () => "ok" as const),
  } as never;
}

function build(connection: GoogleOAuthConnection | null, logger = makeLogger()) {
  const browser = makeBrowser();
  const oauth: GoogleOAuthRepo = {
    findConnection: vi.fn(async () => connection),
    findRefreshToken: vi.fn(async () => null),
    saveConnection: vi.fn(async () => {}),
    deleteConnection: vi.fn(async () => ({ removed: false })),
    markConnectionExpired: vi.fn(async () => {}),
    saveSourceAccess: vi.fn(async () => {}),
  };
  return { usecase: makeBrowseGoogleDrive({ browser, oauth, logger }), browser, oauth };
}

describe("browseGoogleDrive — the connection gate", () => {
  it("refuses an unconnected tenant with GOOGLE_NOT_CONNECTED and never calls Drive", async () => {
    const { usecase, browser } = build(null);
    await expect(usecase.listFolders({ tenantId: TENANT })).rejects.toMatchObject({
      code: "GOOGLE_NOT_CONNECTED",
    });
    expect(browser.listFolders).not.toHaveBeenCalled();
  });

  it("refuses a connection Google already rejected with GOOGLE_AUTH_EXPIRED", async () => {
    const { usecase, browser } = build({ ...ACTIVE, status: "error" });
    await expect(usecase.listFolders({ tenantId: TENANT, parentId: "1abc" })).rejects.toMatchObject({
      code: "GOOGLE_AUTH_EXPIRED",
    });
    expect(browser.listFolders).not.toHaveBeenCalled();
  });

  it("applies the same gate to spreadsheets and tabs", async () => {
    const { usecase, browser } = build(null);
    await expect(usecase.listSpreadsheets({ tenantId: TENANT })).rejects.toMatchObject({
      code: "GOOGLE_NOT_CONNECTED",
    });
    await expect(
      usecase.listSheetTabs({ tenantId: TENANT, spreadsheetId: "sheet-1" }),
    ).rejects.toMatchObject({ code: "GOOGLE_NOT_CONNECTED" });
    expect(browser.listSpreadsheets).not.toHaveBeenCalled();
    expect(browser.listSheetTabs).not.toHaveBeenCalled();
  });
});

describe("browseGoogleDrive — input validation", () => {
  it("refuses a tenant id that is not a UUID", async () => {
    const { usecase, oauth } = build(ACTIVE);
    await expect(usecase.listFolders({ tenantId: testTenantId("nope") })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(oauth.findConnection).not.toHaveBeenCalled();
  });

  it("refuses an absurdly long search text before it reaches a Drive query", async () => {
    const { usecase, browser } = build(ACTIVE);
    await expect(
      usecase.listFolders({ tenantId: TENANT, q: "x".repeat(200) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { reason: "QUERY_TOO_LONG" } });
    expect(browser.listFolders).not.toHaveBeenCalled();
  });

  it("refuses a missing spreadsheet id", async () => {
    const { usecase, browser } = build(ACTIVE);
    await expect(
      usecase.listSheetTabs({ tenantId: TENANT, spreadsheetId: "   " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(browser.listSheetTabs).not.toHaveBeenCalled();
  });
});

describe("browseGoogleDrive — happy path", () => {
  it("defaults to the Drive root and normalises blank paging/search to null", async () => {
    const { usecase, browser } = build(ACTIVE);
    const result = await usecase.listFolders({ tenantId: TENANT, parentId: "  ", q: "  " });

    expect(browser.listFolders).toHaveBeenCalledWith({
      tenantId: TENANT,
      parentId: "root",
      pageToken: null,
      q: null,
    });
    expect(result.breadcrumb).toEqual([{ id: "root", name: "Drive của tôi" }]);
  });

  it("keeps 'no parent' for spreadsheets, which means search the whole Drive", async () => {
    const { usecase, browser } = build(ACTIVE);
    await usecase.listSpreadsheets({ tenantId: TENANT, q: "hàng thiết kế" });

    expect(browser.listSpreadsheets).toHaveBeenCalledWith({
      tenantId: TENANT,
      parentId: null,
      pageToken: null,
      q: "hàng thiết kế",
    });
  });

  it("warns when a spreadsheet reports no tab at all", async () => {
    const logger = makeLogger();
    const { usecase, browser } = build(ACTIVE, logger);
    browser.listSheetTabs.mockResolvedValueOnce([]);

    await expect(
      usecase.listSheetTabs({ tenantId: TENANT, spreadsheetId: "sheet-1" }),
    ).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "NO_TABS" }),
    );
  });
});
