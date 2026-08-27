CREATE TABLE "tenant_profile" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"seller_kind" text,
	"current_tools" text[],
	"channel_count" text,
	"focus_channels" text[],
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_profile" ADD CONSTRAINT "tenant_profile_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;