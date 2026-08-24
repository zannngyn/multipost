import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STOCK_POLICY,
  makeFieldMap,
  MYSP_FIELD_MAP,
} from "@/core/domain/catalog-field-map";

import type { CatalogTextConfig } from "@/core/domain/catalog-text-config";
import { AppError } from "@/core/domain/errors";
import type {
  CatalogConfigRepo,
  CatalogSourceConfig,
  SaveCatalogSourceInput,
} from "@/core/ports/drive-source";
import type {
  GoogleDriveBrowser,
  GoogleOAuthRepo,
  GoogleSourceAccessState,
  SaveGoogleSourceAccessInput,
} from "@/core/ports/google-oauth";
import type { Logger } from "@/core/ports/infra";
import type { UserRepo } from "@/core/ports/user-repo";

import { makeUpdateCatalogSource } from "./update-catalog-source";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { TenantId } from "@/core/domain/tenant-context";

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");
const FOLDER_ID = "1bA48sjugz9BczcoR0-zOc-VNlIYikp4v";
const SHEET_ID = "1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs";

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

interface Harness {
  readonly saved: SaveCatalogSourceInput[];
  readonly catalogConfig: CatalogConfigRepo;
  readonly logger: Logger;
  readonly users: UserRepo;
}

function makeHarness(
  options: { previous?: CatalogSourceConfig | null; saveError?: unknown; userId?: string | null } = {},
): Harness {
  const saved: SaveCatalogSourceInput[] = [];
  const catalogConfig: CatalogConfigRepo = {
    findCatalogConfig: async () => options.previous ?? null,
    findStockPolicy: async () => DEFAULT_STOCK_POLICY,
    findFieldMap: async () => MYSP_FIELD_MAP,
    findCatalogSource: async () => options.previous ?? null,
    saveCatalogSource: async (input) => {
      if (options.saveError) throw options.saveError;
      saved.push(input);
      return { previous: options.previous ?? null };
    },
  };
  const users: UserRepo = {
    findUserIdByEmail: async () => options.userId ?? null,
    // This usecase names its actor by e-mail; the account arm exists only to
    // satisfy the port (added for draft ownership, doc 10 §4.2).
    findUserIdByAccount: async () => null,
  };
  return { saved, catalogConfig, logger: makeLogger(), users };
}

