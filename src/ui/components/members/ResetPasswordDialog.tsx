"use client";

import {
  Banner,
  Button,
  Dialog,
  DialogHeader,
  HStack,
  Stack,
  Text,
} from "@astryxdesign/core";
import type { TextInputProps } from "@astryxdesign/core";
import { useActionState, useEffect, useRef, useState } from "react";

import { PasswordHint } from "@/ui/components/auth/PasswordHint";
import { PasswordInput } from "@/ui/components/auth/PasswordInput";
import { PASSWORD_MAX_LENGTH } from "@/shared/password-policy";
import {
  authFailureHint,
  fieldErrorMessage,
  formErrorMessage,
  isSetPasswordFailure,
  newPasswordProblem,
  type SetPasswordAction,
} from "@/ui/schemas/password-auth.schema";

/**
 * "Đặt lại mật khẩu" — a platform super_admin sets a member's password by hand.
 *
 * WHY THIS EXISTS AT ALL: the product has no self-service reset. An operator who
 * forgets their password, or whose credential locks itself after too many wrong
 * tries, has exactly one way back in, and it is this dialog. That is also why
 * the sign-in screen's refusals point at "quản trị viên hệ thống" instead of at
 * a link.
 *
 * WHAT IT DOES NOT DO: it never shows an existing password (there is none to
 * show — only a hash), it never mails anything, and the value typed here lives
 * in this component's state and in the POST body, nowhere else: no URL, no
 * storage, no query key, no log. The action logs the two account ids and the
 * outcome, never the secret.
 *
 * The four states of the dialog: idle (form) · pending (submit is loading and
 * every input is read-only) · error (banner or field, with the way out) ·
 * success (a confirmation that says what has to happen next, since the person
 * still has to be TOLD the new password out of band).
 */

/**
 * Astryx `TextInput` forwards unknown props onto its `<input>` but types them
 * as `HTMLAttributes`, where `autoComplete`/`maxLength` are not declared. Same
 * commented cast as `PasswordAuthForm` and `ChannelConnectPanel`.
 *
 * `new-password` on both boxes: this is a password manager's cue to offer a
 * generated one, which is exactly what an admin setting somebody else's
 * password should be encouraged to use.
 */
function inputAttrs(attrs: {
  autoComplete: string;
  maxLength?: number;
  spellCheck?: boolean;
}): Partial<TextInputProps> {
  return attrs as unknown as Partial<TextInputProps>;
}

