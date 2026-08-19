import { describe, expect, it, vi } from "vitest";

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

const TENANT = "00000000-0000-0000-0000-000000000001";
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
    findCatalogSource: async () => options.previous ?? null,
    saveCatalogSource: async (input) => {
      if (options.saveError) throw options.saveError;
      saved.push(input);
      return { previous: options.previous ?? null };
    },
  };
  const users: UserRepo = {
    findUserIdByEmail: async () => options.userId ?? null,
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
          tenantId: tenantId as unknown as string,
          driveFolder: FOLDER_ID,
          spreadsheet: SHEET_ID,
          sheetName: "Mẫu 2026",
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(harness.saved).toHaveLength(0);
    },
  );

  it.each([
    ["", "EMPTY"],
    ["  ", "EMPTY"],
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

  it.each([undefined, null, "", "   ", 5])("rejects an empty sheetName (%p)", async (sheetName) => {
    const harness = makeHarness();
    const update = makeUpdateCatalogSource(harness);
    await expect(
      update({
        tenantId: TENANT,
        driveFolder: FOLDER_ID,
        spreadsheet: SHEET_ID,
        sheetName: sheetName as unknown as string,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "sheetName" } });
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
