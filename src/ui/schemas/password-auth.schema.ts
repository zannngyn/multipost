import {
  CredentialEmailSchema,
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  describePasswordProblems,
  describePasswordRequirement,
  passwordProblems,
  type PasswordRequirement,
} from "@/shared/password-policy";

/**
 * The e-mail + password screens, seen from `ui/`.
 *
 * WHY A MIRROR AND NOT AN IMPORT: the two Server Actions live in
 * `src/app/_auth/password-actions.ts` and `ui/**` may not import `@/app/*`
 * (docs/07 §4 + the ESLint zone rule). So the SHAPE is restated here and the
 * actions themselves arrive as props from the page — the same way `SignInScreen`
 * already receives `signInWithGoogle`.
 *
 * The restatement is deliberately WIDER than the original in exactly one place:
 * `code` is a plain string here, because `ErrorCode` is a `core/domain` union
 * this layer may not read. A function returning the narrow union is assignable
 * to one returning the wide one, so the page hands its action over unchanged
 * and TypeScript still checks the rest of the contract.
 *
 * The password RULES are not restated: they come from `@/shared/password-policy`,
 * which is the single copy the form, the action and the usecase all read.
 */

// --- What comes back from an action -----------------------------------------

/** Which input to mark invalid and focus. `null` = a form-level banner. */
export type PasswordAuthField = "email" | "password" | null;

/**
 * A refusal. Never a throw, never a success object: a successful sign-in
 * redirects, so the "success" branch of the UI is simply the next page.
 */
export interface PasswordAuthFailure {
  readonly ok: false;
  /** Stable error code — branch on it, never render it as the main text. */
  readonly code: string;
  /** Vietnamese, ready to render verbatim. */
  readonly message: string;
  readonly field: PasswordAuthField;
  /** Only for AUTH_WEAK_PASSWORD. */
  readonly problems?: readonly PasswordRequirement[];
}

/** `null` is the idle state: nothing has been submitted yet. */
export type PasswordAuthState = PasswordAuthFailure | null;

/**
 * The `useActionState` reducer shape. The page wraps the one-argument Server
 * Actions into this so the form keeps working before hydration — a client-side
 * wrapper would make `/signin` need JavaScript to submit at all
 * (web-auth-flows rule 5: the front door must not).
 */
export type PasswordAuthAction = (
  state: PasswordAuthState,
  formData: FormData,
) => Promise<PasswordAuthState>;

// --- Which mode the screen is in --------------------------------------------

