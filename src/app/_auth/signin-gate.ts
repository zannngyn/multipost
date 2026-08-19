import { z } from "zod";

import { AppError } from "@/core/domain/errors";

import { evaluateEnvAllowList, PENDING_APPROVAL_REDIRECT } from "./auth.config";

/**
 * THE sign-in gate (E1.4) — extracted from auth.ts so it can be tested without
 * booting Auth.js, and so the rule below has exactly one home.
 *
 * Order, and why each step exists:
 *   1. env verdict (pure, see auth.config):
 *        reject           -> out; nothing in the registry can rescue it;
 *        allow            -> a BOOTSTRAP admin (exact address / exact Facebook
 *                            id): in, with no database call on the critical
 *                            path, so an unreachable registry can never close
 *                            the escape hatch;
 *        consult_registry -> everyone else, INCLUDING operators who merely
 *                            matched AUTH_ALLOWED_DOMAINS. That filter says who
 *                            MAY TRY; it grants nothing.
 *   2. the registry decides: approved -> in, blocked -> out, and an unknown
 *      identity is RECORDED as `pending` and sent back with
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
  readonly tenantId: string;
  readonly provider: string;
  readonly providerAccountId: string;
  readonly email: string | null;
  readonly displayName: string | null;
}

export interface SignInGateDeps {
  readonly tenantId: string;
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
    const access = await deps.register(identity);

    if (access.status === "approved") return true;
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
