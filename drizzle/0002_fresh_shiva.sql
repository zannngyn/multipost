CREATE TYPE "public"."post_batch_status" AS ENUM('pending', 'running', 'completed', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."post_job_status" AS ENUM('draft', 'queued', 'publishing', 'published', 'failed', 'blocked');--> statement-breakpoint
CREATE TABLE "post_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"color" text DEFAULT '' NOT NULL,
	"format" text DEFAULT 'image_post' NOT NULL,
	"status" "post_batch_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"product_code" text NOT NULL,
	"color" text DEFAULT '' NOT NULL,
	"channel_id" text NOT NULL,
	"format" text DEFAULT 'image_post' NOT NULL,
	"status" "post_job_status" DEFAULT 'draft' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"published_post_id" text,
	"published_url" text,
	"published_at" timestamp with time zone,
	"caption_text" text NOT NULL,
	"media" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scheduled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_job_duplicate_uq" UNIQUE("tenant_id","batch_id","product_code","color","channel_id","format")
);
--> statement-breakpoint
ALTER TABLE "post_batch" ADD CONSTRAINT "post_batch_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_batch" ADD CONSTRAINT "post_batch_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_job" ADD CONSTRAINT "post_job_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_job" ADD CONSTRAINT "post_job_batch_id_post_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."post_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_batch_tenant_created_idx" ON "post_batch" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "post_job_tenant_status_idx" ON "post_job" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "post_job_tenant_batch_idx" ON "post_job" USING btree ("tenant_id","batch_id");--> statement-breakpoint
CREATE INDEX "post_job_tenant_channel_published_idx" ON "post_job" USING btree ("tenant_id","channel_id","published_at");