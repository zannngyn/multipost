CREATE TYPE "public"."ai_generation_status" AS ENUM('passed', 'validation_failed', 'provider_error');--> statement-breakpoint
CREATE TABLE "ai_generation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"generation_id" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"request_id" text,
	"task" text NOT NULL,
	"tier" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_template_id" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"status" "ai_generation_status" NOT NULL,
	"failure_kind" text,
	"error_code" text,
	"validation_stage_failed" integer,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"escalation_from" integer,
	"input_hash" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"validation_failures" jsonb,
	"output" jsonb,
	"post_job_id" text,
	"batch_id" text,
	"product_code" text,
	"channel_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_prompt_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task" text NOT NULL,
	"platform" text NOT NULL,
	"name" text NOT NULL,
	"system_prompt" text NOT NULL,
	"body" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"changelog" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_prompt_template_version_uq" UNIQUE("tenant_id","task","version")
);
--> statement-breakpoint
CREATE TABLE "ai_model_policy_override" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task" text NOT NULL,
	"override" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_model_policy_override_task_uq" UNIQUE("tenant_id","task")
);
--> statement-breakpoint
ALTER TABLE "ai_generation" ADD CONSTRAINT "ai_generation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_prompt_template" ADD CONSTRAINT "ai_prompt_template_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_model_policy_override" ADD CONSTRAINT "ai_model_policy_override_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_generation_tenant_created_idx" ON "ai_generation" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_generation_tenant_generation_idx" ON "ai_generation" USING btree ("tenant_id","generation_id");--> statement-breakpoint
CREATE INDEX "ai_generation_tenant_job_idx" ON "ai_generation" USING btree ("tenant_id","post_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_prompt_template_active_uq" ON "ai_prompt_template" USING btree ("tenant_id","task","platform") WHERE "ai_prompt_template"."is_active";--> statement-breakpoint
CREATE INDEX "ai_prompt_template_tenant_task_idx" ON "ai_prompt_template" USING btree ("tenant_id","task","platform");