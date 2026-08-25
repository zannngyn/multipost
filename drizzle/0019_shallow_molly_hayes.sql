CREATE TABLE "platform_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_setting" ADD CONSTRAINT "platform_setting_updated_by_account_id_account_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "public"."account"("id") ON DELETE set null ON UPDATE no action;