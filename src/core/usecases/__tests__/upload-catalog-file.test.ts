import { describe, expect, it } from "vitest";

import { DEFAULT_STOCK_POLICY, MYSP_FIELD_MAP } from "@/core/domain/catalog-field-map";
import { AppError } from "@/core/domain/errors";
import { testTenantId } from "@/core/domain/tenant-context.testing";
import type { CatalogFileStore } from "@/core/ports/catalog-file-store";
import type { CatalogSourceRef, CatalogTextSource } from "@/core/ports/catalog-text-source";
import type {
  CatalogConfigRepo,
  CatalogSourceConfig,
  SaveCatalogSourceInput,
} from "@/core/ports/drive-source";
import type { Clock, Logger } from "@/core/ports/infra";

import { makeCsvCatalogTextSource } from "@/adapters/catalog/csv-text-source";

import { makeUploadCatalogFile } from "../upload-catalog-file";

/**
 * The upload uses the REAL CSV adapter on purpose: "the file the operator sees
 * accepted is the file a later sync can read" is the whole promise, and a fake
 * reader here would prove the opposite of what the test claims.
 */

const TENANT = testTenantId("00000000-0000-0000-0000-0000000000e1");
const encoder = new TextEncoder();

const GOOD_CSV = encoder.encode(
  "Mã sản phẩm;Tên sản phẩm;Tồn\r\nMGKVX6310;Giannal;104\r\nMGKSQ6031;Sonata;0\r\n",
);

function makeLogger(lines: { level: string; message: string; context?: unknown }[] = []): Logger {
  const make = (): Logger => ({
    child: () => make(),
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  });
  return make();
}

interface HarnessOptions {
  current?: CatalogSourceConfig | null;
  previous?: CatalogSourceConfig | null;
  saveError?: unknown;
  deleteError?: unknown;
  putError?: unknown;
}

function harness(options: HarnessOptions = {}) {
  const saved: SaveCatalogSourceInput[] = [];
  const put: { fileName: string; bytes: Uint8Array }[] = [];
  const deleted: string[] = [];
  const lines: { level: string; message: string; context?: unknown }[] = [];
  let putCount = 0;

  const catalogFiles: CatalogFileStore = {
    put: async ({ fileName, bytes }) => {
      if (options.putError) throw options.putError;
      put.push({ fileName, bytes });
      putCount += 1;
      return { storageKey: `${TENANT}/catalog_new${putCount}`, sizeBytes: bytes.length };
    },
    get: async () => null,
    delete: async ({ storageKey }) => {
      if (options.deleteError) throw options.deleteError;
      deleted.push(storageKey);
      return true;
    },
  };

  const catalogConfig: CatalogConfigRepo = {
    findCatalogConfig: async () => options.current ?? null,
    findCatalogSource: async () => options.current ?? null,
    findStockPolicy: async () => DEFAULT_STOCK_POLICY,
    findFieldMap: async () => MYSP_FIELD_MAP,
    saveCatalogSource: async (input) => {
      if (options.saveError) throw options.saveError;
      saved.push(input);
      return { previous: options.previous ?? options.current ?? null };
    },
  };

  const clock: Clock = { now: () => new Date("2026-08-24T10:00:00.000Z"), nowMs: () => 0 };

  return {
    saved,
    put,
    deleted,
    lines,
    upload: makeUploadCatalogFile({
      catalogSource: makeCsvCatalogTextSource({ logger: makeLogger() }),
      catalogFiles,
      catalogConfig,
      clock,
      logger: makeLogger(lines),
    }),
  };
}

const call = (overrides: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  fileName: "bang-gia.csv",
  contentType: "text/csv",
  bytes: GOOD_CSV,
  ...overrides,
});

/** Edge cases first (CLAUDE.md technical rule 1). */

