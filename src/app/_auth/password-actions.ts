"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AUTH_EMAIL_RULE, AUTH_IP_RULE, getContainer } from "@/composition/container";
import { AppError, type ErrorCode } from "@/core/domain/errors";
import { maskEmail } from "@/shared/operator-access";
import {
  problemsFromIssue,
  RegisterWithPasswordSchema,
  SignInWithPasswordSchema,
  type PasswordRequirement,
} from "@/shared/password-policy";

import { signIn } from "./auth";
import { PASSWORD_PROVIDER_ID, readPasswordSignInError } from "./password-errors";
import { safeReturnUrl } from "./return-url";

/**
 * The two Server Actions the sign-in screen calls (E-mail + mật khẩu).
 *
 * ============================ CONTRACT FOR ui-web ==========================
 * Both actions take a `FormData` and are safe to pass straight to
 * `<form action={...}>` or to call from a `useActionState` reducer.
 *
 * FIELDS READ FROM THE FORM
 *   `email`      (required)
 *   `password`   (required)
 *   `displayName`(register only, optional — trimmed, "" is treated as absent)
 *   `returnUrl`  (optional) — re-sanitised server-side; anything off-site
 *                becomes "/". Do not trust the client copy.
 *
 * WHAT COMES BACK
 *   SUCCESS -> the action REDIRECTS (throws NEXT_REDIRECT). It never returns a
 *              success object, so `useActionState` only ever sees failures and
 *              the "success" branch of the UI is simply the new page. Do NOT
 *              wrap the call in try/catch in the component: catching would
 *              swallow the redirect.
 *   FAILURE -> a plain object, never a throw:
 *                { ok: false, code, message, field?, problems? }
 *              `code`     — a stable ErrorCode (below), for branching/telemetry
 *              `message`  — Vietnamese, ready to render as-is
 *              `field`    — "email" | "password" | null: which input to mark
 *                           invalid and focus. null = form-level banner
 *              `problems` — only for AUTH_WEAK_PASSWORD: the list of broken
 *                           rules, so a checklist can tick them off. The wording
 *                           for each is `describePasswordRequirement()` in
 *                           `@/shared/password-policy`, which the form should
 *                           also use to validate BEFORE submitting.
 *
 * CODES THE FORM SHOULD EXPECT
 *   INVALID_INPUT             malformed address (register) / empty field
 *   AUTH_WEAK_PASSWORD        register only, comes with `problems`
 *   AUTH_EMAIL_TAKEN          register only, field "email"
 *   AUTH_INVALID_CREDENTIALS  sign-in: wrong address OR wrong password OR a
 *                             suspended account. Deliberately indistinguishable
 *                             — do not try to tell the person which it was
 *   AUTH_ACCOUNT_LOCKED       sign-in: `message` already names the unlock time
 *   AUTH_RATE_LIMITED         too many attempts from this IP or for this address
 *   INTERNAL / DB_ERROR       something broke; show the message, keep the form
 * ===========================================================================
 */

/** Field the UI should mark invalid. `null` = a form-level message. */
export type PasswordAuthField = "email" | "password" | null;

export interface PasswordAuthFailure {
  readonly ok: false;
  readonly code: ErrorCode;
  /** Vietnamese, safe to render verbatim. */
  readonly message: string;
  readonly field: PasswordAuthField;
  /** Present only for AUTH_WEAK_PASSWORD. */
  readonly problems?: readonly PasswordRequirement[];
}

/**
 * `redirect()` throws a control-flow signal, not an error. It MUST leave every
 * catch untouched, or a successful sign-in silently turns into "có lỗi xảy ra"
 * (the digest format is Next's documented contract for exactly this check).
 */
