import { asc, eq, gt, ilike, ne, or, sql, type SQL } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import type { Product } from "@/core/domain/product";
import type {
  CatalogProductPage,
  CatalogReadRepo,
  CatalogSignalGroup,
  ListCatalogProductsQuery,
  ProductRepo,
} from "@/core/ports/product-repo";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { mediaAssets, products, type ProductRow } from "./schema";
import { forTenant, type TenantScopedDb } from "./tenant-scope";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Product persistence (E2). Every statement goes through the tenant scope, and
 * every driver failure becomes AppError('DB_ERROR') with enough context to tell
 * which tenant/operation broke.
 */

/** Postgres caps a statement at 65,535 bind parameters. */
const CHUNK_SIZE = 400;

function toDomain(row: ProductRow): Product {
  return {
    content: {
      code: row.code,
      name: row.name,
      description: row.description,
      category: row.category,
      season: row.season,
    },
    operational: {
      stockRaw: row.stockRaw,
      noteRaw: row.noteRaw,
      colorsRaw: row.colorsRaw,
    },
    hasConflict: row.hasConflict,
    sourceRows: row.sourceRows ?? [],
  };
}

/**
 * LIKE wildcards typed by a human are LITERAL: someone searching for "50%" must
 * not get every product back. Escaped with backslash, which is what Postgres
 * LIKE/ILIKE uses by default.
 */
