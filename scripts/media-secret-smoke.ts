import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { makeFixtureDriveSource } from "@/adapters/google/fixture-catalog-source";
import { mediaAssets, tenantIntegrations, tenants } from "@/adapters/db/schema";
import { openConfigSecrets, sealConfigSecrets } from "@/adapters/db/secret-box";
import { loadConfig } from "@/composition/config";
import { closeContainer, makeContainer, makeTenantSecretBox } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * Dev script (outside `src/`, like catalog-smoke): proves the two Sprint 4A
 * pieces on a REAL Postgres.
 *
 *   1. media bridge  — sign a URL for a real media_asset row, serve it through
 *                      getMediaContent, then try the three ways to abuse it
 *                      (bad signature, expired, unknown asset, other tenant).
 *                      Drive is the fixture source: no Service Account exists
 *                      yet, so the bytes are the fixture's 1x1 PNG.
 *   2. secret box    — seal a Page-token-shaped value, write it to
 *                      tenant_integration.config, read it back through the DB
 *                      and confirm the row holds no plaintext.
 *
 *   DATABASE_URL=... REDIS_URL=... MEDIA_SIGNING_SECRET=... \
 *   TENANT_SECRETS_ENC_KEY=... NODE_ENV=development \
 *     pnpm exec tsx scripts/media-secret-smoke.ts
 */

const BASE_URL = "https://mysp.example.com";
/** Same id as adapters/db/seed, inlined so importing it cannot re-run the seed. */
const DEMO_TENANT_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_TENANT_ID = "00000000-0000-0000-0000-0000000000ff";
const FAKE_PAGE_TOKEN = "EAAG7ZBv1FAKEpageTokenForSmokeTest0000";
const SMOKE_PROVIDER = "smoke-meta";

