import { AppError } from "@/core/domain/errors";
import {
  accountLockedError,
  invalidCredentialsError,
  isLocked,
  nextLockoutState,
  weakPasswordError,
} from "@/core/domain/password-credential";
import type { AccountRepo } from "@/core/ports/account-repo";
import type { CredentialRepo } from "@/core/ports/credential-repo";
import type { Clock, Logger } from "@/core/ports/infra";
import type { PasswordHasher } from "@/core/ports/password-hasher";
import { maskEmail, normaliseDisplayName } from "@/shared/operator-access";
import { CredentialEmailSchema } from "@/shared/password-policy";

/**
 * E-mail + password sign-up / sign-in / admin reset.
 *
 * WHAT THIS USECASE OWNS, and what it deliberately does not:
 *   - it owns the DECISION (is this person who they say, may they in, does the
 *     lock trip) and the ORDER of the checks;
 *   - it does NOT own the session. Auth.js mints the cookie; this returns the
 *     identity it may mint one for, and the sign-in gate (`app/_auth/signin-gate`)
 *     still gets the last word through the account tables — exactly as it does
 *     for Google and Facebook. A password account is not a privileged path.
 *
 * THE ANTI-ENUMERATION RULE, which shapes most of the code below: every sign-in
 * refusal that is not a lock answers `AUTH_INVALID_CREDENTIALS`, and the branch
 * for "no such address" burns the same CPU as a real verify. Otherwise the
 * error code — or just the response time — is a free "does this person have an
 * account here" oracle. The real reason always reaches the log.
 */

export interface RegisterWithPasswordInput {
  readonly email: unknown;
  readonly password: unknown;
  readonly displayName?: unknown;
}

export interface SignInWithPasswordInput {
  readonly email: unknown;
  readonly password: unknown;
}

export interface SetPasswordInput {
  readonly actorAccountId: unknown;
  readonly targetAccountId: unknown;
  readonly newPassword: unknown;
}

/**
 * What Auth.js needs to build a session, and nothing else. No hash, no counter,
 * no lock — this object crosses into the app layer and ends up in a JWT.
 */
export interface PasswordIdentity {
  readonly accountId: string;
  /** The address the JWT carries; for `password` it equals `email`. */
  readonly sessionEmail: string;
  readonly email: string;
  readonly displayName: string | null;
}

export interface PasswordAuthDeps {
  credentials: CredentialRepo;
  /** Only the platform standing is read — `setPassword` is super_admin work. */
  accounts: Pick<AccountRepo, "findPlatformStanding">;
  hasher: PasswordHasher;
  clock: Clock;
  logger: Logger;
}

export interface PasswordAuth {
  register(input: RegisterWithPasswordInput): Promise<PasswordIdentity>;
  signIn(input: SignInWithPasswordInput): Promise<PasswordIdentity>;
  setPassword(input: SetPasswordInput): Promise<void>;
}

/** Address or a typed refusal — one parse, used by all three entry points. */
function parseEmail(value: unknown): { ok: true; email: string } | { ok: false; issue: string } {
  const parsed = CredentialEmailSchema.safeParse(value);
  if (!parsed.success) return { ok: false, issue: parsed.error.issues[0]?.message ?? "invalid" };
  return { ok: true, email: parsed.data };
}

function nonEmptyId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id.length > 0 ? id : null;
}

