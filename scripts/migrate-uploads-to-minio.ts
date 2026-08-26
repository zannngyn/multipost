import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { and, eq, isNotNull } from "drizzle-orm";

import { makeMinioBlobStore } from "@/adapters/media/minio-blob-store";
import { makeDbHandle } from "@/adapters/db/client";
import { mediaAssets } from "@/adapters/db/schema";
import { loadConfig, loadMinioConfig, loadUploadConfig } from "@/composition/config";
import type { Logger } from "@/core/ports/infra";
import type { TenantId } from "@/core/domain/tenant-context";
import type { MediaKind } from "@/core/domain/media-file-name";

/**
 * ONE-TIME move of mode B (E9) bytes from the local `uploaddata` volume into
 * MinIO, keyed by the SAME `storage_key` every row already carries.
 *
 * Deliberately non-destructive: nothing is ever deleted at the source. Taking
 * the old volume away is a manual decision the operator makes AFTER confirming
 * every row moved cleanly — removing it here would make this script the one
 * thing standing between a bad run and permanent data loss.
 *
 * Keeping the same key means `storage_key` never changes value: a rollback is
 * just reverting the wiring commit (container.ts back to the local store), not
 * a second migration in the other direction.
 *
 * Run:
 *   pnpm exec tsx --env-file-if-exists=.env scripts/migrate-uploads-to-minio.ts
 *
 * Expected last line: `moved=N missing=0 mismatched=0 total=N`. A non-zero
 * missing/mismatched count exits non-zero ON PURPOSE — treat it as data to
 * review (a row pointing at a file that is no longer on disk, or a copy whose
 * stored size disagrees with the source), never as a script bug to silence.
 */

const scriptLogger: Logger = {
  info: (message, context) => console.log(message, context ?? ""),
  warn: (message, context) => console.warn(message, context ?? ""),
  error: (message, context) => console.error(message, context ?? ""),
  debug: () => {},
  child() {
    return this;
  },
};

interface UploadRow {
  tenantId: TenantId;
  storageKey: string;
  mimeType: string | null;
  kind: MediaKind;
}

async function listUploadRows(db: ReturnType<typeof makeDbHandle>["db"]): Promise<UploadRow[]> {
  const rows = await db
    .select({
      tenantId: mediaAssets.tenantId,
      storageKey: mediaAssets.storageKey,
      mimeType: mediaAssets.mimeType,
      kind: mediaAssets.kind,
    })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.origin, "upload"), isNotNull(mediaAssets.storageKey)));

  // isNotNull() above is a SQL-level filter; TypeScript still sees the column
  // as nullable, so this is the boundary that turns it into the non-null shape
  // the rest of the script relies on.
  return rows
    .filter((row): row is UploadRow & { storageKey: string } => row.storageKey !== null)
    .map((row) => ({ ...row, storageKey: row.storageKey as string }));
}

/**
 * `storage_key` is `<tenantId>/<assetId>` (adapters/media/*-blob-store.ts).
 * Refuses anything that does not split into exactly that shape, or whose
 * tenant segment disagrees with the row's own `tenant_id` — a mismatch here
 * means the source of truth is corrupted, and guessing which half to trust
 * would risk writing one tenant's bytes under another tenant's key.
 */
function parseStorageKey(row: UploadRow): { assetId: string } | null {
  const parts = row.storageKey.split("/");
  if (parts.length !== 2) return null;
  const [tenantSegment, assetId] = parts;
  if (!tenantSegment || !assetId) return null;
  if (tenantSegment !== row.tenantId) return null;
  return { assetId };
}

async function main(): Promise<void> {
  const root = resolve(loadUploadConfig().UPLOAD_STORAGE_ROOT);
  const { db, close } = makeDbHandle({ url: loadConfig().DATABASE_URL });
  const blobs = makeMinioBlobStore({ config: loadMinioConfig(), logger: scriptLogger });

  let moved = 0;
  let missing = 0;
  let mismatched = 0;

  try {
    const rows = await listUploadRows(db);

    if (rows.length === 0) {
      console.log("No upload rows found (origin='upload' with a storage_key) — nothing to migrate.");
      console.log("moved=0 missing=0 mismatched=0 total=0");
      return;
    }

    for (const row of rows) {
      const parsed = parseStorageKey(row);
      if (!parsed) {
        missing += 1;
        console.error(`MALFORMED_KEY ${row.storageKey} (tenant_id=${row.tenantId})`);
        continue;
      }
      const { assetId } = parsed;

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(join(root, row.tenantId, assetId)));
      } catch (error) {
        missing += 1;
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`MISSING ${row.storageKey}: ${reason}`);
        continue;
      }

      if (bytes.length === 0) {
        missing += 1;
        console.error(`MISSING ${row.storageKey}: source file is empty`);
        continue;
      }

      await blobs.put({
        tenantId: row.tenantId,
        assetId,
        bytes,
        mimeType: row.mimeType ?? "application/octet-stream",
        kind: row.kind,
      });

      // Read the size back from MinIO itself — `put()`'s own return value is
      // just an echo of the bytes handed to it, so it can never disagree with
      // its own input. Only a real `stat()` against the served object proves
      // the write actually landed with the right size.
      const stat = await blobs.stat({ tenantId: row.tenantId, storageKey: row.storageKey });
      if (!stat || stat.sizeBytes !== bytes.length) {
        mismatched += 1;
        console.error(
          `SIZE MISMATCH ${row.storageKey}: expected ${bytes.length}, stored ${stat?.sizeBytes ?? "MISSING"}`,
        );
        continue;
      }

      moved += 1;
    }

    console.log(`moved=${moved} missing=${missing} mismatched=${mismatched} total=${rows.length}`);
    if (missing > 0 || mismatched > 0) process.exitCode = 1;
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