function isNextRedirectError(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

function failure(
  code: ErrorCode,
  field: PasswordAuthField,
  message?: string,
  problems?: readonly PasswordRequirement[],
): PasswordAuthFailure {
  return {
    ok: false,
    code,
    message: message ?? new AppError(code).userMessage,
    field,
    ...(problems ? { problems } : {}),
  };
}

/**
 * Best-effort caller address for the per-IP budget.
 *
 * The app runs behind Caddy on our own VPS (`trustHost: true` in auth.config),
 * so the FIRST hop of `x-forwarded-for` is the client. A request without the
 * header at all gets the shared key `unknown` — one shared bucket for everybody
 * who arrives that way is the safe direction: it can only be too strict.
 */
async function callerIp(): Promise<string> {
  const headerBag = await headers();
  const forwarded = headerBag.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first && first.length > 0 && first.length <= 64) return first;
  const real = headerBag.get("x-real-ip")?.trim();
  if (real && real.length > 0 && real.length <= 64) return real;
  return "unknown";
}

/**
 * Spends one attempt from BOTH budgets before any hashing happens.
 *
 * Both are consumed even when the first says no: an attacker must not be able
 * to keep their per-address budget intact by burning a throw-away IP, and vice
 * versa. The limiter never throws (port contract), so a failure here degrades
 * to "allowed" rather than closing the door on everybody.
 */
async function spendAttempt(
  surface: "signin" | "register",
  email: string,
): Promise<PasswordAuthFailure | null> {
  const container = getContainer();
  const ip = await callerIp();

  const [byIp, byEmail] = await Promise.all([
    container.usecases.authRateLimit.consume(`auth:${surface}:ip:${ip}`, AUTH_IP_RULE),
    container.usecases.authRateLimit.consume(`auth:${surface}:email:${email}`, AUTH_EMAIL_RULE),
  ]);
  if (byIp.allowed && byEmail.allowed) return null;

  const retryAfterMs = Math.max(byIp.retryAfterMs, byEmail.retryAfterMs);
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  container.logger.warn("Password auth attempt refused by the rate limiter", {
    error_code: "AUTH_RATE_LIMITED",
    provider: PASSWORD_PROVIDER_ID,
    surface,
    email: maskEmail(email),
    ip,
    // Which budget ran out — the two mean very different things operationally
    // (one office behind a NAT vs. a distributed run at one account).
    scope: byIp.allowed ? "EMAIL" : byEmail.allowed ? "IP" : "IP_AND_EMAIL",
    retry_after_ms: retryAfterMs,
  });

  return failure(
    "AUTH_RATE_LIMITED",
    null,
    `Bạn thử quá nhiều lần. Vui lòng chờ khoảng ${minutes} phút rồi thử lại.`,
  );
}

function formString(formData: FormData, field: string): string {
  const value = formData?.get?.(field);
  return typeof value === "string" ? value : "";
}

/**
 * Sign in with e-mail + password.
 *
 * NOTE FOR REVIEWERS: this action does NOT call `usecases.passwordAuth.signIn`
 * itself. The verification lives in the Credentials provider's `authorize`
 * (see ./auth.ts), because `/api/auth/callback/password` is reachable without
 * this action — verifying here as well would mean either hashing twice on every
 * successful login, or leaving that endpoint unguarded. The typed refusal still
 * reaches us: `authorize` throws a `PasswordSignInError`, which @auth/core
 * re-throws untouched.
 *
 * @returns never on success (redirects); `PasswordAuthFailure` otherwise.
 */
export async function signInWithPasswordAction(
  formData: FormData,
): Promise<PasswordAuthFailure> {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  const parsed = SignInWithPasswordSchema.safeParse({
    email: formString(formData, "email"),
    password: formString(formData, "password"),
  });
  if (!parsed.success) {
    /**
     * A shape complaint, not a credentials verdict: nothing was looked up, so
     * this leaks nothing. It also costs no rate-limit budget — refusing an
     * empty form must not help anyone exhaust an operator's window.
     */
    const field: PasswordAuthField =
      parsed.error.issues[0]?.path[0] === "password" ? "password" : "email";
    return failure("INVALID_INPUT", field, "Vui lòng nhập email và mật khẩu.");
  }

  const limited = await spendAttempt("signin", parsed.data.email);
  if (limited) return limited;

  const target = safeReturnUrl(formData.get("returnUrl"));

  try {
    /**
     * `redirect: false` so THIS function decides where the browser goes. With
     * Auth.js's own redirect we would hand control to a URL built by @auth/core
     * and lose the ability to answer the form at all.
     */
    await signIn(PASSWORD_PROVIDER_ID, {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: false,
      redirectTo: target,
    });
  } catch (error) {
    // A redirect signal must never be treated as a failure (see the helper).
    if (isNextRedirectError(error)) throw error;

    const { code, userMessage } = readPasswordSignInError(error);
    getContainer().logger.warn("Password sign-in did not produce a session", {
      err: AppError.from(error, "UNAUTHORIZED"),
      error_code: code,
      provider: PASSWORD_PROVIDER_ID,
      email: maskEmail(parsed.data.email),
      ip: await callerIp(),
    });
    return failure(code, code === "AUTH_INVALID_CREDENTIALS" ? "password" : null, userMessage);
  }

  // OUTSIDE the try: the NEXT_REDIRECT this throws is the success path.
  redirect(target);
}

