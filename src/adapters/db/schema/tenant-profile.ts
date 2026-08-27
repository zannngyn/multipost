import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { timestamps } from "./_columns";
import { tenantIdColumn } from "./_tenant-column";

/**
 * Answers to the onboarding survey (E10 — spec §8). ONE row per tenant, so
 * `tenant_id` is the whole primary key: there is no second profile to
 * disambiguate, and a PK is what makes the per-step save an upsert instead of a
 * read-then-write race between two tabs.
 *
 * Every answer column is nullable, and that is the feature, not laxity:
 *   null = the operator pressed "Bỏ qua" (or has not reached the step yet);
 *   []   = the operator answered "none of these";
 *   value = an answer.
 * Three states, three stored values. NEVER write an empty string for "no
 * answer" — it reads back as an answer nobody gave.
 *
 * The stored values are STABLE CODES (`solo_seller`, `meta_business_suite`),
 * never the Vietnamese label shown on screen: rewording a question later must
 * not invalidate rows written before the rewording. The vocabulary itself is
 * NOT constrained here — no enum, no check — because the survey will gain
 * options faster than the table can be migrated; the usecase validates against
 * the constant lists and is the only gate a write passes through.
 *
 * `completed_at` alone decides whether the flow is shown again.
 */
export const tenantProfiles = pgTable("tenant_profile", {
  tenantId: tenantIdColumn().primaryKey(),
  /** Step 1 — one code. */
  sellerKind: text("seller_kind"),
  /** Step 2 — many codes. `text[]` (not jsonb): a flat list of scalars. */
  currentTools: text("current_tools").array(),
  /** Step 3 — one code (a bucket like `4-6`, not a number: buckets never sum). */
  channelCount: text("channel_count"),
  /** Step 4 — many codes. Doubles as a demand vote for channels not built yet. */
  focusChannels: text("focus_channels").array(),
  /** Null while the survey is unfinished. */
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  ...timestamps,
});

export type TenantProfileRow = typeof tenantProfiles.$inferSelect;
export type NewTenantProfileRow = typeof tenantProfiles.$inferInsert;
