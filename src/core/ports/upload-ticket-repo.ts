import type { TenantId } from "@/core/domain/tenant-context";

/** A file that has been handed a pre-signed upload URL, not yet through the type-vetting gate. */
export interface UploadTicket {
  readonly tenantId: TenantId;
  readonly assetId: string;
  readonly storageKey: string;
  readonly fileName: string;
  readonly declaredMime: string;
  readonly declaredSize: number;
  readonly productCode: string;
  readonly expiresAt: Date;
  readonly createdBy?: string | null;
}

export interface UploadTicketRepo {
  createMany(tenantId: TenantId, tickets: readonly UploadTicket[]): Promise<number>;
  /** Only returns tickets of the EXACT tenant given; another tenant's tickets are invisible, not merely filtered. */
  findMany(tenantId: TenantId, assetIds: readonly string[]): Promise<readonly UploadTicket[]>;
  deleteMany(tenantId: TenantId, assetIds: readonly string[]): Promise<number>;
  /** For the expiry sweep: tickets past their expiry, across every tenant. */
  listExpired(input: { now: Date; limit: number }): Promise<readonly UploadTicket[]>;
}
