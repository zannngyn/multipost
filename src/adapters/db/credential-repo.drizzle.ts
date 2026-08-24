import { and, eq, sql } from "drizzle-orm";

import { isAccountStatus } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import type {
  CredentialRepo,
  PasswordCredentialRecord,
  RecordFailedAttemptInput,
  RegisterCredentialRecord,
  RegisteredCredential,
  ReplacePasswordHashInput,
} from "@/core/ports/credential-repo";
import type { Logger } from "@/core/ports/infra";
import { maskEmail } from "@/shared/operator-access";

import type { Database } from "./client";
import { findPgError, wrapDbError } from "./db-errors";
import { accounts, auditLogs, credentials, identities } from "./schema";

/**
 * `credential` reads + the three writes password sign-in needs.
 *
 * NOT tenant-scoped, for the same structural reason as `account-repo.drizzle`:
 * a credential identifies a PERSON, and the lookup happens before any tenant is
 * known. `forTenant()` cannot apply to a table that sits above the boundary.
 *
 * THE HASH NEVER LEAVES `findByEmail`. No other method selects it, nothing logs
 * it, and every log line in this file carries a MASKED address (technical
 * standard #6 — structured logs, not a personal-data dump).
 */

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A row that fails its enum is corruption — refuse loudly, never coerce. */
function unreadable(field: string, value: unknown): AppError {
  return new AppError("INTERNAL", {
    message: `${field} holds an unknown value`,
    context: { field, value: String(value), reason: "UNREADABLE_CREDENTIAL_ROW" },
  });
}

export class DrizzleCredentialRepo implements CredentialRepo {
  constructor(
    private readonly db: Database,
    private readonly deps: { logger: Logger },
  ) {}

