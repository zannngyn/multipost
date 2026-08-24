"use client";

import { Banner, Button, HStack, Icon, Stack, Text, TextInput } from "@astryxdesign/core";
import type { TextInputProps } from "@astryxdesign/core";
import { useActionState, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { PasswordHint } from "@/ui/components/auth/PasswordHint";
import { PASSWORD_MAX_LENGTH } from "@/shared/password-policy";
import {
  authFailureHint,
  confirmPasswordProblem,
  emailShapeProblem,
  fieldErrorMessage,
  formErrorMessage,
  type AuthMode,
  type PasswordAuthAction,
  type PasswordAuthState,
} from "@/ui/schemas/password-auth.schema";

/**
 * The e-mail + password form — one component for both tabs.
 *
 * ONE FORM, TWO MODES rather than `SignInForm` + `RegisterForm`: the two differ
 * by three fields and four strings, and a second copy is a second place to
 * forget an `autocomplete` token (core-component-reuse §"Cây quyết định", bậc 2:
 * biến thể, không phải file mới).
 *
 * SUBMISSION — `<form action={formAction}>` with a Server Action, never RHF
 * `handleSubmit`. Two reasons, both hard rules:
 *   - `/signin` is the front door and has to submit before the client bundle
 *     loads (web-auth-flows rule 5). `useActionState` keeps that as long as the
 *     action it is given IS a Server Action — which is why the page wraps the
 *     two one-argument actions into reducers on the server rather than here.
 *   - mixing RHF with `<form action>` gives one form two submit paths
 *     (web-form-architecture rule 3).
 * The inputs are still controlled: Astryx's `TextInput` has no uncontrolled
 * mode, and the hint line needs the value on every keystroke. Before hydration
 * the rendered `value` is just the initial attribute, so typing and submitting
 * work without React.
 *
 * NO try/catch AROUND THE ACTION anywhere in this file. A successful sign-in
 * REDIRECTS, and the redirect travels as a thrown signal; catching it would
 * turn every success into "có lỗi xảy ra".
 *
 * WHAT IS NOT HERE, on purpose: no "quên mật khẩu" link. The product has no
 * self-service reset — only a platform super_admin can set a password, from
 * /members — so a link would be a dead end. `authFailureHint` says who to ask
 * instead (commit 521d47b removed the previous dead controls from this screen;
 * every control below does something).
 */

/**
 * Astryx `TextInput` forwards unknown props onto its `<input>`, but its prop
 * type extends `HTMLAttributes`, where `autoComplete`, `required` and
 * `maxLength` are not declared (`spellCheck` is explicitly omitted by
 * `BaseProps`). A raw `<input>` would lose the label, description and status
 * wiring, so the attributes are handed over through one commented cast — the
 * same escape hatch `ChannelConnectPanel` already uses for this component.
 *
 * These tokens are not decoration: without `username` + `current-password` /
 * `new-password` a password manager cannot tell which account it is saving
 * (web-auth-flows rule 1), and people fall back to weaker passwords.
 */
function inputAttrs(attrs: {
  autoComplete: string;
  required?: boolean;
  maxLength?: number;
  spellCheck?: boolean;
}): Partial<TextInputProps> {
  return attrs as unknown as Partial<TextInputProps>;
}

const MODE_COPY: Record<
  AuthMode,
  { submit: string; pending: string; pendingAnnouncement: string }
> = {
  signin: {
    submit: "Đăng nhập",
    pending: "Đang đăng nhập…",
    pendingAnnouncement: "Đang kiểm tra email và mật khẩu, vui lòng đợi",
  },
  register: {
    submit: "Tạo tài khoản",
    pending: "Đang tạo tài khoản…",
    pendingAnnouncement: "Đang tạo tài khoản, vui lòng đợi",
  },
};

export function PasswordAuthForm({
  mode,
  action,
  returnUrl,
  email,
  onEmailChange,
}: {
  mode: AuthMode;
  /** A Server Action, handed down by the page — `ui/` may not import `@/app/*`. */
  action: PasswordAuthAction;
  /** Already sanitised server-side; re-sanitised again on the way back in. */
  returnUrl: string;
  /**
   * Lifted to the screen so switching tabs keeps what was typed
   * (core-auth-flows §"Chuyển giữa ba luồng": giữ email đã gõ).
   */
  email: string;
  onEmailChange: (value: string) => void;
}) {
  const [state, formAction, isPending] = useActionState(action, null);

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [isCapsLockOn, setIsCapsLockOn] = useState(false);
  /**
   * `onTouched`, by hand: the address is only judged once the person has left
   * the box or pressed the button. Complaining at the first keystroke would
   * paint "email không hợp lệ" over every address while it is being typed
   * (core-form-architecture §"Thời điểm validate").
   */
  const [hasLeftEmail, setHasLeftEmail] = useState(false);
  const [wasSubmitted, setWasSubmitted] = useState(false);

  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const isRegister = mode === "register";
  const copy = MODE_COPY[mode];

  /**
   * The server's verdict wins over ours when both exist: it saw the whole
   * request. Ours only exists to save a round trip.
   */
  const localEmailProblem =
    hasLeftEmail || wasSubmitted ? emailShapeProblem(email) : null;
  const emailError = fieldErrorMessage(state, "email") ?? localEmailProblem;
  const passwordError = fieldErrorMessage(state, "password");
  const bannerError = formErrorMessage(state);
  const hint = authFailureHint(state);
  const mismatch = isRegister ? confirmPasswordProblem(password, confirmation) : null;

  /**
   * A WRONG PASSWORD (only that one) empties the password box.
   *
   * Adjusted DURING RENDER, not in an effect: React's documented way to react
   * to a changed input is to compare it with what was last seen and set state
   * on the spot, so the cleared box is painted in the same pass. The same code
   * in an effect renders the stale value first and is what
   * `react-hooks/set-state-in-effect` refuses.
   *
   * Nothing else is cleared: a locked account, a rate limit or a weak password
   * are all refusals the person fixes by waiting or editing, and wiping what
   * they typed would be the thing core-form-architecture forbids.
   */
  const [lastState, setLastState] = useState<PasswordAuthState>(null);
  if (state !== lastState) {
    setLastState(state);
    if (state?.code === "AUTH_INVALID_CREDENTIALS") setPassword("");
  }

  /**
   * The cursor moves to the box that has to change — a DOM call, not state, so
   * it belongs in an effect (core-form-architecture: focus lỗi đầu tiên).
   */
  useEffect(() => {
    if (!state) return;
    const target = state.field === "email" ? emailRef.current : passwordRef.current;
    target?.focus();
  }, [state]);

  function trackCapsLock(event: KeyboardEvent<HTMLInputElement>) {
    // Older browsers and synthetic events without the helper simply never warn:
    // no Caps Lock hint is a missing nicety, a thrown TypeError is a dead form.
    if (typeof event.getModifierState !== "function") return;
    setIsCapsLockOn(event.getModifierState("CapsLock"));
  }

  return (
    /* A real <form action>: Enter submits, the browser offers to save the
       credentials, and the request goes out before hydration. `noValidate` —
       the wording comes from the server and from the hint line, and two sources
       for one error is how a field says two different things
       (web-form-architecture rule 5). */
    <form action={formAction} noValidate onSubmit={() => setWasSubmitted(true)}>
      <Stack direction="vertical" gap={3}>
        {/* Client-visible and therefore client-editable: `safeReturnUrl` runs
            again on the server. This copy is a convenience, not a decision. */}
        <input type="hidden" name="returnUrl" value={returnUrl} />

        {/* Always mounted so a refusal is announced the moment it arrives. */}
        <Stack direction="vertical" gap={1} role="alert" aria-live="assertive">
          {bannerError ? (
            <Banner
              status="error"
              title={isRegister ? "Chưa tạo được tài khoản" : "Chưa đăng nhập được"}
              description={bannerError}
            />
          ) : null}
          {hint ? <Text type="supporting">{hint}</Text> : null}
        </Stack>

        <TextInput
          ref={emailRef}
          label="Email"
          type="email"
          placeholder="ban@congty.com"
          isRequired
          value={email}
          onChange={onEmailChange}
          onBlur={() => setHasLeftEmail(true)}
          htmlName="email"
          isDisabled={isPending}
          width="100%"
          status={emailError ? { type: "error", message: emailError } : undefined}
          statusVariant="detached"
          /* `username`, not `email`: it is the token a password manager keys the
             saved credential on. */
          {...inputAttrs({ autoComplete: "username", required: true, maxLength: 320 })}
        />

        {isRegister ? (
          <TextInput
            label="Tên hiển thị"
            description="Tên đồng nghiệp nhìn thấy trong danh sách thành viên. Bỏ trống cũng được."
            placeholder="Nguyễn Văn A"
            isOptional
            value={displayName}
            onChange={setDisplayName}
            htmlName="displayName"
            isDisabled={isPending}
            width="100%"
            {...inputAttrs({ autoComplete: "name", maxLength: 200 })}
          />
        ) : null}

        <Stack direction="vertical" gap={2}>
          <TextInput
            ref={passwordRef}
            label="Mật khẩu"
            /* The SAME input, only its `type` changes. Swapping in a second
               element would drop the value being typed and break autofill
               (web-auth-flows rule 2). */
            type={isPasswordVisible ? "text" : "password"}
            /* No description here in register mode: the one line under the box
               already says what the password needs, and saying it twice is how
               a field speaks in two voices (web-form-architecture rule 5). */
            isRequired
            value={password}
            onChange={setPassword}
            onKeyDown={trackCapsLock}
            htmlName="password"
            isDisabled={isPending}
            width="100%"
            status={passwordError ? { type: "error", message: passwordError } : undefined}
            statusVariant="detached"
            {...inputAttrs({
              autoComplete: isRegister ? "new-password" : "current-password",
              required: true,
              maxLength: PASSWORD_MAX_LENGTH,
              spellCheck: false,
            })}
          />

          <HStack gap={2} align="center" wrap="wrap">
            {/* A labelled button, not a bare icon — and `type="button"`, or it
                would submit the form (web-form-architecture rule 6). */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={<Icon icon="eyeSlash" size="sm" />}
              label={isPasswordVisible ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
              isDisabled={isPending}
              onClick={() => setIsPasswordVisible((visible) => !visible)}
            />
            {/* Caps Lock is the single most common cause of "mật khẩu đúng mà
                vẫn sai". Announced politely, never as an error. */}
            <Text type="supporting" role="status" aria-live="polite">
              {isCapsLockOn ? "Caps Lock đang bật." : ""}
            </Text>
          </HStack>

          {isRegister ? <PasswordHint value={password} /> : null}
        </Stack>

        {isRegister ? (
          /* The one repeated box this product keeps. A repeated EMAIL box is
             the one core-auth-flows forbids — this is a password nobody can
             reset without an admin, so a typo is worth catching here.
             No `htmlName`: it never leaves the browser. */
          <TextInput
            label="Nhập lại mật khẩu"
            type={isPasswordVisible ? "text" : "password"}
            isRequired
            value={confirmation}
            onChange={setConfirmation}
            onKeyDown={trackCapsLock}
            isDisabled={isPending}
            width="100%"
            status={mismatch ? { type: "error", message: mismatch } : undefined}
            statusVariant="detached"
            {...inputAttrs({
              autoComplete: "new-password",
              required: true,
              maxLength: PASSWORD_MAX_LENGTH,
              spellCheck: false,
            })}
          />
        ) : null}

        {/* Never disabled on invalid input: a button that does nothing when
            pressed teaches nobody what is wrong. Disabled only while the
            request is in flight, which is what stops a double submit. */}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          width="100%"
          label={isPending ? copy.pending : copy.submit}
          isLoading={isPending}
          isDisabled={isPending}
        />

        <Text type="supporting" role="status" aria-live="polite">
          {isPending ? copy.pendingAnnouncement : ""}
        </Text>
      </Stack>
    </form>
  );
}
