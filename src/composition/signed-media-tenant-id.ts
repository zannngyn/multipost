import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Tier-P constructor (doc 10 §2): the ONE route outside the membership model.
 *
 * `/api/media/[driveFileId]` serves Meta's fetcher, which arrives with no
 * cookie and no session — its bearer is the HMAC signature, and the tenant id
 * in the query is a CLAIM inside the signed payload, not a client-chosen
 * value in the B-8 sense. The claim is only honoured after two checks that
 * both happen downstream of this cast, inside `getMediaContent`:
 *   1. the signature verifies over `v1\n<tenantId>\n<assetId>\n<expiresAt>`
 *      (a tampered tenant id fails the MAC), and
 *   2. `findByDriveFileId(tenantId, assetId)` is tenant-scoped — a valid MAC
 *      for tenant X can still only reach tenant X's assets.
 *
 * Do not use this anywhere else: any new public `/api` route needs an
 * architecture review first (doc 10 §2), and every session-backed route gets
 * its tenant from `requireTenant()`.
 */
export function signedMediaTenantId(value: unknown): TenantId {
  const tenantId = typeof value === "string" ? value.trim() : "";
  // Blessed cast site (see core/domain/tenant-context.ts) — verified by the
  // HMAC + tenant-scoped lookup in the usecase, not here.
  return tenantId as TenantId;
}
