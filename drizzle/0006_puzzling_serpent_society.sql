CREATE TYPE "public"."media_origin" AS ENUM('drive', 'upload');--> statement-breakpoint
ALTER TABLE "media_asset" ALTER COLUMN "last_sync_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_asset" ADD COLUMN "origin" "media_origin" DEFAULT 'drive' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_asset" ADD COLUMN "storage_key" text;--> statement-breakpoint
CREATE INDEX "media_asset_tenant_origin_created_idx" ON "media_asset" USING btree ("tenant_id","origin","created_at");