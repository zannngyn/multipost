import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { updateCatalogSource } from "@/ui/services/catalog.api";

/**
 * N1 — WHAT ENDS UP ON THE WIRE for `PUT /api/catalog/source`.
 *
 * The bug this locks out is a lost update, and it is invisible from every other
 * angle: the mapping wizard reads the tenant's Drive folder and spreadsheet from
 * a GET, then sits open while an operator works through three steps. Echoing
 * those values back on save reverts whatever another admin changed in the
 * meantime — silently, with a 200, and with a window measured in minutes.
 *
 * So the assertion is about ABSENCE, which no type can express: the three
 * coordinate keys must not be in the body at all. `undefined` and `""` mean
 * opposite things to the server ("giữ nguyên" vs "xoá"), so a `?? ""` slipping
 * back in anywhere would turn every mapping save into a request to blank the
 * tenant's source.
 */

const fetchMock = vi.fn();

/** The body actually sent, decoded from the fetch call. */
function sentBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

const FIELD_MAP = {
  code: "Mã sản phẩm",
  name: "Tên sản phẩm",
  description: "Mô tả",
  category: null,
  season: null,
  stock: "Tồn",
  note: "Lưu ý",
  colors: null,
  mediaLink: null,
};

/** A response shaped like the real one, so the schema parse succeeds. */
const OK_RESPONSE = {
  state: "configured",
  tenantId: "00000000-0000-0000-0000-000000000001",
  source: {
    driveFolderId: "folder-1",
    spreadsheetId: "sheet-1",
    sheetName: "Mẫu 2026",
    driveFolderUrl: "https://drive.google.com/drive/folders/folder-1",
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
    fieldMap: null,
    stockPolicy: null,
    mediaProfile: null,
    textSource: null,
  },
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(OK_RESPONSE), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("updateCatalogSource — the mapping wizard's save", () => {
  it("sends NO coordinate keys at all", async () => {
    await updateCatalogSource({
      fieldMap: FIELD_MAP,
      stockPolicy: { mode: "numeric" },
      sheetColumns: ["Mã sản phẩm", "Tên sản phẩm", "Mô tả", "Tồn", "Lưu ý"],
    });

    const body = sentBody();
    // `in`, not a truthiness check: a key present with "" is the dangerous case,
    // and it would pass `!body.driveFolder`.
    expect("driveFolder" in body).toBe(false);
    expect("spreadsheet" in body).toBe(false);
    expect("sheetName" in body).toBe(false);
  });

  it("still sends everything the mapping step owns", async () => {
    await updateCatalogSource({
      fieldMap: FIELD_MAP,
      stockPolicy: { mode: "numeric" },
      mediaProfile: { kind: "code-color-seq" },
      sheetColumns: ["Mã sản phẩm"],
    });

    const body = sentBody();
    expect(body.fieldMap).toEqual(FIELD_MAP);
    expect(body.stockPolicy).toEqual({ mode: "numeric" });
    expect(body.mediaProfile).toEqual({ kind: "code-color-seq" });
    expect(body.sheetColumns).toEqual(["Mã sản phẩm"]);
  });

  it("does not repoint the source as a side effect of fixing a column", async () => {
    await updateCatalogSource({ fieldMap: FIELD_MAP, stockPolicy: { mode: "numeric" } });

    expect("textConfig" in sentBody()).toBe(false);
  });

  /**
   * The client guard must not fire on a caller that sends no coordinates: there
   * is nothing to validate, and a 400 raised here would be a browser refusing a
   * request the API accepts.
   */
  it("does not refuse a mapping save for 'missing' coordinates", async () => {
    await expect(
      updateCatalogSource({ fieldMap: FIELD_MAP, stockPolicy: { mode: "numeric" } }),
    ).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("updateCatalogSource — the two screens that DO change the source", () => {
  it("sends all three coordinates and the switch to a Google tab", async () => {
    await updateCatalogSource({
      driveFolder: "https://drive.google.com/drive/folders/folder-1",
      spreadsheet: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
      sheetName: "Mẫu 2026",
      textConfig: { kind: "google_sheet" },
    });

    const body = sentBody();
    expect(body.driveFolder).toBe("https://drive.google.com/drive/folders/folder-1");
    expect(body.spreadsheet).toBe("https://docs.google.com/spreadsheets/d/sheet-1/edit");
    expect(body.sheetName).toBe("Mẫu 2026");
    expect(body.textConfig).toEqual({ kind: "google_sheet" });
  });

  it("still refuses a blank box before spending a round trip", async () => {
    await expect(
      updateCatalogSource({
        driveFolder: "https://drive.google.com/drive/folders/folder-1",
        spreadsheet: "  ",
        sheetName: "Mẫu 2026",
        textConfig: { kind: "google_sheet" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * Clearing a coordinate stays possible and stays EXPLICIT — it is the one
   * thing `""` means, and a file tenant is the only one allowed to end up there.
   */
  it("passes an explicit empty string through for a file tenant", async () => {
    await updateCatalogSource({
      driveFolder: "",
      spreadsheet: "",
      sheetName: "",
      textSourceKind: "file",
    });

    const body = sentBody();
    expect(body.driveFolder).toBe("");
    expect(body.spreadsheet).toBe("");
    expect(body.sheetName).toBe("");
  });
});