/**
 * Create an account with e-mail + password, then sign it in.
 *
 * The two steps are deliberately not one transaction: the account IS created
 * once `register` returns, and a session that fails to mint afterwards leaves a
 * usable account the person can simply log into. The reverse (a session for an
 * account that was rolled back) is the state with no repair path.
 *
 * @returns never on success (redirects); `PasswordAuthFailure` otherwise.
 */
export async function registerWithPasswordAction(
  formData: FormData,
): Promise<PasswordAuthFailure> {
  // --- Edge cases first ------------------------------------------------------
  const rawEmail = formString(formData, "email");
  const rawPassword = formString(formData, "password");
  const parsed = RegisterWithPasswordSchema.safeParse({
    email: rawEmail,
    password: rawPassword,
    displayName: formString(formData, "displayName"),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "password") {
      /**
       * The broken rules travel to the UI so a checklist can tick them off.
       * `params.problems` is set by `PasswordSchema` in shared/password-policy;
       * an undefined here just means the checklist stays generic.
       */
      return failure("AUTH_WEAK_PASSWORD", "password", issue.message, problemsFromIssue(issue));
    }
    return failure("INVALID_INPUT", "email", "Địa chỉ email không hợp lệ. Vui lòng kiểm tra lại.");
  }

  const limited = await spendAttempt("register", parsed.data.email);
  if (limited) return limited;

  const container = getContainer();
  const target = safeReturnUrl(formData.get("returnUrl"));

  try {
    await container.usecases.passwordAuth.register(parsed.data);
  } catch (error) {
    // Not swallowed: the usecase and the repo already logged with context; this
    // adds the interface-layer facts (caller IP) and turns it into UI shape.
    const appError = AppError.from(error, "INTERNAL");
    container.logger.warn("Sign-up refused", {
      err: appError,
      error_code: appError.code,
      provider: PASSWORD_PROVIDER_ID,
      email: maskEmail(parsed.data.email),
      ip: await callerIp(),
    });
    const field: PasswordAuthField =
      appError.code === "AUTH_WEAK_PASSWORD"
        ? "password"
        : appError.code === "AUTH_EMAIL_TAKEN" || appError.code === "INVALID_INPUT"
          ? "email"
          : null;
    return failure(
      appError.code,
      field,
      appError.userMessage,
      appError.context.problems as readonly PasswordRequirement[] | undefined,
    );
  }

  try {
    await signIn(PASSWORD_PROVIDER_ID, {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: false,
      redirectTo: target,
    });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;

    /**
     * The ACCOUNT EXISTS at this point — say so, or the person will try to sign
     * up again and be told the address is taken, which reads as a lie.
     */
    const { code } = readPasswordSignInError(error);
    container.logger.error("Account was created but the session could not be minted", {
      err: AppError.from(error, "UNAUTHORIZED"),
      error_code: code,
      provider: PASSWORD_PROVIDER_ID,
      email: maskEmail(parsed.data.email),
      alert: "OPERATOR_ATTENTION",
    });
    return failure(
      code,
      null,
      "Đã tạo tài khoản nhưng chưa đăng nhập được. Hãy thử đăng nhập bằng email và mật khẩu vừa đặt.",
    );
  }

  redirect(target);
}
