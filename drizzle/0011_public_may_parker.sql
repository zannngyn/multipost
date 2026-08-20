CREATE TYPE "public"."access_provider" AS ENUM('google', 'facebook');--> statement-breakpoint
CREATE TYPE "public"."access_status" AS ENUM('pending', 'approved', 'blocked');--> statement-breakpoint
CREATE TABLE "access_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" "access_provider" NOT NULL,
	"provider_account_id" text NOT NULL,
	"session_email" text NOT NULL,
	"email" text,
	"display_name" text,
	"status" "access_status" DEFAULT 'pending' NOT NULL,
	"role" "user_role",
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"decided_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_request_tenant_identity_uq" UNIQUE("tenant_id","provider","provider_account_id"),
	CONSTRAINT "access_request_tenant_session_email_uq" UNIQUE("tenant_id","session_email")
);
--> statement-breakpoint
ALTER TABLE "access_request" ADD CONSTRAINT "access_request_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_request" ADD CONSTRAINT "access_request_decided_by_user_id_app_user_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_request_tenant_status_idx" ON "access_request" USING btree ("tenant_id","status","requested_at");