describe("uploadCatalogFile — refusals never reach the disk", () => {
  it("rejects a malformed tenant id", async () => {
    const h = harness();
    await expect(
      h.upload(call({ tenantId: testTenantId("nope") }) as never),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(h.put).toEqual([]);
  });

  it.each([
    ["empty name", ""],
    ["blank name", "   "],
    ["over-long name", "x".repeat(256)],
  ])("rejects %s", async (_label, fileName) => {
    const h = harness();
    await expect(h.upload(call({ fileName }) as never)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { reason: "CATALOG_FILE_NAME_INVALID" },
    });
    expect(h.put).toEqual([]);
  });

  it("rejects empty bytes", async () => {
    const h = harness();
    await expect(h.upload(call({ bytes: new Uint8Array() }) as never)).rejects.toMatchObject({
      context: { reason: "CATALOG_FILE_EMPTY" },
    });
    expect(h.put).toEqual([]);
  });

  it("rejects a file over the byte cap before reading or storing it", async () => {
    const h = harness();
    const huge = new Uint8Array(6 * 1024 * 1024);
    huge.fill(65);
    await expect(h.upload(call({ bytes: huge }) as never)).rejects.toMatchObject({
      context: { reason: "CATALOG_FILE_TOO_LARGE" },
    });
    expect(h.put).toEqual([]);
  });

  it("rejects an Excel workbook with the export instructions, storing nothing", async () => {
    const h = harness();
    const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

    const error = await h
      .upload(call({ bytes: xlsx, fileName: "gia.xlsx" }) as never)
      .catch((e: unknown) => e as AppError);

    expect((error as AppError).context.reason).toBe("CATALOG_FILE_IS_WORKBOOK");
    expect((error as AppError).userMessage).toContain("CSV UTF-8");
    expect(h.put).toEqual([]);
    expect(h.saved).toEqual([]);
  });

  it("rejects a non-UTF-8 export instead of storing mojibake", async () => {
    const h = harness();
    const cp1258 = new Uint8Array([0x4d, 0xe3, 0x2c, 0x54, 0xea, 0x6e, 0x0a, 0x41, 0x2c, 0x42]);

    await expect(h.upload(call({ bytes: cp1258 }) as never)).rejects.toMatchObject({
      context: { reason: "CATALOG_FILE_ENCODING" },
    });
    expect(h.put).toEqual([]);
  });

  it("treats a blank first line as noise and judges the real header row", async () => {
    const h = harness();
    // Blank rows ABOVE the header are the writer's noise, so `A;B;C` becomes
    // the header — which leaves no data rows, and that is the refusal.
    const blankFirstLine = encoder.encode(";;;\r\nA;B;C\r\n");

    await expect(h.upload(call({ bytes: blankFirstLine }) as never)).rejects.toMatchObject({
      context: { reason: "CATALOG_FILE_NO_PRODUCT_ROWS" },
    });
    expect(h.put).toEqual([]);
  });

  it("rejects a header-only file — there is nothing to sync", async () => {
    const h = harness();
    const headerOnly = encoder.encode("Mã sản phẩm;Tên sản phẩm\r\n");

    await expect(h.upload(call({ bytes: headerOnly }) as never)).rejects.toMatchObject({
      context: { reason: "CATALOG_FILE_NO_PRODUCT_ROWS" },
    });
    expect(h.put).toEqual([]);
  });
});

describe("uploadCatalogFile — order of operations", () => {
  it("reads, stores, then points the config at the stored bytes", async () => {
    const h = harness();

    const result = await h.upload(call() as never);

    expect(h.put).toHaveLength(1);
    expect(h.put[0]?.bytes).toEqual(GOOD_CSV);
    expect(h.saved[0]?.source.textSource).toEqual({
      kind: "file",
      storageKey: `${TENANT}/catalog_new1`,
      fileName: "bang-gia.csv",
      contentType: "text/csv",
      sizeBytes: GOOD_CSV.length,
      uploadedAt: "2026-08-24T10:00:00.000Z",
    });
    expect(result.source.textSource).toMatchObject({ fileName: "bang-gia.csv" });
  });

  it("keeps the tenant's Drive folder and mapping untouched", async () => {
    const h = harness({
      current: {
        driveFolderId: "folder-1",
        spreadsheetId: "sheet-1",
        sheetName: "Mẫu 2026",
        stockPolicy: { mode: "disabled", reason: "Khách quản lý tồn ở phần mềm khác" },
      },
    });

    const result = await h.upload(call() as never);

    // The upload owns exactly one key. Everything else is left out of the
    // patch, so the repo keeps the stored value under its lock and a
    // concurrent "đổi thư mục Drive" cannot be reverted by this upload (F3).
    expect(h.saved[0]?.source).toEqual({ textSource: expect.objectContaining({ kind: "file" }) });
    expect(h.saved[0]?.source).not.toHaveProperty("driveFolderId");
    // ...and the response still reports the effective state.
    expect(result.source.driveFolderId).toBe("folder-1");
    expect(result.source.stockPolicy).toMatchObject({ mode: "disabled" });
  });

  it("deletes the file it replaced, AFTER the config was saved", async () => {
    const previous: CatalogSourceConfig = {
      driveFolderId: "",
      spreadsheetId: "",
      sheetName: "",
      textSource: { kind: "file", storageKey: `${TENANT}/catalog_old`, fileName: "cu.csv" },
    };
    const h = harness({ current: previous, previous });

    const result = await h.upload(call() as never);

    expect(h.deleted).toEqual([`${TENANT}/catalog_old`]);
    expect(result.replaced).toEqual({ storageKey: `${TENANT}/catalog_old`, deleted: true });
  });

  it("does NOT delete anything when the config save failed", async () => {
    const previous: CatalogSourceConfig = {
      driveFolderId: "",
      spreadsheetId: "",
      sheetName: "",
      textSource: { kind: "file", storageKey: `${TENANT}/catalog_old`, fileName: "cu.csv" },
    };
    const h = harness({
      current: previous,
      previous,
      saveError: new AppError("DB_ERROR", { message: "down" }),
    });

    await expect(h.upload(call() as never)).rejects.toMatchObject({ code: "DB_ERROR" });

    // The old file is still the live one: deleting it would leave the tenant
    // pointing at bytes that are gone.
    expect(h.deleted).toEqual([]);
    const orphan = h.lines.find((line) => line.message.includes("could not be updated"));
    expect(orphan?.context).toMatchObject({ storage_key: `${TENANT}/catalog_new1` });
  });

  it("succeeds even when the replaced file cannot be deleted, and says so", async () => {
    const previous: CatalogSourceConfig = {
      driveFolderId: "",
      spreadsheetId: "",
      sheetName: "",
      textSource: { kind: "file", storageKey: `${TENANT}/catalog_old`, fileName: "cu.csv" },
    };
    const h = harness({ current: previous, previous, deleteError: new Error("disk busy") });

    const result = await h.upload(call() as never);

    expect(result.replaced).toEqual({ storageKey: `${TENANT}/catalog_old`, deleted: false });
    const warn = h.lines.find((line) => line.level === "warn");
    expect(warn?.context).toMatchObject({ reason: "CATALOG_FILE_REPLACE_DELETE_FAILED" });
  });

  it("never deletes a previous source that was a Google tab", async () => {
    const previous: CatalogSourceConfig = {
      driveFolderId: "f",
      spreadsheetId: "s",
      sheetName: "Mẫu 2026",
    };
    const h = harness({ current: previous, previous });

    const result = await h.upload(call() as never);

    expect(h.deleted).toEqual([]);
    expect(result.replaced).toBeNull();
  });

  it("propagates a storage failure without touching the config", async () => {
    const h = harness({ putError: new Error("disk full") });

    await expect(h.upload(call() as never)).rejects.toThrow();
    expect(h.saved).toEqual([]);
  });
});

