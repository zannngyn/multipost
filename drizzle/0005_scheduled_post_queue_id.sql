ALTER TABLE "post_job" ADD COLUMN "queue_job_id" text;--> statement-breakpoint
CREATE INDEX "post_job_tenant_scheduled_idx" ON "post_job" USING btree ("tenant_id","status","scheduled_at");