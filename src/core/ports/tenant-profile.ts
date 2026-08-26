/**
 * Onboarding survey profile (E10 — spec §8). Core declares the need;
 * adapters/db implements it. Pure TypeScript: types only (docs/07 §2).
 *
 * The three-state contract every implementer must preserve — get it wrong and
 * the survey either forgets answers or invents them:
 * - `null` on an answer field is VALID and means "no answer": the operator
 *   pressed "Bỏ qua", or has not reached that step. It is never an empty
 *   string, and an empty string must be rejected, not stored;
 * - `[]` is NOT `null`. `[]` means "answered: none of these", `null` means "not
 *   answered". Two different facts about the tenant, stored differently;
 * - in a patch, an ABSENT key (or `undefined`) means "leave the stored value
 *   alone", while `null` means "clear it". A save of step 3 must not blank the
 *   answers to steps 1 and 2.
 *
 * Values are STABLE CODES (`solo_seller`, `meta_business_suite`), never the
 * Vietnamese labels on screen — rewording a question must not break old rows.
 * The valid vocabulary lives with the usecase, not here.
 *
 * Also required of every implementer:
 * - tenant-scoped through the tenant-scope helper (business rule 7); a
 *   missing/invalid tenant id throws AppError('INVALID_INPUT');
 * - `get` returns null when the tenant has no profile row. That is a normal
 *   answer, not an error;
 * - `upsert` is ONE statement on the (tenant_id) key: per-step autosave and two
 *   open tabs must not race into a duplicate key or a lost update;
 * - driver failures surface as AppError('DB_ERROR') carrying `tenant_id` and
 *   the operation name; a driver error must never escape raw.
 */

import type { TenantId } from "@/core/domain/tenant-context";

export interface OnboardingProfile {
  /** Step 1 — one code, or null for "no answer". */
  readonly sellerKind: string | null;
  /** Step 2 — codes; `[]` = "none of these", `null` = not answered. */
  readonly currentTools: readonly string[] | null;
  /** Step 3 — one bucket code, or null. */
  readonly channelCount: string | null;
  /** Step 4 — codes; `[]` = "none of these", `null` = not answered. */
  readonly focusChannels: readonly string[] | null;
  /** Null while the survey is unfinished; this is what gates re-showing it. */
  readonly completedAt: Date | null;
}

/** Absent/`undefined` = keep what is stored. `null` = clear it. */
export type OnboardingProfilePatch = Partial<OnboardingProfile>;

export interface TenantProfileRepo {
  /** Null when this tenant has never answered anything. */
  get(tenantId: TenantId): Promise<OnboardingProfile | null>;
  /**
   * Writes ONLY the fields present in `patch` and returns the row as stored.
   * An empty patch is a caller bug, not a no-op: it throws INVALID_INPUT.
   */
  upsert(tenantId: TenantId, patch: OnboardingProfilePatch): Promise<OnboardingProfile>;
}