describe("uploadCatalogFile — what the operator sees", () => {
  it("reports how the file was read, with a sample and a suggested mapping", async () => {
    const h = harness();

    const { preview } = await h.upload(call() as never);

    expect(preview.columns).toEqual(["Mã sản phẩm", "Tên sản phẩm", "Tồn"]);
    expect(preview.rowCount).toBe(2);
    expect(preview).toMatchObject({ delimiter: ";", delimiterDetected: true, encoding: "utf-8" });
    expect(preview.sampleRows[0]).toMatchObject({ "Mã sản phẩm": "MGKVX6310", Tồn: "104" });
    expect(preview.notices.map((notice) => notice.code)).toContain("DELIMITER_DETECTED");
    // Step 2 of the wizard can be pre-filled from this.
    expect(preview.fieldMapSuggestion.fieldMap).toMatchObject({
      code: "Mã sản phẩm",
      name: "Tên sản phẩm",
      stock: "Tồn",
    });
  });

  it("honours an operator-chosen delimiter and stores it for later reads", async () => {
    const h = harness();

    const result = await h.upload(call({ delimiter: ";" }) as never);

    expect(result.preview.delimiterDetected).toBe(false);
    expect(h.saved[0]?.source.textSource).toMatchObject({ delimiter: ";" });
  });

  it("logs the upload with the file, the key and the staleness note", async () => {
    const h = harness();
    await h.upload(call() as never);

    const line = h.lines.find((entry) => entry.message === "Catalog file uploaded");
    expect(line?.context).toMatchObject({
      file_name: "bang-gia.csv",
      storage_key: `${TENANT}/catalog_new1`,
      delimiter: ";",
      rows: 2,
      note: "catalog is stale until the next sync",
    });
  });

  it("accepts a file the CSV reader can read even when it has odd rows", async () => {
    const h = harness();
    const ragged = encoder.encode("Mã sản phẩm,Tên sản phẩm,Tồn\nA,Váy\nB,Áo,3\n");

    const { preview } = await h.upload(call({ bytes: ragged }) as never);

    expect(preview.rowCount).toBe(2);
    expect(preview.notices.map((notice) => notice.code)).toContain("RAGGED_ROW");
  });

  it("refuses a source that cannot read files at all", async () => {
    const blind: CatalogTextSource = {
      id: "blind",
      canRead: (_ref: CatalogSourceRef) => false,
      readCatalog: async () => {
        throw new Error("must not be called");
      },
    };
    const upload = makeUploadCatalogFile({
      catalogSource: blind,
      catalogFiles: {
        put: async () => ({ storageKey: "k", sizeBytes: 0 }),
        get: async () => null,
        delete: async () => false,
      },
      catalogConfig: {
        findCatalogConfig: async () => null,
        findCatalogSource: async () => null,
        findStockPolicy: async () => DEFAULT_STOCK_POLICY,
        findFieldMap: async () => MYSP_FIELD_MAP,
        saveCatalogSource: async () => ({ previous: null }),
      },
      clock: { now: () => new Date(), nowMs: () => 0 },
      logger: makeLogger(),
    });

    await expect(upload(call() as never)).rejects.toMatchObject({
      context: { reason: "TEXT_SOURCE_NOT_SUPPORTED" },
    });
  });
});
