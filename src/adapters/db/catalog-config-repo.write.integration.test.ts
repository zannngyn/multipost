import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LogBindings, LogContext, Logger } from "@/core/ports/infra";

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
