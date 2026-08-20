import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Support-mode session persistence (M3.3, docs/09 §3.5). Types only.
 *
 * Contract for every implementer:
 * - `open` is ONE transaction: revoke the account's live sessions (audit
 *   `platform.exited_tenant` for each — one visit at a time, never nested),
 *   insert the new row, audit `platform.entered_tenant` UNDER THE TARGET
 *   TENANT (the customer's book must show who came in, with the purpose);
 * - an unknown or suspended tenant answers TENANT_NOT_FOUND — support enters
 *   living companies only;
 * - `findLive` is a FRESH read (the session row IS the authorisation, tier S):
 *   expired, revoked, wrong account or suspended tenant all answer null;
 * - `close` is idempotent and audits `platform.exited_tenant` exactly once;
 * - nothing anywhere updates `expires_at` — more time is a NEW session.
 */

export interface OpenSupportSessionRecord {
  readonly accountId: string;
  readonly tenantId: TenantId;
  readonly purpose: string;
  readonly expiresAt: Date;
  readonly now: Date;
  readonly actorEmail: string | null;
}

export interface OpenedSupportSession {
  readonly sessionId: string;
  readonly tenant: { readonly id: TenantId; readonly name: string; readonly slug: string | null };
  readonly expiresAt: Date;
}

export interface LiveSupportSession {
  readonly sessionId: string;
  readonly tenantId: TenantId;
  readonly tenantName: string;
  readonly tenantSlug: string | null;
  readonly expiresAt: Date;
}

export interface CloseSupportSessionRecord {
  readonly sessionId: string;
  readonly accountId: string;
  readonly now: Date;
  readonly actorEmail: string | null;
}

export interface SupportSessionRepo {
  open(input: OpenSupportSessionRecord): Promise<OpenedSupportSession>;
  /** Null = no live session behind that id for that account. Fresh, always. */
  findLive(sessionId: string, accountId: string, now: Date): Promise<LiveSupportSession | null>;
  close(input: CloseSupportSessionRecord): Promise<"closed" | "already_closed" | "not_found">;
}
