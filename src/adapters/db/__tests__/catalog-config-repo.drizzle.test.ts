import { describe, expect, it } from "vitest";

import { DEFAULT_STOCK_POLICY, makeFieldMap, MYSP_FIELD_MAP } from "@/core/domain/catalog-field-map";
import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";
import { testTenantId } from "@/core/domain/tenant-context.testing";

import { DrizzleCatalogConfigRepo } from "../catalog-config-repo.drizzle";
import type { Database } from "../client";

/**
 * The mapping half of `tenant_integration.config`, without a database: the
 * query builder is stubbed, the ZOD SCHEMA is real — validating the hand-edited
 * JSONB blob is exactly what this test is about (CLAUDE.md technical rule 2).
 */

const TENANT = testTenantId("00000000-0000-0000-0000-000000000001");

const SOURCE = {
  driveFolderId: "folder-1",
  spreadsheetId: "sheet-1",
  sheetName: "Mẫu 2026",
};

interface LogLine {
  level: string;
  message: string;
  context?: LogContext;
}

function recordingLogger(lines: LogLine[]): Logger {
  const make = (): Logger => ({
    child: (_bindings: LogBindings) => make(),
    debug: (message, context) => lines.push({ level: "debug", message, context }),
    info: (message, context) => lines.push({ level: "info", message, context }),
    warn: (message, context) => lines.push({ level: "warn", message, context }),
    error: (message, context) => lines.push({ level: "error", message, context }),
  });
  return make();
}

function stubDb(rows: Array<{ config: Record<string, unknown>; status?: string }>): Database {
  const withStatus = rows.map((row) => ({ status: row.status ?? "active", config: row.config }));
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => withStatus }) }) }),
    transaction: async () => {
      throw new Error("transaction must not be reached when the input is invalid");
    },
  } as unknown as Database;
}

function harness(config: Record<string, unknown>, status = "active") {
  const lines: LogLine[] = [];
  const repo = new DrizzleCatalogConfigRepo(stubDb([{ config, status }]), recordingLogger(lines));
  return { repo, lines };
}

describe("findCatalogConfig — the stored mapping", () => {
  it("returns the three coordinates untouched when no mapping is stored", async () => {
    const { repo } = harness({ ...SOURCE });
    const config = await repo.findCatalogConfig(TENANT);
    // Backward compatibility: no fieldMap key means "the MYSP preset", and the
    // preset is resolved in core — the repo does not invent one here.
    expect(config).toEqual(SOURCE);
    expect(config?.fieldMap).toBeUndefined();
    expect(config?.stockPolicy).toBeUndefined();
  });

  it("returns a stored tenant mapping and stock policy", async () => {
    const fieldMap = makeFieldMap({ code: "SKU", name: "Product name", stock: "Qty" });
    const { repo } = harness({
      ...SOURCE,
      fieldMap,
      stockPolicy: { mode: "textual", inStockValues: ["Còn"], outOfStockValues: ["Hết"] },
    });

    const config = await repo.findCatalogConfig(TENANT);
    expect(config?.fieldMap).toMatchObject({ code: "SKU", name: "Product name", stock: "Qty" });
    expect(config?.stockPolicy).toMatchObject({ mode: "textual" });
  });

  it("accepts the MYSP preset written out in full", async () => {
    const { repo } = harness({ ...SOURCE, fieldMap: MYSP_FIELD_MAP });
    expect((await repo.findCatalogConfig(TENANT))?.fieldMap?.code).toBe(MYSP_FIELD_MAP.code);
  });

  it.each([
    ["a non-string column", { fieldMap: { ...makeFieldMap({ code: "SKU" }), name: 42 } }],
    ["a missing key", { fieldMap: { code: "SKU" } }],
    ["an unknown stock mode", { stockPolicy: { mode: "auto" } }],
    ["disabled without a reason", { stockPolicy: { mode: "disabled" } }],
    ["disabled with an empty reason", { stockPolicy: { mode: "disabled", reason: "  " } }],
    ["textual without values", { stockPolicy: { mode: "textual", inStockValues: [] } }],
  ])("refuses to fall back to the default on %s", async (_label, broken) => {
    const { repo } = harness({ ...SOURCE, ...broken });
    await expect(repo.findCatalogConfig(TENANT)).rejects.toMatchObject({
      code: "SYNC_FAILED",
      context: expect.objectContaining({ reason: "MAPPING_INVALID" }),
    });
  });

  it("still names an incomplete source as such, not as a mapping problem", async () => {
    const { repo } = harness({ spreadsheetId: "sheet-1" });
    await expect(repo.findCatalogConfig(TENANT)).rejects.toMatchObject({
      context: expect.objectContaining({ reason: "CONFIG_INCOMPLETE" }),
    });
  });
});

