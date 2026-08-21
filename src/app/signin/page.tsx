import type { Metadata } from "next";

import { signIn } from "@/app/_auth/auth";
import { DEFAULT_RETURN_URL, safeReturnUrl } from "@/app/_auth/return-url";
import { SignInScreen } from "@/ui/components/auth/SignInScreen";

/**
 * Sign-in page — a thin Server Component: read the query string, turn it into
 * Vietnamese, hand two Server Actions to the screen.
 *
 * It sits OUTSIDE the middleware guard; putting it inside would redirect to
 * itself forever.
 */

export const metadata: Metadata = {
  title: "Đăng nhập — MYSP",
  robots: { index: false, follow: false },
};

/** Never cache: the page reflects per-request query params. */
export const dynamic = "force-dynamic";

/**
 * Auth.js reports failures as `?error=<code>`. Anything unknown falls back to a
 * generic message — we never print the raw code as the main text.
 */
const ERROR_MESSAGES: Record<string, string> = {
  // Covers both gates, and the case where the operator simply pressed "Huỷ" at
  // the provider — declining is not a failure, so the wording stays neutral.
  AccessDenied:
    "Tài khoản này chưa được cấp quyền vào hệ thống, hoặc bạn đã huỷ ở bước cấp quyền. Với Google, hãy dùng email thuộc tên miền được phép; với Facebook, nhờ quản trị viên thêm tài khoản của bạn vào danh sách cho phép.",
  Verification:
    "Liên kết đăng nhập đã hết hạn hoặc đã được dùng. Hãy bấm “Đăng nhập bằng Google” để thử lại.",
  Configuration:
    "Cấu hình đăng nhập của hệ thống chưa đúng. Vui lòng liên hệ quản trị viên — người dùng không tự khắc phục được.",
  OAuthAccountNotLinked:
    "Email này đã được liên kết với một cách đăng nhập khác. Liên hệ quản trị viên để hợp nhất tài khoản.",
};

const GENERIC_ERROR_MESSAGE =
  "Không hoàn tất được đăng nhập. Hãy thử lại. Nếu vẫn lỗi, gửi mã bên dưới cho quản trị viên.";

/**
 * NOT a failure, and deliberately NOT painted red: the account was recognised
 * and recorded, it is simply waiting for an admin on /access. Someone who
 * reads "bị từ chối" here will go ask for a new account instead of waiting five
 * minutes (core-feedback-states: an error the user did not cause must not look
 * like their mistake).
 *
 * PENDING(pending-approval-param): the exact query value is owned by the auth
 * layer (`src/app/_auth/**`, another agent's file). `pending_approval` is the
 * agreed name; if the backend lands a different one, only this constant moves.
 */
const PENDING_APPROVAL_ERROR = "pending_approval";

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

/**
 * `signIn()` throws NEXT_REDIRECT — it must never sit inside try/catch, or the
 * redirect signal gets swallowed (web-data-fetching rule 4).
 *
 * `returnUrl` arrives from a hidden field the browser can edit, so it is
 * sanitised again here rather than trusted: this is the open-redirect gate
 * (web-frontend-security §6), and the client-side value is only a convenience.
 */
async function signInWithGoogle(formData: FormData) {
  "use server";
  const target = safeReturnUrl(formData.get("returnUrl"));
  await signIn("google", { redirectTo: target });
}

async function signInWithFacebook(formData: FormData) {
  "use server";
  const target = safeReturnUrl(formData.get("returnUrl"));
  await signIn("facebook", { redirectTo: target });
}

export default async function SignInPage(props: PageProps<"/signin">) {
  const searchParams = await props.searchParams;
  const returnUrl = safeReturnUrl(firstParam(searchParams.returnUrl));
  const errorCode = firstParam(searchParams.error);
  const isPendingApproval = errorCode === PENDING_APPROVAL_ERROR;
  const errorMessage =
    errorCode && !isPendingApproval ? (ERROR_MESSAGES[errorCode] ?? GENERIC_ERROR_MESSAGE) : null;
  // Only a code we could NOT translate is worth showing: printing "AccessDenied"
  // under a sentence that already explains it is noise.
  const unknownErrorCode =
    errorMessage && errorCode && !ERROR_MESSAGES[errorCode] ? errorCode : null;

  return (
    <main className="flex w-full flex-1">
      <SignInScreen
        returnUrl={returnUrl}
        isDefaultReturnUrl={returnUrl === DEFAULT_RETURN_URL}
        errorMessage={errorMessage}
        unknownErrorCode={unknownErrorCode}
        isPendingApproval={isPendingApproval}
        signInWithGoogle={signInWithGoogle}
        signInWithFacebook={signInWithFacebook}
      />
    </main>
  );
}
