import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/domain/errors";
import type { CatalogConfigRepo, CatalogSourceConfig } from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";

import { makeGetCatalogSource } from "./get-catalog-source";

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

function makeDeps(source: CatalogSourceConfig | null, error?: unknown) {
  const catalogConfig: CatalogConfigRepo = {
    findCatalogConfig: async () => source,
    findCatalogSource: async () => {
      if (error) throw error;
      return source;
    },
    saveCatalogSource: async () => ({ previous: null }),
  };
  return { catalogConfig, logger: makeLogger() };
}

describe("getCatalogSource — edge cases first", () => {
  it.each([undefined, null, "", "   ", "not-a-uuid", 42])(
    "rejects a malformed tenant id (%p) with INVALID_INPUT",
    async (tenantId) => {
      const getCatalogSource = makeGetCatalogSource(makeDeps(null));
      await expect(
        getCatalogSource({ tenantId: tenantId as unknown as string }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    },
  );

  it("returns null when the tenant has no usable integration row", async () => {
    const getCatalogSource = makeGetCatalogSource(makeDeps(null));
    await expect(getCatalogSource({ tenantId: TENANT })).resolves.toBeNull();
  });

  it("propagates a repository failure instead of reporting 'not configured'", async () => {
    const deps = makeDeps(null, new AppError("DB_ERROR", { message: "connection lost" }));
    const getCatalogSource = makeGetCatalogSource(deps);
    await expect(getCatalogSource({ tenantId: TENANT })).rejects.toMatchObject({
      code: "DB_ERROR",
    });
  });
});

describe("getCatalogSource — happy path", () => {
  it("returns the ids plus the two links an operator can open", async () => {
    const deps = makeDeps({
      driveFolderId: "1bA48sjugz9BczcoR0-zOc-VNlIYikp4v",
      spreadsheetId: "1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs",
      sheetName: "Mẫu 2026",
    });
    const getCatalogSource = makeGetCatalogSource(deps);

    await expect(getCatalogSource({ tenantId: TENANT })).resolves.toEqual({
      driveFolderId: "1bA48sjugz9BczcoR0-zOc-VNlIYikp4v",
      spreadsheetId: "1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs",
      sheetName: "Mẫu 2026",
      driveFolderUrl:
        "https://drive.google.com/drive/folders/1bA48sjugz9BczcoR0-zOc-VNlIYikp4v",
      spreadsheetUrl:
        "https://docs.google.com/spreadsheets/d/1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs",
    });
  });

  it("escapes an id that was hand-edited into something URL-unsafe", async () => {
    const deps = makeDeps({
      driveFolderId: "abc/../../evil?x=1",
      spreadsheetId: "id with space",
      sheetName: "Mẫu 2026",
    });
    const view = await makeGetCatalogSource(deps)({ tenantId: TENANT });
    expect(view?.driveFolderUrl).toBe(
      "https://drive.google.com/drive/folders/abc%2F..%2F..%2Fevil%3Fx%3D1",
    );
    expect(view?.spreadsheetUrl).toBe("https://docs.google.com/spreadsheets/d/id%20with%20space");
  });

  it("trims the tenant id before use", async () => {
    const deps = makeDeps({
      driveFolderId: "folder",
      spreadsheetId: "sheet",
      sheetName: "Tab",
    });
    await expect(makeGetCatalogSource(deps)({ tenantId: `  ${TENANT}  ` })).resolves.toMatchObject({
      driveFolderId: "folder",
    });
  });
});
