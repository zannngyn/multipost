CREATE TABLE "upload_ticket" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"declared_mime" text NOT NULL,
	"declared_size" bigint NOT NULL,
	"product_code" text NOT NULL,
	"created_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "upload_ticket" ADD CONSTRAINT "upload_ticket_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "upload_ticket_tenant_asset_idx" ON "upload_ticket" USING btree ("tenant_id","asset_id");--> statement-breakpoint
CREATE INDEX "upload_ticket_expires_idx" ON "upload_ticket" USING btree ("expires_at");