  async findByEmail(email: string): Promise<PasswordCredentialRecord | null> {
    // Guard: an empty address must not run a query matching "whoever has ''".
    const address = str(email).toLowerCase();
    if (address.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "findByEmail requires an address",
        context: { field: "email" },
      });
    }

    try {
      /**
       * ONE round trip across the three tables: the hash (credential), the ban
       * (account.status) and the session address (identity.session_email) all
       * take part in the same decision, and reading them in three queries would
       * let the account be suspended between two of them.
       *
       * The identity join is filtered to `provider='password'` — an account may
       * also hold a Google identity, and the JWT of a PASSWORD sign-in must
       * carry the password identity's address.
       */
      const rows = await this.db
        .select({
          credentialId: credentials.id,
          accountId: credentials.accountId,
          email: credentials.email,
          passwordHash: credentials.passwordHash,
          failedAttempts: credentials.failedAttempts,
          lockedUntil: credentials.lockedUntil,
          accountStatus: accounts.status,
          displayName: accounts.displayName,
          sessionEmail: identities.sessionEmail,
        })
        .from(credentials)
        .innerJoin(accounts, eq(accounts.id, credentials.accountId))
        .innerJoin(
          identities,
          and(eq(identities.accountId, credentials.accountId), eq(identities.provider, "password")),
        )
        .where(eq(sql`lower(${credentials.email})`, address))
        .limit(1);

      const row = rows[0];
      if (!row) return null;
      if (!isAccountStatus(row.accountStatus)) throw unreadable("account.status", row.accountStatus);

      return {
        credentialId: row.credentialId,
        accountId: row.accountId,
        email: row.email,
        passwordHash: row.passwordHash,
        failedAttempts: row.failedAttempts,
        lockedUntil: row.lockedUntil ?? null,
        accountStatus: row.accountStatus,
        sessionEmail: row.sessionEmail,
        displayName: row.displayName ?? null,
      };
    } catch (error) {
      throw wrapDbError(error, { operation: "credential.findByEmail", field: "email" });
    }
  }

  /**
   * Sign-up: account + identity + credential + audit in ONE transaction.
   *
   * The shape it writes is DELIBERATELY the same one
   * `AccountRepo.provisionAccount` writes for a first OAuth sign-in — active
   * account, one identity, zero memberships — so the new person lands in the
   * same NoMembership lobby (docs/09 §3.8) and every screen downstream keeps
   * working without knowing how they signed up. It is not a call to that method
   * because the credential row must be in the SAME transaction: an account
   * nobody can log into, even for one crashed millisecond, has no repair path.
   */
  async register(input: RegisterCredentialRecord): Promise<RegisteredCredential> {
    // --- Edge cases first -----------------------------------------------------
    const email = str(input?.email).toLowerCase();
    const passwordHash = str(input?.passwordHash);
    if (email.length === 0 || passwordHash.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "register requires an e-mail and a password hash",
        context: { field: email.length === 0 ? "email" : "passwordHash" },
      });
    }
    const displayName = str(input?.displayName) || null;

    try {
      const created = await this.db.transaction(async (tx) => {
        const accountRows = await tx
          .insert(accounts)
          .values({ displayName })
          .returning({ id: accounts.id });
        const accountId = accountRows[0].id;

        await tx.insert(identities).values({
          accountId,
          provider: "password",
          // No third party hands out a `sub` here: the address IS the key
          // (shared/operator-access.normaliseIdentityKey).
          providerAccountId: email,
          sessionEmail: email,
          email,
        });

        const credentialRows = await tx
          .insert(credentials)
          .values({ accountId, email, passwordHash })
          .returning({ id: credentials.id });

        /**
         * `tenant_id` NULL: at sign-up the person belongs to no company, and
         * borrowing a tenant id would both file the event under a company that
         * had nothing to do with it and re-arm the FK bomb of M3.1/B1. See the
         * column comment in schema/audit-log.ts.
         */
        await tx.insert(auditLogs).values({
          tenantId: null,
          actorUserId: null,
          actorKind: "user",
          action: "auth.password_registered",
          entityType: "account",
          entityId: accountId,
          // The address is the identity key and already lives in `identity`;
          // the HASH never appears here.
          payload: { provider: "password", session_email: email },
        });

        return { accountId, credentialId: credentialRows[0].id };
      });

      this.deps.logger.info("Password account created", {
        provider: "password",
        account_id: created.accountId,
        email: maskEmail(email),
      });

      return {
        accountId: created.accountId,
        credentialId: created.credentialId,
        sessionEmail: email,
        displayName,
      };
    } catch (error) {
      /**
       * A unique violation here is one of `credential_email_uq` /
       * `identity_session_email_uq` — both mean "this address is already
       * taken". A REFUSAL, not an outage: answering DB_ERROR would tell the
       * person to retry something retrying can never fix.
       *
       * The whole transaction rolled back, so no orphan account survives the
       * collision.
       */
      if (findPgError(error)?.code === "23505") {
        this.deps.logger.warn("Sign-up refused: address already registered", {
          error_code: "AUTH_EMAIL_TAKEN",
          provider: "password",
          email: maskEmail(email),
        });
        throw new AppError("AUTH_EMAIL_TAKEN", {
          message: "An identity already exists for this e-mail address",
          context: { provider: "password", field: "email" },
          cause: error,
        });
      }
      throw wrapDbError(error, {
        operation: "credential.register",
        provider: "password",
        field: "email",
      });
    }
  }

  async recordFailedAttempt(input: RecordFailedAttemptInput): Promise<void> {
    // --- Edge cases first -----------------------------------------------------
    const credentialId = str(input?.credentialId);
    if (credentialId.length === 0 || !Number.isSafeInteger(input?.failedAttempts)) {
      throw new AppError("INVALID_INPUT", {
        message: "recordFailedAttempt requires a credential id and an integer counter",
        context: { field: credentialId.length === 0 ? "credentialId" : "failedAttempts" },
      });
    }

    try {
      await this.db
        .update(credentials)
        .set({ failedAttempts: input.failedAttempts, lockedUntil: input.lockedUntil ?? null })
        .where(eq(credentials.id, credentialId));
    } catch (error) {
      throw wrapDbError(error, {
        operation: "credential.recordFailedAttempt",
        field: "credentialId",
      });
    }
  }

  async clearFailedAttempts(credentialId: string): Promise<void> {
    const id = str(credentialId);
    if (id.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "clearFailedAttempts requires a credential id",
        context: { field: "credentialId" },
      });
    }

    try {
      /**
       * The WHERE keeps the common case a pure read: almost every sign-in has
       * a clean row already, and an unconditional UPDATE would bump
       * `updated_at` (and write a WAL record) on every single login.
       */
      await this.db
        .update(credentials)
        .set({ failedAttempts: 0, lockedUntil: null })
        .where(
          and(
            eq(credentials.id, id),
            sql`(${credentials.failedAttempts} <> 0 OR ${credentials.lockedUntil} IS NOT NULL)`,
          ),
        );
    } catch (error) {
      throw wrapDbError(error, {
        operation: "credential.clearFailedAttempts",
        field: "credentialId",
      });
    }
  }

  async replacePasswordHash(input: ReplacePasswordHashInput): Promise<boolean> {
    // --- Edge cases first -----------------------------------------------------
    const targetAccountId = str(input?.targetAccountId);
    const actorAccountId = str(input?.actorAccountId);
    const passwordHash = str(input?.passwordHash);
    if (targetAccountId.length === 0 || actorAccountId.length === 0 || passwordHash.length === 0) {
      throw new AppError("INVALID_INPUT", {
        message: "replacePasswordHash requires actor, target and a password hash",
        context: {
          field:
            targetAccountId.length === 0
              ? "targetAccountId"
              : actorAccountId.length === 0
                ? "actorAccountId"
                : "passwordHash",
        },
      });
    }

    try {
      return await this.db.transaction(async (tx) => {
        /**
         * The reset also LIFTS the lock: an admin resetting a password for
         * someone locked out has just solved their problem, and leaving them to
         * wait out 15 minutes with a brand-new password is a support ticket.
         */
        const rows = await tx
          .update(credentials)
          .set({ passwordHash, failedAttempts: 0, lockedUntil: null })
          .where(eq(credentials.accountId, targetAccountId))
          .returning({ id: credentials.id });
        // No credential row: an OAuth-only person. The caller turns this into
        // AUTH_CREDENTIAL_NOT_FOUND rather than minting a password login for
        // an identity that never had one.
        if (rows.length === 0) return false;

        await tx.insert(auditLogs).values({
          tenantId: null,
          actorUserId: null,
          actorKind: "user",
          action: "auth.password_reset_by_admin",
          entityType: "account",
          entityId: targetAccountId,
          payload: {
            provider: "password",
            actor_account_id: actorAccountId,
            reason: "PLATFORM_ADMIN_RESET",
            lock_cleared: true,
          },
        });
        return true;
      });
    } catch (error) {
      throw wrapDbError(error, {
        operation: "credential.replacePasswordHash",
        field: "targetAccountId",
      });
    }
  }
}
