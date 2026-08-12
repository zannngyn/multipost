CREATE TYPE "public"."sync_run_status" AS ENUM('running', 'succeeded', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TABLE "sync_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" "sync_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"source" jsonb NOT NULL,
	"counts" jsonb,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"season" text,
	"stock_raw" text DEFAULT '' NOT NULL,
	"note_raw" text DEFAULT '' NOT NULL,
	"colors_raw" text DEFAULT '' NOT NULL,
	"has_conflict" boolean DEFAULT false NOT NULL,
	"source_rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_sync_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_tenant_code_uq" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "media_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"drive_file_id" text NOT NULL,
	"file_name" text NOT NULL,
	"product_code" text NOT NULL,
	"color" text,
	"color_raw" text,
	"sequence" integer,
	"kind" "media_kind" NOT NULL,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"real_photo" boolean DEFAULT false NOT NULL,
	"back_view" boolean DEFAULT false NOT NULL,
	"mime_type" text,
	"size_bytes" bigint,
	"modified_time" timestamp with time zone,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"last_sync_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_asset_tenant_file_uq" UNIQUE("tenant_id","drive_file_id")
);
--> statement-breakpoint
ALTER TABLE "sync_run" ADD CONSTRAINT "sync_run_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_run_tenant_started_idx" ON "sync_run" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "product_tenant_sync_run_idx" ON "product" USING btree ("tenant_id","last_sync_run_id");--> statement-breakpoint
CREATE INDEX "media_asset_tenant_code_seq_idx" ON "media_asset" USING btree ("tenant_id","product_code","sequence");--> statement-breakpoint
CREATE INDEX "media_asset_tenant_sync_run_idx" ON "media_asset" USING btree ("tenant_id","last_sync_run_id");