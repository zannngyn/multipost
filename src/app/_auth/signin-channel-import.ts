import type { TenantId } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

/**
 * E5.2 / M1.4 — the Page tokens are harvested from the very token that just
 * signed the operator in, so connecting channels needs no second trip to
 * Facebook.
 *
 * WHICH tenant receives them is no longer a constant: until M1.4 this pinned
 * `DEMO_TENANT_ID`, which after multi-tenant landed meant "whoever signs in
 * with Facebook writes Page credentials into the demo tenant" — a B-8-shaped
 * cross-tenant write. Now the target comes from the person's OWN membership:
 *
 *   - exactly ONE active membership, and `requireTenant` (fresh, tier S,
 *     minRole admin — importing credentials is admin work, doc 10 §4.2)
 *     approves it → import into THAT tenant;
 *   - zero or several memberships → SKIP, logged: guessing a tenant is how a
 *     credential lands in the wrong company. The operator can always import
 *     deliberately from /channels, where the active tenant is explicit;
 *   - role below admin → SKIP, logged: sign-in must not smuggle in a write the
 *     person could not perform through the front door.
 *
 * Runs as an EVENT, not inside the `signIn` callback: a failure here must not
 * keep the operator out of the tool. Losing the channel import is bad; losing
 * the way in is worse. Every failure is logged with its error code instead.
 */

/** Structural mirrors — the app layer may not import core/usecases (docs/07 §2). */
export interface SignInImportDeps {
  resolveAccount(sessionEmail: string): Promise<{
    accountId: string;
    activeMemberships: readonly { tenantId: string }[];
  } | null>;
  requireTenant(
    session: { accountId: string | null; email: string },
    selector: string,
    options: { tier: "S"; minRole: "admin" },
  ): Promise<{ tenantId: TenantId }>;
  importChannels(input: {
    tenantId: TenantId;
    userAccessToken: string;
    actorEmail: string | null;
  }): Promise<{ imported: number; updated: number; skipped: number }>;
  logger: {
    child(bindings: Record<string, unknown>): SignInImportDeps["logger"];
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown> & { err?: unknown }): void;
  };
}

export async function importChannelsFromSignIn(
  deps: SignInImportDeps,
  input: {
    readonly userAccessToken: string;
    /** The synthetic session address (`fb-<id>@facebook.local`). */
    readonly sessionEmail: string;
    readonly facebookUserId: string | null;
  },
): Promise<void> {
  const log = deps.logger.child({
    provider: "facebook",
    step: "import_on_signin",
    facebook_user_id: input.facebookUserId,
  });

  try {
    // --- Edge cases first: who is this, and which company is unambiguous? ---
    const account = await deps.resolveAccount(input.sessionEmail);
    if (!account || account.activeMemberships.length === 0) {
      // Normal for a bootstrap Facebook admin with no account row yet, and for
      // anyone mid-approval: nothing to import INTO, not an error.
      log.info("Sign-in import skipped: no membership to target", {
        reason: "NO_MEMBERSHIP",
        has_account: account !== null,
      });
      return;
    }
    if (account.activeMemberships.length > 1) {
      log.info("Sign-in import skipped: several companies, refusing to guess", {
        reason: "AMBIGUOUS_TENANT",
        membership_count: account.activeMemberships.length,
      });
      return;
    }

    // Fresh admin check against the ONE candidate — importing credentials is
    // admin work, and the sign-in path gets no exemption from that.
    const ctx = await deps.requireTenant(
      { accountId: account.accountId, email: input.sessionEmail },
      account.activeMemberships[0].tenantId,
      { tier: "S", minRole: "admin" },
    );

    const result = await deps.importChannels({
      tenantId: ctx.tenantId,
      userAccessToken: input.userAccessToken,
      // No e-mail on purpose: Facebook may not return one, and matching an
      // operator by e-mail across providers is the account-linking hijack.
      actorEmail: null,
    });
    log.info("Imported Facebook Pages from the sign-in token", {
      tenant_id: ctx.tenantId,
      imported: result.imported,
      updated: result.updated,
      // Loud on purpose: a Page listed without a token is a Page the operator
      // will look for and not find.
      skipped: result.skipped,
    });
  } catch (error) {
    const appError = AppError.from(error, "INTERNAL");
    if (appError.code === "FORBIDDEN" || appError.code === "TENANT_NOT_FOUND") {
      // Not admin (or membership vanished mid-flight): the import is refused,
      // the sign-in stands, and /channels remains the deliberate door.
      log.warn("Sign-in import skipped: not an admin of the target tenant", {
        reason: "ROLE_BELOW_ADMIN",
        error_code: appError.code,
      });
      return;
    }
    log.error("Could not import Pages from the sign-in token — sign-in still allowed", {
      error_code: appError.code,
      alert: "OPERATOR_ATTENTION",
      err: appError,
    });
  }
}
