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
 * What a request is allowed to touch, and as whom (docs/09 §3.3). Produced by
 * `requireTenant()` after the membership check; `membershipVersion` is carried
 * so tier-M callers can detect a revoke that happened after the cache filled.
 */
export interface TenantContext {
  readonly tenantId: TenantId;
  readonly role: OperatorRole;
  readonly membershipVersion: number;
}
