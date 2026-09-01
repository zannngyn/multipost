"use server";

import { z } from "zod";

import { canManageAccess } from "@/app/_auth/operator-session";
import { getOperatorSession } from "@/app/_auth/session";
import { getContainer } from "@/composition/container";
import { AppError, type ErrorCode } from "@/core/domain/errors";
import { PasswordSchema, problemsFromIssue, type PasswordRequirement } from "@/shared/password-policy";

/**
 * Server Actions of the "Thành viên" screen. Today: ONE — resetting somebody
 * else's password.
 *
 * ============================ CONTRACT FOR THE UI ==========================
 * `setPasswordAction` is a `useActionState` reducer: `(state, formData)`. It
 * never throws and never redirects, so the dialog stays open on both outcomes.
 *
 * FIELDS READ FROM THE FORM
 *   `accountId` — the TARGET account (`Member.accountId` from /api/members)
 *   `password`  — the new password, verbatim (never trimmed: a trailing space
 *                 is part of what the person typed)
 *
 * WHAT COMES BACK
 *   { ok: true }                       — the password was replaced and the
 *                                        lock, if any, was lifted
 *   { ok: false, code, message, field, problems? }
 *                                      — `message` is Vietnamese, render as-is;
 *                                        `field: "password"` marks the input,
 *                                        null means a banner; `problems` only
 *                                        for AUTH_WEAK_PASSWORD
 * ===========================================================================
 *
 * TWO GATES, and they are NOT the same gate:
 *   1. here — a session, plus `canManageAccess`, the same rule that guards the
 *      rest of this screen. It is a cheap pre-filter that keeps an ordinary
 *      member's request from ever reaching a usecase;
 *   2. inside `passwordAuth.setPassword` — FRESH platform standing, and only an
 *      active `super_admin` passes. That is the authoritative check (doc 10
 *      tier S), and it is the one that decides.
 * A tenant owner who is not a platform super_admin therefore passes gate 1 and
 * is refused by gate 2 with FORBIDDEN — which is why the dialog is only offered
 * to a super_admin in the first place, and why its refusal is rendered rather
 * than swallowed.
 */

/** Which input the dialog should mark invalid. `null` = a form-level banner. */
export type SetPasswordField = "password" | null;

export interface SetPasswordFailure {
  readonly ok: false;
  readonly code: ErrorCode;
  /** Vietnamese, safe to render verbatim. */
  readonly message: string;
  readonly field: SetPasswordField;
  /** Present only for AUTH_WEAK_PASSWORD. */
  readonly problems?: readonly PasswordRequirement[];
}

export interface SetPasswordSuccess {
  readonly ok: true;
}

export type SetPasswordResult = SetPasswordSuccess | SetPasswordFailure;

/**
 * The target is an opaque id the browser echoes back from `/api/members`. It is
 * checked for SHAPE only — whether this account may be touched is the usecase's
 * decision, made against the database, not against anything sent from here.
 */
const SetPasswordSchema = z.object({
  accountId: z.string().trim().min(1).max(64),
  password: PasswordSchema,
});

function failure(
  code: ErrorCode,
  field: SetPasswordField,
  message?: string,
  problems?: readonly PasswordRequirement[],
): SetPasswordFailure {
  return {
    ok: false,
    code,
    message: message ?? new AppError(code).userMessage,
    field,
    ...(problems ? { problems } : {}),
  };
}

function formString(formData: FormData, field: string): string {
  const value = formData?.get?.(field);
  return typeof value === "string" ? value : "";
}

/**
 * Set another account's password (E10 + M-password). Reducer signature so the
 * dialog can drive it with `useActionState`; the previous state is ignored on
 * purpose — each attempt is judged on its own.
 */
export async function setPasswordAction(
  /**
   * The previous state. `unknown` rather than `SetPasswordResult | null`
   * because a parameter type is CONTRAVARIANT: the UI restates this contract
   * with a wider `code` (it may not import `ErrorCode` from `core/`), and a
   * narrower parameter here would make the action unassignable to the type the
   * dialog declares. Nothing reads it, so nothing is lost.
   */
  _state: unknown,
  formData: FormData,
): Promise<SetPasswordResult> {
  // --- Edge cases first (CLAUDE.md technical rule 1) ------------------------
  const session = await getOperatorSession("action:members/setPassword");
  if (!session) {
    return failure(
      "UNAUTHORIZED",
      null,
      "Phiên đăng nhập đã hết hạn. Hãy tải lại trang và đăng nhập lại.",
    );
  }

  if (!canManageAccess(session) || !session.accountId) {
    /**
     * Logged, not silent: an attempt to reset a password from a session that
     * may not is exactly the line an audit has to be able to see afterwards.
     * The target is NOT read from the form here — nothing has been validated
     * yet, and a rejected caller must not get to write arbitrary strings into
     * our log.
     */
    getContainer().logger.warn("Password reset refused before the usecase", {
      error_code: "FORBIDDEN",
      surface: "members",
      actor_account_id: session.accountId,
      actor_platform_role: session.platformRole,
      actor_role: session.role,
      alert: "OPERATOR_ATTENTION",
    });
    return failure(
      "FORBIDDEN",
      null,
      "Chỉ quản trị viên hệ thống mới được đặt lại mật khẩu cho tài khoản khác.",
    );
  }

  const parsed = SetPasswordSchema.safeParse({
    accountId: formString(formData, "accountId"),
    password: formString(formData, "password"),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "password") {
      // The broken rules travel so the dialog's checklist can tick them off.
      return failure("AUTH_WEAK_PASSWORD", "password", issue.message, problemsFromIssue(issue));
    }
    return failure(
      "INVALID_INPUT",
      null,
      "Không xác định được thành viên cần đặt lại mật khẩu. Hãy tải lại danh sách rồi thử lại.",
    );
  }

  const container = getContainer();
  try {
    await container.usecases.passwordAuth.setPassword({
      actorAccountId: session.accountId,
      targetAccountId: parsed.data.accountId,
      newPassword: parsed.data.password,
    });
  } catch (error) {
    // Not swallowed: the usecase already logged the decision with its own
    // context; this adds the interface-layer facts and turns it into UI shape.
    const appError = AppError.from(error, "INTERNAL");
    container.logger.warn("Password reset refused", {
      err: appError,
      error_code: appError.code,
      surface: "members",
      actor_account_id: session.accountId,
      target_account_id: parsed.data.accountId,
    });
    return failure(
      appError.code,
      appError.code === "AUTH_WEAK_PASSWORD" ? "password" : null,
      appError.userMessage,
      appError.context.problems as readonly PasswordRequirement[] | undefined,
    );
  }

  container.logger.info("Password reset from the members screen", {
    surface: "members",
    actor_account_id: session.accountId,
    target_account_id: parsed.data.accountId,
  });
  return { ok: true };
}
