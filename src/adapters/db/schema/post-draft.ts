import { integer, jsonb, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";
import { users } from "./user";

/**
 * Server-side draft of the compose screen (E10) — what the operator typed
 * survives F5, a closed tab, and a different machine.
 *
 * `payload` is JSONB and NOT a set of columns on purpose: it is form state, it
 * changes shape with the wizard, and it is never queried by field. What it may
 * contain is enforced in core (`assertComposeDraftPayload`), which refuses
 * stock/price/note/URL keys — this table must never become a second home for
 * catalog data (business rule 2).
 *
 * `schema_version` is stored next to it so a payload written by an older
 * deployment can be recognised and skipped instead of being fed to a reader
 * that expects other fields.
 *
 * The unique (tenant_id, owner_user_id, kind) is what makes autosave safe: it
 * turns "write every ~1.5s" into an upsert of ONE row per operator instead of
 * an unbounded append, and it settles the race between two tabs of the same
 * person. `owner_user_id` cascades — a deleted operator leaves no orphan draft.
 */
export const postDrafts = pgTable(
  "post_draft",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Which screen the draft belongs to. Only 'compose' exists in Phase 1. */
    kind: text("kind").notNull().default("compose"),
    schemaVersion: integer("schema_version").notNull().default(1),
    payload: jsonb("payload").notNull(),
    ...timestamps,
  },
  // Doubles as the tenant_id index (B-tree leftmost prefix) and as the conflict
  // target of the upsert.
  (table) => [
    unique("post_draft_tenant_owner_kind_uq").on(table.tenantId, table.ownerUserId, table.kind),
  ],
);

export type PostDraftRow = typeof postDrafts.$inferSelect;
export type NewPostDraftRow = typeof postDrafts.$inferInsert;
