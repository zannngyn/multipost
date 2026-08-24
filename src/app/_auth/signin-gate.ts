import { z } from "zod";

import { AppError } from "@/core/domain/errors";

import { evaluateEnvAllowList } from "./auth.config";

/**
 * THE sign-in gate — M2.4 edition: the approval queue is RETIRED (docs/09
 * M2.4). A stranger who passes the env checks is no longer parked as
 * `pending`; they get an ACCOUNT on the spot and land in the NoMembership
 * state, where the create-or-join screens (M2.1/M2.2) take over. Access to any
 * COMPANY still comes only from a membership — signing in grants nothing but a
 * lobby.
 *
 * Order, and why each step exists (M3.1 — same precedence wording in
 * session.ts and auth.config.ts; change one, change all three):
 *   1. env verdict (pure, see auth.config):
 *        reject -> out; an unverified e-mail, an unknown provider or an address
 *                  outside AUTH_ALLOWED_DOMAINS can never enter;
 *        allow  -> a BOOTSTRAP admin. Since M3.1 the env is only SEED + RESCUE:
 *                  when their account ROW answers, the DATABASE decides — a
 *                  suspended/rejected row refuses even them (N9). Only a DB
 *                  that cannot answer leaves the env carrying them;
 *        consult -> everyone else, to the account tables.
 *   2. the account tables:
 *        member / no_membership -> in (the session is valid either way; the
 *                  tenant boundary decides everything per-company);
 *        suspended -> out — the platform ban survives retirement. NOTE: the
 *                  only way to BAN someone now is `account.status='suspended'`,
 *                  set by hand until M3.1 ships the platform suspend switch —
 *                  the /access decide door answers 410;
 *        rejected -> out — a recycled address / unclaimable identity row
 *                  (PROVIDER_SUB_MISMATCH guard of M1.2, kept verbatim);
 *        unknown -> PROVISION account + identity, then in.
 *
 * `access_request` is no longer written by anything here; the table stays as
 * read-only history behind GET /api/access-requests until it is dropped.
 */

/**
 * The shape a provider must hand back before anything is filed. Nullable, not
 * optional-with-a-default: an absent e-mail is DATA (Facebook accounts
 * registered with a phone number have none), not a value to invent.
 */
const SignInProfileSchema = z.object({
  provider: z.enum(["google", "facebook", "password"]),
  /**
   * 320, not 128: for `password` this field IS the e-mail address (there is no
   * third-party `sub` to key on — shared/operator-access.normaliseIdentityKey),
   * and 128 would refuse long but perfectly ordinary addresses. Google and
   * Facebook ids are far below either bound, so nothing is loosened for them.
   */
  providerAccountId: z.string().trim().min(1).max(320),
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
  info(message: string, context?: Record<string, unknown>): void;
}

export interface SignInIdentity {
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
  readonly kind: "unknown" | "rejected" | "suspended" | "no_membership" | "member";
}

export interface SignInGateDeps {
  /**
   * `usecases.operatorAccounts.signIn` — identity → account → membership, and
   * the placeholder-sub patch as a side effect (M1.1 obligation).
   */
  signInAccount(input: SignInIdentity): Promise<AccountSignInAnswer>;
  /** `usecases.operatorAccounts.provision` — first sign-in creates the person. */
  provisionAccount(input: SignInIdentity): Promise<unknown>;
  readonly logger: SignInGateLogger;
}

export async function decideSignIn(
  deps: SignInGateDeps,
  params: SignInParams,
): Promise<boolean> {
  // --- Edge cases first ------------------------------------------------------
  const verdict = evaluateEnvAllowList(params);
  if (verdict === "reject") return false;

  /**
   * SHAPE check at the boundary (CLAUDE.md rule 2) before the payload reaches a
   * usecase. Facebook has been seen returning no e-mail, an empty name and an
   * id that is only sometimes a string.
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

  const identity: SignInIdentity = {
    provider: parsed.data.provider,
    providerAccountId: parsed.data.providerAccountId,
    email: parsed.data.email ?? null,
    displayName: parsed.data.displayName ?? null,
  };

  if (verdict === "allow") {
    return recordBootstrapIdentity(deps, identity);
  }

  try {
    /**
     * The account tables answer (M1.2). This call also patches a placeholder
     * provider sub in place — it must run before any refusal so the first real
     * sign-in of a backfilled operator repairs their identity.
     */
    const account = await deps.signInAccount(identity);

    // A valid person is IN whether or not they belong to a company yet: the
    // NoMembership state is a real signed-in state since M2.4 (docs/09 §3.8).
    if (account.kind === "member" || account.kind === "no_membership") return true;

    if (account.kind === "suspended" || account.kind === "rejected") {
      deps.logger.warn("Sign-in refused", {
        error_code: "UNAUTHORIZED",
        provider: identity.provider,
        account_verdict: account.kind,
      });
      return false;
    }

    // `unknown` — a genuinely new person: create them, let them in (M2.4).
    await deps.provisionAccount(identity);
    return true;
  } catch (error) {
    /**
     * FAIL CLOSED. A database we cannot read is not permission to enter; the
     * bootstrap admins (decided above, without the database) can still get in
     * and fix whatever is broken.
     */
    const appError = AppError.from(error, "DB_ERROR");
    deps.logger.error("Could not resolve/provision the account — sign-in refused", {
      ...appError.toLogObject(),
      error_code: appError.code,
      provider: identity.provider,
    });
    return false;
  }
}

/**
 * A bootstrap admin is filed in the account tables too, so /api/me and the
 * members screens see the person — and since M3.1 the answer BINDS: a
 * suspended (or unclaimable/rejected) row refuses even a bootstrap admin,
 * because once the row exists the DATABASE is the source of truth (N9).
 * Only a database that cannot answer at all leaves the env carrying them —
 * the rescue door a broken deployment is repaired through.
 */
async function recordBootstrapIdentity(
  deps: SignInGateDeps,
  identity: SignInIdentity,
): Promise<boolean> {
  try {
    const account = await deps.signInAccount(identity);
    if (account.kind === "suspended" || account.kind === "rejected") {
      deps.logger.warn("Bootstrap admin refused by their own account row (N9)", {
        error_code: "UNAUTHORIZED",
        provider: identity.provider,
        account_verdict: account.kind,
        alert: "OPERATOR_ATTENTION",
      });
      return false;
    }
    if (account.kind === "unknown") await deps.provisionAccount(identity);
    return true;
  } catch (error) {
    const appError = AppError.from(error, "DB_ERROR");
    deps.logger.error("Bootstrap admin signed in but could not be recorded", {
      ...appError.toLogObject(),
      error_code: appError.code,
      provider: identity.provider,
      alert: "OPERATOR_ATTENTION",
    });
    return true; // the rescue door: env carries them while the DB is down
  }
}
