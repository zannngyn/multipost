import { AppError } from "@/core/domain/errors";
import { isTenantId } from "@/core/domain/tenant";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * TEST-ONLY `TenantId` constructor (docs/11 §3 — the codemod of M1.3a rewrites
 * every fixture tenant string to this call). Importing it from production code
 * is a review FAIL; the M1.3a ESLint rule will also machine-enforce that this
 * module is only reachable from `*.test.ts` and `__fixtures__`.
 *
 * It still validates the shape: a test that runs with `testTenantId("nope")`
 * would otherwise pass the compiler and then die inside Postgres with a cast
 * error that looks like an infrastructure failure.
 */
export function testTenantId(value: string): TenantId {
  if (!isTenantId(value)) {
    throw new AppError("INVALID_INPUT", {
      message: "testTenantId requires a UUID-shaped string",
      context: { tenant_id: value },
    });
  }
  // Blessed cast site (see tenant-context.ts header).
  return value as TenantId;
}
