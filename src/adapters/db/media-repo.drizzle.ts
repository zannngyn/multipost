import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import { MEDIA_KINDS, type MediaKind } from "@/core/domain/media-file-name";
import { MEDIA_ORIGINS, type MediaAsset, type MediaOrigin } from "@/core/domain/product";
import type { MediaAssetLookup } from "@/core/ports/drive-source";
import type { MediaRepo, OrphanedUpload } from "@/core/ports/product-repo";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { mediaAssets, type MediaAssetRow } from "./schema";
import { forTenant } from "./tenant-scope";
import type { TenantId } from "@/core/domain/tenant-context";

/** Postgres caps a statement at 65,535 bind parameters; 18 columns per row. */
const CHUNK_SIZE = 400;

function toDomain(row: MediaAssetRow): MediaAsset {
  // The DB enum can drift from the domain union across migrations.
  if (!(MEDIA_KINDS as readonly string[]).includes(row.kind)) {
    throw new AppError("DB_ERROR", {
      message: `Unknown media kind '${row.kind}' returned by the database`,
      userMessage: "Dữ liệu ảnh/video không hợp lệ. Vui lòng chạy lại đồng bộ.",
      context: { drive_file_id: row.driveFileId, kind: row.kind },
    });
  }

  if (!(MEDIA_ORIGINS as readonly string[]).includes(row.origin)) {
    throw new AppError("DB_ERROR", {
      message: `Unknown media origin '${row.origin}' returned by the database`,
      userMessage: "Dữ liệu ảnh/video không hợp lệ. Vui lòng chạy lại đồng bộ.",
      context: { drive_file_id: row.driveFileId, origin: row.origin },
    });
  }

  return {
    driveFileId: row.driveFileId,
    origin: row.origin as MediaOrigin,
    storageKey: row.storageKey,
    fileName: row.fileName,
    productCode: row.productCode,
    color: row.color,
    colorRaw: row.colorRaw,
    sequence: row.sequence,
    kind: row.kind as MediaKind,
    variants: {
      aiGenerated: row.aiGenerated,
      realPhoto: row.realPhoto,
      backView: row.backView,
    },
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    modifiedTime: row.modifiedTime ? row.modifiedTime.toISOString() : null,
    warnings: row.warnings ?? [],
    needsReview: row.needsReview,
  };
}

function toModifiedDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export class DrizzleMediaRepo implements MediaRepo, MediaAssetLookup {
  constructor(private readonly db: Database) {}

  /**
   * Tenant-scoped resolution of a Drive file id (MediaAssetLookup). This is the
   * isolation gate of the signed media route: the Service Account can read every
   * tenant's folder, so a row that does not belong to `tenantId` must read as
   * "not found" rather than as a Drive permission question.
   */
  async findByDriveFileId(tenantId: TenantId, driveFileId: string): Promise<MediaAsset | null> {
    const scope = forTenant(this.db, tenantId);
    const fileId = typeof driveFileId === "string" ? driveFileId.trim() : "";
    if (fileId.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "findByDriveFileId requires a Drive file id",
        userMessage: "Thiếu mã file ảnh trên Drive.",
        context: { tenant_id: scope.tenantId },
      });
    }

    let rows: MediaAssetRow[];
    try {
      rows = await scope.db
        .select()
        .from(mediaAssets)
        .where(scope.where(mediaAssets, eq(mediaAssets.driveFileId, fileId)))
        .limit(1);
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        drive_file_id: fileId,
        operation: "media.findByDriveFileId",
      });
    }

    const row = rows[0];
    return row ? toDomain(row) : null;
  }

  async listByProductCode(tenantId: TenantId, code: string): Promise<readonly MediaAsset[]> {
    const scope = forTenant(this.db, tenantId);
    const normalised = typeof code === "string" ? code.trim().toUpperCase() : "";
    if (normalised.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "listByProductCode requires a product code",
        userMessage: "Thiếu mã sản phẩm.",
        context: { tenant_id: scope.tenantId },
      });
    }

    let rows: MediaAssetRow[];
    try {
      rows = await scope.db
        .select()
        .from(mediaAssets)
        .where(scope.where(mediaAssets, eq(mediaAssets.productCode, normalised)))
        // NULLS LAST keeps unnumbered files behind numbered ones.
        .orderBy(asc(mediaAssets.sequence), asc(mediaAssets.fileName));
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        product_code: normalised,
        operation: "media.listByProductCode",
      });
    }

    return rows.map(toDomain);
  }

  async upsertMany(
    tenantId: TenantId,
    assets: readonly MediaAsset[],
    syncRunId: string,
  ): Promise<number> {
    const scope = forTenant(this.db, tenantId);
    if (!Array.isArray(assets) || assets.length === 0) return 0;

    let written = 0;
    for (let start = 0; start < assets.length; start += CHUNK_SIZE) {
      const chunk = assets.slice(start, start + CHUNK_SIZE).map((asset) =>
        scope.row({
          driveFileId: asset.driveFileId,
          fileName: asset.fileName,
          productCode: asset.productCode,
          color: asset.color,
          colorRaw: asset.colorRaw,
          sequence: asset.sequence,
          kind: asset.kind,
          aiGenerated: asset.variants.aiGenerated,
          realPhoto: asset.variants.realPhoto,
          backView: asset.variants.backView,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          modifiedTime: toModifiedDate(asset.modifiedTime),
          warnings: [...asset.warnings],
          needsReview: asset.needsReview,
          // upsertMany is the SYNC writer; an uploaded asset is registered by
          // registerUpload instead and must never be stamped with a run id.
          origin: "drive" as const,
          storageKey: null,
          lastSyncRunId: syncRunId,
        }),
      );

      try {
        const result = await scope.db
          .insert(mediaAssets)
          .values(chunk)
          .onConflictDoUpdate({
            target: [mediaAssets.tenantId, mediaAssets.driveFileId],
            set: {
              fileName: sql`excluded.file_name`,
              productCode: sql`excluded.product_code`,
              color: sql`excluded.color`,
              colorRaw: sql`excluded.color_raw`,
              sequence: sql`excluded.sequence`,
              kind: sql`excluded.kind`,
              aiGenerated: sql`excluded.ai_generated`,
              realPhoto: sql`excluded.real_photo`,
              backView: sql`excluded.back_view`,
              mimeType: sql`excluded.mime_type`,
              sizeBytes: sql`excluded.size_bytes`,
              modifiedTime: sql`excluded.modified_time`,
              warnings: sql`excluded.warnings`,
              needsReview: sql`excluded.needs_review`,
              lastSyncRunId: sql`excluded.last_sync_run_id`,
              updatedAt: new Date(),
            },
          })
          .returning({ id: mediaAssets.id });
        written += result.length;
      } catch (error) {
        throw wrapDbError(error, {
          tenant_id: scope.tenantId,
          field: "syncRunId",
          operation: "media.upsertMany",
          chunk_start: start,
          chunk_size: chunk.length,
        });
      }
    }

    return written;
  }

  /**
   * Removes the Drive rows the latest sync did not see.
   *
   * Scoped to `origin = 'drive'` on purpose: an uploaded row (E9) belongs to no
   * sync run at all, so an unscoped "everything not from this run" would delete
   * every file the operator uploaded the moment the next Drive sync ran, and
   * strand its bytes in the blob store.
   */
  async deleteStale(tenantId: TenantId, syncRunId: string): Promise<number> {
    const scope = forTenant(this.db, tenantId);
    try {
      const deleted = await scope.db
        .delete(mediaAssets)
        .where(
          scope.where(
            mediaAssets,
            and(eq(mediaAssets.origin, "drive"), ne(mediaAssets.lastSyncRunId, syncRunId)),
          ),
        )
        .returning({ id: mediaAssets.id });
      return deleted.length;
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "syncRunId",
        operation: "media.deleteStale",
        sync_run_id: syncRunId,
      });
    }
  }

  /**
   * Counts exactly what `deleteStale` above may remove — Drive rows only. The
   * sync compares it with the number of files the listing returned, so the two
   * numbers must describe the same set or the comparison means nothing.
   */
  async countDriveAssets(tenantId: TenantId): Promise<number> {
    const scope = forTenant(this.db, tenantId);
    try {
      const rows = await scope.db
        .select({ count: sql<number>`count(*)` })
        .from(mediaAssets)
        .where(scope.where(mediaAssets, eq(mediaAssets.origin, "drive")));
      const raw = rows[0]?.count;
      const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "tenantId",
        operation: "media.countDriveAssets",
      });
    }
  }

  // --- E9 (mode B) ---------------------------------------------------------

  async registerUpload(tenantId: TenantId, asset: MediaAsset): Promise<void> {
    const scope = forTenant(this.db, tenantId);

    if (asset.origin !== "upload" || !asset.storageKey) {
      // A programming error, not a data error: writing this row without a key
      // would create an asset whose bytes can never be found.
      throw new AppError("INVALID_INPUT", {
        message: "registerUpload requires an asset with origin 'upload' and a storage key",
        context: {
          tenant_id: scope.tenantId,
          drive_file_id: asset?.driveFileId ?? null,
          origin: asset?.origin ?? null,
          operation: "media.registerUpload",
        },
      });
    }

    try {
      await scope.db.insert(mediaAssets).values(
        scope.row({
          driveFileId: asset.driveFileId,
          fileName: asset.fileName,
          productCode: asset.productCode,
          color: asset.color,
          colorRaw: asset.colorRaw,
          sequence: asset.sequence,
          kind: asset.kind,
          aiGenerated: asset.variants.aiGenerated,
          realPhoto: asset.variants.realPhoto,
          backView: asset.variants.backView,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          modifiedTime: toModifiedDate(asset.modifiedTime),
          warnings: [...asset.warnings],
          needsReview: asset.needsReview,
          origin: "upload" as const,
          storageKey: asset.storageKey,
          // No sync run: see the note on deleteStale.
          lastSyncRunId: null,
        }),
      );
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "driveFileId",
        operation: "media.registerUpload",
        drive_file_id: asset.driveFileId,
      });
    }
  }

  /**
   * "Orphan" means no post job carries the asset in its media array. The check
   * is a jsonb containment probe rather than a join: post_job.media is the only
   * place an asset id is referenced, and it is a document, not a foreign key.
   *
   * Not tenant-scoped, like `findStalePublishing`: a maintenance sweep runs as
   * nobody. Each row carries its tenant so the delete can scope itself again.
   *
   * PERF: the containment probe cannot use an index on post_job.media until a
   * GIN index exists there. Acceptable while this runs once an hour over rows
   * older than a day; revisit if post_job grows large.
   */
  async listOrphanedUploads(input: {
    olderThan: Date;
    limit: number;
  }): Promise<readonly OrphanedUpload[]> {
    const limit = input?.limit;
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100;

    try {
      const rows = await this.db
        .select({
          tenantId: mediaAssets.tenantId,
          assetId: mediaAssets.driveFileId,
          storageKey: mediaAssets.storageKey,
          fileName: mediaAssets.fileName,
          sizeBytes: mediaAssets.sizeBytes,
        })
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.origin, "upload"),
            lt(mediaAssets.createdAt, input.olderThan),
            sql`NOT EXISTS (
              SELECT 1 FROM post_job pj
              WHERE pj.tenant_id = ${mediaAssets.tenantId}
                AND pj.media @> jsonb_build_array(
                      jsonb_build_object('driveFileId', ${mediaAssets.driveFileId}::text))
            )`,
          ),
        )
        .orderBy(asc(mediaAssets.createdAt))
        .limit(safeLimit);

      // A row with no storage key has no bytes to remove; the usecase still
      // deletes the row, so keep it in the list rather than hiding it.
      return rows.map((row) => ({
        tenantId: row.tenantId,
        assetId: row.assetId,
        storageKey: row.storageKey ?? "",
        fileName: row.fileName,
        sizeBytes: row.sizeBytes,
      }));
    } catch (error) {
      throw wrapDbError(error, {
        field: "olderThan",
        operation: "media.listOrphanedUploads",
      });
    }
  }

  async listUnreferencedUploadsForCode(
    tenantId: TenantId,
    productCode: string,
  ): Promise<readonly OrphanedUpload[]> {
    const scope = forTenant(this.db, tenantId);
    const code = typeof productCode === "string" ? productCode.trim().toUpperCase() : "";
    if (code.length === 0) return [];

    try {
      const rows = await scope.db
        .select({
          tenantId: mediaAssets.tenantId,
          assetId: mediaAssets.driveFileId,
          storageKey: mediaAssets.storageKey,
          fileName: mediaAssets.fileName,
          sizeBytes: mediaAssets.sizeBytes,
        })
        .from(mediaAssets)
        .where(
          scope.where(
            mediaAssets,
            and(
              eq(mediaAssets.origin, "upload"),
              eq(mediaAssets.productCode, code),
              // Same "nobody posted it" predicate as the sweep.
              sql`NOT EXISTS (
                SELECT 1 FROM post_job pj
                WHERE pj.tenant_id = ${mediaAssets.tenantId}
                  AND pj.media @> jsonb_build_array(
                        jsonb_build_object('driveFileId', ${mediaAssets.driveFileId}::text))
              )`,
            ),
          ),
        );

      return rows.map((row) => ({
        tenantId: row.tenantId,
        assetId: row.assetId,
        storageKey: row.storageKey ?? "",
        fileName: row.fileName,
        sizeBytes: row.sizeBytes,
      }));
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "productCode",
        operation: "media.listUnreferencedUploadsForCode",
        product_code: code,
      });
    }
  }

  async deleteUploads(tenantId: TenantId, assetIds: readonly string[]): Promise<number> {
    const scope = forTenant(this.db, tenantId);
    const ids = [...new Set(assetIds ?? [])].filter(
      (id) => typeof id === "string" && id.length > 0,
    );
    if (ids.length === 0) return 0;

    try {
      const deleted = await scope.db
        .delete(mediaAssets)
        .where(
          scope.where(
            mediaAssets,
            // Scoped to uploads so a bad id list can never remove a synced row.
            and(eq(mediaAssets.origin, "upload"), inArray(mediaAssets.driveFileId, ids)),
          ),
        )
        .returning({ id: mediaAssets.id });
      return deleted.length;
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "assetIds",
        operation: "media.deleteUploads",
        count: ids.length,
      });
    }
  }
}
