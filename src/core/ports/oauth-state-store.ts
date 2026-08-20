import type { TenantId } from "@/core/domain/tenant-context";

/**
 * Server-side OAuth state persistence (M1.3b, doc 10 §6). Types only.
 *
 * The port speaks HASHES: the raw nonce lives only in the cookie and in
 * transit. Hashing happens in the composition service, so neither core nor the
 * adapter ever holds a value that could complete someone else's flow.
 *
 * Contract for every implementer:
 * - `issue` binds (tenant, account, purpose) at flow START — the values the
 *   callback will trust, precisely because they cannot come from the browser;
 * - `claim` is SINGLE-USE and ATOMIC: it returns the row only if it is unused
 *   and unexpired, and marks it used in the same statement — two racing
 *   callbacks can never both win;
 * - `purpose` is part of the claim key: a Google nonce must not complete a
 *   Facebook flow.
 */

export type OAuthPurpose = "google_drive" | "facebook_pages";

export interface IssueOAuthStateInput {
  readonly nonceHash: string;
  readonly tenantId: TenantId;
  readonly accountId: string;
  readonly purpose: OAuthPurpose;
  readonly expiresAt: Date;
}

export interface ClaimOAuthStateInput {
  readonly nonceHash: string;
  readonly purpose: OAuthPurpose;
  readonly now: Date;
}

/** What the callback may trust. Plain string tenant id on purpose: the brand
 * comes back only after `requireTenant` re-authorises the CURRENT session
 * against this tenant — the row alone proves binding, not authority. */
export interface ClaimedOAuthState {
  readonly tenantId: string;
  readonly accountId: string;
}

export interface OAuthStateStore {
  issue(input: IssueOAuthStateInput): Promise<void>;
  /** Null: unknown nonce, wrong purpose, already used, or expired — the caller
   * treats all four as the same refusal (no oracle). */
  claim(input: ClaimOAuthStateInput): Promise<ClaimedOAuthState | null>;
}