export const AUTH_MODES = ["signin", "register"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const AUTH_MODE_LABELS: Record<AuthMode, string> = {
  signin: "Đăng nhập",
  register: "Đăng ký",
};

/** Query parameter that carries the mode, so the tab survives F5 and Back. */
export const AUTH_MODE_PARAM = "mode";

/**
 * Anything that is not exactly `register` is the sign-in tab.
 *
 * Signing in is what the overwhelming majority of visits want and it is the
 * harmless default, so a hand-edited `?mode=xyz` lands there rather than on an
 * error (core-routing-patterns: a bad param falls back, it does not break).
 */
export function parseAuthMode(value: unknown): AuthMode {
  if (Array.isArray(value)) return parseAuthMode(value[0]);
  return value === "register" ? "register" : "signin";
}

/**
 * The address of the other tab — a real URL, so the switch is an anchor that
 * works before hydration and can be opened in a new tab.
 *
 * `returnUrl` rides along or the operator loses their destination by switching
 * tabs. It is NEVER given the e-mail: an address in the query string ends up in
 * browser history and server logs (core-frontend-security §"Dữ liệu cá nhân").
 */
export function authModeHref(mode: AuthMode, returnUrl: string): string {
  const params = new URLSearchParams();
  if (mode !== "signin") params.set(AUTH_MODE_PARAM, mode);
  if (returnUrl && returnUrl !== "/") params.set("returnUrl", returnUrl);
  const query = params.toString();
  return query.length > 0 ? `/signin?${query}` : "/signin";
}

// --- Where a refusal is shown ------------------------------------------------

/**
 * The message that belongs UNDER this input, or null.
 *
 * A refusal is shown in exactly one place: `field` decides, and everything the
 * server did not pin to an input becomes the banner instead. Showing it twice
 * is how a form says the same thing in two voices
 * (core-form-architecture §"Hợp đồng lỗi từ server").
 */
export function fieldErrorMessage(
  state: SetPasswordState,
  field: Exclude<PasswordAuthField, null>,
): string | null {
  if (!state || state.ok !== false) return null;
  return state.field === field ? state.message : null;
}

/**
 * The message that belongs in the banner at the top of the form, or null.
 *
 * Typed against the WIDER `SetPasswordState` so the sign-in forms and the admin
 * reset dialog share one set of readers — the extra `{ ok: true }` member is
 * simply never a message.
 */
export function formErrorMessage(state: SetPasswordState): string | null {
  if (!state || state.ok !== false) return null;
  return state.field === null ? state.message : null;
}

/**
 * The WAY OUT for a refusal the person cannot simply retype their way past.
 *
 * core-auth-flows: "trạng thái bị chặn phải có lối ra, không phải ngõ cụt". The
 * product has no self-service reset (only a platform super_admin can set a
 * password, `/members`), so every sentence here points at a human instead of at
 * a link that does not exist.
 */
export function authFailureHint(state: SetPasswordState): string | null {
  if (!state || state.ok !== false) return null;
  switch (state.code) {
    case "AUTH_ACCOUNT_LOCKED":
      return "Khoá tự mở khi hết thời gian ở trên. Cần vào ngay thì nhờ quản trị viên hệ thống đặt lại mật khẩu giúp bạn ở màn hình Thành viên.";
    case "AUTH_RATE_LIMITED":
      return "Mỗi lần thử thêm đều tính vào giới hạn, nên hãy đợi hết thời gian rồi mới bấm lại.";
    case "AUTH_INVALID_CREDENTIALS":
      return "Không nhớ mật khẩu? Nhờ quản trị viên hệ thống đặt lại giúp, hoặc dùng nút Google/Facebook bên dưới.";
    case "AUTH_EMAIL_TAKEN":
      return "Email này đã có tài khoản — chuyển sang thẻ “Đăng nhập” ở trên, email bạn vừa gõ sẽ được giữ nguyên.";
    case "AUTH_CREDENTIAL_NOT_FOUND":
      return "Tài khoản này đăng nhập bằng Google hoặc Facebook, chưa từng đặt mật khẩu.";
    default:
      return null;
  }
}

// --- The address -------------------------------------------------------------

/**
 * What is wrong with the SHAPE of the address, or null.
 *
 * It runs `CredentialEmailSchema` — the very schema the Server Action parses
 * with — instead of a regex of its own. A client rule stricter than the server's
 * refuses real people; a looser one just moves the same complaint one round trip
 * later. One copy, in `@/shared`, read by both.
 *
 * SHAPE ONLY. It never asks whether the address is registered: a form that can
 * tell "chưa có tài khoản" from "sai mật khẩu" is an account-enumeration oracle
 * (core-auth-flows §"Không lộ sự tồn tại tài khoản").
 */
export function emailShapeProblem(value: string): string | null {
  const candidate = value.trim();
  if (candidate.length === 0) return "Chưa nhập email.";
  if (candidate.length > EMAIL_MAX_LENGTH) return `Email tối đa ${EMAIL_MAX_LENGTH} ký tự.`;
  if (!CredentialEmailSchema.safeParse(candidate).success) {
    return "Địa chỉ email không hợp lệ — cần dạng ten@congty.com.";
  }
  return null;
}

// --- The password hint -------------------------------------------------------

export interface PasswordHint {
  /** ONE Vietnamese sentence. Never empty — the box always has something to say. */
  readonly message: string;
  /** True once every rule is satisfied. */
  readonly isReady: boolean;
}

/**
 * What to say under the new-password box, as a SINGLE sentence.
 *
 * This replaced a four-line tick list. Whatever the value breaks — one rule or
 * all four — the person reads one message, and it names everything still
 * missing at once; four lines that each said "Chưa đạt" made them assemble the
 * answer themselves, and on a phone the list pushed the submit button off the
 * fold. The wording comes from `shared/password-policy`, the same table the
 * server's refusal is built from, so the sentence the form shows while typing
 * and the sentence that comes back from a rejected submit are the same words.
 *
 * NOT AN ERROR while it is unmet: the caller renders it in the ordinary
 * supporting colour and nothing turns red before blur (core-auth-flows: thanh
 * đo cập nhật khi gõ nhưng không báo đỏ trước khi rời ô). The refusal that DOES
 * turn red is the server's, and it lands in the input's own status.
 */
export function passwordHint(value: string): PasswordHint {
  const problems = passwordProblems(value);
  if (problems.length === 0) return { message: "Mật khẩu đã đạt đủ yêu cầu.", isReady: true };
  return { message: describePasswordProblems(problems), isReady: false };
}

/**
 * "Nhập lại mật khẩu" is the ONE repeated field this product keeps (the repeated
 * EMAIL box is the one core-auth-flows forbids): a typo in a password nobody can
 * reset without an admin costs a support ticket.
 *
 * Silent while the box is still empty — a mismatch warning that appears on the
 * first keystroke is noise, not help.
 */
export function confirmPasswordProblem(password: string, confirmation: string): string | null {
  if (confirmation.length === 0) return null;
  if (confirmation === password) return null;
  return "Hai ô mật khẩu chưa khớp.";
}

/**
 * Everything wrong with a new-password pair, as ONE Vietnamese sentence, or
 * null when it is ready to send. Used by the admin reset dialog to refuse
 * before the round trip; the server checks again regardless.
 */
export function newPasswordProblem(password: string, confirmation: string): string | null {
  if (password.length === 0) return "Chưa nhập mật khẩu mới.";
  if (password.length > PASSWORD_MAX_LENGTH) {
    return describePasswordRequirement("too_long");
  }
  const problems = passwordProblems(password);
  if (problems.length > 0) return "Mật khẩu mới chưa đạt đủ yêu cầu bên dưới.";
  if (confirmation.length === 0) return "Chưa nhập lại mật khẩu mới.";
  if (confirmation !== password) return "Hai ô mật khẩu chưa khớp.";
  return null;
}

// --- The admin reset (`/members`) -------------------------------------------

/**
 * What `setPasswordAction` answers. Restated for the same reason as
 * `PasswordAuthFailure` above: `ui/` may not import `@/app/*`.
 *
 * Unlike sign-in, this one HAS a success value — nothing redirects, the dialog
 * stays put and says so.
 */
export type SetPasswordResult = { readonly ok: true } | PasswordAuthFailure;

/** `null` is idle: the dialog has just opened. */
export type SetPasswordState = SetPasswordResult | null;

export type SetPasswordAction = (
  state: SetPasswordState,
  formData: FormData,
) => Promise<SetPasswordState>;

/**
 * Why a member's password cannot be set right now — or null when it can.
 *
 * A credential is keyed on an e-mail address, so an account without one has
 * never had a password and there is nothing to replace: the round trip could
 * only ever come back AUTH_CREDENTIAL_NOT_FOUND. Said as a sentence rather than
 * a silent disabled button (core-auth-session: một nút xám không có lý do là
 * thứ bị cấm).
 *
 * An account that HAS an address may still have no password (Google sign-in) —
 * that one is only knowable on the server, and its refusal is rendered.
 */
export function resetPasswordBlockReason(member: { email: string | null }): string | null {
  if ((member.email ?? "").trim().length === 0) {
    return "Tài khoản này không có email nên chưa từng đặt mật khẩu — họ đăng nhập bằng Google hoặc Facebook.";
  }
  return null;
}

/** Narrowing helper — `state.ok` is unreadable until the null is gone. */
export function isSetPasswordFailure(state: SetPasswordState): state is PasswordAuthFailure {
  return state !== null && state.ok === false;
}
