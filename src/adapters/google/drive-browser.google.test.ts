import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "@/core/ports/infra";

/**
 * The in-app Drive picker (E2) against fixtures shaped like Drive v3 answers.
 * No live call is made: what is tested is the boundary contract — the query it
 * builds (including a name with a quote in it), schema validation, the
 * breadcrumb walk with its cycle/depth/permission guards, and error mapping.
 */

const listMock = vi.fn();
const getMock = vi.fn();
const spreadsheetsGetMock = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    drive: () => ({ files: { list: listMock, get: getMock } }),
    sheets: () => ({ spreadsheets: { get: spreadsheetsGetMock } }),
    auth: { JWT: class {}, OAuth2: class {} },
  },
}));

const { makeGoogleDriveBrowser } = await import("./drive-browser.google");
const { escapeQueryValue } = await import("./drive-query");

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

const reportAuthFailure = vi.fn(async () => null);
const auth = {
  forTenant: async () => ({}) as never,
  reportAuthFailure,
  invalidate: () => {},
} as never;

function build(logger = makeLogger()) {
  return makeGoogleDriveBrowser({ auth, logger });
}

beforeEach(() => {
  listMock.mockReset();
  getMock.mockReset();
  spreadsheetsGetMock.mockReset();
  reportAuthFailure.mockReset();
  reportAuthFailure.mockResolvedValue(null);
});

describe("listFolders — the query", () => {
  it("asks Drive for folders of the parent only, trashed excluded", async () => {
    listMock.mockResolvedValueOnce({ data: { files: [{ id: "1abc", name: "Ảnh sản phẩm" }] } });

    const result = await build().listFolders({ tenantId: TENANT, parentId: "root" });

    const args = listMock.mock.calls[0][0];
    expect(args.q).toBe(
      "'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
    );
    expect(args).toMatchObject({
      fields: "nextPageToken,files(id,name,modifiedTime)",
      orderBy: "folder,name",
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    expect(result.items).toEqual([{ id: "1abc", name: "Ảnh sản phẩm" }]);
    expect(result.nextPageToken).toBeNull();
    // parentId=root: the breadcrumb is one entry and costs no extra call.
    expect(result.breadcrumb).toEqual([{ id: "root", name: "Drive của tôi" }]);
    expect(getMock).not.toHaveBeenCalled();
  });

  it("escapes a quote in the search text so it cannot break out of the literal", async () => {
    listMock.mockResolvedValueOnce({ data: { files: [] } });
    await build().listFolders({ tenantId: TENANT, parentId: "root", q: "Ảnh 'mẫu' 2026" });

    expect(listMock.mock.calls[0][0].q).toContain("name contains 'Ảnh \\'mẫu\\' 2026'");
  });

  it("escapes a backslash before the quote (order matters)", () => {
    expect(escapeQueryValue("a\\'b")).toBe("a\\\\\\'b");
  });

  it.each([
    ["plain", "plain"],
    ["it's", "it\\'s"],
    ["a\\b", "a\\\\b"],
    ["\\'", "\\\\\\'"],
    ["''", "\\'\\'"],
  ])("escapeQueryValue(%j) -> %j", (raw, expected) => {
    expect(escapeQueryValue(raw)).toBe(expected);
  });

  it("passes the page token through and returns the next one", async () => {
    listMock.mockResolvedValueOnce({
      data: { files: [{ id: "1", name: "A" }], nextPageToken: "page-2" },
    });

    const result = await build().listFolders({
      tenantId: TENANT,
      parentId: "root",
      pageToken: "page-1",
    });

    expect(listMock.mock.calls[0][0].pageToken).toBe("page-1");
    expect(result.nextPageToken).toBe("page-2");
  });

  it("drops entries without an id or a name and counts them in a warning", async () => {
    const logger = makeLogger();
    listMock.mockResolvedValueOnce({
      data: { files: [{ id: "1", name: "A" }, { name: "no-id" }, { id: "2" }] },
    });

    const result = await build(logger).listFolders({ tenantId: TENANT, parentId: "root" });

    expect(result.items).toEqual([{ id: "1", name: "A" }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ malformed_entries: 2 }),
    );
  });

  it("rejects a payload that does not look like a Drive listing", async () => {
    listMock.mockResolvedValueOnce({ data: { files: "not-an-array" } });
    await expect(
      build().listFolders({ tenantId: TENANT, parentId: "root" }),
    ).rejects.toMatchObject({ code: "DRIVE_ERROR" });
  });
});

describe("listFolders — error mapping", () => {
  it("maps 404/403 to INVALID_INPUT: a wrong id is not an outage", async () => {
    listMock.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: 404 }));
    await expect(
      build().listFolders({ tenantId: TENANT, parentId: "missing" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { http_status: 404 } });
  });

  it("maps a rate limit to DRIVE_ERROR with the tenant in context", async () => {
    listMock.mockRejectedValueOnce(Object.assign(new Error("rate limit"), { code: 429 }));
    await expect(
      build().listFolders({ tenantId: TENANT, parentId: "root" }),
    ).rejects.toMatchObject({
      code: "DRIVE_ERROR",
      context: { tenant_id: TENANT, http_status: 429 },
    });
  });

  it("lets an expired tenant connection win over the generic mapping", async () => {
    reportAuthFailure.mockResolvedValueOnce({
      _tag: "AppError",
      code: "GOOGLE_AUTH_EXPIRED",
    } as never);
    listMock.mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { code: 401 }));

    await expect(
      build().listFolders({ tenantId: TENANT, parentId: "root" }),
    ).rejects.toMatchObject({ code: "GOOGLE_AUTH_EXPIRED" });
  });
});