describe("findCatalogSource — the read model behind the panel", () => {
  it("shows a source with its mapping", async () => {
    const { repo } = harness({ ...SOURCE, fieldMap: makeFieldMap({ code: "SKU", name: "Tên" }) });
    expect((await repo.findCatalogSource(TENANT))?.fieldMap?.code).toBe("SKU");
  });

  it("OMITS the keys when the tenant never declared them (null upstream)", async () => {
    // The panel turns this absence into `fieldMap: null` = "chưa khai", which is
    // what stops the wizard from overwriting a hand-fixed mapping.
    const { repo } = harness({ ...SOURCE });
    const source = await repo.findCatalogSource(TENANT);
    expect(source).not.toBeNull();
    expect(source).not.toHaveProperty("fieldMap");
    expect(source).not.toHaveProperty("stockPolicy");
  });

  it("reports a declared map that happens to equal the preset as DECLARED", async () => {
    const { repo } = harness({ ...SOURCE, fieldMap: MYSP_FIELD_MAP });
    expect((await repo.findCatalogSource(TENANT))?.fieldMap).toMatchObject({
      code: MYSP_FIELD_MAP.code,
    });
  });

  it("answers 'chưa cấu hình' and logs the reason when the mapping is broken", async () => {
    const { repo, lines } = harness({ ...SOURCE, fieldMap: { code: 5 } });
    expect(await repo.findCatalogSource(TENANT)).toBeNull();
    expect(lines.some((line) => line.context?.reason === "MAPPING_INVALID")).toBe(true);
  });
});