describe("updateCatalogSource — edge cases first", () => {
  it.each([undefined, null, "", "  ", "nope"])(
    "rejects a malformed tenant id (%p) before touching the repository",
    async (tenantId) => {
      const harness = makeHarness();
      const update = makeUpdateCatalogSource(harness);
      await expect(
        update({
          tenantId: tenantId as unknown as TenantId,
          driveFolder: FOLDER_ID,
          spreadsheet: SHEET_ID,
          sheetName: "Mẫu 2026",
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(harness.saved).toHaveLength(0);
    },
  );

  it.each([
    ["https://dropbox.com/folders/abcdefghijkl", "WRONG_HOST"],
    ["https://drive.google.com/drive/my-drive", "WRONG_PATH"],
    ["rac", "MALFORMED_ID"],
  ])("rejects driveFolder %p (%s) and names the field", async (driveFolder, reason) => {
    const harness = makeHarness();
    const update = makeUpdateCatalogSource(harness);
    await expect(
      update({
        tenantId: TENANT,
        driveFolder,
        spreadsheet: SHEET_ID,
        sheetName: "Mẫu 2026",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { field: "driveFolder", reason },
    });
    expect(harness.saved).toHaveLength(0);
  });

  it("rejects a spreadsheet reference and names THAT field", async () => {
    const harness = makeHarness();
    const update = makeUpdateCatalogSource(harness);
    await expect(
      update({
        tenantId: TENANT,
        driveFolder: FOLDER_ID,
        spreadsheet: "https://docs.google.com/document/d/abcdefghijkl",
        sheetName: "Mẫu 2026",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "spreadsheet" } });
  });

  /**
   * "Toạ độ bắt buộc" moved DOWN a layer with F3. It is no longer a property of
   * this call — a mapping-only save legitimately sends none of the three — but
   * of the state AFTER the merge, which only the repo can see under its lock
   * (integration test: "STILL refuses blank coordinates for a tenant on a
   * Google tab"). What stays here is the difference between the three requests.
   */
  it.each([undefined, null])(
    "leaves a coordinate OUT of the patch when it was not sent (%p)",
    async (sheetName) => {
      const harness = makeHarness();
      const update = makeUpdateCatalogSource(harness);

      await update({
        tenantId: TENANT,
        driveFolder: FOLDER_ID,
        spreadsheet: SHEET_ID,
        sheetName: sheetName as unknown as string,
      });

      // Absent, not "": the repo keeps whatever the row holds.
      expect(harness.saved[0]?.source).not.toHaveProperty("sheetName");
      expect(harness.saved[0]?.source.driveFolderId).toBe(FOLDER_ID);
    },
  );

  it.each(["", "   "])("passes an emptied box through as an explicit clear (%p)", async (sheetName) => {
    const harness = makeHarness();
    const update = makeUpdateCatalogSource(harness);

    await update({
      tenantId: TENANT,
      driveFolder: FOLDER_ID,
      spreadsheet: SHEET_ID,
      sheetName,
    });

    // "" reaches the repo, which refuses it for a Google tenant and accepts it
    // for one reading a file. Deciding that here would need a read taken
    // outside the write transaction — the lost update F3 closed.
    expect(harness.saved[0]?.source.sheetName).toBe("");
  });

  /**
   * `""` is a COMMAND here ("xoá toạ độ"), so a wrong-typed field must never
   * collapse into it. The route's zod refuses non-strings too, but that is one
   * caller's schema — the usecase is its own boundary (technical rule 2, and
   * the same reasoning as the `kind: "file"` refusal).
   */
  it.each([
    ["driveFolder", 5],
    ["driveFolder", true],
    ["spreadsheet", {}],
    ["sheetName", 5],
    ["sheetName", ["Mẫu 2026"]],
  ])("refuses a non-string %s (%p) instead of reading it as a clear", async (field, value) => {
    const harness = makeHarness();

    await expect(
      makeUpdateCatalogSource(harness)({
        tenantId: TENANT,
        driveFolder: FOLDER_ID,
        spreadsheet: SHEET_ID,
        sheetName: "Mẫu 2026",
        [field]: value,
      } as unknown as Parameters<ReturnType<typeof makeUpdateCatalogSource>>[0]),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { field, reason: "PATCH_VALUE_NOT_A_STRING" },
    });
    expect(harness.saved).toEqual([]);
  });

  it("still rejects a sheet name that is too long", async () => {
    const harness = makeHarness();
    await expect(
      makeUpdateCatalogSource(harness)({
        tenantId: TENANT,
        driveFolder: FOLDER_ID,
        spreadsheet: SHEET_ID,
        sheetName: "x".repeat(101),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "sheetName" } });
    expect(harness.saved).toHaveLength(0);
  });

  it("rejects a sheetName longer than 100 characters", async () => {
    const harness = makeHarness();
    const update = makeUpdateCatalogSource(harness);
    await expect(
      update({
        tenantId: TENANT,
        driveFolder: FOLDER_ID,
        spreadsheet: SHEET_ID,
        sheetName: "a".repeat(101),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "sheetName" } });
  });

  it("lets a repository failure through instead of reporting success", async () => {
    const harness = makeHarness({
      saveError: new AppError("DB_ERROR", { message: "connection lost" }),
    });
    const update = makeUpdateCatalogSource(harness);
    await expect(
      update({
        tenantId: TENANT,
        driveFolder: FOLDER_ID,
        spreadsheet: SHEET_ID,
        sheetName: "Mẫu 2026",
      }),
    ).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  it("still saves when the actor cannot be resolved — attribution is not a gate", async () => {
    const harness = makeHarness({ userId: null });
    const update = makeUpdateCatalogSource(harness);
    await update({
      tenantId: TENANT,
      driveFolder: FOLDER_ID,
      spreadsheet: SHEET_ID,
      sheetName: "Mẫu 2026",
      actorEmail: "ai-do@mysp.local",
    });
    expect(harness.saved[0]).toMatchObject({
      actorUserId: null,
      actorEmail: "ai-do@mysp.local",
    });
  });
});

describe("updateCatalogSource — happy path", () => {
  it("accepts pasted URLs and stores the extracted ids", async () => {
    const harness = makeHarness();
    const update = makeUpdateCatalogSource(harness);

    const view = await update({
      tenantId: TENANT,
      driveFolder: `https://drive.google.com/drive/folders/${FOLDER_ID}?usp=sharing`,
      spreadsheet: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`,
      sheetName: "  Mẫu 2026  ",
    });

    expect(harness.saved[0]?.source).toEqual({
      driveFolderId: FOLDER_ID,
      spreadsheetId: SHEET_ID,
      sheetName: "Mẫu 2026",
    });
    expect(view).toEqual({
      driveFolderId: FOLDER_ID,
      spreadsheetId: SHEET_ID,
      sheetName: "Mẫu 2026",
      driveFolderUrl: `https://drive.google.com/drive/folders/${FOLDER_ID}`,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}`,
      // Nothing was sent and nothing was stored -> chưa khai.
      fieldMap: null,
      stockPolicy: null,
      mediaProfile: null,
      textSource: null,
    });
  });

  it("accepts bare ids too", async () => {
    const harness = makeHarness();
    const view = await makeUpdateCatalogSource(harness)({
      tenantId: TENANT,
      driveFolder: FOLDER_ID,
      spreadsheet: SHEET_ID,
      sheetName: "Mẫu 2026",
    });
    expect(view.driveFolderId).toBe(FOLDER_ID);
    expect(view.spreadsheetId).toBe(SHEET_ID);
  });

  it("attributes the change to the resolved operator", async () => {
    const harness = makeHarness({ userId: "11111111-1111-1111-1111-111111111111" });
    await makeUpdateCatalogSource(harness)({
      tenantId: TENANT,
      driveFolder: FOLDER_ID,
      spreadsheet: SHEET_ID,
      sheetName: "Mẫu 2026",
      actorEmail: "  Operator@MYSP.local ",
    });
    expect(harness.saved[0]).toMatchObject({
      tenantId: TENANT,
      actorUserId: "11111111-1111-1111-1111-111111111111",
      actorEmail: "operator@mysp.local",
    });
  });

  it("logs the previous source and the warning that the catalog is now stale", async () => {
    const harness = makeHarness({
      previous: { driveFolderId: "oldFolderId12", spreadsheetId: "oldSheetId12", sheetName: "Cũ" },
    });
    await makeUpdateCatalogSource(harness)({
      tenantId: TENANT,
      driveFolder: FOLDER_ID,
      spreadsheet: SHEET_ID,
      sheetName: "Mẫu 2026",
    });

    expect(harness.logger.info).toHaveBeenCalledWith(
      "Catalog source updated",
      expect.objectContaining({
        changed: true,
        previous: expect.objectContaining({ drive_folder_id: "oldFolderId12" }),
        next: expect.objectContaining({ drive_folder_id: FOLDER_ID }),
        note: "catalog is stale until the next sync",
      }),
    );
  });

  it("reports changed=false when the operator re-saves the same source", async () => {
    const harness = makeHarness({
      previous: { driveFolderId: FOLDER_ID, spreadsheetId: SHEET_ID, sheetName: "Mẫu 2026" },
    });
    await makeUpdateCatalogSource(harness)({
      tenantId: TENANT,
      driveFolder: FOLDER_ID,
      spreadsheet: SHEET_ID,
      sheetName: "Mẫu 2026",
    });
    expect(harness.logger.info).toHaveBeenCalledWith(
      "Catalog source updated",
      expect.objectContaining({ changed: false, note: "no change" }),
    );
  });

  it("works without a user repository wired", async () => {
    const harness = makeHarness();
    const update = makeUpdateCatalogSource({
      catalogConfig: harness.catalogConfig,
      logger: harness.logger,
    });
    await expect(
      update({
        tenantId: TENANT,
        driveFolder: FOLDER_ID,
        spreadsheet: SHEET_ID,
        sheetName: "Mẫu 2026",
        actorEmail: "operator@mysp.local",
      }),
    ).resolves.toMatchObject({ driveFolderId: FOLDER_ID });
    expect(harness.saved[0]?.actorUserId).toBeNull();
  });
});


/**
 * Pointing the tenant at another folder/sheet makes the stored "can this
 * account read it?" verdict describe the wrong thing. It is recomputed here —
 * with a real probe even on the picker path, because a "đã duyệt rồi" flag
 * would arrive from the browser and outside data is not trusted.
 */
describe("updateCatalogSource — the source-access verdict", () => {
  const NOW = Date.UTC(2026, 7, 19, 4, 0, 0);
  const clock = { now: () => new Date(NOW), nowMs: () => NOW };

  function withProbe(options: {
    previous?: CatalogSourceConfig | null;
    state?: GoogleSourceAccessState;
    probeError?: unknown;
  }) {
    const harness = makeHarness({ previous: options.previous ?? null });
    const saved: SaveGoogleSourceAccessInput[] = [];
    const checkSourceAccess = vi.fn(async () => {
      if (options.probeError) throw options.probeError;
      return options.state ?? "ok";
    });
    const browser = {
      listFolders: vi.fn(),
      listSpreadsheets: vi.fn(),
      listSheetTabs: vi.fn(),
      checkSourceAccess,
    } as unknown as GoogleDriveBrowser;
    const oauth = {
      findConnection: vi.fn(),
      findRefreshToken: vi.fn(),
      saveConnection: vi.fn(),
      deleteConnection: vi.fn(),
      markConnectionExpired: vi.fn(),
      saveSourceAccess: vi.fn(async (input: SaveGoogleSourceAccessInput) => {
        saved.push(input);
      }),
    } as unknown as GoogleOAuthRepo;

    const update = makeUpdateCatalogSource({ ...harness, oauth, browser, clock });
    return { update, harness, saved, checkSourceAccess };
  }

  const input = {
    tenantId: TENANT,
    driveFolder: FOLDER_ID,
    spreadsheet: SHEET_ID,
    sheetName: "Mẫu 2026",
  };

  it("re-probes the source and stores the new verdict", async () => {
    const { update, saved, checkSourceAccess } = withProbe({ state: "drive_unreadable" });

    await update(input);

    expect(checkSourceAccess).toHaveBeenCalledTimes(1);
    expect(saved).toEqual([
      {
        tenantId: TENANT,
        state: "drive_unreadable",
        checkedAt: new Date(NOW).toISOString(),
      },
    ]);
  });

  it("saves the source even when the probe blows up — the save is not the probe's hostage", async () => {
    const { update, harness, saved } = withProbe({ probeError: new Error("drive is down") });

    await expect(update(input)).resolves.toMatchObject({ driveFolderId: FOLDER_ID });
    expect(harness.saved).toHaveLength(1);
    expect(saved[0]?.state).toBe("unknown");
  });

  it("skips the probe when nothing actually changed", async () => {
    const { update, checkSourceAccess } = withProbe({
      previous: { driveFolderId: FOLDER_ID, spreadsheetId: SHEET_ID, sheetName: "Mẫu 2026" },
    });

    await update(input);
    expect(checkSourceAccess).not.toHaveBeenCalled();
  });
});

/**
 * Onboarding phase 1: the same call now carries the column mapping and the
 * stock policy. Everything is validated BEFORE the write — an unusable map
 * stored is a sync that dies hours later, far from the person who typed it.
 */
describe("updateCatalogSource — fieldMap + stockPolicy", () => {
  const SHEET_COLUMNS_OF_TENANT = ["SKU", "Product name", "Qty", "Ghi chú", "Giá bán"];
  const GOOD_MAP = makeFieldMap({ code: "SKU", name: "Product name", stock: "Qty" });

  const call = (harness: Harness, extra: Record<string, unknown>) =>
    makeUpdateCatalogSource(harness)({
      tenantId: TENANT,
      driveFolder: FOLDER_ID,
      spreadsheet: SHEET_ID,
      sheetName: "Danh mục",
      ...extra,
    });

  it("writes nothing when the map has no code column", async () => {
    const harness = makeHarness();
    await expect(
      call(harness, { fieldMap: makeFieldMap({ name: "Product name" }) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "fieldMap" } });
    expect(harness.saved).toHaveLength(0);
  });

  it("writes nothing when two fields share a column", async () => {
    const harness = makeHarness();
    await expect(
      call(harness, { fieldMap: makeFieldMap({ code: "SKU", name: "SKU" }) }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(harness.saved).toHaveLength(0);
  });

  it("refuses a map pointing at a column the sheet does not have", async () => {
    const harness = makeHarness();
    await expect(
      call(harness, {
        fieldMap: makeFieldMap({ code: "SKU", name: "Tên khác" }),
        sheetColumns: SHEET_COLUMNS_OF_TENANT,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "fieldMap" } });
    expect(harness.saved).toHaveLength(0);
  });

  it("refuses to turn the stock check off without a written reason", async () => {
    const harness = makeHarness();
    await expect(
      call(harness, { stockPolicy: { mode: "disabled", reason: "x" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "stockPolicy" } });
    expect(harness.saved).toHaveLength(0);
  });

  it("refuses a textual policy with an empty vocabulary", async () => {
    const harness = makeHarness();
    await expect(
      call(harness, {
        stockPolicy: { mode: "textual", inStockValues: [], outOfStockValues: ["Hết"] },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(harness.saved).toHaveLength(0);
  });

  it("passes a valid map and policy through to the repository", async () => {
    const harness = makeHarness();
    await call(harness, {
      fieldMap: GOOD_MAP,
      sheetColumns: SHEET_COLUMNS_OF_TENANT,
      stockPolicy: { mode: "textual", inStockValues: ["Còn"], outOfStockValues: ["Hết"] },
    });

    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0].source.fieldMap).toMatchObject({ code: "SKU", stock: "Qty" });
    expect(harness.saved[0].source.stockPolicy).toMatchObject({ mode: "textual" });
  });

  it("sends NO mapping key when the caller only changes the folder", async () => {
    // The repo reads that as "keep what is stored" — an onboarding session must
    // not be wiped by someone fixing a link.
    const harness = makeHarness();
    await call(harness, {});
    expect(harness.saved[0].source).not.toHaveProperty("fieldMap");
    expect(harness.saved[0].source).not.toHaveProperty("stockPolicy");
  });

  it("says in the log WHICH part changed", async () => {
    const harness = makeHarness({
      previous: {
        driveFolderId: FOLDER_ID,
        spreadsheetId: SHEET_ID,
        sheetName: "Danh mục",
        fieldMap: makeFieldMap({ code: "Mã", name: "Tên" }),
      },
    });
    await call(harness, { fieldMap: GOOD_MAP, sheetColumns: SHEET_COLUMNS_OF_TENANT });

    expect(harness.logger.info).toHaveBeenCalledWith(
      "Catalog source updated",
      expect.objectContaining({ source_changed: false, field_map_changed: true }),
    );
  });

  it("logs a warning of its own when the stock check is switched off", async () => {
    const harness = makeHarness();
    await call(harness, {
      stockPolicy: { mode: "disabled", reason: "Khách quản lý tồn ở phần mềm khác" },
    });

    expect(harness.logger.warn).toHaveBeenCalledWith(
      "Stock check turned OFF for this tenant",
      expect.objectContaining({ error_code: "STOCK_CHECK_DISABLED" }),
    );
  });
});


/**
 * The PUT response must describe the state AFTER the write, because the UI
 * swaps it straight into the state a GET produced (docblock of
 * toCatalogSourceView). Reporting "chưa khai" right after saving a map — or
 * after preserving one — would send the wizard back to the suggestion.
 */
describe("updateCatalogSource — the view it returns", () => {
  const call = (harness: Harness, extra: Record<string, unknown> = {}) =>
    makeUpdateCatalogSource(harness)({
      tenantId: TENANT,
      driveFolder: FOLDER_ID,
      spreadsheet: SHEET_ID,
      sheetName: "Danh mục",
      ...extra,
    });

  it("echoes the map that was just saved", async () => {
    const fieldMap = makeFieldMap({ code: "SKU", name: "Product name" });
    const view = await call(makeHarness(), {
      fieldMap,
      stockPolicy: { mode: "textual", inStockValues: ["Còn"], outOfStockValues: ["Hết"] },
    });

    expect(view.fieldMap).toMatchObject({ code: "SKU", name: "Product name" });
    expect(view.stockPolicy).toMatchObject({ mode: "textual" });
  });

  it("keeps reporting the STORED map when the call only changed the folder", async () => {
    const harness = makeHarness({
      previous: {
        driveFolderId: "old-folder",
        spreadsheetId: SHEET_ID,
        sheetName: "Danh mục",
        fieldMap: makeFieldMap({ code: "SKU", name: "Product name" }),
        stockPolicy: { mode: "disabled", reason: "Khách quản lý tồn ở phần mềm khác" },
      },
    });

    const view = await call(harness);
    expect(view.fieldMap).toMatchObject({ code: "SKU" });
    expect(view.stockPolicy).toMatchObject({ mode: "disabled" });
  });

  it("reports null only when nothing was sent and nothing was stored", async () => {
    const view = await call(makeHarness());
    expect(view.fieldMap).toBeNull();
    expect(view.stockPolicy).toBeNull();
  });
});


// --- Onboarding phase 3: a tenant whose table is an uploaded file ------------

const FILE_SOURCE: CatalogTextConfig = {
  kind: "file",
  storageKey: `${TENANT}/catalog_abc`,
  fileName: "bang-gia.csv",
  uploadedAt: "2026-08-24T10:00:00.000Z",
};

describe("updateCatalogSource — file source", () => {
  /**
   * Pointing a tenant AT a file requires a file that exists, and only
   * `uploadCatalogFile` can produce one (it reads the bytes, then mints the
   * key). Accepting a `storageKey` here would let any caller aim a tenant at a
   * key of its own invention. The rule used to live in the route's zod schema —
   * a convention the next caller does not inherit.
   */
  it("refuses to point a tenant at a file — that is uploadCatalogFile's job", async () => {
    const harness = makeHarness();

    await expect(
      makeUpdateCatalogSource(harness)({
        tenantId: TENANT,
        textConfig: FILE_SOURCE,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { field: "textConfig", reason: "TEXT_SOURCE_FILE_NOT_SETTABLE_HERE" },
    });
    expect(harness.saved).toEqual([]);
  });

  it("says how to switch to a file source instead of just refusing", async () => {
    const harness = makeHarness();
    const error = await makeUpdateCatalogSource(harness)({
      tenantId: TENANT,
      textConfig: FILE_SOURCE,
    }).catch((e: unknown) => e as AppError);

    expect((error as AppError).userMessage).toContain("tải file .csv lên");
  });

  it("allows switching BACK from a file to a tab (no stored artefact needed)", async () => {
    const harness = makeHarness({
      previous: { driveFolderId: "", spreadsheetId: "", sheetName: "", textSource: FILE_SOURCE },
    });

    const view = await makeUpdateCatalogSource(harness)({
      tenantId: TENANT,
      driveFolder: FOLDER_ID,
      spreadsheet: SHEET_ID,
      sheetName: "Mẫu 2026",
      textConfig: { kind: "google_sheet" },
    });

    expect(harness.saved[0]?.source).toMatchObject({
      driveFolderId: FOLDER_ID,
      spreadsheetId: SHEET_ID,
      sheetName: "Mẫu 2026",
      textSource: { kind: "google_sheet" },
    });
    expect(view.textSource).toEqual({ kind: "google_sheet" });
  });

  it("does not force a stored file tenant to re-send its source to fix a mapping", async () => {
    // The operator only changes columns. Without the stored-source lookup this
    // would demand a spreadsheet id they do not have.
    const harness = makeHarness({
      previous: {
        driveFolderId: "",
        spreadsheetId: "",
        sheetName: "",
        textSource: FILE_SOURCE,
      },
    });

    const view = await makeUpdateCatalogSource(harness)({
      tenantId: TENANT,
      fieldMap: makeFieldMap({ code: "SKU", name: "Ten hang" }),
    });

    expect(harness.saved[0]?.source.fieldMap).toMatchObject({ code: "SKU" });
    // Untouched, so the repo keeps it — and the response still reports it.
    expect(harness.saved[0]?.source.textSource).toBeUndefined();
    expect(view.textSource).toEqual(FILE_SOURCE);
  });

  it("does not wipe the Drive photo folder of a file tenant fixing a mapping", async () => {
    const harness = makeHarness({
      previous: {
        driveFolderId: FOLDER_ID,
        spreadsheetId: "",
        sheetName: "",
        textSource: FILE_SOURCE,
      },
    });

    // The mapping wizard sends no coordinate at all.
    const view = await makeUpdateCatalogSource(harness)({
      tenantId: TENANT,
      fieldMap: makeFieldMap({ code: "SKU", name: "Ten hang" }),
    });

    // Stronger than "it re-sent the stored value": it does not send the key at
    // all, so there is nothing for a concurrent save to lose. The repo merges
    // it under the lock, and the response reports the merged state.
    expect(harness.saved[0]?.source).not.toHaveProperty("driveFolderId");
    expect(view.driveFolderId).toBe(FOLDER_ID);
  });

  it("still parses a Drive folder for a file tenant who keeps photos on Drive", async () => {
    const harness = makeHarness({
      previous: { driveFolderId: "", spreadsheetId: "", sheetName: "", textSource: FILE_SOURCE },
    });

    await makeUpdateCatalogSource(harness)({
      tenantId: TENANT,
      driveFolder: `https://drive.google.com/drive/folders/${FOLDER_ID}`,
    });

    expect(harness.saved[0]?.source.driveFolderId).toBe(FOLDER_ID);
    expect(harness.saved[0]?.source).not.toHaveProperty("spreadsheetId");
  });

  it("refuses a file source with no storage key, like any other file source", async () => {
    const harness = makeHarness();

    await expect(
      makeUpdateCatalogSource(harness)({
        tenantId: TENANT,
        textConfig: { kind: "file", storageKey: "  ", fileName: "x.csv" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "textConfig" } });
    expect(harness.saved).toEqual([]);
  });

  it("refuses an unknown source kind rather than guessing", async () => {
    const harness = makeHarness();

    await expect(
      makeUpdateCatalogSource(harness)({
        tenantId: TENANT,
        driveFolder: FOLDER_ID,
        spreadsheet: SHEET_ID,
        sheetName: "Mẫu 2026",
        textConfig: { kind: "dropbox" } as unknown as CatalogTextConfig,
      }),
    ).rejects.toMatchObject({ context: { field: "textConfig" } });
  });

  // The switch this usecase performs is the REVERSE one (file -> tab); pointing
  // a tenant at a file is `uploadCatalogFile`'s job, and is refused above.
  it("switching a file tenant back to a tab is logged as a source change", async () => {
    const harness = makeHarness({
      previous: { driveFolderId: "", spreadsheetId: "", sheetName: "", textSource: FILE_SOURCE },
    });
    const info = harness.logger.info as unknown as ReturnType<typeof vi.fn>;

    await makeUpdateCatalogSource(harness)({
      tenantId: TENANT,
      driveFolder: FOLDER_ID,
      spreadsheet: SHEET_ID,
      sheetName: "Mẫu 2026",
      textConfig: { kind: "google_sheet" },
    });

    const line = info.mock.calls.find((call) => call[0] === "Catalog source updated");
    expect(line?.[1]).toMatchObject({ text_source_changed: true, changed: true });
    expect(line?.[1]?.next).toMatchObject({ text_source_kind: "google_sheet" });
  });
});
