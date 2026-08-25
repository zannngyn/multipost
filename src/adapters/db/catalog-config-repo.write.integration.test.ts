import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

import { makeFieldMap } from "@/core/domain/catalog-field-map";
import { AppError } from "@/core/domain/errors";

import { DrizzleCatalogConfigRepo, GOOGLE_PROVIDER } from "./catalog-config-repo.drizzle";
import { makeDbHandle } from "./client";
import { integrationLockKey } from "./integration-lock";
import { auditLogs, tenantIntegrations, tenants } from "./schema";
import { testTenantId } from "@/core/domain/tenant-context.testing";

/**
 * `saveCatalogSource` writes the same table as the channel repo (provider
 * google) and had the same gap: on the FIRST save of a tenant there is no row
 * for `SELECT ... FOR UPDATE` to lock, so two operators saving "Nguồn dữ liệu"
 * at the same moment both read nothing — one save is lost and its audit row
 * claims `old: null`, which is exactly what the method's docblock promises
 * cannot happen.
 *
 * Runs only when TEST_DATABASE_URL points at a MIGRATED database:
 *   TEST_DATABASE_URL=postgres://... pnpm test src/adapters/db/catalog-config-repo.write.integration.test.ts
 */

const url = process.env.TEST_DATABASE_URL;

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

const SOURCE_B = {
  driveFolderId: "folder-B",
  spreadsheetId: "sheet-B",
  sheetName: "Mẫu B",
};

