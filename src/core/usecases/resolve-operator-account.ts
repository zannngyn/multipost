import type { PlatformRole } from "@/core/domain/account";
import { AppError } from "@/core/domain/errors";
import type { AccountRepo, OperatorAccountSummary } from "@/core/ports/account-repo";
import type { Logger } from "@/core/ports/infra";
import {
  isOperatorProvider,
  isPlaceholderProviderAccountId,
  normaliseProviderAccountId,
  operatorSessionEmail,
  type OperatorRole,
} from "@/shared/operator-access";
import type { TenantId } from "@/core/domain/tenant-context";

/**
 * M1.2 — the two questions the auth layer asks the ACCOUNT tables (replacing
 * the access-registry as the source of "được vào", docs/09 §3.1/3.3):
 *   1. every request: "which person is behind this session address, and does
 *      that person still hold any active membership?" (`forSession`);
 *   2. sign-in: "is this provider identity a known person?" — and while we hold
 *      the REAL provider sub in hand, PATCH the placeholder the M1.1 backfill
 *      minted (`forSignIn`). That patch is the M1.1 obligation: lookup by
 *      session_email FIRST, update in place, never insert by (provider, sub).
 */

export interface OperatorAccountState {
  readonly accountId: string;
  readonly status: "active" | "suspended";
  readonly platformRole: PlatformRole | null;
  readonly displayName: string | null;
  readonly activeMemberships: readonly { tenantId: TenantId; role: OperatorRole; version: number }[];
}

export type SignInAccountVerdict =
  /** No identity under this address — the legacy pending flow takes over. */
  | { readonly kind: "unknown" }
  /** Platform-level ban: refuse, regardless of what the registry says. */
  | { readonly kind: "suspended" }
  /** Account exists but holds no active membership — pending flow decides. */
  | { readonly kind: "no_membership"; readonly account: OperatorAccountState }
  | { readonly kind: "member"; readonly account: OperatorAccountState };

export interface SignInIdentityInput {
  readonly provider: unknown;
  readonly providerAccountId: unknown;
  readonly email?: unknown;
}

export interface ResolveOperatorAccountDeps {
  accounts: AccountRepo;
  logger: Logger;
}

export interface ResolveOperatorAccount {
  /** Null when nobody signs in under that address. Never throws on bad input. */
  forSession(sessionEmail: string): Promise<OperatorAccountState | null>;
  /** Sign-in path: identify, patch a placeholder sub, classify. Throws on DB failure. */
  forSignIn(input: SignInIdentityInput): Promise<SignInAccountVerdict>;
}

export function makeResolveOperatorAccount(deps: ResolveOperatorAccountDeps): ResolveOperatorAccount {
  return {
    async forSession(sessionEmail) {
      // --- Edge cases first -------------------------------------------------
      const email = typeof sessionEmail === "string" ? sessionEmail.trim().toLowerCase() : "";
      if (email.length === 0 || email.length > 320) return null;

      const summary = await deps.accounts.findAccountBySessionEmail(email);
      return summary ? toState(summary) : null;
    },

    async forSignIn(input) {
      // --- Edge cases first -------------------------------------------------
      if (!isOperatorProvider(input?.provider)) {
        throw new AppError("INVALID_INPUT", {
          message: "Unsupported sign-in provider for account resolution",
          context: { provider: typeof input?.provider === "string" ? input.provider : null },
        });
      }
      const provider = input.provider;
      const providerAccountId = normaliseProviderAccountId(input?.providerAccountId);
      if (!providerAccountId) {
        throw new AppError("INVALID_INPUT", {
          message: "Provider account id is missing or malformed",
          context: { provider, field: "providerAccountId" },
        });
      }
      const sessionEmail = operatorSessionEmail({ provider, providerAccountId, email: input?.email });
      if (!sessionEmail) {
        throw new AppError("INVALID_INPUT", {
          message: "Sign-in carried no usable identity address",
          context: { provider, provider_account_id: providerAccountId, field: "email" },
        });
      }

      const log = deps.logger.child({ provider, session_email: sessionEmail });
      const summary = await deps.accounts.findAccountBySessionEmail(sessionEmail);
      if (!summary) return { kind: "unknown" };

      /**
       * Same address, DIFFERENT provider: for Google that would mean a Facebook
       * synthetic address colliding with a real gmail — structurally impossible
       * by construction, so if it ever shows up something upstream is broken.
       * Fail to "unknown" (the pending flow, which cannot grant anything) and
       * shout; auto-adopting the row would be the account-linking hijack.
       */
      if (summary.identity.provider !== provider) {
        log.error("Identity under this address belongs to ANOTHER provider — refusing to adopt", {
          error_code: "UNAUTHORIZED",
          account_id: summary.accountId,
          stored_provider: summary.identity.provider,
          alert: "OPERATOR_ATTENTION",
        });
        return { kind: "unknown" };
      }

      if (summary.identity.providerAccountId !== providerAccountId) {
        /**
         * A REAL sub that differs is a DIFFERENT PERSON on a recycled address
         * (a workspace deletes alice@corp.com and re-issues it): the sub is
         * the stable identity, the e-mail only an attribute (docs/09 §3.1).
         * Overwriting it would hand the newcomer Alice's account with every
         * membership on it. Refuse the session outright — `unknown` sends
         * them to the pending flow, which can grant nothing by itself.
         */
        if (!isPlaceholderProviderAccountId(summary.identity.providerAccountId)) {
          log.error(
            "Sign-in sub differs from the stored REAL sub — refusing to adopt this account",
            {
              error_code: "UNAUTHORIZED",
              account_id: summary.accountId,
              reason: "PROVIDER_SUB_MISMATCH",
              alert: "OPERATOR_ATTENTION",
            },
          );
          return { kind: "unknown" };
        }

        /**
         * THE M1.1 OBLIGATION. The backfill knew the address but not the sub,
         * so it minted `legacy-app-user:<email>` (or `seed:*`) — the ONLY
         * shapes a sign-in may overwrite. The first real sign-in is the only
         * moment address and sub are both in hand: patch the row IN PLACE (an
         * insert keyed on (provider, sub) would explode on
         * `identity_session_email_uq`).
         */
        const patched = await deps.accounts.attachProviderAccountId({
          provider,
          sessionEmail,
          providerAccountId,
        });
        if (patched) {
          log.info("Patched placeholder provider account id with the real sub", {
            account_id: summary.accountId,
            previous: summary.identity.providerAccountId,
          });
        } else {
          /**
           * The repo refused: the row changed under us, or the real sub already
           * belongs to ANOTHER identity (unique). Either way this session must
           * not be granted on a row we could not claim.
           */
          log.error("Could not patch the placeholder provider account id — refusing the session", {
            error_code: "UNAUTHORIZED",
            account_id: summary.accountId,
            alert: "OPERATOR_ATTENTION",
          });
          return { kind: "unknown" };
        }
      }

      if (summary.status === "suspended") return { kind: "suspended" };
      const account = toState(summary);
      if (summary.activeMemberships.length === 0) return { kind: "no_membership", account };
      return { kind: "member", account };
    },
  };
}

function toState(summary: OperatorAccountSummary): OperatorAccountState {
  return {
    accountId: summary.accountId,
    status: summary.status,
    platformRole: summary.platformRole,
    displayName: summary.displayName,
    activeMemberships: summary.activeMemberships,
  };
}