describe("saveCatalogSource — validates before it writes", () => {
  const repo = () => new DrizzleCatalogConfigRepo(stubDb([]), recordingLogger([]));

  it("rejects a map without a code column", async () => {
    await expect(
      repo().saveCatalogSource({
        tenantId: TENANT,
        source: { ...SOURCE, fieldMap: makeFieldMap({ name: "Tên" }) },
        actorUserId: null,
        actorEmail: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "fieldMap" } });
  });

  it("rejects a map that gives one column to two fields", async () => {
    await expect(
      repo().saveCatalogSource({
        tenantId: TENANT,
        source: { ...SOURCE, fieldMap: makeFieldMap({ code: "A", name: "A" }) },
        actorUserId: null,
        actorEmail: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects turning the stock check off without a written reason", async () => {
    await expect(
      repo().saveCatalogSource({
        tenantId: TENANT,
        source: { ...SOURCE, stockPolicy: { mode: "disabled", reason: "x" } },
        actorUserId: null,
        actorEmail: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "stockPolicy" } });
  });

  it("rejects a textual policy with an empty vocabulary", async () => {
    await expect(
      repo().saveCatalogSource({
        tenantId: TENANT,
        source: {
          ...SOURCE,
          stockPolicy: { mode: "textual", inStockValues: [], outOfStockValues: ["Hết"] },
        },
        actorUserId: null,
        actorEmail: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  /**
   * This used to assert that a blank spreadsheet id was rejected BEFORE the
   * transaction. That ordering was the bug: "are the Google coordinates
   * required?" depends on which source the tenant ends up reading, and a caller
   * that only changes a column mapping omits `textSource` on purpose ("keep
   * what is stored"). Judging that from the patch alone made every save of a
   * CSV tenant fail with "Thiếu thông tin nguồn dữ liệu Drive/Sheet".
   *
   * The RULE is unchanged and still enforced — a Google tenant cannot store
   * blank coordinates — but it now runs inside the transaction, against the
   * stored source, so it cannot be covered by a stub that refuses to open one.
   * Its coverage lives in catalog-config-repo.write.integration.test.ts
   * ("saveCatalogSource — source kind comes from stored state").
   *
   * What CAN still be decided without touching the database is the shape, and
   * that is what stays here: a non-string coordinate is refused before any
   * connection is used.
   */
  it("rejects a non-string coordinate before opening a transaction", async () => {
    await expect(
      repo().saveCatalogSource({
        tenantId: TENANT,
        source: { ...SOURCE, spreadsheetId: 42 as unknown as string },
        actorUserId: null,
        actorEmail: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "source" } });
  });

  it("does not decide the source kind from the patch any more", async () => {
    // A mapping-only save carries no `textSource`; reaching the transaction is
    // the proof that the decision was deferred to the stored state.
    await expect(
      repo().saveCatalogSource({
        tenantId: TENANT,
        source: { ...SOURCE, spreadsheetId: "  ", fieldMap: makeFieldMap({ code: "A", name: "B" }) },
        actorUserId: null,
        actorEmail: null,
      }),
    ).rejects.toThrow("transaction must not be reached");
  });
});

/**
 * The two HOT-PATH reads. Their contract is the opposite of
 * `findCatalogConfig`: a tenant without a google integration is normal (the
 * upload-only mode) and must get the defaults, while a STORED value that cannot
 * be parsed must still be an error — that asymmetry is the whole test.
 */
describe("findStockPolicy / findFieldMap — never throw for a tenant without config", () => {
  function repoOn(rows: Array<{ config: Record<string, unknown>; status?: string }>) {
    const lines: LogLine[] = [];
    return {
      repo: new DrizzleCatalogConfigRepo(stubDb(rows), recordingLogger(lines)),
      lines,
    };
  }

  it("answers the defaults when the tenant has no integration row", async () => {
    const { repo, lines } = repoOn([]);
    expect(await repo.findStockPolicy(TENANT)).toEqual(DEFAULT_STOCK_POLICY);
    expect(await repo.findFieldMap(TENANT)).toEqual(MYSP_FIELD_MAP);
    expect(lines.some((line) => line.context?.reason === "NO_INTEGRATION_ROW")).toBe(true);
  });

  it("answers the defaults when the integration is disabled", async () => {
    const { repo, lines } = repoOn([{ config: { ...SOURCE }, status: "disabled" }]);
    expect(await repo.findStockPolicy(TENANT)).toEqual(DEFAULT_STOCK_POLICY);
    expect(await repo.findFieldMap(TENANT)).toEqual(MYSP_FIELD_MAP);
    expect(lines.some((line) => line.context?.reason === "INTEGRATION_DISABLED")).toBe(true);
  });

  it("answers the defaults when the keys are simply absent", async () => {
    const { repo } = repoOn([{ config: { ...SOURCE } }]);
    expect(await repo.findStockPolicy(TENANT)).toEqual(DEFAULT_STOCK_POLICY);
    expect(await repo.findFieldMap(TENANT)).toEqual(MYSP_FIELD_MAP);
  });

  it("does NOT need complete coordinates — a half-filled row must not break a compose", async () => {
    const { repo } = repoOn([
      { config: { spreadsheetId: "sheet-1", stockPolicy: { mode: "numeric" } } },
    ]);
    expect(await repo.findStockPolicy(TENANT)).toMatchObject({ mode: "numeric" });
    expect(await repo.findFieldMap(TENANT)).toEqual(MYSP_FIELD_MAP);
  });

  it("returns the stored textual policy and the stored map", async () => {
    const fieldMap = makeFieldMap({ code: "SKU", name: "Product name", stock: "Qty" });
    const { repo } = repoOn([
      {
        config: {
          ...SOURCE,
          fieldMap,
          stockPolicy: { mode: "textual", inStockValues: ["Còn"], outOfStockValues: ["Hết"] },
        },
      },
    ]);
    expect(await repo.findStockPolicy(TENANT)).toMatchObject({ mode: "textual" });
    expect(await repo.findFieldMap(TENANT)).toMatchObject({ code: "SKU", stock: "Qty" });
  });

  it("logs a warning on every read of a disabled stock gate", async () => {
    const { repo, lines } = repoOn([
      {
        config: {
          ...SOURCE,
          stockPolicy: { mode: "disabled", reason: "Khách quản lý tồn ở phần mềm khác" },
        },
      },
    ]);
    expect(await repo.findStockPolicy(TENANT)).toMatchObject({ mode: "disabled" });
    expect(
      lines.some(
        (line) => line.level === "warn" && line.context?.error_code === "STOCK_CHECK_DISABLED",
      ),
    ).toBe(true);
  });

  it.each([
    ["an unknown mode", { stockPolicy: { mode: "auto" } }],
    ["disabled without a reason", { stockPolicy: { mode: "disabled" } }],
    ["textual with one empty list", { stockPolicy: { mode: "textual", inStockValues: ["Còn"], outOfStockValues: [] } }],
  ])("refuses to answer 'numeric' for %s", async (_label, broken) => {
    const { repo } = repoOn([{ config: { ...SOURCE, ...broken } }]);
    await expect(repo.findStockPolicy(TENANT)).rejects.toMatchObject({
      code: "SYNC_FAILED",
      context: expect.objectContaining({ reason: "MAPPING_INVALID" }),
    });
  });

  it.each([
    ["a non-string column", { fieldMap: { ...makeFieldMap({ code: "SKU", name: "T" }), name: 7 } }],
    ["a map with no code column", { fieldMap: makeFieldMap({ name: "Product name" }) }],
    ["one column on two fields", { fieldMap: makeFieldMap({ code: "A", name: "A" }) }],
  ])("refuses to answer the MYSP preset for %s", async (_label, broken) => {
    const { repo } = repoOn([{ config: { ...SOURCE, ...broken } }]);
    await expect(repo.findFieldMap(TENANT)).rejects.toMatchObject({
      code: "SYNC_FAILED",
      context: expect.objectContaining({ reason: "MAPPING_INVALID" }),
    });
  });
});

/**
 * Onboarding phase 2: the media profile lives in the same JSONB blob under the
 * same contract as `fieldMap` — absent means the internal convention, stored
 * but unparsable means an error, never a silent default.
 */
describe("mediaProfile — the phase 2 key of the same blob", () => {
  it("returns no mediaProfile at all for a row written before phase 2", async () => {
    const { repo } = harness({ ...SOURCE, fieldMap: makeFieldMap(MYSP_FIELD_MAP) });
    const config = await repo.findCatalogConfig(TENANT);
    expect(config?.mediaProfile).toBeUndefined();
  });

  it("reads a stored profile with its colour vocabulary", async () => {
    const { repo } = harness({
      ...SOURCE,
      mediaProfile: {
        kind: "folder-per-code",
        colors: { canonical: ["Gỗ sồi"], includeDefaults: false },
      },
    });
    const config = await repo.findCatalogConfig(TENANT);
    expect(config?.mediaProfile).toEqual({
      kind: "folder-per-code",
      colors: { canonical: ["Gỗ sồi"], includeDefaults: false },
    });
  });

  it("fails loudly on a stored profile kind nobody implements", async () => {
    const { repo } = harness({ ...SOURCE, mediaProfile: { kind: "drive-magic" } });
    await expect(repo.findCatalogConfig(TENANT)).rejects.toMatchObject({
      code: "SYNC_FAILED",
      context: expect.objectContaining({ reason: "MAPPING_INVALID" }),
    });
  });

  it("shows the panel 'chưa cấu hình' rather than a source with a broken profile", async () => {
    const { repo } = harness({ ...SOURCE, mediaProfile: { kind: 42 } });
    await expect(repo.findCatalogSource(TENANT)).resolves.toBeNull();
  });

  it("refuses to save a profile kind that is not one of the four", async () => {
    const repo = new DrizzleCatalogConfigRepo(stubDb([]), recordingLogger([]));
    await expect(
      repo.saveCatalogSource({
        tenantId: TENANT,
        source: { ...SOURCE, mediaProfile: { kind: "drive-magic" } as never },
        actorUserId: null,
        actorEmail: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "mediaProfile" } });
  });
});
