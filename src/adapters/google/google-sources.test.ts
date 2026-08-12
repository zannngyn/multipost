import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "@/core/ports/infra";

/**
 * Drive/Sheets adapters against fixtures shaped like the real API payloads
 * (values are taken from sample-data). No live call is made — a Service Account
 * does not exist yet, so the boundary contract is what gets tested: pagination,
 * schema validation, error wrapping.
 */

const listMock = vi.fn();
const valuesGetMock = vi.fn();

vi.mock("googleapis", () => ({
  google: {
    drive: () => ({ files: { list: listMock } }),
    sheets: () => ({ spreadsheets: { values: { get: valuesGetMock } } }),
    auth: { JWT: class {} },
  },
}));

const { makeGoogleDriveSource } = await import("./drive-source.google");
const { makeGoogleSheetSource } = await import("./sheet-source.google");
const { makeGoogleAuth } = await import("./service-account");

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const auth = {} as any;

describe("makeGoogleAuth", () => {
  it("refuses to build a client with no credentials configured", () => {
    expect(() => makeGoogleAuth({})).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("refuses a key that is not JSON", () => {
    expect(() => makeGoogleAuth({ serviceAccountJson: "not json" })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("refuses a key missing client_email / private_key", () => {
    expect(() =>
      makeGoogleAuth({ serviceAccountJson: '{"type":"service_account"}' }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("refuses a credentials path that cannot be read", () => {
    expect(() => makeGoogleAuth({ credentialsPath: "/nope/missing-key.json" })).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it("accepts an inlined key with escaped newlines", () => {
    const key = JSON.stringify({
      type: "service_account",
      client_email: "mysp@project.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n",
    });
    expect(() => makeGoogleAuth({ serviceAccountJson: key })).not.toThrow();
  });
});

describe("makeGoogleDriveSource", () => {
  beforeEach(() => {
    listMock.mockReset();
  });

  it("rejects a missing folder id before calling Drive", async () => {
    const drive = makeGoogleDriveSource({ auth, logger: makeLogger() });
    await expect(drive.listFiles({ tenantId: TENANT, folderId: "  " })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(listMock).not.toHaveBeenCalled();
  });

  it("wraps a Drive failure into DRIVE_ERROR with context", async () => {
    listMock.mockRejectedValueOnce(Object.assign(new Error("Insufficient permissions"), { code: 403 }));
    const drive = makeGoogleDriveSource({ auth, logger: makeLogger() });

    const error = await drive
      .listFiles({ tenantId: TENANT, folderId: "folder-1" })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "DRIVE_ERROR" });
    expect((error as { context: Record<string, unknown> }).context).toMatchObject({
      tenant_id: TENANT,
      folder_id: "folder-1",
      operation: "drive.files.list",
    });
  });

  it("rejects a payload that does not look like a Drive listing", async () => {
    listMock.mockResolvedValueOnce({ data: { files: "not-an-array" } });
    const drive = makeGoogleDriveSource({ auth, logger: makeLogger() });
    await expect(drive.listFiles({ tenantId: TENANT, folderId: "folder-1" })).rejects.toMatchObject({
      code: "DRIVE_ERROR",
    });
  });

  it("drops entries without an id or a name instead of returning half-built assets", async () => {
    listMock.mockResolvedValueOnce({
      data: {
        files: [
          {
            id: "1a",
            name: "MGKVX6310-KEM (1).jpeg",
            mimeType: "image/jpeg",
            size: "482913",
            modifiedTime: "2026-08-01T10:00:00.000Z",
          },
          { name: "no-id.jpg" },
          { id: "2b" },
        ],
      },
    });

    const files = await makeGoogleDriveSource({ auth, logger: makeLogger() }).listFiles({
      tenantId: TENANT,
      folderId: "folder-1",
    });

    expect(files).toEqual([
      {
        id: "1a",
        name: "MGKVX6310-KEM (1).jpeg",
        mimeType: "image/jpeg",
        sizeBytes: 482913,
        modifiedTime: "2026-08-01T10:00:00.000Z",
      },
    ]);
  });

  it("follows nextPageToken and excludes folders and trashed files", async () => {
    listMock
      .mockResolvedValueOnce({
        data: {
          files: [{ id: "1", name: "MGKAD6045-XANH (27).png" }],
          nextPageToken: "page-2",
        },
      })
      .mockResolvedValueOnce({
        data: { files: [{ id: "2", name: "MGKAD6045-XANH (28).png" }] },
      });

    const files = await makeGoogleDriveSource({ auth, logger: makeLogger() }).listFiles({
      tenantId: TENANT,
      folderId: "folder-1",
    });

    expect(files.map((file) => file.id)).toEqual(["1", "2"]);
    expect(listMock).toHaveBeenCalledTimes(2);
    const query = listMock.mock.calls[0][0].q as string;
    expect(query).toContain("'folder-1' in parents");
    expect(query).toContain("trashed = false");
    expect(query).toContain("mimeType != 'application/vnd.google-apps.folder'");
    expect(listMock.mock.calls[1][0].pageToken).toBe("page-2");
  });

  it("stops at maxFiles", async () => {
    listMock.mockResolvedValueOnce({
      data: {
        files: [
          { id: "1", name: "a.jpg" },
          { id: "2", name: "b.jpg" },
          { id: "3", name: "c.jpg" },
        ],
        nextPageToken: "page-2",
      },
    });

    const files = await makeGoogleDriveSource({ auth, logger: makeLogger() }).listFiles({
      tenantId: TENANT,
      folderId: "folder-1",
      maxFiles: 2,
    });

    expect(files).toHaveLength(2);
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});

describe("makeGoogleSheetSource", () => {
  beforeEach(() => {
    valuesGetMock.mockReset();
  });

  it("rejects a missing spreadsheet id or tab name", async () => {
    const sheet = makeGoogleSheetSource({ auth, logger: makeLogger() });
    await expect(
      sheet.readRows({ tenantId: TENANT, spreadsheetId: "", sheetName: "Mẫu 2026" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      sheet.readRows({ tenantId: TENANT, spreadsheetId: "sheet-1", sheetName: " " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(valuesGetMock).not.toHaveBeenCalled();
  });

  it("wraps a Sheets failure into SHEET_ERROR with context", async () => {
    valuesGetMock.mockRejectedValueOnce(new Error("Requested entity was not found"));
    const sheet = makeGoogleSheetSource({ auth, logger: makeLogger() });

    const error = await sheet
      .readRows({ tenantId: TENANT, spreadsheetId: "sheet-1", sheetName: "Mẫu 2026" })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "SHEET_ERROR" });
    expect((error as { context: Record<string, unknown> }).context).toMatchObject({
      spreadsheet_id: "sheet-1",
      sheet_name: "Mẫu 2026",
    });
  });

  it("returns an empty snapshot for an empty tab instead of throwing", async () => {
    valuesGetMock.mockResolvedValueOnce({ data: { range: "'Mẫu 2026'!A1:BZ1" } });
    const snapshot = await makeGoogleSheetSource({ auth, logger: makeLogger() }).readRows({
      tenantId: TENANT,
      spreadsheetId: "sheet-1",
      sheetName: "Mẫu 2026",
    });
    expect(snapshot).toEqual({ columns: [], duplicateColumns: [], rows: [] });
  });

  it("maps a ragged grid onto name-addressed rows", async () => {
    valuesGetMock.mockResolvedValueOnce({
      data: {
        range: "'Mẫu 2026'!A1:BZ3",
        values: [
          ["Ảnh", "Mã sản phẩm", "", "Tên sản phẩm", "Tồn", "Mã sản phẩm"],
          ["", "MR0AC6080", "", "Penny", "0"],
          ["", "MRKSQ6066", "", "Celyra", "39", "ignored-duplicate-column"],
        ],
      },
    });

    const snapshot = await makeGoogleSheetSource({ auth, logger: makeLogger() }).readRows({
      tenantId: TENANT,
      spreadsheetId: "sheet-1",
      sheetName: "Mẫu 2026",
    });

    expect(snapshot.columns).toEqual(["Ảnh", "Mã sản phẩm", "Tên sản phẩm", "Tồn"]);
    expect(snapshot.duplicateColumns).toEqual(["Mã sản phẩm"]);
    expect(snapshot.rows[0]).toEqual({
      rowNumber: 2,
      values: { "Ảnh": "", "Mã sản phẩm": "MR0AC6080", "Tên sản phẩm": "Penny", "Tồn": "0" },
    });
    // Missing trailing cells become "", never undefined.
    expect(snapshot.rows[1].values["Tồn"]).toBe("39");
    expect(valuesGetMock.mock.calls[0][0].range).toBe("'Mẫu 2026'!A:BZ");
  });

  it("rejects a payload whose values are not a grid", async () => {
    valuesGetMock.mockResolvedValueOnce({ data: { values: [{ nope: true }] } });
    await expect(
      makeGoogleSheetSource({ auth, logger: makeLogger() }).readRows({
        tenantId: TENANT,
        spreadsheetId: "sheet-1",
        sheetName: "Mẫu 2026",
      }),
    ).rejects.toMatchObject({ code: "SHEET_ERROR" });
  });
});
