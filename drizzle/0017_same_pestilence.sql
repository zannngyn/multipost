-- 0017 — password sign-in: `access_provider` gains 'password', plus the
-- `credential` table (hash + lock-out) that hangs off `account`.
--
-- HAND-CHECKED, and this is the part a generator cannot know:
-- `ALTER TYPE ... ADD VALUE` is legal inside a transaction on PostgreSQL 12+,
-- but the NEW VALUE MAY NOT BE USED in that same transaction. Drizzle runs
-- EVERY pending migration inside ONE transaction (pg-core dialect.migrate:
-- `session.transaction(...)` wraps the whole loop), so splitting this into two
-- FILES would not help — they would still share it.
--
-- This migration is safe because nothing here writes the value: `credential`
-- has no enum column, and the first row with provider='password' is inserted at
-- runtime, long after the commit.
--
-- RULE FOR WHOEVER WRITES THE NEXT ONE: never add an enum value and INSERT/
-- UPDATE/CAST with it in the same `db:migrate` run. Ship the ADD VALUE, let it
-- commit, then use it in a later run.
ALTER TYPE "public"."access_provider" ADD VALUE 'password';--> statement-breakpoint
CREATE TABLE "credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_email_uq" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_account_idx" ON "credential" USING btree ("account_id");