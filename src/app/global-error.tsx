"use client";

import { useEffect } from "react";

import { ErrorState } from "@/ui/components/feedback/ErrorState";

import "./globals.css";

/**
 * App-root boundary: replaces the root layout, so it renders its own html/body
 * and imports the stylesheet itself. Only fires when the layout itself throws.
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
        <ErrorState
          title="Ứng dụng gặp sự cố"
          description="Hệ thống không khởi động được giao diện. Hãy tải lại trang. Nếu vẫn lỗi, gửi mã tham chiếu bên dưới cho quản trị viên."
          referenceCode={error.digest}
          onRetry={reset}
          retryLabel="Tải lại"
        />
      </body>
    </html>
  );
}
