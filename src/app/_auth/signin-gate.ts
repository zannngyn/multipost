import { z } from "zod";

import type { TenantId } from "@/composition/container";
import { AppError } from "@/core/domain/errors";

import { evaluateEnvAllowList, PENDING_APPROVAL_REDIRECT } from "./auth.config";

/**
 * THE sign-in gate (E1.4) — extracted from auth.ts so it can be tested without
 * booting Auth.js, and so the rule below has exactly one home.
 *
 * Order, and why each step exists:
 *   1. env verdict (pure, see auth.config):
 *        reject           -> out; nothing in the database can rescue it;
 *        allow            -> a BOOTSTRAP admin (exact address / exact Facebook
 *                            id): in, with no database call on the critical
 *                            path, so an unreachable database can never close
 *                            the escape hatch;
 *        consult_registry -> everyone else, INCLUDING operators who merely
 *                            matched AUTH_ALLOWED_DOMAINS. That filter says who
 *                            MAY TRY; it grants nothing.
 *   2. the ACCOUNT tables decide "được vào" (M1.2, docs/09 §3.1): an active
 *      account holding an active membership is in — and this same lookup is
 *      where a `legacy-app-user:*` placeholder sub gets patched with the real
 *      one (the M1.1 obligation). A suspended account is out, full stop.
 *   3. everyone else falls through to the legacy PENDING flow (retires at
 *      M2.4): an unknown identity is RECORDED as `pending` and sent back with
 *      `?error=pending_approval`, so an admin has a row to act on instead of
 *      fishing an app-scoped id out of a log line.
 *
 * Returning a string makes Auth.js redirect there WITHOUT setting a session
 * cookie (see @auth/core `handleAuthorized`).
 */

/**
 * The shape a provider must hand back before anything is filed. Nullable, not
 * optional-with-a-default: an absent e-mail is DATA (Facebook accounts
 * registered with a phone number have none), not a value to invent.
 */
const SignInProfileSchema = z.object({
  provider: z.enum(["google", "facebook"]),
  providerAccountId: z.string().trim().min(1).max(128),
  email: z.string().trim().max(320).nullish().catch(null),
  displayName: z.string().trim().max(500).nullish().catch(null),
});

export interface SignInParams {
  readonly provider: unknown;
  readonly providerAccountId: unknown;
  readonly email: unknown;
  readonly emailVerified: unknown;
  readonly displayName: unknown;
}

/** Structural logger type — the app layer must not import ports or adapters. */
export interface SignInGateLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown> & { err?: unknown }): void;
}

export interface RegisterIdentityInput {
  readonly tenantId: TenantId;
  readonly provider: string;
  readonly providerAccountId: string;
  readonly email: string | null;
  readonly displayName: string | null;
}

/**
 * Structural mirror of `SignInAccountVerdict` (core/usecases) — the app layer
 * may not import core/usecases (docs/07 §2), so the shape is restated here and
 * the container's gate satisfies it structurally.
 */
export interface AccountSignInAnswer {
  readonly kind: "unknown" | "suspended" | "no_membership" | "member";
}

export interface SignInGateDeps {
  readonly tenantId: TenantId;
  /**
   * `usecases.operatorAccounts.signIn` — identity → account → membership, and
   * the placeholder-sub patch as a side effect (M1.1 obligation).
   */
  signInAccount(input: RegisterIdentityInput): Promise<AccountSignInAnswer>;
  /** `usecases.operatorAccess.register` — files an unknown identity as pending. */
  register(input: RegisterIdentityInput): Promise<{ status: string }>;
  readonly logger: SignInGateLogger;
}

