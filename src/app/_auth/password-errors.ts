import { CredentialsSignin } from "next-auth";

import { AppError, isErrorCode, type ErrorCode } from "@/core/domain/errors";

/**
 * The one word for e-mail + password, and the error type that survives the trip
 * back out of Auth.js.
 *
 * Its own module (not `auth.ts`) for two reasons: `auth.ts` builds the whole
 * NextAuth instance — importing it from a test or from the server action just to
 * read a constant would drag Google/Facebook config and the container in — and
 * both `auth.ts` and `password-actions.ts` need these.
 */

/**
 * Auth.js provider id, `identity.provider`, the `access_provider` enum value and
 * the sign-in gate's branch all say `password`. One concept, one word.
 */
export const PASSWORD_PROVIDER_ID = "password";

/**
 * WHY A SUBCLASS: @auth/core rebrands anything thrown inside `authorize` as
 * `CallbackRouteError` — EXCEPT an `AuthError`, which it re-throws untouched
 * (`lib/actions/callback/index.js`: `if (e instanceof AuthError) throw e`).
 * Since `signIn()` runs `Auth()` in `raw` mode, that same instance lands in the
 * server action's catch with `code` and `userMessage` intact.
 *
 * Without it, "sai mật khẩu", "đang bị khoá tới 14:35" and "hệ thống lỗi" all
 * arrive as one opaque `CallbackRouteError` and the form can only say "có lỗi".
 */
export class PasswordSignInError extends CredentialsSignin {
  /**
   * Ends up in `?code=` on the redirect path, so it is an ERROR CODE, never a
   * sentence and never anything drawn from user input. `AUTH_ACCOUNT_LOCKED`
   * does admit the address exists — deliberately: a lock the person cannot see
   * is a lock they will keep hammering. Every other refusal is the single
   * indistinguishable `AUTH_INVALID_CREDENTIALS`.
   */
  override code: string;

  /** Vietnamese, ready for the form. Carries the unlock time when locked. */
  readonly userMessage: string;

  constructor(code: ErrorCode, userMessage?: string) {
    super(code);
    this.code = code;
    this.userMessage = userMessage ?? new AppError(code).userMessage;
  }
}

/**
 * Reads an error thrown by `signIn()` back into `{code, userMessage}`.
 *
 * STRUCTURAL, not `instanceof`: the error crosses a module boundary owned by
 * next-auth, and duplicated package instances are exactly the case
 * `AppError.is` already guards against elsewhere in this codebase. A shape
 * check costs nothing and cannot be defeated by a hoisting decision in pnpm.
 *
 * Everything unrecognised becomes `AUTH_INVALID_CREDENTIALS`: the paths that
 * reach here are `authorize` refusing, the gate answering `AccessDenied`
 * (suspended / unclaimable identity), and nothing else — all of which the
 * person outside must see as one sentence.
 */
export function readPasswordSignInError(error: unknown): {
  code: ErrorCode;
  userMessage: string;
} {
  const candidate = error as { code?: unknown; userMessage?: unknown } | null;
  const code = isErrorCode(candidate?.code) ? candidate.code : "AUTH_INVALID_CREDENTIALS";
  const userMessage =
    typeof candidate?.userMessage === "string" && candidate.userMessage.length > 0
      ? candidate.userMessage
      : new AppError(code).userMessage;
  return { code, userMessage };
}
