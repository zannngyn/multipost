-- E10 BACKFILL — no DDL. Marks every tenant that ALREADY EXISTS when this
-- migration runs as "onboarding survey done", so the first-run survey is only
-- ever shown to tenants created after this release.
--
-- WHY: `FirstRunGate` sends every owner/admin whose tenant has no
-- `completed_at` into a full-screen 4-question survey. Without this backfill
-- that gate would catch tenants that have been using the product for months —
-- a flow named "first run" turned into a toll booth for everyone, which is not
-- what it is (plan task 13, PM decision 26/08/2026).
--
-- WHY DATA AND NOT A RUNTIME CONDITION: telling "new" from "old" at runtime
-- needs either a hardcoded cut-off date or a second flag; both are unreadable
-- six months from now. One migration explains itself.
--
-- HOW TO READ THE STATS THIS PRODUCES: the four answer columns are left NULL on
-- purpose — NULL means "no answer", which is the truth here; nobody was asked.
-- These tenants land in the `noAnswer` bucket of the survey summary
-- (src/core/domain/onboarding-survey-summary.ts), NOT in `answeredNone` (`[]`,
-- an actual answer). `now()` is the transaction timestamp, so every backfilled
-- row shares ONE `completed_at` — a cluster of `noAnswer` rows on a single
-- instant in the report IS this migration, not a wave of operators skipping.
--
-- IDEMPOTENT, and both halves matter:
--   * ON CONFLICT: a tenant that already has a profile row keeps it.
--   * WHERE completed_at IS NULL: a tenant that really finished the survey is
--     never re-stamped, and a second run cannot move the `completed_at` the
--     first run wrote. Answer columns are never in the UPDATE list, so a
--     half-finished profile keeps the answers it has and only stops being
--     pulled back into the gate.
INSERT INTO "tenant_profile" ("tenant_id", "completed_at")
SELECT t."id", now()
FROM "tenant" t
ON CONFLICT ("tenant_id") DO UPDATE
SET "completed_at" = now(),
	"updated_at" = now()
WHERE "tenant_profile"."completed_at" IS NULL;