describe("listFolders — breadcrumb", () => {
  it("climbs the parent chain and returns it root-first", async () => {
    listMock.mockResolvedValueOnce({ data: { files: [] } });
    getMock
      .mockResolvedValueOnce({ data: { id: "child", name: "Ảnh sản phẩm", parents: ["parent"] } })
      .mockResolvedValueOnce({ data: { id: "parent", name: "Hàng 2026", parents: ["theRoot"] } })
      .mockResolvedValueOnce({ data: { id: "theRoot", name: "My Drive" } });

    const result = await build().listFolders({ tenantId: TENANT, parentId: "child" });

    expect(result.breadcrumb).toEqual([
      { id: "root", name: "Drive của tôi" },
      { id: "parent", name: "Hàng 2026" },
      { id: "child", name: "Ảnh sản phẩm" },
    ]);
  });

  it("stops at an ancestor the account cannot read, instead of failing the listing", async () => {
    const logger = makeLogger();
    listMock.mockResolvedValueOnce({ data: { files: [{ id: "x", name: "X" }] } });
    getMock
      .mockResolvedValueOnce({ data: { id: "child", name: "Chia sẻ với tôi", parents: ["hidden"] } })
      .mockRejectedValueOnce(Object.assign(new Error("forbidden"), { code: 403 }));

    const result = await build(logger).listFolders({ tenantId: TENANT, parentId: "child" });

    expect(result.items).toEqual([{ id: "x", name: "X" }]);
    expect(result.breadcrumb).toEqual([
      { id: "root", name: "Drive của tôi" },
      { id: "child", name: "Chia sẻ với tôi" },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "BREADCRUMB_ANCESTOR_UNREADABLE" }),
    );
  });

  it("breaks a parent cycle instead of spinning forever", async () => {
    const logger = makeLogger();
    listMock.mockResolvedValueOnce({ data: { files: [] } });
    getMock.mockImplementation(async ({ fileId }: { fileId: string }) => ({
      data: { id: fileId, name: fileId, parents: [fileId === "a" ? "b" : "a"] },
    }));

    const result = await build(logger).listFolders({ tenantId: TENANT, parentId: "a" });

    expect(getMock).toHaveBeenCalledTimes(2);
    expect(result.breadcrumb.map((entry) => entry.id)).toEqual(["root", "b", "a"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "BREADCRUMB_CYCLE" }),
    );
  });

  it("stops at the depth cap when Drive keeps handing back a new parent", async () => {
    const logger = makeLogger();
    listMock.mockResolvedValueOnce({ data: { files: [] } });
    let index = 0;
    getMock.mockImplementation(async ({ fileId }: { fileId: string }) => {
      index += 1;
      return { data: { id: fileId, name: `f${index}`, parents: [`f-${index}`] } };
    });

    const result = await build(logger).listFolders({ tenantId: TENANT, parentId: "deep" });

    expect(getMock).toHaveBeenCalledTimes(20);
    expect(result.breadcrumb).toHaveLength(21);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "BREADCRUMB_TOO_DEEP" }),
    );
  });
});

