import { and, eq } from "drizzle-orm";

import { AppError } from "@/core/domain/errors";
import { POST_DRAFT_KIND_COMPOSE } from "@/core/domain/post-draft";
import type { PostDraftRepo, SavePostDraftRecord, StoredPostDraft } from "@/core/ports/post-draft-repo";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { postDrafts, type PostDraftRow } from "./schema";
import { forTenant } from "./tenant-scope";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * post_draft persistence (E10). Tenant-scoped like every repo here.
 *
 * `save` is an UPSERT on the unique (tenant_id, owner_user_id, kind), not a
 * read-then-write: autosave fires every ~1.5s and two tabs of the same operator
 * would otherwise race into either a duplicate-key error or a lost update. The
 * DB decides, in one statement.
 *
 * `payload` leaves as `unknown` — see StoredPostDraft: the column is jsonb and
 * a row may have been written by an older deployment, so validating it is the
 * usecase's job, not a cast here.
 */

function toDomain(row: PostDraftRow): StoredPostDraft {
  return {
    payload: row.payload,
    // jsonb/int columns are typed by drizzle, but a hand-edited row can still
    // hold a non-integer version; a NaN version must read as "not our version".
    schemaVersion: typeof row.schemaVersion === "number" ? row.schemaVersion : -1,
    updatedAt: row.updatedAt,
  };
}

function missingOwner(tenantId: TenantId, operation: string): AppError {
  return new AppError("INVALID_INPUT", {
    message: `${operation} requires an owner user id`,
    userMessage: "Không xác định được người dùng sở hữu bản nháp.",
    context: { tenant_id: tenantId, operation, reason: "MISSING_OWNER_USER_ID" },
  });
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export class DrizzlePostDraftRepo implements PostDraftRepo {
  constructor(private readonly db: Database) {}

  async load(tenantId: TenantId, ownerUserId: string, kind: string): Promise<StoredPostDraft | null> {
    const scope = forTenant(this.db, tenantId);
    const owner = str(ownerUserId);
    if (owner.length === 0) throw missingOwner(scope.tenantId, "postDraft.load");
    const draftKind = str(kind) || POST_DRAFT_KIND_COMPOSE;

    try {
      const rows = await scope.db
        .select()
        .from(postDrafts)
        .where(
          scope.where(
            postDrafts,
            and(eq(postDrafts.ownerUserId, owner), eq(postDrafts.kind, draftKind)),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? toDomain(row) : null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postDraft.load",
        tenant_id: scope.tenantId,
        owner_user_id: owner,
        draft_kind: draftKind,
        field: "ownerUserId",
      });
    }
  }

  async save(input: SavePostDraftRecord): Promise<StoredPostDraft> {
    const scope = forTenant(this.db, input.tenantId);
    const owner = str(input?.ownerUserId);
    if (owner.length === 0) throw missingOwner(scope.tenantId, "postDraft.save");
    const draftKind = str(input?.kind) || POST_DRAFT_KIND_COMPOSE;

    try {
      const rows = await scope.db
        .insert(postDrafts)
        .values(
          scope.row({
            ownerUserId: owner,
            kind: draftKind,
            schemaVersion: input.schemaVersion,
            payload: input.payload,
          }),
        )
        .onConflictDoUpdate({
          target: [postDrafts.tenantId, postDrafts.ownerUserId, postDrafts.kind],
          set: {
            schemaVersion: input.schemaVersion,
            payload: input.payload,
            // Set explicitly: $onUpdate does not fire on a conflict branch, and
            // `updatedAt` is what the UI shows and what picks the newer copy.
            updatedAt: new Date(),
          },
        })
        .returning();

      const row = rows[0];
      if (!row) {
        throw new AppError("DB_ERROR", {
          message: "Upsert returned no post_draft row",
          context: {
            tenant_id: scope.tenantId,
            owner_user_id: owner,
            draft_kind: draftKind,
            operation: "postDraft.save",
          },
        });
      }
      return toDomain(row);
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postDraft.save",
        tenant_id: scope.tenantId,
        owner_user_id: owner,
        draft_kind: draftKind,
        field: "ownerUserId",
      });
    }
  }

  async discard(tenantId: TenantId, ownerUserId: string, kind: string): Promise<void> {
    const scope = forTenant(this.db, tenantId);
    const owner = str(ownerUserId);
    if (owner.length === 0) throw missingOwner(scope.tenantId, "postDraft.discard");
    const draftKind = str(kind) || POST_DRAFT_KIND_COMPOSE;

    try {
      // No row is a normal outcome (nothing was ever saved) — the port says so.
      await scope.db
        .delete(postDrafts)
        .where(
          scope.where(
            postDrafts,
            and(eq(postDrafts.ownerUserId, owner), eq(postDrafts.kind, draftKind)),
          ),
        );
    } catch (error) {
      throw wrapDbError(error, {
        operation: "postDraft.discard",
        tenant_id: scope.tenantId,
        owner_user_id: owner,
        draft_kind: draftKind,
        field: "ownerUserId",
      });
    }
  }
}
