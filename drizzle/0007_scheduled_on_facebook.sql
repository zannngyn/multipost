ALTER TYPE "public"."post_job_status" ADD VALUE 'scheduled_on_facebook' BEFORE 'published';--> statement-breakpoint
ALTER TABLE "post_job" ADD COLUMN "scheduled_post_id" text;--> statement-breakpoint
CREATE INDEX "post_job_status_scheduled_idx" ON "post_job" USING btree ("status","scheduled_at");