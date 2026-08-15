import { presentApiError, type ApiErrorView } from "@/ui/components/feedback/present-api-error";
import { ApiError } from "@/ui/services/api-error";

/**
 * Pre-flight warning for the one config gap that is invisible on the read path.
 *
 * Without `TENANT_SECRETS_ENC_KEY` the server can still LIST channels (nothing
 * is unsealed to do that), so the screen looks perfectly healthy — while every
 * write fails. An operator would paste a token, wait, and only then find out.
 *
 * Rather than writing a second sentence for the same situation, this rebuilds
 * the exact `ApiError` the server raises on the first write and runs it through
 * `presentApiError`, whose `isSystemConfigError` branch already owns the copy.
 * Warning-before and failure-after therefore say the same thing, always.
 */

/** Mirrors the env var name parsed by composition/config.ts. */
export const TENANT_SECRETS_ENC_KEY = "TENANT_SECRETS_ENC_KEY";

function secretsNotConfiguredError(): ApiError {
  return new ApiError({
    code: "INVALID_INPUT",
    status: 400,
    message: `${TENANT_SECRETS_ENC_KEY} is not configured on the server`,
    userMessage:
      "Máy chủ chưa khai báo khoá mã hoá, nên chưa lưu được kênh nào cho đơn vị này.",
    // The env var name in `path` is what makes `isSystemConfigError` fire.
    issues: [
      {
        path: TENANT_SECRETS_ENC_KEY,
        message: "Chưa khai báo khoá mã hoá bí mật của đơn vị.",
      },
    ],
  });
}

/** Title / description / hint, identical to what a failed write would show. */
export function secretsNotConfiguredView(): ApiErrorView {
  return presentApiError(secretsNotConfiguredError());
}

/**
 * One short line for a tooltip on a disabled control. A control that is dead
 * without saying why is worse than one that fails loudly (core-feedback-states:
 * every message has a way out), so this is required wherever we disable.
 */
export function secretsNotConfiguredReason(): string {
  const view = secretsNotConfiguredView();
  return view.hint ?? view.description;
}
