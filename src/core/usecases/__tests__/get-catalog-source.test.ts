import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STOCK_POLICY,
  makeFieldMap,
  MYSP_FIELD_MAP,
} from "@/core/domain/catalog-field-map";

import { AppError } from "@/core/domain/errors";
import { DEFAULT_MEDIA_PROFILE, type MediaProfile } from "@/core/domain/media-profile";
import type { CatalogConfigRepo, CatalogSourceConfig } from "@/core/ports/drive-source";
import type { Logger } from "@/core/ports/infra";

import { makeGetCatalogSource } from "../get-catalog-source";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { TenantId } from "@/core/domain/tenant-context";

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

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
    findStockPolicy: async () => DEFAULT_STOCK_POLICY,
    findFieldMap: async () => MYSP_FIELD_MAP,
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
        getCatalogSource({ tenantId: tenantId as unknown as TenantId }),
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
      // Null = tenant chưa khai ánh xạ, đang chạy preset (onboarding phase 1).
      fieldMap: null,
      stockPolicy: null,
      // Same for the photo layout (phase 2) — chưa khai, đang chạy mặc định.
      mediaProfile: null,
      // And for the source of the product text (phase 3) — chưa khai = tab.
      textSource: null,
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
    await expect(makeGetCatalogSource(deps)({ tenantId: testTenantId(`  ${TENANT}  `) })).resolves.toMatchObject({
      driveFolderId: "folder",
    });
  });
});


/**
 * Onboarding phase 1 — the panel must be able to answer "đã khai ánh xạ chưa?".
 *
 * Without it the wizard has no way to tell a tenant running the preset from one
 * whose mapping somebody spent an onboarding session fixing, so re-opening the
 * wizard and pressing Save would overwrite that work with `suggestFieldMap`.
 */
describe("getCatalogSource — declared mapping vs preset", () => {
  const SOURCE = {
    driveFolderId: "folder-1",
    spreadsheetId: "sheet-1",
    sheetName: "Danh mục",
  };

  it("answers null for all three when the tenant never declared anything", async () => {
    const view = await makeGetCatalogSource(makeDeps({ ...SOURCE }))({ tenantId: TENANT });
    expect(view).toMatchObject({ fieldMap: null, stockPolicy: null, mediaProfile: null });
  });

  it("returns the DECLARED mapping and policy as they are stored", async () => {
    const fieldMap = makeFieldMap({ code: "SKU", name: "Product name", stock: "Qty" });
    const view = await makeGetCatalogSource(
      makeDeps({
        ...SOURCE,
        fieldMap,
        stockPolicy: { mode: "disabled", reason: "Khách quản lý tồn ở phần mềm khác" },
      }),
    )({ tenantId: TENANT });

    expect(view?.fieldMap).toMatchObject({ code: "SKU", name: "Product name", stock: "Qty" });
    expect(view?.stockPolicy).toMatchObject({ mode: "disabled" });
  });

  /**
   * Onboarding phase 2, same failure mode as the field map: the panel dropped
   * `mediaProfile`, so a tenant who had declared how their photos are named was
   * shown "chưa khai" after a reload and invited to pick again from the
   * suggestion — the silent overwrite this whole contract exists to prevent.
   */
  it("returns the DECLARED media profile as it is stored", async () => {
    const mediaProfile: MediaProfile = { kind: "folder-per-code" };
    const view = await makeGetCatalogSource(makeDeps({ ...SOURCE, mediaProfile }))({
      tenantId: TENANT,
    });

    expect(view?.mediaProfile).toEqual({ kind: "folder-per-code" });
  });

  it("does NOT collapse a declared media profile that equals the default into null", async () => {
    const view = await makeGetCatalogSource(
      makeDeps({ ...SOURCE, mediaProfile: DEFAULT_MEDIA_PROFILE }),
    )({ tenantId: TENANT });

    expect(view?.mediaProfile).not.toBeNull();
    expect(view?.mediaProfile?.kind).toBe(DEFAULT_MEDIA_PROFILE.kind);
  });

  it("does NOT collapse a declared map that equals the preset into null", async () => {
    // "Đã khai và trùng preset" is a different state from "chưa khai": only the
    // second one may be overwritten by the suggestion.
    const view = await makeGetCatalogSource(
      makeDeps({ ...SOURCE, fieldMap: MYSP_FIELD_MAP, stockPolicy: DEFAULT_STOCK_POLICY }),
    )({ tenantId: TENANT });

    expect(view?.fieldMap).not.toBeNull();
    expect(view?.fieldMap?.code).toBe(MYSP_FIELD_MAP.code);
    expect(view?.stockPolicy).toMatchObject({ mode: "numeric" });
  });

  it("says 'chưa cấu hình' when the stored config is broken (repo returns null)", async () => {
    // The repo turns an unparseable blob into null + a logged reason; the panel
    // must not paper over it with a preset-shaped answer.
    await expect(makeGetCatalogSource(makeDeps(null))({ tenantId: TENANT })).resolves.toBeNull();
  });
});
