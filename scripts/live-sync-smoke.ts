import { count, eq, sql } from "drizzle-orm";

import { mediaAssets, products, syncRuns, tenantIntegrations, tenants } from "@/adapters/db/schema";
import { DEMO_TENANT_ID } from "@/adapters/db/seed-constants";
import {
  makeFixtureDriveSource,
  makeFixtureSheetSource,
} from "@/adapters/google/fixture-catalog-source";
import { makeGoogleAuth } from "@/adapters/google/service-account";
import { AppError } from "@/core/domain/errors";
import type { SyncRunCounts } from "@/core/ports/product-repo";
import { loadConfig, loadGoogleConfig } from "@/composition/config";
import { closeContainer, makeContainer } from "@/composition/container";

/**
 * E2/E3 LIVE smoke test — the real Google Drive folder and the real Sheet, no
 * fixtures. `scripts/catalog-smoke.ts` proves the pipeline against the frozen
 * `sample-data/` listing; this script proves the two things fixtures cannot:
 * that the Service Account really reaches the sources, and that Drive paging
 * (>1,000 files) works on a folder of ~5,500.
 *
 * READ-ONLY: the Service Account carries `drive.readonly` +
 * `spreadsheets.readonly` (adapters/google/service-account.ts), so nothing here
 * can write to the customer's Drive or Sheet even by accident.
 *
 * Run it through the wrapper, which owns the throwaway Postgres:
 *
 *   ./scripts/live-sync-smoke.sh
 *
 * or by hand against a migrated database:
 *
 *   DATABASE_URL=... pnpm exec tsx --env-file=.env scripts/live-sync-smoke.ts
 *
 * `--fixtures` runs the SAME script against `sample-data/` instead of Google.
 * That is a self-test of this harness (assertions, drift report, media chain),
 * NOT a live verification — it is labelled as such in the output on purpose.
 *
 * Credentials come from GOOGLE_SERVICE_ACCOUNT_JSON or
 * GOOGLE_APPLICATION_CREDENTIALS via loadGoogleConfig(); the key is never
 * printed. The Service Account's `client_email` IS printed — it is not a
 * secret, and the operator needs it to share the folder/sheet.
 *
 * Exit code 1 on any assertion failure: a green run is the evidence.
 */

/** Self-test mode: same assertions, `sample-data/` instead of Google. */
const FIXTURE_MODE = process.argv.includes("--fixtures");

/** Coordinates of the real sources (docs/05). Overridable for another tenant. */
const LIVE_SOURCE = {
  driveFolderId: envOr("LIVE_DRIVE_FOLDER_ID", "1bA48sjugz9BczcoR0-zOc-VNlIYikp4v"),
  spreadsheetId: envOr("LIVE_SPREADSHEET_ID", "1Qdhp9YS0mePn7G3focqAhqV3Mb1eymFqbX0EC1bFCVs"),
  sheetName: envOr("LIVE_SHEET_NAME", "Mẫu 2026"),
};

/**
 * Fixture baseline: what the frozen 2026-08-12 snapshot in `sample-data/`
 * produces (docs/05 sections 1 and 2, re-measured with catalog-smoke on
 * 2026-08-13). Live numbers WILL drift as the shop edits Drive/Sheet — the
 * delta is information, not a failure, so it is reported and never asserted.
 */
const FIXTURE_BASELINE = {
  driveFilesSeen: 5497,
  mediaParsed: 3111,
  sheetRowsSeen: 302,
  productsParsed: 299,
} as const;

/** Beyond this the drift is more likely a permission/config problem than edits. */
const DRIFT_ALERT_RATIO = 0.25;

/** A photo bigger than this is refused by the media route; keep the probe equal. */
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

interface Failure {
  readonly step: string;
  readonly detail: string;
}

const failures: Failure[] = [];
const fail = (step: string, detail: string): void => {
  failures.push({ step, detail });
  console.error(`FAIL [${step}] ${detail}`);
};

