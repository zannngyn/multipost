import type { AccountStatus } from "@/core/domain/account";

/**
 * Password credentials (`credential` table) + the ONE write that creates a
 * person from a sign-up form. Types only (docs/07 §2).
 *
 * Contract for every implementer:
 * - `email` is THE identity key here: compared case-insensitively, stored
 *   lower-cased and trimmed, unique across the table. Callers may hand over
 *   whatever the form carried;
 * - `findByEmail` joins credential → account → identity in one round trip,
 *   because every one of those three columns takes part in the sign-in decision
 *   (hash, lock, `account.status`, and the session address the JWT will carry);
 * - `register` creates account + identity(provider='password') + credential + the
 *   audit row in ONE transaction. A half-created person — an account nobody can
 *   log into, or a credential pointing at nothing — is not a state this app has
 *   a repair path for. It throws `AUTH_EMAIL_TAKEN` on the unique collision, so
 *   the check-then-insert race cannot produce two accounts for one address;
 * - the resulting rows are DELIBERATELY identical in shape to what
 *   `AccountRepo.provisionAccount` writes for a first OAuth sign-in (active
 *   account, one identity, zero memberships): a password account then walks the
 *   same NoMembership path (docs/09 §3.8) as everybody else;
 * - driver failures surface as AppError (DB_ERROR / INVALID_INPUT).
 */

export interface PasswordCredentialRecord {
  readonly credentialId: string;
  readonly accountId: string;
  /** Normalised — what the unique index holds. */
  readonly email: string;
  readonly passwordHash: string;
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
  /** From `account.status`: a platform ban must refuse the password door too. */
  readonly accountStatus: AccountStatus;
  /** From `identity.session_email` — the address the JWT session will carry. */
  readonly sessionEmail: string;
  readonly displayName: string | null;
}

export interface RegisterCredentialRecord {
  /** Already normalised by the usecase; the repo lower-cases again defensively. */
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string | null;
}

export interface RegisteredCredential {
  readonly accountId: string;
  readonly credentialId: string;
  readonly sessionEmail: string;
  readonly displayName: string | null;
}

export interface RecordFailedAttemptInput {
  readonly credentialId: string;
  readonly failedAttempts: number;
  /** Null clears a stale lock; a Date sets one. Never left untouched. */
  readonly lockedUntil: Date | null;
}

export interface ReplacePasswordHashInput {
  readonly targetAccountId: string;
  readonly passwordHash: string;
  /** Who ordered the reset — goes on the audit row, never null here. */
  readonly actorAccountId: string;
}

export interface CredentialRepo {
  /** Null when nobody signs in with a password under that address. */
  findByEmail(email: string): Promise<PasswordCredentialRecord | null>;

  register(input: RegisterCredentialRecord): Promise<RegisteredCredential>;

  /** Persists the counter + lock decided by `nextLockoutState`. */
  recordFailedAttempt(input: RecordFailedAttemptInput): Promise<void>;

  /**
   * Successful sign-in: counter back to 0, lock cleared. Idempotent, and a
   * no-op when the row is already clean (the common case — no write amplified
   * onto every login).
   */
  clearFailedAttempts(credentialId: string): Promise<void>;

  /**
   * Admin reset: new hash, counter cleared, lock lifted, audit row — one
   * transaction. Returns FALSE when the target account has no credential row
   * (an OAuth-only person): the caller turns that into
   * `AUTH_CREDENTIAL_NOT_FOUND` rather than silently minting a password login
   * for an identity that never had one.
   */
  replacePasswordHash(input: ReplacePasswordHashInput): Promise<boolean>;
}