export async function decideSignIn(
  deps: SignInGateDeps,
  params: SignInParams,
): Promise<boolean | string> {
  // --- Edge cases first ------------------------------------------------------
  const verdict = evaluateEnvAllowList(params);
  if (verdict === "reject") return false;

  /**
   * SHAPE check at the boundary (CLAUDE.md rule 2) before the payload reaches a
   * usecase. Facebook has been seen returning no e-mail, an empty name and an id
   * that is only sometimes a string. The business rules on top (which id is
   * usable, what the session address is) stay in core/domain/access-request.
   */
  const parsed = SignInProfileSchema.safeParse(params);
  if (!parsed.success) {
    deps.logger.warn("Provider payload is not usable — this identity cannot be filed", {
      error_code: "INVALID_INPUT",
      provider: typeof params.provider === "string" ? params.provider : null,
      issues: parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"),
      // A bootstrap admin still gets in: their grant comes from env, not from a
      // row. Anyone else is refused, because nothing can be filed for them.
      bootstrap: verdict === "allow",
    });
    return verdict === "allow";
  }

  const identity: RegisterIdentityInput = {
    tenantId: deps.tenantId,
    provider: parsed.data.provider,
    providerAccountId: parsed.data.providerAccountId,
    email: parsed.data.email ?? null,
    displayName: parsed.data.displayName ?? null,
  };

  if (verdict === "allow") {
    await recordBootstrapIdentity(deps, identity);
    return true;
  }

  try {
    /**
     * The account tables answer FIRST (M1.2). This call also patches a
     * placeholder provider sub in place — it must run before any refusal so
     * the first real sign-in of a backfilled operator repairs their identity
     * even when they are then held at the door.
     */
    const account = await deps.signInAccount(identity);

    if (account.kind === "member") return true;
    if (account.kind === "suspended") {
      deps.logger.warn("Sign-in refused: this account is suspended", {
        error_code: "UNAUTHORIZED",
        tenant_id: deps.tenantId,
        provider: identity.provider,
        account_verdict: account.kind,
      });
      return false;
    }

    // `unknown` / `no_membership` — the legacy pending flow decides (and files
    // a row for a first-time identity). Retires at M2.4.
    const access = await deps.register(identity);

    if (access.status === "approved") {
      /**
       * The registry says approved but the account tables hold no membership:
       * the M1.2 decide-wiring should have created one, so this is drift
       * (pre-M1.2 approval the backfill missed, or a failed provision). Letting
       * them in would mint a session `getOperatorSession` immediately refuses —
       * a redirect loop. Hold them at the door, loudly, as "đang chờ duyệt":
       * re-approving on /access is the repair path.
       */
      deps.logger.error("Registry says approved but no active membership exists — holding at the door", {
        error_code: "INTERNAL",
        tenant_id: deps.tenantId,
        provider: identity.provider,
        account_verdict: account.kind,
        alert: "OPERATOR_ATTENTION",
      });
      return PENDING_APPROVAL_REDIRECT;
    }
    if (access.status === "blocked") {
      deps.logger.warn("Sign-in refused: this identity is blocked", {
        error_code: "UNAUTHORIZED",
        tenant_id: deps.tenantId,
        provider: identity.provider,
        access_status: access.status,
      });
      return false;
    }
    return PENDING_APPROVAL_REDIRECT;
  } catch (error) {
    /**
     * FAIL CLOSED. A registry we cannot read is not permission to enter; the
     * bootstrap admins (decided above, without the database) can still get in
     * and fix whatever is broken.
     */
    const appError = AppError.from(error, "DB_ERROR");
    deps.logger.error("Could not read the access registry — sign-in refused", {
      ...appError.toLogObject(),
      error_code: appError.code,
      tenant_id: deps.tenantId,
      provider: identity.provider,
    });
    return false;
  }
}

/**
 * A bootstrap admin is filed in the registry too, so the approval screen lists
 * everybody who can sign in rather than hiding the most privileged accounts.
 * Best effort ON PURPOSE: their access comes from env, and a database outage
 * must not close the one door that is meant to survive one.
 */
async function recordBootstrapIdentity(
  deps: SignInGateDeps,
  identity: RegisterIdentityInput,
): Promise<void> {
  try {
    await deps.register(identity);
  } catch (error) {
    const appError = AppError.from(error, "DB_ERROR");
    deps.logger.error("Bootstrap admin signed in but could not be recorded in the registry", {
      ...appError.toLogObject(),
      error_code: appError.code,
      tenant_id: deps.tenantId,
      provider: identity.provider,
      alert: "OPERATOR_ATTENTION",
    });
  }
}