function likeContains(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Aggregates are bigint in Postgres; some drivers hand them back as strings. */
function toInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * Media tally per product code, as a sub-select joined ONCE — not one count
 * query per row. `filter (where ...)` keeps images and videos in a single scan
 * of the tenant's media, which the (tenant_id, product_code, sequence) index
 * already serves.
 */
function mediaCountsSubquery(scope: TenantScopedDb) {
  return scope.db
    .select({
      productCode: mediaAssets.productCode,
      imageCount: sql<number>`count(*) filter (where ${mediaAssets.kind} = 'image')`.as(
        "image_count",
      ),
      videoCount: sql<number>`count(*) filter (where ${mediaAssets.kind} = 'video')`.as(
        "video_count",
      ),
    })
    .from(mediaAssets)
    .where(scope.where(mediaAssets))
    .groupBy(mediaAssets.productCode)
    .as("media_counts");
}

export class DrizzleProductRepo implements ProductRepo, CatalogReadRepo {
  constructor(private readonly db: Database) {}

  async findByCode(tenantId: TenantId, code: string): Promise<Product | null> {
    const scope = forTenant(this.db, tenantId);
    const normalised = typeof code === "string" ? code.trim().toUpperCase() : "";
    if (normalised.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "findByCode requires a product code",
        userMessage: "Thiếu mã sản phẩm.",
        context: { tenant_id: scope.tenantId },
      });
    }

    let rows: ProductRow[];
    try {
      rows = await scope.db
        .select()
        .from(products)
        .where(scope.where(products, eq(products.code, normalised)))
        .limit(1);
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        product_code: normalised,
        operation: "product.findByCode",
      });
    }

    const row = rows[0];
    return row ? toDomain(row) : null;
  }

  async upsertMany(
    tenantId: TenantId,
    items: readonly Product[],
    syncRunId: string,
  ): Promise<number> {
    const scope = forTenant(this.db, tenantId);
    if (!Array.isArray(items) || items.length === 0) return 0;

    let written = 0;
    for (let start = 0; start < items.length; start += CHUNK_SIZE) {
      const chunk = items.slice(start, start + CHUNK_SIZE).map((product) =>
        scope.row({
          code: product.content.code,
          name: product.content.name,
          description: product.content.description,
          category: product.content.category,
          season: product.content.season,
          stockRaw: product.operational.stockRaw,
          noteRaw: product.operational.noteRaw,
          colorsRaw: product.operational.colorsRaw,
          hasConflict: product.hasConflict,
          sourceRows: [...product.sourceRows],
          lastSyncRunId: syncRunId,
        }),
      );

      try {
        const result = await scope.db
          .insert(products)
          .values(chunk)
          .onConflictDoUpdate({
            target: [products.tenantId, products.code],
            set: {
              name: sql`excluded.name`,
              description: sql`excluded.description`,
              category: sql`excluded.category`,
              season: sql`excluded.season`,
              stockRaw: sql`excluded.stock_raw`,
              noteRaw: sql`excluded.note_raw`,
              colorsRaw: sql`excluded.colors_raw`,
              hasConflict: sql`excluded.has_conflict`,
              sourceRows: sql`excluded.source_rows`,
              lastSyncRunId: sql`excluded.last_sync_run_id`,
              updatedAt: new Date(),
            },
          })
          .returning({ id: products.id });
        written += result.length;
      } catch (error) {
        throw wrapDbError(error, {
          tenant_id: scope.tenantId,
          field: "syncRunId",
          operation: "product.upsertMany",
          chunk_start: start,
          chunk_size: chunk.length,
        });
      }
    }

    return written;
  }

  /**
   * Catalog screen page (CatalogReadRepo). ONE statement: products left-joined
   * to the media tally, keyset-paged on `code`.
   *
   * Reads `limit + 1` rows to tell "there is more" from "that was the last
   * page" without a second COUNT.
   */
  async listCatalog(query: ListCatalogProductsQuery): Promise<CatalogProductPage> {
    const scope = forTenant(this.db, query.tenantId);
    const limit = Number.isInteger(query?.limit) && query.limit > 0 ? query.limit : 50;
    const counts = mediaCountsSubquery(scope);

    const filters: Array<SQL | undefined> = [];
    const search = typeof query?.search === "string" ? query.search.trim() : "";
    if (search.length > 0) {
      const pattern = likeContains(search);
      filters.push(or(ilike(products.code, pattern), ilike(products.name, pattern)));
    }
    const afterCode = typeof query?.afterCode === "string" ? query.afterCode.trim() : "";
    if (afterCode.length > 0) filters.push(gt(products.code, afterCode));

    try {
      const rows = await scope.db
        .select({
          code: products.code,
          name: products.name,
          category: products.category,
          season: products.season,
          stockRaw: products.stockRaw,
          noteRaw: products.noteRaw,
          hasConflict: products.hasConflict,
          imageCount: counts.imageCount,
          videoCount: counts.videoCount,
        })
        .from(products)
        .leftJoin(counts, eq(counts.productCode, products.code))
        .where(scope.where(products, ...filters))
        .orderBy(asc(products.code))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        items: page.map((row) => ({
          code: row.code,
          name: row.name,
          category: row.category,
          season: row.season,
          stockRaw: row.stockRaw,
          noteRaw: row.noteRaw,
          hasConflict: row.hasConflict,
          mediaImageCount: toInt(row.imageCount),
          mediaVideoCount: toInt(row.videoCount),
        })),
        nextAfterCode: hasMore ? (page[page.length - 1]?.code ?? null) : null,
      };
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "filter",
        operation: "product.listCatalog",
        search: search || null,
      });
    }
  }

  /**
   * Counters for the same filter. GROUP BY on the four signals the decision
   * table reads, so Postgres does the counting while the rules stay in core —
   * re-implementing "hết hàng" in SQL is exactly the drift to avoid.
   */
  async aggregateCatalog(query: {
    tenantId: TenantId;
    search?: string;
  }): Promise<readonly CatalogSignalGroup[]> {
    const scope = forTenant(this.db, query.tenantId);
    const counts = mediaCountsSubquery(scope);
    const hasMedia = sql<boolean>`(coalesce(${counts.imageCount}, 0) + coalesce(${counts.videoCount}, 0)) > 0`;

    const filters: Array<SQL | undefined> = [];
    const search = typeof query?.search === "string" ? query.search.trim() : "";
    if (search.length > 0) {
      const pattern = likeContains(search);
      filters.push(or(ilike(products.code, pattern), ilike(products.name, pattern)));
    }

    try {
      const rows = await scope.db
        .select({
          stockRaw: products.stockRaw,
          noteRaw: products.noteRaw,
          hasConflict: products.hasConflict,
          hasMedia: hasMedia,
          count: sql<number>`count(*)`,
        })
        .from(products)
        .leftJoin(counts, eq(counts.productCode, products.code))
        .where(scope.where(products, ...filters))
        .groupBy(products.stockRaw, products.noteRaw, products.hasConflict, hasMedia);

      return rows.map((row) => ({
        stockRaw: row.stockRaw,
        noteRaw: row.noteRaw,
        hasConflict: row.hasConflict === true,
        hasMedia: row.hasMedia === true,
        count: toInt(row.count),
      }));
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "filter",
        operation: "product.aggregateCatalog",
        search: search || null,
      });
    }
  }

  /**
   * Row count of the tenant's catalog. `count(*)`, not a page of ids: the caller
   * only compares it with "how many rows did the sheet parse to".
   */
  async countAll(tenantId: TenantId): Promise<number> {
    const scope = forTenant(this.db, tenantId);
    try {
      const rows = await scope.db
        .select({ count: sql<number>`count(*)` })
        .from(products)
        .where(scope.where(products));
      return toInt(rows[0]?.count);
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "tenantId",
        operation: "product.countAll",
      });
    }
  }

  async deleteStale(tenantId: TenantId, syncRunId: string): Promise<number> {
    const scope = forTenant(this.db, tenantId);
    try {
      const deleted = await scope.db
        .delete(products)
        .where(scope.where(products, ne(products.lastSyncRunId, syncRunId)))
        .returning({ id: products.id });
      return deleted.length;
    } catch (error) {
      throw wrapDbError(error, {
        tenant_id: scope.tenantId,
        field: "syncRunId",
        operation: "product.deleteStale",
        sync_run_id: syncRunId,
      });
    }
  }
}