export function ResetPasswordDialog({
  isOpen,
  onOpenChange,
  action,
  memberName,
  memberAccountId,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** `setPasswordAction`, handed down by the page — `ui/` may not import `@/app/*`. */
  action: SetPasswordAction;
  /** Who this is about, said out loud in the title and in every message. */
  memberName: string;
  /** `Member.accountId`; travels in a hidden field and is re-checked server-side. */
  memberAccountId: string;
}) {
  const [state, formAction, isPending] = useActionState(action, null);

  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [isVisible, setIsVisible] = useState(false);
  /** True once "Đặt lại mật khẩu" has been pressed — see `localProblem`. */
  const [wasSubmitted, setWasSubmitted] = useState(false);

  const passwordRef = useRef<HTMLInputElement>(null);
  const isDone = state?.ok === true;

  const passwordError = fieldErrorMessage(state, "password");
  const bannerError = formErrorMessage(state);
  const hint = authFailureHint(state);

  /**
   * The client's own verdict, held back until the first submit
   * (core-form-architecture: `onTouched`, không báo đỏ khi mới gõ chữ đầu). It
   * is a convenience — the server applies the same rules from the same module
   * and has the last word.
   */
  const localProblem = wasSubmitted ? newPasswordProblem(password, confirmation) : null;

  /** A refusal puts the cursor back where the fix has to happen. */
  useEffect(() => {
    if (isSetPasswordFailure(state) && state.field === "password") passwordRef.current?.focus();
  }, [state]);

  function close() {
    onOpenChange(false);
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        // Never yanked away mid-request, and never by a stray backdrop click
        // while there is a typed secret in it (`purpose="form"` covers the
        // backdrop; this covers Escape during the write).
        if (!open && isPending) return;
        if (!open) close();
      }}
      purpose="form"
      width={520}
    >
      <DialogHeader
        title={`Đặt lại mật khẩu cho ${memberName}`}
        subtitle="Mật khẩu mới có hiệu lực ngay và mở luôn khoá đăng nhập nếu tài khoản đang bị khoá."
        onOpenChange={isPending ? undefined : () => close()}
      />

      <Stack direction="vertical" gap={3} padding={4}>
        {isDone ? (
          <Stack direction="vertical" gap={3}>
            <Banner
              status="success"
              role="status"
              title="Đã đặt lại mật khẩu"
              description={`${memberName} đăng nhập được ngay bằng mật khẩu mới. Hệ thống KHÔNG gửi mật khẩu đi đâu cả — bạn phải báo trực tiếp cho họ, và nhắc họ đổi lại sau khi vào được.`}
            />
            <HStack gap={2}>
              <Button variant="primary" label="Đóng" onClick={close} />
            </HStack>
          </Stack>
        ) : (
          /* A real <form action>: Enter submits and the whole thing is one
             request. `noValidate` — the wording comes from the shared policy,
             not from the browser (web-form-architecture rule 5). */
          <form action={formAction} noValidate onSubmit={() => setWasSubmitted(true)}>
            <Stack direction="vertical" gap={3}>
              <input type="hidden" name="accountId" value={memberAccountId} />

              <Stack direction="vertical" gap={1} role="alert" aria-live="assertive">
                {bannerError ? (
                  <Banner
                    status="error"
                    title="Chưa đặt lại được mật khẩu"
                    description={bannerError}
                  />
                ) : null}
                {localProblem && !bannerError && !passwordError ? (
                  <Banner status="error" title="Chưa gửi được" description={localProblem} />
                ) : null}
                {hint ? <Text type="supporting">{hint}</Text> : null}
              </Stack>

              <PasswordInput
                ref={passwordRef}
                label="Mật khẩu mới"
                isVisible={isVisible}
                onToggleVisibility={() => setIsVisible((visible) => !visible)}
                isRequired
                hasAutoFocus
                value={password}
                onChange={setPassword}
                htmlName="password"
                isDisabled={isPending}
                width="100%"
                status={passwordError ? { type: "error", message: passwordError } : undefined}
                statusVariant="detached"
                {...inputAttrs({
                  autoComplete: "new-password",
                  maxLength: PASSWORD_MAX_LENGTH,
                  spellCheck: false,
                })}
              />

              <PasswordHint value={password} />

              {/* Under the field rather than as its `description`: a
                  description would push the control down and take the show/hide
                  button with it (see PasswordInput). */}
              <Text type="supporting">
                Nên dùng mật khẩu do trình quản lý mật khẩu sinh ra.
              </Text>

              {/* Never submitted — the confirmation exists to catch a typo in a
                  password nobody else can read back. */}
              <PasswordInput
                label="Nhập lại mật khẩu mới"
                isVisible={isVisible}
                onToggleVisibility={() => setIsVisible((visible) => !visible)}
                isRequired
                value={confirmation}
                onChange={setConfirmation}
                isDisabled={isPending}
                width="100%"
                status={
                  confirmation.length > 0 && confirmation !== password
                    ? { type: "error", message: "Hai ô mật khẩu chưa khớp." }
                    : undefined
                }
                statusVariant="detached"
                {...inputAttrs({
                  autoComplete: "new-password",
                  maxLength: PASSWORD_MAX_LENGTH,
                  spellCheck: false,
                })}
              />

              <Text type="supporting">
                Mật khẩu này không được gửi qua email hay tin nhắn tự động. Bạn phải báo cho{" "}
                {memberName} bằng kênh an toàn.
              </Text>

              <HStack gap={2} align="center" wrap="wrap">
                {/* Not disabled on invalid input: pressing it is what reveals
                    what is still missing. */}
                <Button
                  type="submit"
                  variant="primary"
                  label="Đặt lại mật khẩu"
                  isLoading={isPending}
                  isDisabled={isPending}
                />
                <Button
                  type="button"
                  variant="ghost"
                  label="Huỷ"
                  isDisabled={isPending}
                  onClick={close}
                />
              </HStack>

              <Text type="supporting" role="status" aria-live="polite">
                {isPending ? "Đang đặt lại mật khẩu, vui lòng đợi" : ""}
              </Text>
            </Stack>
          </form>
        )}
      </Stack>
    </Dialog>
  );
}