export function makePasswordAuth(deps: PasswordAuthDeps): PasswordAuth {
  return {
    async register(input) {
      // --- Edge cases first (CLAUDE.md technical rule 1) --------------------
      const email = parseEmail(input?.email);
      if (!email.ok) {
        throw new AppError("INVALID_INPUT", {
          message: `Sign-up e-mail rejected: ${email.issue}`,
          userMessage: "Địa chỉ email không hợp lệ. Vui lòng kiểm tra lại.",
          context: { field: "email", reason: "EMAIL_MALFORMED" },
        });
      }

      /**
       * The password is checked BEFORE anything is written and before the
       * address is looked up: a weak password must cost nothing, and must not
       * be the request that tells someone whether an address is registered.
       */
      const weak = weakPasswordError(input?.password, { field: "password" });
      if (weak) {
        deps.logger.warn("Sign-up refused: password policy", {
          error_code: weak.code,
          provider: "password",
          email: maskEmail(email.email),
          problems: weak.context.problems,
        });
        throw weak;
      }

      const displayName = normaliseDisplayName(input?.displayName);
      const passwordHash = await deps.hasher.hash(input.password as string);

      /**
       * No "does this address exist" query first, on purpose. The check would
       * be a TOCTOU gap (two sign-ups, one address, two accounts) AND a
       * probing oracle. The unique index decides, and the repo turns its
       * violation into AUTH_EMAIL_TAKEN.
       */
      const created = await deps.credentials.register({
        email: email.email,
        passwordHash,
        displayName,
      });

      deps.logger.info("Account registered with a password", {
        provider: "password",
        account_id: created.accountId,
        email: maskEmail(email.email),
      });

      return {
        accountId: created.accountId,
        sessionEmail: created.sessionEmail,
        email: email.email,
        displayName: created.displayName,
      };
    },

    async signIn(input) {
      const now = deps.clock.now();
      const password = typeof input?.password === "string" ? input.password : "";

      // --- Edge cases first -------------------------------------------------
      const email = parseEmail(input?.email);
      if (!email.ok || password.length === 0) {
        /**
         * Malformed input is the SAME refusal as a wrong password. Answering
         * "email không hợp lệ" here would let a probe tell a typo from a miss,
         * and there is nothing the person can do differently either way.
         */
        const error = invalidCredentialsError(
          email.ok ? "EMPTY_PASSWORD" : "EMAIL_MALFORMED",
          { field: email.ok ? "password" : "email" },
        );
        deps.logger.warn("Password sign-in refused", {
          error_code: error.code,
          provider: "password",
          email: maskEmail(input?.email),
          reason: error.context.reason,
        });
        throw error;
      }

      const log = deps.logger.child({ provider: "password", email: maskEmail(email.email) ?? "" });
      const credential = await deps.credentials.findByEmail(email.email);

      if (!credential) {
        /**
         * Burn the same CPU a real verify costs. Without this, "unknown
         * address" answers in ~1ms and "wrong password" in ~100ms, and the
         * difference IS the user list.
         */
        await deps.hasher.burn(password);
        const error = invalidCredentialsError("NO_CREDENTIAL");
        log.warn("Password sign-in refused", { error_code: error.code, reason: "NO_CREDENTIAL" });
        throw error;
      }

      /**
       * The lock is checked BEFORE the hash: while it holds, a correct password
       * must not open the door either — otherwise the lock only slows down the
       * attacker who is still wrong.
       */
      if (isLocked(credential.lockedUntil, now)) {
        const lockedUntil = credential.lockedUntil as Date;
        const error = accountLockedError(lockedUntil, { account_id: credential.accountId });
        log.warn("Password sign-in refused: credential locked", {
          error_code: error.code,
          account_id: credential.accountId,
          failed_attempts: credential.failedAttempts,
          locked_until: lockedUntil.toISOString(),
        });
        throw error;
      }

      const matches = await deps.hasher.verify(password, credential.passwordHash);
      if (!matches) {
        const next = nextLockoutState(credential.failedAttempts, now);
        /**
         * The counter is persisted even though the request is about to fail —
         * this write IS the lock-out. If it throws, the sign-in still fails
         * (the error propagates), it simply fails without counting; that is
         * logged by the repo and is the safe direction.
         */
        await deps.credentials.recordFailedAttempt({
          credentialId: credential.credentialId,
          failedAttempts: next.failedAttempts,
          lockedUntil: next.lockedUntil,
        });

        if (next.lockedUntil) {
          const error = accountLockedError(next.lockedUntil, {
            account_id: credential.accountId,
            failed_attempts: next.failedAttempts,
          });
          log.warn("Password sign-in refused: credential just locked", {
            error_code: error.code,
            account_id: credential.accountId,
            failed_attempts: next.failedAttempts,
            locked_until: next.lockedUntil.toISOString(),
            alert: "OPERATOR_ATTENTION",
          });
          throw error;
        }

        const error = invalidCredentialsError("WRONG_PASSWORD", {
          account_id: credential.accountId,
        });
        log.warn("Password sign-in refused", {
          error_code: error.code,
          account_id: credential.accountId,
          reason: "WRONG_PASSWORD",
          failed_attempts: next.failedAttempts,
        });
        throw error;
      }

      /**
       * Right password, banned person. Same code as a wrong password on
       * purpose: a suspension is a platform decision the person must hear from
       * a human, not a login form that confirms their password still works.
       */
      if (credential.accountStatus !== "active") {
        const error = invalidCredentialsError("ACCOUNT_SUSPENDED", {
          account_id: credential.accountId,
        });
        log.warn("Password sign-in refused: account suspended", {
          error_code: error.code,
          account_id: credential.accountId,
          account_status: credential.accountStatus,
          alert: "OPERATOR_ATTENTION",
        });
        throw error;
      }

      await deps.credentials.clearFailedAttempts(credential.credentialId);
      log.info("Password sign-in accepted", { account_id: credential.accountId });

      return {
        accountId: credential.accountId,
        sessionEmail: credential.sessionEmail,
        email: credential.email,
        displayName: credential.displayName,
      };
    },

    async setPassword(input) {
      // --- Edge cases first -------------------------------------------------
      const actorAccountId = nonEmptyId(input?.actorAccountId);
      const targetAccountId = nonEmptyId(input?.targetAccountId);
      if (!actorAccountId || !targetAccountId) {
        throw new AppError("INVALID_INPUT", {
          message: "setPassword requires actorAccountId and targetAccountId",
          context: { field: actorAccountId ? "targetAccountId" : "actorAccountId" },
        });
      }

      const weak = weakPasswordError(input?.newPassword, { field: "newPassword" });
      if (weak) throw weak;

      /**
       * FRESH platform standing, never a cached session claim (tier S, doc 10
       * §3.5): resetting someone else's password is the strongest write in the
       * app, and a `super_admin` who was suspended a minute ago must not still
       * be able to take an account over.
       */
      const standing = await deps.accounts.findPlatformStanding(actorAccountId);
      if (!standing || standing.status !== "active" || standing.platformRole !== "super_admin") {
        const error = new AppError("FORBIDDEN", {
          message: "Only an active platform super_admin may set another account's password",
          userMessage: "Chỉ quản trị viên hệ thống mới được đặt lại mật khẩu cho tài khoản khác.",
          context: {
            actor_account_id: actorAccountId,
            target_account_id: targetAccountId,
            actor_platform_role: standing?.platformRole ?? null,
            actor_status: standing?.status ?? null,
          },
        });
        deps.logger.warn("Password reset refused: actor is not a platform super_admin", {
          error_code: error.code,
          ...error.context,
          alert: "OPERATOR_ATTENTION",
        });
        throw error;
      }

      const passwordHash = await deps.hasher.hash(input.newPassword as string);
      const replaced = await deps.credentials.replacePasswordHash({
        targetAccountId,
        passwordHash,
        actorAccountId,
      });

      if (!replaced) {
        throw new AppError("AUTH_CREDENTIAL_NOT_FOUND", {
          message: "Target account has no password credential to replace",
          context: { actor_account_id: actorAccountId, target_account_id: targetAccountId },
        });
      }

      deps.logger.info("Password reset by platform super_admin", {
        actor_account_id: actorAccountId,
        target_account_id: targetAccountId,
        // The lock is lifted by the same write — say so, or the next support
        // ticket asks whether the person still has to wait 15 minutes.
        lock_cleared: true,
      });
    },
  };
}
