"use client";

import { useEffect } from "react";

import { ErrorState } from "@/ui/components/feedback/ErrorState";

/**
 * Route-level boundary: header/nav stay mounted, only this segment reports.
 * Catches render errors only — data errors surface through the query state.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Console is the only sink until the monitoring adapter lands (observability epic).
    // Never swallowed: the digest printed here matches the one shown to the operator.
    console.error("[ui] route render failed", {
      digest: error.digest,
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
  }, [error]);

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <ErrorState
        title="Không tải được nội dung"
        description="Trang gặp lỗi khi hiển thị. Dữ liệu của bạn vẫn an toàn — hãy thử lại. Nếu vẫn lỗi, gửi mã tham chiếu bên dưới cho quản trị viên."
        referenceCode={error.digest}
        onRetry={reset}
      />
    </main>
  );
}
