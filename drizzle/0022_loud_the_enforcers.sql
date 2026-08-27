DROP INDEX "upload_ticket_tenant_asset_idx";--> statement-breakpoint
ALTER TABLE "upload_ticket" ADD CONSTRAINT "upload_ticket_tenant_asset_uq" UNIQUE("tenant_id","asset_id");