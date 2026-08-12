import { eq, ne, sql } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import type { Product } from "@/core/domain/product";
import type { ProductRepo } from "@/core/ports/product-repo";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { products, type ProductRow } from "./schema";
import { forTenant } from "./tenant-scope";

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

export class DrizzleProductRepo implements ProductRepo {
  constructor(private readonly db: Database) {}

  async findByCode(tenantId: string, code: string): Promise<Product | null> {
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
    tenantId: string,
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

  async deleteStale(tenantId: string, syncRunId: string): Promise<number> {
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
