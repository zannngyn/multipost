"use client";

import { Theme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { useEffect } from "react";

import { ErrorState } from "@/ui/components/feedback/ErrorState";

import "./globals.css";

/**
 * App-root boundary: replaces the root layout, so it renders its own html/body
 * and imports the stylesheet itself. Only fires when the layout itself throws.
 *
 * It therefore never sees `app/providers.tsx`, which is where Theme lives for
 * every other route. Without the wrapper below, `ErrorState`'s Banner and
 * Button would render in the Astryx core default accent (`#0074e2`) — the one
 * screen where an operator meets an unfamiliar colour would be the one telling
 * them something broke. No LinkProvider: nothing in this tree navigates.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ui] app root render failed", {
      digest: error.digest,
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
  }, [error]);

  return (
    <html lang="vi" className="h-full antialiased">
      <body className="bg-background text-foreground flex min-h-full items-center justify-center px-6 py-16">
        <Theme theme={neutralTheme}>
          <ErrorState
            title="Ứng dụng gặp sự cố"
            description="Hệ thống không khởi động được giao diện. Hãy tải lại trang. Nếu vẫn lỗi, gửi mã tham chiếu bên dưới cho quản trị viên."
            referenceCode={error.digest}
            onRetry={reset}
            retryLabel="Tải lại"
          />
        </Theme>
      </body>
    </html>
  );
}