function heading(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function expectFailure(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    throw new Error(`${label}: expected a rejection, got a success`);
  } catch (error) {
    if (!AppError.is(error)) throw error;
    print({ case: label, code: error.code, reason: error.context.reason ?? null });
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const container = makeContainer(config, { drive: makeFixtureDriveSource() });
  const { db, usecases, logger } = container;

  await db
    .insert(tenants)
    .values([
      { id: DEMO_TENANT_ID, name: "Demo Tenant", status: "active" },
      { id: OTHER_TENANT_ID, name: "Other Tenant", status: "active" },
    ])
    .onConflictDoNothing();

  // --- 1. media bridge -------------------------------------------------------
  // A real row, written the way sync-catalog writes it.
  const driveFileId = "fixture-00007";
  const syncRunId = randomUUID();
  await db
    .insert(mediaAssets)
    .values({
      tenantId: DEMO_TENANT_ID,
      driveFileId,
      fileName: "MGKVX6310-KEM (1).jpg",
      productCode: "MGKVX6310",
      color: "KEM",
      colorRaw: "KEM",
      sequence: 1,
      kind: "image",
      mimeType: "image/jpeg",
      sizeBytes: 482913,
      lastSyncRunId: syncRunId,
    })
    .onConflictDoUpdate({
      target: [mediaAssets.tenantId, mediaAssets.driveFileId],
      set: { lastSyncRunId: syncRunId },
    });

  const signed = usecases.signMediaUrl({
    tenantId: DEMO_TENANT_ID,
    assetId: driveFileId,
    baseUrl: BASE_URL,
  });

  heading("signMediaUrl");
  print({
    url: signed.url.replace(/sig=[0-9a-f]+/, "sig=<redacted>"),
    path_shape: signed.path.replace(/sig=[0-9a-f]+/, "sig=<redacted>"),
    expires_in_ms: signed.expiresAtMs - Date.now(),
    signature_length: signed.signature.length,
    accepted_by_create_post_batch: /^https?:\/\/\S+$/i.test(signed.url),
  });

  const url = new URL(signed.url);
  const request = {
    tenantId: url.searchParams.get("tenant") ?? "",
    mediaAssetId: decodeURIComponent(url.pathname.split("/").pop() ?? ""),
    expiresAt: url.searchParams.get("expires") ?? "",
    signature: url.searchParams.get("sig") ?? "",
  };

  heading("getMediaContent — valid signature");
  const content = await usecases.getMediaContent(request);
  print({
    drive_file_id: content.driveFileId,
    file_name: content.fileName,
    product_code: content.productCode,
    mime_type: content.mimeType,
    bytes: content.sizeBytes,
    png_magic: [...content.bytes.slice(0, 4)].join(","),
  });

  heading("getMediaContent — abuse cases");
  await expectFailure("forged signature", () =>
    usecases.getMediaContent({ ...request, signature: "a".repeat(64) }),
  );
  await expectFailure("expired link", () =>
    usecases.getMediaContent({ ...request, expiresAt: Date.now() - 1000 }),
  );
  await expectFailure("tampered asset id (MAC covers it)", () =>
    usecases.getMediaContent({ ...request, mediaAssetId: "fixture-99999" }),
  );
  await expectFailure("correctly signed link for an asset that was never synced", () => {
    const unknown = usecases.signMediaUrl({
      tenantId: DEMO_TENANT_ID,
      assetId: "fixture-99999",
      baseUrl: BASE_URL,
    });
    return usecases.getMediaContent({
      tenantId: DEMO_TENANT_ID,
      mediaAssetId: "fixture-99999",
      expiresAt: unknown.expiresAtMs,
      signature: unknown.signature,
    });
  });
  await expectFailure("valid link of another tenant (no row for it)", () =>
    usecases.getMediaContent(
      (() => {
        const other = usecases.signMediaUrl({
          tenantId: OTHER_TENANT_ID,
          assetId: driveFileId,
          baseUrl: BASE_URL,
        });
        return {
          tenantId: OTHER_TENANT_ID,
          mediaAssetId: driveFileId,
          expiresAt: other.expiresAtMs,
          signature: other.signature,
        };
      })(),
    ),
  );

  // --- 2. secret box ---------------------------------------------------------
  const box = makeTenantSecretBox(logger);
  const sealedConfig = sealConfigSecrets(
    { pageId: "123456789", pageAccessToken: FAKE_PAGE_TOKEN, spacingMs: 60_000 },
    box,
  );

  await db
    .insert(tenantIntegrations)
    .values({ tenantId: DEMO_TENANT_ID, provider: SMOKE_PROVIDER, config: sealedConfig })
    .onConflictDoUpdate({
      target: [tenantIntegrations.tenantId, tenantIntegrations.provider],
      set: { config: sealedConfig },
    });

  const [row] = await db
    .select({ config: tenantIntegrations.config })
    .from(tenantIntegrations)
    .where(
      and(
        eq(tenantIntegrations.tenantId, DEMO_TENANT_ID),
        eq(tenantIntegrations.provider, SMOKE_PROVIDER),
      ),
    );

  const storedJson = JSON.stringify(row?.config ?? {});
  const opened = openConfigSecrets(row?.config ?? {}, box, {
    tenantId: DEMO_TENANT_ID,
    provider: SMOKE_PROVIDER,
  }) as Record<string, unknown>;

  heading("secret box — round trip through Postgres");
  print({
    stored_row: storedJson.replace(/enc:v1:[^"]+/, "enc:v1:<redacted>"),
    stored_holds_plaintext_token: storedJson.includes(FAKE_PAGE_TOKEN),
    envelope_prefix_ok: String(
      (row?.config as Record<string, string> | undefined)?.pageAccessToken,
    ).startsWith("enc:v1:"),
    opened_matches_original: opened.pageAccessToken === FAKE_PAGE_TOKEN,
    non_secret_fields_untouched: opened.pageId === "123456789" && opened.spacingMs === 60_000,
  });

  heading("secret box — legacy plaintext row still readable (with a warning)");
  const legacy = { pageId: "1", pageAccessToken: FAKE_PAGE_TOKEN };
  const legacyOpened = openConfigSecrets(legacy, box, {
    tenantId: DEMO_TENANT_ID,
    provider: SMOKE_PROVIDER,
  }) as Record<string, unknown>;
  print({ passthrough_ok: legacyOpened.pageAccessToken === FAKE_PAGE_TOKEN });

  // Leave nothing behind: the smoke row is not a real integration.
  await db
    .delete(tenantIntegrations)
    .where(
      and(
        eq(tenantIntegrations.tenantId, DEMO_TENANT_ID),
        eq(tenantIntegrations.provider, SMOKE_PROVIDER),
      ),
    );
  await db
    .delete(mediaAssets)
    .where(
      and(
        eq(mediaAssets.tenantId, DEMO_TENANT_ID),
        eq(mediaAssets.driveFileId, driveFileId),
      ),
    );
  await db.delete(tenants).where(eq(tenants.id, OTHER_TENANT_ID));
}

main()
  .catch((error: unknown) => {
    const wrapped = AppError.from(error, "INTERNAL", { operation: "media-secret-smoke" });
    console.error(JSON.stringify({ level: "fatal", err: wrapped.toLogObject() }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeContainer();
  });
