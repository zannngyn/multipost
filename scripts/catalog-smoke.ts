import { count, eq } from "drizzle-orm";

import { makeFixtureDriveSource, makeFixtureSheetSource } from "@/adapters/google/fixture-catalog-source";
import { DEMO_TENANT_ID } from "@/adapters/db/seed";
import { mediaAssets, products, syncRuns, tenantIntegrations, tenants } from "@/adapters/db/schema";
import { AppError } from "@/core/domain/errors";
import { loadConfig } from "@/composition/config";
import { closeContainer, makeContainer } from "@/composition/container";

/**
 * Dev script (NOT part of the app — it lives outside `src/` so no production
 * bundle can reach the `sample-data/` fixture sources): runs a full catalog sync
 * against a REAL Postgres using the fixtures as Drive/Sheet, then reads the sync
 * status back and composes three posts (happy / out of stock / no media), so the
 * whole E2+E3 chain is exercised end to end while no Service Account exists.
 *
 *   DATABASE_URL=... REDIS_URL=... NODE_ENV=development \
 *     pnpm exec tsx scripts/catalog-smoke.ts
 */

const CASES = {
  /** MGKVX6310 "Giannal": stock 104, 4+ colours, every naming quirk. */
  happy: "MGKVX6310",
  /** MR0AC6080 "Penny": stock 0 + note HẾT HÀNG — the brief's own example. */
  outOfStock: "MR0AC6080",
};

async function main(): Promise<void> {
  const config = loadConfig();
  const container = makeContainer(config, {
    drive: makeFixtureDriveSource(),
    sheet: makeFixtureSheetSource(),
  });
  const { db, usecases } = container;

  // Tenant + integration row: the sync reads Drive/Sheet coordinates from
  // tenant_integration, never from env (business rule 7).
  await db
    .insert(tenants)
    .values({ id: DEMO_TENANT_ID, name: "Demo Tenant", status: "active" })
    .onConflictDoNothing();
  await db
    .insert(tenantIntegrations)
    .values({
      tenantId: DEMO_TENANT_ID,
      provider: "google",
      config: {
        driveFolderId: "1bA48sjugz9BczcoR0-zOc-VNlIYikp4v",
        spreadsheetId: "1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs",
        sheetName: "Mẫu 2026",
      },
    })
    .onConflictDoUpdate({
      target: [tenantIntegrations.tenantId, tenantIntegrations.provider],
      set: { status: "active" },
    });

  const result = await usecases.syncCatalog({ tenantId: DEMO_TENANT_ID });
  console.log("\n=== sync-catalog result ===");
  console.log(JSON.stringify({ status: result.status, counts: result.counts }, null, 2));
  console.log(`issues stored: ${result.issues.length} (capped)`);
  console.log(
    JSON.stringify(
      result.issues.slice(0, 5).map((issue) => `${issue.errorCode}/${issue.reason}: ${issue.ref}`),
      null,
      2,
    ),
  );

  const [productCount] = await db
    .select({ value: count() })
    .from(products)
    .where(eq(products.tenantId, DEMO_TENANT_ID));
  const [mediaCount] = await db
    .select({ value: count() })
    .from(mediaAssets)
    .where(eq(mediaAssets.tenantId, DEMO_TENANT_ID));
  const runs = await db
    .select({
      id: syncRuns.id,
      status: syncRuns.status,
      counts: syncRuns.counts,
      issues: syncRuns.issues,
    })
    .from(syncRuns)
    .where(eq(syncRuns.tenantId, DEMO_TENANT_ID));

  console.log("\n=== rows in Postgres ===");
  console.log(
    JSON.stringify(
      {
        product: productCount?.value,
        media_asset: mediaCount?.value,
        sync_run: runs.length,
        last_run_status: runs.at(-1)?.status,
        last_run_issue_count: runs.at(-1)?.issues.length,
        last_run_counts: runs.at(-1)?.counts,
      },
      null,
      2,
    ),
  );

  // Read model the status panel will use (E10): must match the run just written.
  const status = await usecases.getSyncStatus({ tenantId: DEMO_TENANT_ID });
  console.log("\n=== get-sync-status ===");
  console.log(
    JSON.stringify(
      {
        syncRunId: status?.syncRunId,
        status: status?.status,
        startedAt: status?.startedAt,
        finishedAt: status?.finishedAt,
        issuesStored: status?.issues.length,
        issuesTotal: status?.counts?.issuesTotal,
        issuesTruncated: status?.counts?.issuesTruncated,
        errorCode: status?.errorCode,
      },
      null,
      2,
    ),
  );

  // A code that is IN STOCK but has no photo on Drive. Most missing-media codes
  // are also sold out and the stock gate (correctly) wins, so the candidate is
  // picked from the database rather than from the issue list.
  const productRows = await db
    .select({
      code: products.code,
      stockRaw: products.stockRaw,
      noteRaw: products.noteRaw,
      hasConflict: products.hasConflict,
    })
    .from(products)
    .where(eq(products.tenantId, DEMO_TENANT_ID));
  const mediaCodes = new Set(
    (
      await db
        .selectDistinct({ code: mediaAssets.productCode })
        .from(mediaAssets)
        .where(eq(mediaAssets.tenantId, DEMO_TENANT_ID))
    ).map((row) => row.code),
  );
  const missingMediaCode =
    productRows.find(
      (row) =>
        !mediaCodes.has(row.code) &&
        !row.hasConflict &&
        /^\d+$/.test(row.stockRaw.trim()) &&
        Number(row.stockRaw.trim()) > 0 &&
        row.noteRaw.trim().toUpperCase() !== "HẾT HÀNG",
    )?.code ?? "MR0VX6076";

  console.log("\n=== compose-post ===");
  for (const [label, code] of [
    ["happy", CASES.happy],
    ["out of stock", CASES.outOfStock],
    ["no media", missingMediaCode],
  ] as const) {
    const composed = await usecases.composePost({
      tenantId: DEMO_TENANT_ID,
      productCode: code,
      channel: "fb-page-demo",
    });
    console.log(
      JSON.stringify(
        {
          case: label,
          code,
          blocked: composed.blocked,
          inventory: composed.inventory
            ? { status: composed.inventory.status, stock: composed.inventory.stock }
            : null,
          contentKeys: composed.content ? Object.keys(composed.content) : null,
          mediaCount: composed.media.length,
          cover: composed.media[0]?.fileName ?? null,
          colors: composed.availableColors,
          warnings: composed.warnings,
        },
        null,
        2,
      ),
    );
  }
}

main()
  .catch((error: unknown) => {
    const wrapped = AppError.from(error, "INTERNAL", { operation: "catalog-smoke" });
    console.error(JSON.stringify({ level: "fatal", err: wrapped.toLogObject() }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeContainer();
  });
