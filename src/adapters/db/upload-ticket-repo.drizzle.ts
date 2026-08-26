import { inArray, lt } from "drizzle-orm";

import type { TenantId } from "@/core/domain/tenant-context";
import type { UploadTicket, UploadTicketRepo } from "@/core/ports/upload-ticket-repo";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { uploadTickets, type UploadTicketRow } from "./schema";
import { forTenant } from "./tenant-scope";

function toTicket(row: UploadTicketRow): UploadTicket {
  return {
    tenantId: row.tenantId,
    assetId: row.assetId,
    storageKey: row.storageKey,
    fileName: row.fileName,
    declaredMime: row.declaredMime,
    declaredSize: Number(row.declaredSize),
    productCode: row.productCode,
    expiresAt: row.expiresAt,
    createdBy: row.createdBy,
  };
}

/**
 * `upload_ticket` persistence — see the schema comment for why this is its own
 * table rather than a state on `media_asset`.
 *
 * Every method except `listExpired` goes through `forTenant()` so the tenant
 * filter cannot be forgotten (CLAUDE.md rule 7); `listExpired` is the single
 * documented cross-tenant read, feeding the expiry sweep.
 */
export class DrizzleUploadTicketRepo implements UploadTicketRepo {
  constructor(private readonly db: Database) {}

  async createMany(tenantId: TenantId, tickets: readonly UploadTicket[]): Promise<number> {
    // Edge case first: nothing to insert must not touch the DB.
    if (tickets.length === 0) return 0;
    const scope = forTenant(this.db, tenantId);

    try {
      const rows = tickets.map((ticket) =>
        scope.row({
          assetId: ticket.assetId,
          storageKey: ticket.storageKey,
          fileName: ticket.fileName,
          declaredMime: ticket.declaredMime,
          declaredSize: ticket.declaredSize,
          productCode: ticket.productCode,
          createdBy: ticket.createdBy ?? null,
          expiresAt: ticket.expiresAt,
        }),
      );
      await scope.db.insert(uploadTickets).values(rows);
      return rows.length;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "uploadTicket.createMany",
        tenant_id: scope.tenantId,
        reason: "TICKET_INSERT_FAILED",
      });
    }
  }

  async findMany(tenantId: TenantId, assetIds: readonly string[]): Promise<readonly UploadTicket[]> {
    // Edge case first: an empty id list must short-circuit without a query.
    if (assetIds.length === 0) return [];
    const scope = forTenant(this.db, tenantId);

    try {
      const rows = await scope.db
        .select()
        .from(uploadTickets)
        .where(scope.where(uploadTickets, inArray(uploadTickets.assetId, [...assetIds])));
      return rows.map(toTicket);
    } catch (error) {
      throw wrapDbError(error, {
        operation: "uploadTicket.findMany",
        tenant_id: scope.tenantId,
        reason: "TICKET_SELECT_FAILED",
      });
    }
  }

  async deleteMany(tenantId: TenantId, assetIds: readonly string[]): Promise<number> {
    if (assetIds.length === 0) return 0;
    const scope = forTenant(this.db, tenantId);

    try {
      const removed = await scope.db
        .delete(uploadTickets)
        .where(scope.where(uploadTickets, inArray(uploadTickets.assetId, [...assetIds])))
        .returning({ assetId: uploadTickets.assetId });
      return removed.length;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "uploadTicket.deleteMany",
        tenant_id: scope.tenantId,
        reason: "TICKET_DELETE_FAILED",
      });
    }
  }

  async listExpired(input: { now: Date; limit: number }): Promise<readonly UploadTicket[]> {
    // Cross-tenant by design (port doc): the sweep must see every tenant's
    // expired tickets, so this is the one method that does NOT go through
    // forTenant().
    try {
      const rows = await this.db
        .select()
        .from(uploadTickets)
        .where(lt(uploadTickets.expiresAt, input.now))
        .limit(input.limit);
      return rows.map(toTicket);
    } catch (error) {
      throw wrapDbError(error, {
        operation: "uploadTicket.listExpired",
        reason: "TICKET_EXPIRED_SELECT_FAILED",
      });
    }
  }
}