describe.skipIf(!url)("DrizzleCatalogConfigRepo — two first saves at once", () => {
  // >= 3: the test holds one connection open while the repo works on another.
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 5 });
  const repo = new DrizzleCatalogConfigRepo(handle.db, recordingLogger([]));
  const tenantId = testTenantId(randomUUID());

  beforeAll(async () => {
    await handle.db
      .insert(tenants)
      .values({ id: tenantId, name: `E2 race test ${tenantId}`, status: "active" });
  });

  afterAll(async () => {
    await handle.db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    await handle.db.delete(tenantIntegrations).where(eq(tenantIntegrations.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  /**
   * The interleaving is FORCED, not hoped for: writer B holds the repo's own
   * advisory lock, inserts the google row, and is committed only after the repo
   * call has had time to reach its read. Without the lock in saveCatalogSource,
   * A reads an empty config and this test fails twice over — `previous` comes
   * back null (the audit row would say a first-ever save) and B's extra config
   * key is wiped.
   */
  it("does not lose the source the other operator saved first", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const writerB = handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${integrationLockKey(tenantId, GOOGLE_PROVIDER)}))`,
      );
      await tx.insert(tenantIntegrations).values({
        tenantId,
        provider: GOOGLE_PROVIDER,
        status: "active",
        // `keepMe` stands for any other key of the shared google blob: the
        // docblock promises a source change preserves it.
        config: { ...SOURCE_B, keepMe: "other provider setting" },
      });
      await held;
    });

    const writerA = repo.saveCatalogSource({
      tenantId,
      source: { driveFolderId: "folder-A", spreadsheetId: "sheet-A", sheetName: "Mẫu A" },
      actorEmail: "a@example.com",
      actorUserId: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await writerB;
    const result = await writerA;

    // A only read the row AFTER B committed, so it reports the real previous
    // value instead of inventing a first-ever save.
    expect(result.previous).toEqual(SOURCE_B);

    const [row] = await handle.db
      .select({ config: tenantIntegrations.config })
      .from(tenantIntegrations)
      .where(eq(tenantIntegrations.tenantId, tenantId));
    expect(row.config).toEqual({
      driveFolderId: "folder-A",
      spreadsheetId: "sheet-A",
      sheetName: "Mẫu A",
      keepMe: "other provider setting",
    });

    // ...and the audit trail says what really changed.
    const audits = await handle.db
      .select({ action: auditLogs.action, payload: auditLogs.payload })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tenantId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "catalog_source.updated",
      payload: { old: SOURCE_B, new: { driveFolderId: "folder-A" } },
    });
  });
});


/**
 * Onboarding phase 1: the field map lives in the SAME blob as the coordinates,
 * so the two ways it can be lost are a save that omits it and a save that
 * overwrites the rest of the blob with it. Both are checked here, on a real
 * transaction — the unit test can only prove the validation.
 */
describe.skipIf(!url)("DrizzleCatalogConfigRepo — fieldMap in tenant_integration.config", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const repo = new DrizzleCatalogConfigRepo(handle.db, recordingLogger([]));
  const tenantId = testTenantId(randomUUID());

  const CUSTOMER_MAP = makeFieldMap({
    code: "SKU",
    name: "Product name",
    stock: "Qty",
  });

  beforeAll(async () => {
    await handle.db
      .insert(tenants)
      .values({ id: tenantId, name: `E2 field map test ${tenantId}`, status: "active" });
  });

  afterAll(async () => {
    await handle.db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    await handle.db.delete(tenantIntegrations).where(eq(tenantIntegrations.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  it("stores the map, keeps it on a later source-only save, and audits both", async () => {
    await repo.saveCatalogSource({
      tenantId,
      source: {
        driveFolderId: "folder-1",
        spreadsheetId: "sheet-1",
        sheetName: "Danh mục",
        fieldMap: CUSTOMER_MAP,
        stockPolicy: { mode: "disabled", reason: "Khách quản lý tồn ở phần mềm khác" },
      },
      actorEmail: "onboarding@example.com",
      actorUserId: null,
    });

    const stored = await repo.findCatalogConfig(tenantId);
    expect(stored?.fieldMap).toMatchObject({ code: "SKU", name: "Product name", stock: "Qty" });
    expect(stored?.stockPolicy).toMatchObject({ mode: "disabled" });

    // The operator now only fixes the folder id — the mapping must survive.
    const second = await repo.saveCatalogSource({
      tenantId,
      source: { driveFolderId: "folder-2", spreadsheetId: "sheet-1", sheetName: "Danh mục" },
      actorEmail: "onboarding@example.com",
      actorUserId: null,
    });

    expect(second.previous?.fieldMap).toMatchObject({ code: "SKU" });
    const after = await repo.findCatalogConfig(tenantId);
    expect(after?.driveFolderId).toBe("folder-2");
    expect(after?.fieldMap).toMatchObject({ code: "SKU", name: "Product name" });
    expect(after?.stockPolicy).toMatchObject({ mode: "disabled" });

    const audits = await handle.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tenantId));
    expect(audits).toHaveLength(2);
  });
});

/**
 * Onboarding phase 3 — the cross-layer bug this suite exists to prevent.
 *
 * A tenant whose catalog is an uploaded CSV saved their source once. Every
 * later save (fixing a column mapping, a stock policy) carries NO `textSource`,
 * because omitting it means "keep what is stored" (port contract). The
 * coordinate guard used to read the kind off that patch, saw `undefined`,
 * assumed a Google tab and demanded a spreadsheet id the tenant does not have:
 *
 *   PUT /api/catalog/source {driveFolder:"", spreadsheet:"", sheetName:"", fieldMap:{...}}
 *   -> 400 INVALID_INPUT "Thiếu thông tin nguồn dữ liệu Drive/Sheet."
 *
 * Unit tests could not catch it: the decision now depends on a row read under
 * the lock INSIDE the transaction, and a stub that refuses to open one never
 * reaches it. Hence a real database.
 */
describe.skipIf(!url)("saveCatalogSource — source kind comes from stored state", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const repo = new DrizzleCatalogConfigRepo(handle.db, recordingLogger([]));
  const fileTenant = testTenantId(randomUUID());
  const sheetTenant = testTenantId(randomUUID());

  const FILE_SOURCE = {
    kind: "file" as const,
    storageKey: `${fileTenant}/catalog_abc`,
    fileName: "bang-gia.csv",
    uploadedAt: "2026-08-24T10:00:00.000Z",
  };

  beforeAll(async () => {
    for (const [id, name] of [
      [fileTenant, "E3 file tenant"],
      [sheetTenant, "E3 sheet tenant"],
    ] as const) {
      await handle.db.insert(tenants).values({ id, name: `${name} ${id}`, status: "active" });
    }

    // The tenant records their uploaded CSV as the source, with no Google
    // coordinates at all — the whole point of phase 3.
    await repo.saveCatalogSource({
      tenantId: fileTenant,
      source: { driveFolderId: "", spreadsheetId: "", sheetName: "", textSource: FILE_SOURCE },
      actorEmail: "csv@example.com",
      actorUserId: null,
    });
  });

  afterAll(async () => {
    for (const id of [fileTenant, sheetTenant]) {
      await handle.db.delete(auditLogs).where(eq(auditLogs.tenantId, id));
      await handle.db.delete(tenantIntegrations).where(eq(tenantIntegrations.tenantId, id));
      await handle.db.delete(tenants).where(eq(tenants.id, id));
    }
    await handle.close();
  });

  it("saves a mapping-only patch for a stored FILE tenant (the reported 400)", async () => {
    const result = await repo.saveCatalogSource({
      tenantId: fileTenant,
      source: {
        driveFolderId: "",
        spreadsheetId: "",
        sheetName: "",
        fieldMap: makeFieldMap({ code: "Mã hàng", name: "Tên hàng", stock: "Số lượng tồn" }),
      },
      actorEmail: "csv@example.com",
      actorUserId: null,
    });

    expect(result.previous?.textSource).toMatchObject({ kind: "file", fileName: "bang-gia.csv" });

    const stored = await repo.findCatalogConfig(fileTenant);
    expect(stored?.fieldMap).toMatchObject({ code: "Mã hàng", stock: "Số lượng tồn" });
    // The source it never sent is still there — "vắng = giữ nguyên".
    expect(stored?.textSource).toMatchObject({ kind: "file", storageKey: FILE_SOURCE.storageKey });
  });

  it("also accepts a stock-policy-only patch from the same tenant", async () => {
    await repo.saveCatalogSource({
      tenantId: fileTenant,
      source: {
        driveFolderId: "",
        spreadsheetId: "",
        sheetName: "",
        stockPolicy: { mode: "disabled", reason: "Khách quản lý tồn ở phần mềm khác" },
      },
      actorEmail: "csv@example.com",
      actorUserId: null,
    });

    const stored = await repo.findCatalogConfig(fileTenant);
    expect(stored?.stockPolicy).toMatchObject({ mode: "disabled" });
    expect(stored?.textSource).toMatchObject({ kind: "file" });
  });

  it("STILL refuses blank coordinates for a tenant on a Google tab", async () => {
    // The rule did not go away with the fix; it just asks the right question.
    await expect(
      repo.saveCatalogSource({
        tenantId: sheetTenant,
        source: { driveFolderId: "", spreadsheetId: "", sheetName: "" },
        actorEmail: "sheet@example.com",
        actorUserId: null,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: { field: "source", text_source: "google_sheet" },
    });

    // Nothing was written for that tenant.
    const rows = await handle.db
      .select({ config: tenantIntegrations.config })
      .from(tenantIntegrations)
      .where(eq(tenantIntegrations.tenantId, sheetTenant));
    expect(rows).toHaveLength(0);
  });

  it("refuses blank coordinates when a patch switches a file tenant BACK to a tab", async () => {
    await expect(
      repo.saveCatalogSource({
        tenantId: fileTenant,
        source: {
          driveFolderId: "",
          spreadsheetId: "",
          sheetName: "",
          textSource: { kind: "google_sheet" },
        },
        actorEmail: "csv@example.com",
        actorUserId: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { text_source: "google_sheet" } });

    // ...and the tenant is still on their file, unharmed.
    const stored = await repo.findCatalogConfig(fileTenant);
    expect(stored?.textSource).toMatchObject({ kind: "file" });
  });

  it("reads the stored kind even when the stored fieldMap is broken", async () => {
    // A hand-edited blob: the mapping no longer parses, but the row still knows
    // perfectly well that it reads a file.
    await handle.db
      .update(tenantIntegrations)
      .set({
        config: {
          driveFolderId: "",
          spreadsheetId: "",
          sheetName: "",
          textSource: FILE_SOURCE,
          fieldMap: { code: "only-one-key" },
        },
      })
      .where(eq(tenantIntegrations.tenantId, fileTenant));

    // The coordinate guard must not fire (that would be the old bug); the save
    // is refused for the REAL reason instead — the map it was handed is unusable.
    await expect(
      repo.saveCatalogSource({
        tenantId: fileTenant,
        source: {
          driveFolderId: "",
          spreadsheetId: "",
          sheetName: "",
          fieldMap: makeFieldMap({ name: "Tên hàng" }),
        },
        actorEmail: "csv@example.com",
        actorUserId: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "fieldMap" } });

    // A valid map goes through, proving the coordinates were never the blocker.
    await repo.saveCatalogSource({
      tenantId: fileTenant,
      source: {
        driveFolderId: "",
        spreadsheetId: "",
        sheetName: "",
        fieldMap: makeFieldMap({ code: "Mã hàng", name: "Tên hàng" }),
      },
      actorEmail: "csv@example.com",
      actorUserId: null,
    });
    const stored = await repo.findCatalogConfig(fileTenant);
    expect(stored?.fieldMap).toMatchObject({ code: "Mã hàng" });
  });
});

/**
 * Onboarding — combinations that are legal in each half and meaningless once
 * put together. Same class as the source-kind bug above: the verdict must come
 * from PATCH + STORED, because a save that only changes one of the two halves
 * deliberately omits the other.
 *
 * They are refused at SAVE time even though `syncCatalog` also refuses them:
 * the sync happens hours later with nobody watching, and by then the operator
 * has left the form that caused it.
 */
describe.skipIf(!url)("saveCatalogSource — patch + stored combinations", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const repo = new DrizzleCatalogConfigRepo(handle.db, recordingLogger([]));
  const tenantId = testTenantId(randomUUID());

  const SOURCE = { driveFolderId: "folder-1", spreadsheetId: "sheet-1", sheetName: "Danh mục" };
  const MAP_WITHOUT_EXTRAS = makeFieldMap({ code: "SKU", name: "Product name" });
  const MAP_WITH_LINK = makeFieldMap({ code: "SKU", name: "Product name", mediaLink: "Link ảnh" });
  const MAP_WITH_STOCK = makeFieldMap({ code: "SKU", name: "Product name", stock: "Qty" });

  beforeAll(async () => {
    await handle.db
      .insert(tenants)
      .values({ id: tenantId, name: `E3 combo test ${tenantId}`, status: "active" });
    await repo.saveCatalogSource({
      tenantId,
      source: { ...SOURCE, fieldMap: MAP_WITHOUT_EXTRAS },
      actorEmail: "onboarding@example.com",
      actorUserId: null,
    });
  });

  afterAll(async () => {
    await handle.db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    await handle.db.delete(tenantIntegrations).where(eq(tenantIntegrations.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  it("refuses 'ảnh theo cột link' when the STORED map has no link column", async () => {
    // The patch carries only the profile — the column it needs can only be
    // judged against what is already stored.
    await expect(
      repo.saveCatalogSource({
        tenantId,
        source: { ...SOURCE, mediaProfile: { kind: "sheet-column" } },
        actorEmail: "onboarding@example.com",
        actorUserId: null,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: {
        field: "mediaProfile",
        reason: "MEDIA_PROFILE_NEEDS_LINK_COLUMN",
        media_profile_from: "patch",
        field_map_from: "stored",
      },
    });

    const stored = await repo.findCatalogConfig(tenantId);
    expect(stored?.mediaProfile).toBeUndefined();
  });

  it("says what to fix and where, in Vietnamese", async () => {
    const error = await repo
      .saveCatalogSource({
        tenantId,
        source: { ...SOURCE, mediaProfile: { kind: "sheet-column" } },
        actorEmail: "onboarding@example.com",
        actorUserId: null,
      })
      .catch((e: unknown) => e as AppError);

    expect((error as AppError).userMessage).toContain("cột link");
    expect((error as AppError).userMessage).toContain("chưa chỉ định cột nào chứa link ảnh");
  });

  it("accepts the pair when the SAME patch carries both halves", async () => {
    await repo.saveCatalogSource({
      tenantId,
      source: { ...SOURCE, fieldMap: MAP_WITH_LINK, mediaProfile: { kind: "sheet-column" } },
      actorEmail: "onboarding@example.com",
      actorUserId: null,
    });

    const stored = await repo.findCatalogConfig(tenantId);
    expect(stored?.mediaProfile).toMatchObject({ kind: "sheet-column" });
    expect(stored?.fieldMap).toMatchObject({ mediaLink: "Link ảnh" });
  });

  it("refuses a map patch that would REMOVE the link column the stored profile needs", async () => {
    // Stored: sheet-column + a link column. The patch re-maps the columns and
    // drops the link one — legal on its own, broken next to the stored profile.
    await expect(
      repo.saveCatalogSource({
        tenantId,
        source: { ...SOURCE, fieldMap: MAP_WITHOUT_EXTRAS },
        actorEmail: "onboarding@example.com",
        actorUserId: null,
      }),
    ).rejects.toMatchObject({
      context: {
        reason: "MEDIA_PROFILE_NEEDS_LINK_COLUMN",
        media_profile_from: "stored",
        field_map_from: "patch",
      },
    });
  });

  it("lets the operator switch away from 'ảnh theo cột link' in one save", async () => {
    await repo.saveCatalogSource({
      tenantId,
      source: { ...SOURCE, fieldMap: MAP_WITHOUT_EXTRAS, mediaProfile: { kind: "code-color-seq" } },
      actorEmail: "onboarding@example.com",
      actorUserId: null,
    });

    const stored = await repo.findCatalogConfig(tenantId);
    expect(stored?.mediaProfile).toMatchObject({ kind: "code-color-seq" });
    expect(stored?.fieldMap?.mediaLink).toBeNull();
  });

  it("refuses a textual stock policy when no stock column is mapped", async () => {
    await expect(
      repo.saveCatalogSource({
        tenantId,
        source: {
          ...SOURCE,
          stockPolicy: {
            mode: "textual",
            inStockValues: ["Còn hàng"],
            outOfStockValues: ["Hết hàng"],
          },
        },
        actorEmail: "onboarding@example.com",
        actorUserId: null,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      context: {
        field: "stockPolicy",
        reason: "STOCK_POLICY_NEEDS_STOCK_COLUMN",
        stock_policy_from: "patch",
        field_map_from: "stored",
      },
    });
  });

  it("accepts the textual policy once the stock column is mapped", async () => {
    await repo.saveCatalogSource({
      tenantId,
      source: {
        ...SOURCE,
        fieldMap: MAP_WITH_STOCK,
        stockPolicy: {
          mode: "textual",
          inStockValues: ["Còn hàng"],
          outOfStockValues: ["Hết hàng"],
        },
      },
      actorEmail: "onboarding@example.com",
      actorUserId: null,
    });

    const stored = await repo.findCatalogConfig(tenantId);
    expect(stored?.stockPolicy).toMatchObject({ mode: "textual" });
    expect(stored?.fieldMap).toMatchObject({ stock: "Qty" });
  });

  it("refuses a later map patch that drops the stock column under a textual policy", async () => {
    await expect(
      repo.saveCatalogSource({
        tenantId,
        source: { ...SOURCE, fieldMap: MAP_WITHOUT_EXTRAS },
        actorEmail: "onboarding@example.com",
        actorUserId: null,
      }),
    ).rejects.toMatchObject({
      context: { reason: "STOCK_POLICY_NEEDS_STOCK_COLUMN", stock_policy_from: "stored" },
    });
  });

  it("still allows a numeric policy without a stock column (blocks at post time, not here)", async () => {
    // Deliberately NOT refused: this is the state of every tenant halfway
    // through the wizard, and the consequence is the SAFE one — the stock gate
    // blocks every product with STOCK_EMPTY instead of posting anything.
    await repo.saveCatalogSource({
      tenantId,
      source: { ...SOURCE, fieldMap: MAP_WITHOUT_EXTRAS, stockPolicy: { mode: "numeric" } },
      actorEmail: "onboarding@example.com",
      actorUserId: null,
    });

    const stored = await repo.findCatalogConfig(tenantId);
    expect(stored?.stockPolicy).toMatchObject({ mode: "numeric" });
    expect(stored?.fieldMap?.stock).toBeNull();
  });
});

/**
 * F3 — LOST UPDATE on the three coordinates.
 *
 * Both callers used to read the config OUTSIDE the write transaction and send
 * all three coordinates back with their own edit. Two admins saving at the same
 * moment therefore reverted each other with no trace: whoever committed second
 * wrote the coordinates it had read BEFORE the first one committed.
 *
 * The fix is the patch shape — absent key = "keep what is stored" — with the
 * merge happening under the advisory lock. This proves it on a real database,
 * with the two writes genuinely interleaved rather than hoped to be.
 */
describe.skipIf(!url)("saveCatalogSource — concurrent saves do not revert each other", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 5 });
  const repo = new DrizzleCatalogConfigRepo(handle.db, recordingLogger([]));
  const tenantId = testTenantId(randomUUID());

  const ORIGINAL = {
    driveFolderId: "folder-original",
    spreadsheetId: "sheet-1",
    sheetName: "Danh mục",
  };

  beforeAll(async () => {
    await handle.db
      .insert(tenants)
      .values({ id: tenantId, name: `E3 race test ${tenantId}`, status: "active" });
    await repo.saveCatalogSource({
      tenantId,
      source: { ...ORIGINAL, fieldMap: makeFieldMap({ code: "SKU", name: "Product name" }) },
      actorEmail: "setup@example.com",
      actorUserId: null,
    });
  });

  afterAll(async () => {
    await handle.db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    await handle.db.delete(tenantIntegrations).where(eq(tenantIntegrations.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  /**
   * The interleaving is FORCED, not hoped for: admin B holds the repo's own
   * advisory lock and moves the Drive folder, and only releases it after A —
   * who is saving a column mapping read before any of this — has had time to
   * reach its own lock acquisition.
   */
  it("keeps BOTH changes when a mapping save races a folder move", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const adminB = handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${integrationLockKey(tenantId, GOOGLE_PROVIDER)}))`,
      );
      await tx
        .update(tenantIntegrations)
        .set({ config: { ...ORIGINAL, driveFolderId: "folder-MOVED-by-B" } })
        .where(eq(tenantIntegrations.tenantId, tenantId));
      locked();
      await held;
    });

    // Nothing is left to chance: A starts only once B provably holds the lock.
    await hasLock;

    // Admin A only changes the column mapping. Under the old code this call
    // carried `driveFolderId: "folder-original"` — the value it read before B
    // moved the folder — and silently put it back.
    const adminA = repo.saveCatalogSource({
      tenantId,
      source: { fieldMap: makeFieldMap({ code: "Mã hàng", name: "Tên hàng", stock: "Qty" }) },
      actorEmail: "a@example.com",
      actorUserId: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await adminB;
    await adminA;

    const after = await repo.findCatalogConfig(tenantId);
    // B's folder move survived A's save...
    expect(after?.driveFolderId).toBe("folder-MOVED-by-B");
    // ...and A's mapping survived too.
    expect(after?.fieldMap).toMatchObject({ code: "Mã hàng", stock: "Qty" });
    // Nothing else was collateral damage.
    expect(after?.spreadsheetId).toBe("sheet-1");
    expect(after?.sheetName).toBe("Danh mục");
  });

  it("an upload racing a folder move keeps both as well", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => {
      locked = resolve;
    });

    const adminB = handle.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${integrationLockKey(tenantId, GOOGLE_PROVIDER)}))`,
      );
      await tx
        .update(tenantIntegrations)
        .set({
          config: {
            ...ORIGINAL,
            driveFolderId: "folder-MOVED-again",
            fieldMap: makeFieldMap({ code: "Mã hàng", name: "Tên hàng", stock: "Qty" }),
          },
        })
        .where(eq(tenantIntegrations.tenantId, tenantId));
      locked();
      await held;
    });

    await hasLock;

    // What `uploadCatalogFile` sends: only the key it owns.
    const uploader = repo.saveCatalogSource({
      tenantId,
      source: {
        textSource: {
          kind: "file",
          storageKey: `${tenantId}/catalog_new`,
          fileName: "bang-gia.csv",
          uploadedAt: "2026-08-24T10:00:00.000Z",
        },
      },
      actorEmail: "csv@example.com",
      actorUserId: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await adminB;
    await uploader;

    const after = await repo.findCatalogConfig(tenantId);
    expect(after?.textSource).toMatchObject({ kind: "file", fileName: "bang-gia.csv" });
    expect(after?.driveFolderId).toBe("folder-MOVED-again");
    expect(after?.fieldMap).toMatchObject({ code: "Mã hàng" });
  });

  it("still tells absent from empty: '' CLEARS a coordinate", async () => {
    // The port keeps the two meanings apart, so a deliberate "xoá thư mục ảnh"
    // stays possible for a tenant who no longer keeps photos on Drive.
    await repo.saveCatalogSource({
      tenantId,
      source: { driveFolderId: "" },
      actorEmail: "csv@example.com",
      actorUserId: null,
    });

    const after = await repo.findCatalogConfig(tenantId);
    expect(after?.driveFolderId).toBe("");
    // The rest is untouched by that one-key patch.
    expect(after?.spreadsheetId).toBe("sheet-1");
    expect(after?.textSource).toMatchObject({ kind: "file" });
  });

  it("refuses to clear a coordinate a Google-tab tenant still needs", async () => {
    const sheetTenant = testTenantId(randomUUID());
    await handle.db
      .insert(tenants)
      .values({ id: sheetTenant, name: `E3 race sheet ${sheetTenant}`, status: "active" });
    await repo.saveCatalogSource({
      tenantId: sheetTenant,
      source: ORIGINAL,
      actorEmail: "sheet@example.com",
      actorUserId: null,
    });

    await expect(
      repo.saveCatalogSource({
        tenantId: sheetTenant,
        source: { spreadsheetId: "" },
        actorEmail: "sheet@example.com",
        actorUserId: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", context: { field: "source" } });

    const after = await repo.findCatalogConfig(sheetTenant);
    expect(after?.spreadsheetId).toBe("sheet-1");

    await handle.db.delete(auditLogs).where(eq(auditLogs.tenantId, sheetTenant));
    await handle.db.delete(tenantIntegrations).where(eq(tenantIntegrations.tenantId, sheetTenant));
    await handle.db.delete(tenants).where(eq(tenants.id, sheetTenant));
  });
});

/**
 * N4 — the audit payload must describe the ROW, not the patch.
 *
 * `new` used to carry only the keys a save had touched, while `old` was the
 * full config. An old->new diff of a "chỉ đổi thư mục" save therefore read as
 * "the column mapping was deleted" — the audit trail telling a false story is
 * worse than no audit trail, because it is consulted precisely when something
 * has gone wrong.
 */
describe.skipIf(!url)("saveCatalogSource — the audit payload describes the row", () => {
  const handle = makeDbHandle({ url: url ?? "postgres://unused", maxPoolSize: 3 });
  const repo = new DrizzleCatalogConfigRepo(handle.db, recordingLogger([]));
  const tenantId = testTenantId(randomUUID());

  const MAP = makeFieldMap({ code: "SKU", name: "Product name", stock: "Qty" });

  beforeAll(async () => {
    await handle.db
      .insert(tenants)
      .values({ id: tenantId, name: `E3 audit test ${tenantId}`, status: "active" });
    await repo.saveCatalogSource({
      tenantId,
      source: {
        driveFolderId: "folder-1",
        spreadsheetId: "sheet-1",
        sheetName: "Danh mục",
        fieldMap: MAP,
        stockPolicy: { mode: "disabled", reason: "Khách quản lý tồn ở phần mềm khác" },
      },
      actorEmail: "setup@example.com",
      actorUserId: null,
    });
  });

  afterAll(async () => {
    await handle.db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    await handle.db.delete(tenantIntegrations).where(eq(tenantIntegrations.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  it("keeps untouched keys in `new`, so a folder move does not read as a wipe", async () => {
    await repo.saveCatalogSource({
      tenantId,
      source: { driveFolderId: "folder-2" },
      actorEmail: "admin@example.com",
      actorUserId: null,
    });

    const audits = await handle.db
      .select({ payload: auditLogs.payload })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tenantId));
    const latest = audits[audits.length - 1]?.payload as {
      old: Record<string, unknown> | null;
      new: Record<string, unknown> | null;
      patched: string[];
    };

    // Both halves have the same shape...
    expect(latest.old).toMatchObject({
      driveFolderId: "folder-1",
      fieldMap: { code: "SKU" },
      stockPolicy: { mode: "disabled" },
    });
    // ...and `new` shows the mapping still there, next to the moved folder.
    expect(latest.new).toMatchObject({
      driveFolderId: "folder-2",
      spreadsheetId: "sheet-1",
      sheetName: "Danh mục",
      fieldMap: { code: "SKU", stock: "Qty" },
      stockPolicy: { mode: "disabled" },
    });
    // And what the save actually asked for stays visible on its own.
    expect(latest.patched).toEqual(["driveFolderId"]);
  });

  it("records a mapping change with the coordinates intact on both sides", async () => {
    await repo.saveCatalogSource({
      tenantId,
      source: { fieldMap: makeFieldMap({ code: "Mã hàng", name: "Tên hàng", stock: "Qty" }) },
      actorEmail: "admin@example.com",
      actorUserId: null,
    });

    const audits = await handle.db
      .select({ payload: auditLogs.payload })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, tenantId));
    const latest = audits[audits.length - 1]?.payload as {
      old: Record<string, unknown> | null;
      new: Record<string, unknown> | null;
      patched: string[];
    };

    expect(latest.old).toMatchObject({ driveFolderId: "folder-2", fieldMap: { code: "SKU" } });
    expect(latest.new).toMatchObject({
      driveFolderId: "folder-2",
      fieldMap: { code: "Mã hàng" },
    });
    expect(latest.patched).toEqual(["fieldMap"]);
  });
});
