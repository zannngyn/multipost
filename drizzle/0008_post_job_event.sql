CREATE TABLE "post_job_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"post_job_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_job_event" ADD CONSTRAINT "post_job_event_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_job_event" ADD CONSTRAINT "post_job_event_post_job_id_post_job_id_fk" FOREIGN KEY ("post_job_id") REFERENCES "public"."post_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_job_event_tenant_job_idx" ON "post_job_event" USING btree ("tenant_id","post_job_id","occurred_at");--> statement-breakpoint
CREATE INDEX "post_job_event_tenant_batch_idx" ON "post_job_event" USING btree ("tenant_id","batch_id","occurred_at");