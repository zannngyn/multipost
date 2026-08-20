import { z } from "zod";

import type { OperatorRole } from "@/shared/operator-access";

/**
 * Branded tenant id — defence layer #2 of B-8 (docs/09 §3.3, docs/11 §3).
 *
 * A `TenantId` can only come out of an AUTHORISATION decision, never out of a
 * request. There is deliberately NO exported constructor here: the compiler
 * refuses a plain string wherever a `TenantId` is demanded, so once ports and
 * usecases take this type (M1.3a), a route physically cannot push a client
 * string into `forTenant()` without going through one of the blessed makers.
 *
 * Blessed constructor sites — each performs the `as TenantId` cast itself, and
 * the M1.3a ESLint rule (`no "as TenantId"` outside this list + tests) is what
 * keeps the list closed:
 *   - `requireTenant()` (composition/require-tenant.ts) — membership-checked;
 *   - `testTenantId()`  (core/domain/tenant-context.testing.ts) — tests only;
 *   - `legacyTenantIdFromRequest()` (composition/legacy-tenant-id.ts) — the
 *     M1.3a transition shim, deleted in M1.3b;
 *   - `systemTenantId()` (M1.3a) and the platform layer (M3.3), when they land.
 */

declare const TENANT_ID_BRAND: unique symbol;

export type TenantId = string & { readonly [TENANT_ID_BRAND]: "TenantId" };

/**
 * The one named way to turn a `TenantId` back into a raw string (docs/11 §2).
 *
 * At a few boundaries the tenant is composed into a plain string that is NOT a
 * SQL predicate — a Redis key, a filesystem path segment, an HMAC payload. Those
 * would accept `String(tenantId)` silently and a wrong brand would still "work",
 * so every such site must unbrand THROUGH this function: the name is what makes
 * those boundaries greppable and reviewable (risk #2, docs/11 §5).
 */
export function unbrandTenantId(tenantId: TenantId): string {
  return tenantId;
}

/**
 * Trim an ALREADY-branded tenant id and keep the brand (docs/11 §1.3).
 *
 * Several usecases and `forTenant()` used to do `input.tenantId.trim()` on an
 * untrusted string; `.trim()` returns a plain `string` and so drops the brand.
 * This does the same trim but preserves `TenantId`. It takes a `TenantId`, not a
 * string, so it can NEVER mint a brand from a raw client value — that stays the
 * job of the blessed constructors (`requireTenant`, `legacyTenantIdFromRequest`,
 * `systemTenantId`). Shape validation stays the caller's `isTenantId` check;
 * this does not throw.
 */
export function normalizeTenantId(tenantId: TenantId): TenantId {
  // Blessed cast site (see header): input is already a TenantId, we only clean it.
  return tenantId.trim() as TenantId;
}

/**
 * A zod field that parses a request/payload tenant string and BRANDS it, for the
 * boundaries that validate with zod rather than isTenantId (worker payloads,
 * prompt-template ops). It is a blessed cast site: only a string that passed the
 * schema leaves it. Callers that already hold a `TenantId` do not need this.
 */
export function tenantIdField(message = "tenantId is required") {
  // Blessed cast site (see header).
  return z
    .string()
    .trim()
    .min(1, message)
    .transform((value) => value as TenantId);
}

/**
 * What a request is allowed to touch, and as whom (docs/09 §3.3). Produced by
 * `requireTenant()` after the membership check; `membershipVersion` is carried
 * so tier-M callers can detect a revoke that happened after the cache filled.
 */
export interface TenantContext {
  readonly tenantId: TenantId;
  readonly role: OperatorRole;
  readonly membershipVersion: number;
}
