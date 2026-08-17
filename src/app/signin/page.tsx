import type { Metadata } from "next";

import { signIn } from "@/app/_auth/auth";
import { DEFAULT_RETURN_URL, safeReturnUrl } from "@/app/_auth/return-url";
import { Button } from "@/ui/components/ui/button";

/**
 * Sign-in page — a Server Component with a real `<form action>`, so it submits
 * even before the client bundle loads (web-auth-flows rule 5). It sits OUTSIDE
 * the middleware guard; putting it inside would redirect to itself forever.
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

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

export default async function SignInPage(props: PageProps<"/signin">) {
  const searchParams = await props.searchParams;
  const returnUrl = safeReturnUrl(firstParam(searchParams.returnUrl));
  const errorCode = firstParam(searchParams.error);
  const errorMessage = errorCode ? (ERROR_MESSAGES[errorCode] ?? GENERIC_ERROR_MESSAGE) : null;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">MYSP — Đăng bài tự động</h1>
        <p className="text-muted-foreground text-sm">
          Công cụ nội bộ. Đăng nhập bằng tài khoản Google thuộc tên miền đã được cấp quyền.
        </p>
      </header>

      {errorMessage ? (
        <div
          role="alert"
          className="border-destructive/30 bg-destructive/5 space-y-1 rounded-xl border p-4"
        >
          <p className="text-sm font-medium">Không đăng nhập được</p>
          <p className="text-muted-foreground text-sm">{errorMessage}</p>
          {errorCode && !ERROR_MESSAGES[errorCode] ? (
            <p className="text-muted-foreground/80 font-mono text-xs">Mã lỗi: {errorCode}</p>
          ) : null}
        </div>
      ) : null}

      <form
        action={async (formData: FormData) => {
          "use server";
          // signIn() throws NEXT_REDIRECT — it must never sit inside try/catch,
          // or the redirect signal gets swallowed (web-data-fetching rule 4).
          const target = safeReturnUrl(formData.get("returnUrl"));
          await signIn("google", { redirectTo: target });
        }}
        className="space-y-3"
      >
        <input type="hidden" name="returnUrl" value={returnUrl} />
        <Button type="submit" size="lg" className="w-full">
          Đăng nhập bằng Google
        </Button>
        {returnUrl !== DEFAULT_RETURN_URL ? (
          <p className="text-muted-foreground text-xs">
            Sau khi đăng nhập, bạn sẽ quay lại: <span className="font-mono">{returnUrl}</span>
          </p>
        ) : null}
      </form>

      {/* E5.2 — the same round trip signs the operator in AND brings back the
          Page tokens, so a successful Facebook sign-in leaves the channels
          already connected. Full-page redirect, never a popup: popups are
          blocked often enough that they need a fallback anyway
          (web-auth-methods rule 1). */}
      <form
        action={async (formData: FormData) => {
          "use server";
          const target = safeReturnUrl(formData.get("returnUrl"));
          await signIn("facebook", { redirectTo: target });
        }}
        className="space-y-3"
      >
        <input type="hidden" name="returnUrl" value={returnUrl} />
        <Button type="submit" size="lg" variant="outline" className="w-full">
          Đăng nhập bằng Facebook
        </Button>
        <p className="text-muted-foreground text-xs">
          Dành cho tài khoản đã được cấp quyền. Đăng nhập xong, danh sách Fanpage được lấy về luôn.
        </p>
      </form>
    </main>
  );
}