describe("listSpreadsheets", () => {
  it("searches the whole Drive, newest first, when no folder is given", async () => {
    listMock.mockResolvedValueOnce({ data: { files: [{ id: "s1", name: "Hàng thiết kế 2026" }] } });

    const result = await build().listSpreadsheets({ tenantId: TENANT });

    const args = listMock.mock.calls[0][0];
    expect(args.q).toBe(
      "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    );
    expect(args.orderBy).toBe("modifiedTime desc");
    expect(result.items).toEqual([{ id: "s1", name: "Hàng thiết kế 2026" }]);
  });

  it("scopes to a folder and sorts by name when a parent is given", async () => {
    listMock.mockResolvedValueOnce({ data: { files: [] } });
    await build().listSpreadsheets({ tenantId: TENANT, parentId: "1abc", q: "hàng" });

    const args = listMock.mock.calls[0][0];
    expect(args.q).toBe(
      "'1abc' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and name contains 'hàng'",
    );
    expect(args.orderBy).toBe("folder,name");
  });
});

describe("listSheetTabs", () => {
  it("refuses an empty spreadsheet id before calling Sheets", async () => {
    await expect(
      build().listSheetTabs({ tenantId: TENANT, spreadsheetId: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(spreadsheetsGetMock).not.toHaveBeenCalled();
  });

  it("maps a 404 to INVALID_INPUT with a message about the id/permission", async () => {
    spreadsheetsGetMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: 404 }));
    await expect(
      build().listSheetTabs({ tenantId: TENANT, spreadsheetId: "sheet-1" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { http_status: 404 } });
  });

  it("maps an outage to SHEET_ERROR", async () => {
    spreadsheetsGetMock.mockRejectedValueOnce(Object.assign(new Error("down"), { code: 503 }));
    await expect(
      build().listSheetTabs({ tenantId: TENANT, spreadsheetId: "sheet-1" }),
    ).rejects.toMatchObject({ code: "SHEET_ERROR" });
  });

  it("returns the tab titles in sheet order, skipping untitled entries", async () => {
    spreadsheetsGetMock.mockResolvedValueOnce({
      data: {
        sheets: [
          { properties: { title: "Mẫu 2026" } },
          { properties: {} },
          { properties: { title: "Sheet1" } },
        ],
      },
    });

    await expect(
      build().listSheetTabs({ tenantId: TENANT, spreadsheetId: "sheet-1" }),
    ).resolves.toEqual(["Mẫu 2026", "Sheet1"]);
    expect(spreadsheetsGetMock).toHaveBeenCalledWith({
      spreadsheetId: "sheet-1",
      fields: "sheets.properties.title",
    });
  });
});


/**
 * The probe behind the "kết nối được nhưng không đọc được nguồn" warning.
 *
 * `files.get` is used deliberately: `files.list` answers HTTP 200 with an empty
 * page for a folder the account cannot see, which is the very ambiguity this
 * check exists to remove.
 */
describe("checkSourceAccess", () => {
  const source = { tenantId: TENANT, driveFolderId: "folder-1", spreadsheetId: "sheet-1" };

  it("answers no_source without calling Google when nothing is configured", async () => {
    await expect(
      build().checkSourceAccess({ tenantId: TENANT, driveFolderId: "", spreadsheetId: null }),
    ).resolves.toBe("no_source");
    expect(getMock).not.toHaveBeenCalled();
    expect(spreadsheetsGetMock).not.toHaveBeenCalled();
  });

  it("answers ok when both objects can be read", async () => {
    getMock.mockResolvedValueOnce({ data: { id: "folder-1" } });
    spreadsheetsGetMock.mockResolvedValueOnce({ data: { spreadsheetId: "sheet-1" } });

    await expect(build().checkSourceAccess(source)).resolves.toBe("ok");
    expect(getMock).toHaveBeenCalledWith({
      fileId: "folder-1",
      fields: "id",
      supportsAllDrives: true,
    });
  });

  it.each([404, 403])("answers drive_unreadable on HTTP %s from the folder", async (status) => {
    getMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: status }));
    spreadsheetsGetMock.mockResolvedValueOnce({ data: { spreadsheetId: "sheet-1" } });

    await expect(build().checkSourceAccess(source)).resolves.toBe("drive_unreadable");
  });

  it("answers spreadsheet_unreadable when only the sheet is invisible", async () => {
    getMock.mockResolvedValueOnce({ data: { id: "folder-1" } });
    spreadsheetsGetMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: 403 }));

    await expect(build().checkSourceAccess(source)).resolves.toBe("spreadsheet_unreadable");
  });

  it("answers both_unreadable when neither can be read", async () => {
    getMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: 404 }));
    spreadsheetsGetMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: 404 }));

    await expect(build().checkSourceAccess(source)).resolves.toBe("both_unreadable");
  });

  it("answers unknown (never ok) when the check is inconclusive", async () => {
    getMock.mockRejectedValueOnce(Object.assign(new Error("down"), { code: 503 }));
    spreadsheetsGetMock.mockResolvedValueOnce({ data: { spreadsheetId: "sheet-1" } });

    await expect(build().checkSourceAccess(source)).resolves.toBe("unknown");
  });

  it("prefers a real verdict over an inconclusive half", async () => {
    getMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: 403 }));
    spreadsheetsGetMock.mockRejectedValueOnce(Object.assign(new Error("down"), { code: 500 }));

    await expect(build().checkSourceAccess(source)).resolves.toBe("drive_unreadable");
  });

  it("never parks the integration row: a probe runs right after a successful connect", async () => {
    getMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: 401 }));
    spreadsheetsGetMock.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: 401 }));

    await expect(build().checkSourceAccess(source)).resolves.toBe("unknown");
    expect(reportAuthFailure).not.toHaveBeenCalled();
  });

  it("refuses an empty tenant id", async () => {
    await expect(
      build().checkSourceAccess({ tenantId: " ", driveFolderId: "f", spreadsheetId: "s" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
