ALTER TYPE "public"."post_batch_status" ADD VALUE 'blocked' BEFORE 'failed';--> statement-breakpoint
CREATE TABLE "channel_group" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_group_tenant_name_uq" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "channel_group" ADD CONSTRAINT "channel_group_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;