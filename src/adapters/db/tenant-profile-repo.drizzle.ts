import { z } from "zod";

import { AppError } from "@/core/domain/errors";
import type { TenantId } from "@/core/domain/tenant-context";
import type {
  OnboardingProfile,
  OnboardingProfilePatch,
  TenantProfileRepo,
} from "@/core/ports/tenant-profile";

import type { Database } from "./client";
import { wrapDbError } from "./db-errors";
import { tenantProfiles, type NewTenantProfileRow, type TenantProfileRow } from "./schema";
import { forTenant } from "./tenant-scope";

/**
 * tenant_profile persistence (E10 — the onboarding survey). Tenant-scoped like
 * every repo here; `tenant_id` is also the primary key, so the scope predicate
 * IS the row lookup.
 *
 * `upsert` is one INSERT ... ON CONFLICT, not a read-then-write: each survey
 * step saves as soon as "Tiếp tục" is pressed, and two open tabs would
 * otherwise race into a duplicate key or a lost update.
 *
 * What the `set` object contains is the whole contract (see the port): only the
 * keys the caller actually sent. A patch carrying step 3 must leave steps 1 and
 * 2 exactly as they were, so `undefined` is filtered out here rather than
 * defaulted to null — a spread of the full shape would blank three columns per
 * step and nobody would notice until someone reopened a half-finished flow.
 */

/**
 * A stable code, never a display label. Trimmed and non-empty on purpose: "no
 * answer" is spelled `null`, and a blank string reads back as an answer nobody
 * gave. The VOCABULARY is not checked here — the usecase owns the four constant
 * lists; this is the shape gate only.
 */
const AnswerCodeSchema = z.string().trim().min(1).max(64);

/**
 * `strictObject`: an unknown key is a rejection, not something to drop — a
 * typo'd field name must not look like a successful save. Every field is
 * `.optional().nullable()` because absent and null mean different things.
 */
const ProfilePatchSchema = z.strictObject({
  sellerKind: AnswerCodeSchema.nullable().optional(),
  currentTools: z.array(AnswerCodeSchema).nullable().optional(),
  channelCount: AnswerCodeSchema.nullable().optional(),
  focusChannels: z.array(AnswerCodeSchema).nullable().optional(),
  completedAt: z.date().nullable().optional(),
});

type ProfileWrites = Pick<
  NewTenantProfileRow,
  "sellerKind" | "currentTools" | "channelCount" | "focusChannels" | "completedAt"
>;

function toDomain(row: TenantProfileRow): OnboardingProfile {
  return {
    sellerKind: row.sellerKind ?? null,
    // `[] ?? null` is `[]` — the empty array survives, which is the point:
    // "không chọn gì" must not degrade into "chưa trả lời".
    currentTools: row.currentTools ?? null,
    channelCount: row.channelCount ?? null,
    focusChannels: row.focusChannels ?? null,
    completedAt: row.completedAt ?? null,
  };
}

function invalidPatch(tenantId: TenantId, field: string, cause?: unknown): AppError {
  return new AppError("INVALID_INPUT", {
    message: `tenantProfile.upsert received an invalid patch (${field})`,
    userMessage: "Câu trả lời khảo sát không hợp lệ.",
    context: { tenant_id: tenantId, operation: "tenantProfile.upsert", field },
    cause,
  });
}

/** Only the keys the caller sent, `undefined` dropped. */
function collectWrites(tenantId: TenantId, patch: OnboardingProfilePatch): ProfileWrites {
  if (typeof patch !== "object" || patch === null) throw invalidPatch(tenantId, "patch");

  const parsed = ProfilePatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw invalidPatch(tenantId, String(parsed.error.issues[0]?.path[0] ?? "patch"), parsed.error);
  }

  const writes: ProfileWrites = {};
  if (parsed.data.sellerKind !== undefined) writes.sellerKind = parsed.data.sellerKind;
  if (parsed.data.currentTools !== undefined) writes.currentTools = parsed.data.currentTools;
  if (parsed.data.channelCount !== undefined) writes.channelCount = parsed.data.channelCount;
  if (parsed.data.focusChannels !== undefined) writes.focusChannels = parsed.data.focusChannels;
  if (parsed.data.completedAt !== undefined) writes.completedAt = parsed.data.completedAt;

  // An empty patch writes a row that asserts nothing; it is a caller bug, and a
  // silent no-op here would show up later as "the answer was not saved".
  if (Object.keys(writes).length === 0) throw invalidPatch(tenantId, "patch");
  return writes;
}

export class DrizzleTenantProfileRepo implements TenantProfileRepo {
  constructor(private readonly db: Database) {}

  async get(tenantId: TenantId): Promise<OnboardingProfile | null> {
    const scope = forTenant(this.db, tenantId);

    try {
      const rows = await scope.db
        .select()
        .from(tenantProfiles)
        .where(scope.where(tenantProfiles))
        .limit(1);
      const row = rows[0];
      // No row = the survey was never started. A normal answer, not an error.
      return row ? toDomain(row) : null;
    } catch (error) {
      throw wrapDbError(error, {
        operation: "tenantProfile.get",
        tenant_id: scope.tenantId,
        field: "tenantId",
      });
    }
  }

  async upsert(tenantId: TenantId, patch: OnboardingProfilePatch): Promise<OnboardingProfile> {
    const scope = forTenant(this.db, tenantId);
    const writes = collectWrites(scope.tenantId, patch);

    try {
      const rows = await scope.db
        .insert(tenantProfiles)
        .values(scope.row(writes))
        .onConflictDoUpdate({
          target: tenantProfiles.tenantId,
          // Set explicitly: $onUpdate does not fire on the conflict branch.
          set: { ...writes, updatedAt: new Date() },
        })
        .returning();

      const row = rows[0];
      if (!row) {
        throw new AppError("DB_ERROR", {
          message: "Upsert returned no tenant_profile row",
          context: {
            tenant_id: scope.tenantId,
            operation: "tenantProfile.upsert",
            fields: Object.keys(writes),
          },
        });
      }
      return toDomain(row);
    } catch (error) {
      throw wrapDbError(error, {
        operation: "tenantProfile.upsert",
        tenant_id: scope.tenantId,
        fields: Object.keys(writes),
        field: "tenantId",
      });
    }
  }
}
