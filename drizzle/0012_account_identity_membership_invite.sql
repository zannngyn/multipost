CREATE TYPE "public"."actor_kind" AS ENUM('user', 'system', 'platform_support', 'external');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."platform_role" AS ENUM('support', 'super_admin');--> statement-breakpoint
CREATE TYPE "public"."tenant_plan" AS ENUM('internal', 'standard');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"platform_role" "platform_role",
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" "access_provider" NOT NULL,
	"provider_account_id" text NOT NULL,
	"session_email" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_session_email_uq" UNIQUE("session_email"),
	CONSTRAINT "identity_provider_account_uq" UNIQUE("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"role" "user_role" NOT NULL,
	"status" "membership_status" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"invited_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_tenant_account_uq" UNIQUE("tenant_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"role" "user_role" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"created_by_account_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_token_hash_uq" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "created_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant" ADD COLUMN "plan" "tenant_plan" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_kind" "actor_kind";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "system_component" text;--> statement-breakpoint
ALTER TABLE "ai_generation" ADD COLUMN "actor_kind" "actor_kind";--> statement-breakpoint
ALTER TABLE "ai_generation" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "identity" ADD CONSTRAINT "identity_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_invited_by_account_id_account_id_fk" FOREIGN KEY ("invited_by_account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_account_idx" ON "identity" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "membership_account_status_idx" ON "membership" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "invite_tenant_created_idx" ON "invite" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_generation" ADD CONSTRAINT "ai_generation_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_slug_uq" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_tenant_account_uq" UNIQUE("tenant_id","account_id");