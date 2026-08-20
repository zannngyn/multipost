import type { TenantId } from "@/core/domain/tenant-context";

/**
 * TEST-ONLY `TenantId` constructor (docs/11 §3 — the M1.3a codemod rewrites
 * every fixture tenant string to this call). Importing it from production code
 * is a review FAIL; the M1.3a ESLint rule also machine-enforces that this module
 * is only reachable from `*.test.ts` and `__fixtures__`.
 *
 * It deliberately does NOT validate: many unit tests brand a non-UUID string
 * ("t1", "nope", "not-a-uuid") on purpose, precisely so the code under test —
 * `forTenant()`, a route validator — is the thing that rejects it. Validating
 * here would move the throw out of `expect().rejects` into fixture setup and
 * change what those tests observe. The brand is a compile-time marker only.
 */
export function testTenantId(value: string): TenantId {
  // Blessed cast site (see tenant-context.ts header).
  return value as TenantId;
}
