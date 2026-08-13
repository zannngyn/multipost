import { and, count, eq } from "drizzle-orm";

import { makeFixtureDriveSource, makeFixtureSheetSource } from "@/adapters/google/fixture-catalog-source";
import { DEMO_TENANT_ID } from "@/adapters/db/seed-constants";
import {
  auditLogs,
  mediaAssets,
  products,
  syncRuns,
  tenantIntegrations,
  tenants,
} from "@/adapters/db/schema";
import { AppError } from "@/core/domain/errors";
import { loadConfig } from "@/composition/config";
import { closeContainer, makeContainer, type Container } from "@/composition/container";

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

  await catalogScreenSmoke(container);

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

/**
 * The "nguồn dữ liệu + sản phẩm hợp lệ/không hợp lệ" screen against real rows:
 * the SQL aggregate, the keyset page, the status filter and the search all run
 * on Postgres here — a fake repo cannot prove the GROUP BY or the ILIKE escape.
 */
async function catalogScreenSmoke(container: Container): Promise<void> {
  const { usecases } = container;

  console.log("\n=== get-catalog-source ===");
  console.log(JSON.stringify(await usecases.getCatalogSource({ tenantId: DEMO_TENANT_ID }), null, 2));

  console.log("\n=== list-catalog-products (page 1) ===");
  const firstPage = await usecases.listCatalogProducts({
    tenantId: DEMO_TENANT_ID,
    filter: { limit: 5 },
  });
  console.log(`totals: ${JSON.stringify(firstPage.totals)}`);
  console.log(`nextCursor: ${firstPage.nextCursor}`);
  console.log(JSON.stringify(firstPage.items, null, 2));

  const okPage = await usecases.listCatalogProducts({
    tenantId: DEMO_TENANT_ID,
    filter: { status: "ok", limit: 5 },
  });
  console.log("\n=== status=ok ===");
  console.log(
    JSON.stringify(
      okPage.items.map((item) => ({
        code: item.code,
        composable: item.composable,
        stock: item.inventory.stock,
        images: item.mediaImageCount,
        videos: item.mediaVideoCount,
      })),
      null,
      2,
    ),
  );
  const notComposable = okPage.items.filter((item) => !item.composable);
  console.log(`non-composable rows leaked into status=ok: ${notComposable.length}`);

  const blockedPage = await usecases.listCatalogProducts({
    tenantId: DEMO_TENANT_ID,
    filter: { status: "blocked", limit: 5 },
  });
  console.log("\n=== status=blocked ===");
  console.log(
    JSON.stringify(
      blockedPage.items.map((item) => ({
        code: item.code,
        reason: item.blockedReason?.code,
        userMessage: item.blockedReason?.userMessage,
        inventoryReason: item.inventory.reason,
      })),
      null,
      2,
    ),
  );

  const search = await usecases.listCatalogProducts({
    tenantId: DEMO_TENANT_ID,
    filter: { q: "MGKVX", limit: 5 },
  });
  console.log("\n=== q=MGKVX ===");
  console.log(`totals: ${JSON.stringify(search.totals)}`);
  console.log(JSON.stringify(search.items.map((item) => item.code), null, 2));

  // A LIKE metacharacter must be a literal, not a wildcard matching everything.
  const wildcard = await usecases.listCatalogProducts({
    tenantId: DEMO_TENANT_ID,
    filter: { q: "%", limit: 5 },
  });
  console.log(`q="%" -> ${wildcard.totals.total} products (0 = wildcards are escaped)`);

  // Paging must not repeat a code across two pages.
  const pageTwo = await usecases.listCatalogProducts({
    tenantId: DEMO_TENANT_ID,
    filter: { limit: 5, cursor: firstPage.nextCursor },
  });
  const overlap = pageTwo.items.filter((item) =>
    firstPage.items.some((first) => first.code === item.code),
  );
  console.log(
    `\npage 2 starts at ${pageTwo.items[0]?.code} — overlap with page 1: ${overlap.length}`,
  );

  // Cross-check: the SQL GROUP BY totals must equal what the decision table
  // says when every row is walked one by one. If these ever disagree, the
  // aggregate is lying to the counters on screen.
  let walkedTotal = 0;
  let walkedOk = 0;
  let walkCursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const chunk = await usecases.listCatalogProducts({
      tenantId: DEMO_TENANT_ID,
      filter: { limit: 100, cursor: walkCursor },
    });
    walkedTotal += chunk.items.length;
    walkedOk += chunk.items.filter((item) => item.composable).length;
    walkCursor = chunk.nextCursor;
    if (walkCursor === null) break;
  }
  const totalsAgree =
    walkedTotal === firstPage.totals.total && walkedOk === firstPage.totals.ok;
  console.log(
    `\ntotals cross-check: sql=${JSON.stringify(firstPage.totals)} walked={"total":${walkedTotal},"ok":${walkedOk},"blocked":${walkedTotal - walkedOk}} agree=${totalsAgree}`,
  );
  if (!totalsAgree) {
    console.error("FAIL: SQL totals disagree with the per-row decision table");
    process.exitCode = 1;
  }

  console.log("\n=== update-catalog-source (round trip) ===");
  const before = await usecases.getCatalogSource({ tenantId: DEMO_TENANT_ID });
  const updated = await usecases.updateCatalogSource({
    tenantId: DEMO_TENANT_ID,
    // Pasted exactly as a browser would give it, to prove the URL parser.
    driveFolder: "https://drive.google.com/drive/folders/1bA48sjugz9BczcoR0-zOc-VNlIYikp4v?usp=sharing",
    spreadsheet:
      "https://docs.google.com/spreadsheets/d/1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs/edit#gid=0",
    sheetName: "Mẫu 2026",
    actorEmail: "demo@mysp.local",
  });
  console.log(JSON.stringify(updated, null, 2));
  console.log(`unchanged after round trip: ${before?.driveFolderId === updated.driveFolderId}`);

  const audit = await container.db
    .select({ action: auditLogs.action, payload: auditLogs.payload })
    .from(auditLogs)
    .where(eq(auditLogs.tenantId, DEMO_TENANT_ID));
  console.log(
    `audit rows: ${JSON.stringify(audit.filter((entry) => entry.action === "catalog_source.updated"))}`,
  );

  // Point somewhere else, then back: proves the audit row records a REAL change
  // and that the panel reads what was written.
  await usecases.updateCatalogSource({
    tenantId: DEMO_TENANT_ID,
    driveFolder: "0AAbbCCddEEffGGhhIIjjKK",
    spreadsheet: "1zzzYYYxxxWWWvvvUUUtttSSSrrrQQQpppOOO",
    sheetName: "Tab thử",
    actorEmail: "demo@mysp.local",
  });
  console.log(
    `after switch: ${JSON.stringify(await usecases.getCatalogSource({ tenantId: DEMO_TENANT_ID }))}`,
  );
  const switchAudit = await container.db
    .select({ payload: auditLogs.payload })
    .from(auditLogs)
    .where(
      and(eq(auditLogs.tenantId, DEMO_TENANT_ID), eq(auditLogs.action, "catalog_source.updated")),
    );
  console.log(`audit rows now: ${switchAudit.length}, last: ${JSON.stringify(switchAudit.at(-1))}`);
  await usecases.updateCatalogSource({
    tenantId: DEMO_TENANT_ID,
    driveFolder: "1bA48sjugz9BczcoR0-zOc-VNlIYikp4v",
    spreadsheet: "1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs",
    sheetName: "Mẫu 2026",
    actorEmail: "demo@mysp.local",
  });

  try {
    await usecases.updateCatalogSource({
      tenantId: DEMO_TENANT_ID,
      driveFolder: "https://dropbox.com/folders/khong-phai-google",
      spreadsheet: "1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs",
      sheetName: "Mẫu 2026",
    });
    console.error("FAIL: a non-Google link was accepted");
    process.exitCode = 1;
  } catch (error) {
    const appError = AppError.is(error) ? error : null;
    console.log(
      `bad link rejected: ${appError?.code} field=${String(appError?.context.field)} — ${appError?.userMessage}`,
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