async function main(): Promise<void> {
  if (FIXTURE_MODE) {
    console.log(
      "!! --fixtures: reading sample-data/, NOT Google. This does NOT verify Drive/Sheet access.",
    );
  }

  const serviceAccountEmail = FIXTURE_MODE ? "(fixture mode — no Service Account)" : await preflight();

  const config = loadConfig();
  // Live mode passes NO overrides: that is the whole point — the REAL Drive and
  // Sheet adapters, built lazily by the composition root exactly as the web app
  // builds them. Fixture mode swaps in `sample-data/` to self-test the script.
  const container = makeContainer(
    config,
    FIXTURE_MODE ? { drive: makeFixtureDriveSource(), sheet: makeFixtureSheetSource() } : {},
  );
  const { db, usecases } = container;

  await seedTenantIntegration(db);

  // --- Sync #1 --------------------------------------------------------------
  console.log("\n=== sync #1 (cold) ===");
  const first = await timed(() => usecases.syncCatalog({ tenantId: DEMO_TENANT_ID }), {
    serviceAccountEmail,
  });
  reportRun("sync #1", first.value.status, first.value.counts, first.ms);
  reportDrift(first.value.counts);
  reportSchemaDrift(first.value.schemaDrift);
  reportIssues(first.value.issues, first.value.counts);

  if (first.value.counts.driveFilesSeen === 0) {
    fail("sync #1", "Drive returned 0 files — folder id wrong, or not shared with the SA");
  }
  if (first.value.counts.sheetRowsSeen === 0) {
    fail("sync #1", "Sheet returned 0 rows — spreadsheet id / tab name wrong, or not shared");
  }
  if (first.value.counts.driveFilesSeen > 1000) {
    console.log(
      `paging: ${first.value.counts.driveFilesSeen} files > pageSize 1000 — multi-page listing exercised`,
    );
  } else {
    console.log(
      `paging: only ${first.value.counts.driveFilesSeen} files — ONE page, paging NOT exercised`,
    );
  }

  const afterFirst = await countRows(db);
  console.log(`rows after #1: ${JSON.stringify(afterFirst)}`);

  // --- Sync #2 (idempotency + warm timing) ----------------------------------
  console.log("\n=== sync #2 (warm, idempotency) ===");
  const second = await timed(() => usecases.syncCatalog({ tenantId: DEMO_TENANT_ID }), {
    serviceAccountEmail,
  });
  reportRun("sync #2", second.value.status, second.value.counts, second.ms);

  const afterSecond = await countRows(db);
  console.log(`rows after #2: ${JSON.stringify(afterSecond)}`);

  if (afterSecond.products !== afterFirst.products) {
    fail(
      "idempotency",
      `product rows changed between identical syncs: ${afterFirst.products} -> ${afterSecond.products}`,
    );
  }
  if (afterSecond.media !== afterFirst.media) {
    fail(
      "idempotency",
      `media rows changed between identical syncs: ${afterFirst.media} -> ${afterSecond.media}`,
    );
  }
  // Deletes on the second pass would mean the sync forgot rows it had just
  // written (a stale-sweep bug), not that Drive changed in those seconds.
  if (second.value.counts.productsDeleted > 0 || second.value.counts.mediaDeleted > 0) {
    fail(
      "idempotency",
      `sync #2 deleted rows: products=${second.value.counts.productsDeleted} media=${second.value.counts.mediaDeleted}`,
    );
  }
  console.log(
    `timing: cold ${first.ms} ms, warm ${second.ms} ms (${afterSecond.media} media rows, ${afterSecond.products} products)`,
  );

  // --- Read model -----------------------------------------------------------
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
  if (!status) fail("get-sync-status", "no run returned right after two syncs");
  if (status && status.syncRunId !== second.value.syncRunId) {
    fail("get-sync-status", "status does not point at the latest run");
  }

  // --- compose-post on live data -------------------------------------------
  const candidate = await pickComposableCode(db);
  console.log("\n=== compose-post (live, happy path) ===");
  if (!candidate) {
    fail("compose-post", "no in-stock product with media found in the live catalog");
  } else {
    const composed = await usecases.composePost({
      tenantId: DEMO_TENANT_ID,
      productCode: candidate,
      channel: "fb-page-live-smoke",
    });
    console.log(
      JSON.stringify(
        {
          code: candidate,
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
    if (composed.blocked) {
      fail("compose-post", `expected a composable post, blocked: ${composed.blocked.reason}`);
    }
    if (composed.media.length === 0) fail("compose-post", "composed post has no media");
  }

  // --- Drive download through the /api/media chain --------------------------
  await probeMediaDownload(usecases, db, serviceAccountEmail);

  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} FAILURE(S):`);
    for (const failure of failures) console.error(`  [${failure.step}] ${failure.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    FIXTURE_MODE
      ? "OK (fixture mode) — harness verified on sample-data; Drive/Sheet access NOT verified"
      : "OK — live Drive/Sheet sync, idempotency, compose and media download all verified",
  );
}

/**
 * Fails BEFORE any Postgres container work when the credentials are absent or
 * unusable, and prints the Service Account address the operator must share the
 * folder/sheet with. `authorize()` only mints an OAuth token — still read-only.
 */
async function preflight(): Promise<string> {
  let google: ReturnType<typeof loadGoogleConfig>;
  try {
    google = loadGoogleConfig();
  } catch (error) {
    const wrapped = AppError.from(error, "INVALID_INPUT", { operation: "live-smoke.preflight" });
    console.error(
      "No Google credentials in the environment. Set ONE of:\n" +
        "  GOOGLE_SERVICE_ACCOUNT_JSON=<the key file, inlined on one line>\n" +
        "  GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/key.json",
    );
    throw wrapped;
  }

  const auth = makeGoogleAuth({
    serviceAccountJson: google.GOOGLE_SERVICE_ACCOUNT_JSON,
    credentialsPath: google.GOOGLE_APPLICATION_CREDENTIALS,
  });
  // Not a secret; the operator needs it to grant Viewer on Drive + Sheet.
  const email = typeof auth.email === "string" && auth.email.length > 0 ? auth.email : "(unknown)";

  console.log("=== preflight ===");
  console.log(`service account: ${email}`);
  console.log(`drive folder:    ${LIVE_SOURCE.driveFolderId}`);
  console.log(`spreadsheet:     ${LIVE_SOURCE.spreadsheetId} (tab "${LIVE_SOURCE.sheetName}")`);
  console.log("scopes:          drive.readonly, spreadsheets.readonly (READ-ONLY)");

  try {
    await auth.authorize();
  } catch (error) {
    console.error(
      `Service account ${email} could not mint a token — the key is rejected by Google ` +
        "(disabled account, revoked key, or wrong project).",
    );
    throw AppError.from(error, "UNAUTHORIZED", {
      operation: "live-smoke.authorize",
      service_account: email,
    });
  }
  console.log("token:           minted OK");
  return email;
}

/**
 * Tenant + Drive/Sheet coordinates in `tenant_integration` — business rule 7:
 * the sync reads them from the database, never from env.
 */
async function seedTenantIntegration(db: ReturnType<typeof makeContainer>["db"]): Promise<void> {
  await db
    .insert(tenants)
    .values({ id: DEMO_TENANT_ID, name: "Demo Tenant", status: "active" })
    .onConflictDoNothing();
  await db
    .insert(tenantIntegrations)
    .values({ tenantId: DEMO_TENANT_ID, provider: "google", config: { ...LIVE_SOURCE } })
    .onConflictDoUpdate({
      target: [tenantIntegrations.tenantId, tenantIntegrations.provider],
      set: { config: { ...LIVE_SOURCE }, status: "active" },
    });
}

/**
 * Times one call and turns a Drive/Sheet permission failure into the sentence
 * the operator can act on, instead of a raw googleapis stack.
 */
async function timed<T>(
  run: () => Promise<T>,
  hints: { serviceAccountEmail: string },
): Promise<{ value: T; ms: number }> {
  const startedAt = Date.now();
  try {
    const value = await run();
    return { value, ms: Date.now() - startedAt };
  } catch (error) {
    if (AppError.is(error)) explainGoogleFailure(error, hints.serviceAccountEmail);
    throw error;
  }
}

/** Turns DRIVE_ERROR/SHEET_ERROR into the operator's next action. */
function explainGoogleFailure(error: AppError, serviceAccountEmail: string): void {
  const status = readStatus(error);
  console.error(`\n!! ${error.code} after ${JSON.stringify(error.context)}`);
  if (status === 403 || status === 404) {
    console.error(
      `The Service Account cannot see the source. Share BOTH with ${serviceAccountEmail} ` +
        "as Viewer (folder + spreadsheet), or check the ids above. " +
        '"Anyone with the link" also works, but only if the link sharing really is on.',
    );
    return;
  }
  if (status === 429 || status === 500 || status === 503) {
    console.error(
      "Google throttled or dropped the request. The Drive adapter has NO retry/backoff today " +
        "(adapters/google/drive-source.google.ts) — a 429 mid-listing fails the whole sync.",
    );
  }
}

function readStatus(error: AppError): number | null {
  const fromContext = error.context.http_status;
  if (typeof fromContext === "number") return fromContext;
  const cause = error.cause as { status?: unknown; code?: unknown } | undefined;
  for (const value of [cause?.status, cause?.code]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d{3}$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

function reportRun(label: string, status: string, counts: SyncRunCounts, ms: number): void {
  console.log(`${label}: status=${status} in ${ms} ms`);
  console.log(JSON.stringify(counts, null, 2));
}

/** Live vs the frozen snapshot: expected to drift, loud when it drifts a lot. */
function reportDrift(counts: SyncRunCounts): void {
  console.log("\n--- live vs sample-data (2026-08-12 snapshot) ---");
  const rows: Array<[string, number, number]> = [
    ["driveFilesSeen", counts.driveFilesSeen, FIXTURE_BASELINE.driveFilesSeen],
    ["mediaParsed", counts.mediaParsed, FIXTURE_BASELINE.mediaParsed],
    ["sheetRowsSeen", counts.sheetRowsSeen, FIXTURE_BASELINE.sheetRowsSeen],
    ["productsParsed", counts.productsParsed, FIXTURE_BASELINE.productsParsed],
  ];
  for (const [name, live, baseline] of rows) {
    const delta = live - baseline;
    const ratio = baseline === 0 ? 0 : Math.abs(delta) / baseline;
    const flag = ratio > DRIFT_ALERT_RATIO ? "  <-- CHECK" : "";
    const percent = baseline === 0 ? "n/a" : `${((delta / baseline) * 100).toFixed(1)}%`;
    console.log(
      `${name.padEnd(16)} live=${String(live).padStart(6)} snapshot=${String(baseline).padStart(6)} delta=${delta >= 0 ? "+" : ""}${delta} (${percent})${flag}`,
    );
  }
}

function reportSchemaDrift(drift: readonly string[]): void {
  if (drift.length === 0) {
    console.log("\nschema drift: none — every expected sheet column is present");
    return;
  }
  // Not a failure of the script: the sheet is the customer's, and the sync
  // already downgraded itself to `partial`. It must be visible, though.
  console.log(`\nschema drift: MISSING/RENAMED COLUMNS -> ${JSON.stringify(drift)}`);
}

function reportIssues(
  issues: readonly { errorCode: string; reason: string; ref: string; detail: string }[],
  counts: SyncRunCounts,
): void {
  console.log(
    `\nissues: ${counts.issuesTotal} detected, ${issues.length} stored (truncated=${counts.issuesTruncated})`,
  );
  const byReason = new Map<string, number>();
  for (const issue of issues) {
    const key = `${issue.errorCode}/${issue.reason}`;
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  for (const [key, howMany] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${howMany} (of the stored sample)`);
  }
  for (const issue of issues.slice(0, 8)) {
    console.log(`  e.g. ${issue.errorCode}/${issue.reason}: ${issue.ref} — ${issue.detail}`);
  }
}

async function countRows(
  db: ReturnType<typeof makeContainer>["db"],
): Promise<{ products: number; media: number; runs: number }> {
  const [productCount] = await db
    .select({ value: count() })
    .from(products)
    .where(eq(products.tenantId, DEMO_TENANT_ID));
  const [mediaCount] = await db
    .select({ value: count() })
    .from(mediaAssets)
    .where(eq(mediaAssets.tenantId, DEMO_TENANT_ID));
  const [runCount] = await db
    .select({ value: count() })
    .from(syncRuns)
    .where(eq(syncRuns.tenantId, DEMO_TENANT_ID));
  return {
    products: productCount?.value ?? 0,
    media: mediaCount?.value ?? 0,
    runs: runCount?.value ?? 0,
  };
}

/** An in-stock code that actually has photos — chosen from the live data. */
async function pickComposableCode(
  db: ReturnType<typeof makeContainer>["db"],
): Promise<string | null> {
  const rows = await db
    .select({ code: products.code })
    .from(products)
    .innerJoin(mediaAssets, eq(mediaAssets.productCode, products.code))
    .where(
      sql`${products.tenantId} = ${DEMO_TENANT_ID}
        and ${mediaAssets.tenantId} = ${DEMO_TENANT_ID}
        and ${products.hasConflict} = false
        and ${mediaAssets.kind} = 'image'
        and trim(${products.stockRaw}) ~ '^[0-9]+$'
        and (trim(${products.stockRaw}))::int > 3
        and upper(trim(${products.noteRaw})) <> 'HẾT HÀNG'`,
    )
    .orderBy(products.code)
    .limit(1);
  return rows[0]?.code ?? null;
}

/**
 * The /api/media chain end to end on a real file: sign -> verify -> tenant-scoped
 * lookup -> Drive download. Bytes stay in memory; nothing is written to disk.
 */
async function probeMediaDownload(
  usecases: ReturnType<typeof makeContainer>["usecases"],
  db: ReturnType<typeof makeContainer>["db"],
  serviceAccountEmail: string,
): Promise<void> {
  console.log("\n=== drive download (signed media chain) ===");

  const [asset] = await db
    .select({
      driveFileId: mediaAssets.driveFileId,
      fileName: mediaAssets.fileName,
      mimeType: mediaAssets.mimeType,
      sizeBytes: mediaAssets.sizeBytes,
    })
    .from(mediaAssets)
    .where(
      // `size_bytes` is null for files Drive did not report a size for; those
      // are still valid candidates — the route's own byte budget catches a
      // surprise. Only a known-too-big file is excluded up front.
      sql`${mediaAssets.tenantId} = ${DEMO_TENANT_ID}
        and ${mediaAssets.kind} = 'image'
        and coalesce(${mediaAssets.sizeBytes}, 1) between 1 and ${MEDIA_MAX_BYTES}`,
    )
    .orderBy(mediaAssets.fileName)
    .limit(1);

  if (!asset) {
    fail("media-download", "no image asset within the size budget after a live sync");
    return;
  }

  let signed: ReturnType<typeof usecases.signMediaUrl>;
  try {
    signed = usecases.signMediaUrl({
      tenantId: DEMO_TENANT_ID,
      assetId: asset.driveFileId,
      baseUrl: envOr("MEDIA_PUBLIC_BASE_URL", "http://localhost:3000"),
    });
  } catch (error) {
    fail(
      "media-download",
      `could not sign a media URL (needs MEDIA_SIGNING_SECRET + MEDIA_PUBLIC_BASE_URL): ${describe(error)}`,
    );
    return;
  }

  const startedAt = Date.now();
  try {
    const content = await usecases.getMediaContent({
      tenantId: DEMO_TENANT_ID,
      mediaAssetId: asset.driveFileId,
      expiresAt: signed.expiresAtMs,
      signature: signed.signature,
    });
    const magic = [...content.bytes.slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ");
    console.log(
      JSON.stringify(
        {
          fileName: content.fileName,
          productCode: content.productCode,
          driveFileId: content.driveFileId,
          mimeType: content.mimeType,
          sizeFromSheetSync: asset.sizeBytes,
          downloadedBytes: content.bytes.length,
          ms: Date.now() - startedAt,
          magicBytes: magic,
          detected: detectImageType(content.bytes),
        },
        null,
        2,
      ),
    );

    if (content.bytes.length === 0) fail("media-download", "downloaded 0 bytes");
    if (asset.sizeBytes !== null && content.bytes.length !== asset.sizeBytes) {
      // Not fatal — Drive may have a newer revision than the last sync saw.
      console.log(
        `note: byte count differs from the size recorded by the sync (${asset.sizeBytes}); the file changed on Drive since then`,
      );
    }
    const detected = detectImageType(content.bytes);
    if (detected === "unknown") {
      fail(
        "media-download",
        `magic bytes are not a known image format (${magic}) — Drive may have returned an HTML error page`,
      );
    }
  } catch (error) {
    if (AppError.is(error)) explainGoogleFailure(error, serviceAccountEmail);
    fail("media-download", describe(error));
  }
}

/** Format from the first bytes — the cheapest proof the body is a real photo. */
function detectImageType(bytes: Uint8Array): string {
  const starts = (...prefix: number[]): boolean =>
    prefix.every((byte, index) => bytes[index] === byte);
  if (starts(0xff, 0xd8, 0xff)) return "jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (starts(0x52, 0x49, 0x46, 0x46)) return "riff/webp";
  if (starts(0x42, 0x4d)) return "bmp";
  return "unknown";
}

function describe(error: unknown): string {
  if (AppError.is(error)) return `${error.code}: ${error.message}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

main()
  .catch((error: unknown) => {
    const wrapped = AppError.from(error, "INTERNAL", { operation: "live-sync-smoke" });
    console.error(JSON.stringify({ level: "fatal", err: wrapped.toLogObject() }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeContainer();
  });
