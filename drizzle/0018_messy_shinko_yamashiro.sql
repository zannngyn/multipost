CREATE TYPE "public"."product_origin" AS ENUM('sheet', 'manual');--> statement-breakpoint
ALTER TABLE "product" ALTER COLUMN "last_sync_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "origin" "product_origin" DEFAULT 'sheet' NOT NULL;--> statement-breakpoint
ALTER TABLE "post_job" ADD COLUMN "product_origin" "product_origin" DEFAULT 'sheet' NOT NULL;--> statement-breakpoint
CREATE INDEX "product_tenant_origin_idx" ON "product" USING btree ("tenant_id","origin");