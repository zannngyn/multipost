import { uuid } from "drizzle-orm/pg-core";

import type { TenantId } from "@/core/domain/tenant-context";

import { tenants } from "./tenant";

/**
 * The tenant discriminator every business table MUST carry (CLAUDE.md rule 7).
 * NOT NULL + FK so an orphan row cannot exist; reads/writes go through
 * tenant-scope.ts so the WHERE clause can never be forgotten.
 *
 * Lives in its own module (not _columns.ts) to keep the import graph acyclic:
 * tenant.ts -> _columns.ts, and this file -> tenant.ts.
 */
export const tenantIdColumn = () =>
  uuid("tenant_id")
    .$type<TenantId>()
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
