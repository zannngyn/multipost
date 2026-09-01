import {
  OnboardingProfilePatchSchema,
  OnboardingProfileSchema,
  type OnboardingProfilePatch,
  type OnboardingProfileView,
} from "@/ui/schemas/onboarding-profile.schema";

import { ApiError } from "./api-error";
import { apiRequest } from "./http-client";

/**
 * Data layer of the onboarding survey (docs/07 §4.1): one resource, three
 * verbs, and nothing else in this file knows what a screen is.
 *
 *   GET    read the answers, so a half-finished flow reopens where it stopped
 *   PATCH  save ONE step, the moment "Tiếp tục" is pressed
 *   POST   finish the survey. No body, idempotent.
 *
 * WRITES ARE NEVER AUTO-RETRIED — that decision belongs to the hooks above, but
 * it is worth saying here why: PATCH is idempotent per field and POST keeps the
 * first `completed_at`, so a retry is SAFE; it is simply not automatic, because
 * an operator who is watching a spinner deserves to be told when a save failed
 * rather than have it silently re-attempted behind an unchanged screen.
 */

const ROUTE = "/api/tenants/onboarding-profile";

/** Query keys carry the tenant key so cached answers cannot cross tenants. */
export const onboardingProfileKeys = {
  profile: (tenantKey: string) => ["onboarding-profile", tenantKey] as const,
};

const MALFORMED =
  "Dữ liệu khảo sát không đúng định dạng. Hãy tải lại trang; nếu vẫn lỗi, báo quản trị viên.";

export async function fetchOnboardingProfile(signal?: AbortSignal): Promise<OnboardingProfileView> {
  return apiRequest(ROUTE, {
    schema: OnboardingProfileSchema,
    signal,
    malformedMessage: MALFORMED,
  });
}

/**
 * Save one step. The server answers with the WHOLE profile as stored, which is
 * what the hook writes back into the cache — no second read, and no chance of
 * the screen believing something the row does not say.
 *
 * The patch is validated HERE, before the request: `PATCH {}` is a 400 the
 * operator can do nothing about, an unknown key is a typo that must not look
 * like a successful save, and a code outside the vocabulary is a bug in a card.
 * Catching all three locally turns "máy chủ từ chối" into a refusal that names
 * itself, and saves a round trip (`createTenant` guards its own name the same
 * way).
 */
export async function saveOnboardingStep(
  patch: OnboardingProfilePatch,
  signal?: AbortSignal,
): Promise<OnboardingProfileView> {
  const parsed = OnboardingProfilePatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new ApiError({
      code: "INVALID_INPUT",
      status: 0,
      message: `saveOnboardingStep refused a patch: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "patch"}: ${issue.message}`)
        .join("; ")}`,
      userMessage: "Câu trả lời này không gửi đi được. Hãy tải lại trang rồi chọn lại.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "patch",
        message: issue.message,
      })),
    });
  }

  return apiRequest(ROUTE, {
    method: "PATCH",
    /**
     * `parsed.data`, not the caller's object: zod hands back exactly the keys
     * the contract knows, so `null` stays `null` and `[]` stays `[]` (the two
     * are different facts — see `onboarding-answers.ts`).
     */
    body: parsed.data,
    schema: OnboardingProfileSchema,
    signal,
    malformedMessage: MALFORMED,
  });
}

/**
 * Finish the survey. No body on purpose: the answers were already saved step by
 * step, and there is nothing left to say beyond "the operator reached the end".
 */
export async function completeOnboarding(signal?: AbortSignal): Promise<OnboardingProfileView> {
  return apiRequest(ROUTE, {
    method: "POST",
    schema: OnboardingProfileSchema,
    signal,
    malformedMessage:
      "Không đọc được kết quả hoàn tất khảo sát. Hãy tải lại trang để xem đã xong chưa.",
  });
}
