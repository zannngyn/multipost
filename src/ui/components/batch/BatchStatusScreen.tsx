"use client";

import Link from "next/link";

import { BatchChannelTable } from "@/ui/components/batch/BatchChannelTable";
import { BatchStatusSkeleton } from "@/ui/components/batch/BatchStatusSkeleton";
import { BatchSummaryCard } from "@/ui/components/batch/BatchSummaryCard";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { Button } from "@/ui/components/ui/button";
import { useBatchStatus } from "@/ui/hooks/usePostBatch";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { isSettledBatchStatus } from "@/ui/schemas/post-batch.schema";

/**
 * "Theo dõi lô đăng" (E7.5): component -> hook -> service -> internal API
 * (docs/07 §4.1). The browser never talks to Graph API; it polls the DB read
 * model through our own endpoint (business rule: no long-held connection).
 *
 * The four mandatory states (core-feedback-states):
 *   loading — skeleton of the real layout, delayed 300ms
 *   data    — summary card + per-channel table, refreshed while jobs move
 *   empty   — a batch with no channel row at all (nothing was fanned out)
 *   error   — 400 "không tìm thấy lô" (no retry button — retrying repeats it)
 *             vs 5xx (retryable), told apart by `presentApiError`
 *   stale   — a background refetch keeps the table on screen and shows a thin
 *             "đang cập nhật" line instead of blanking it
 */
export function BatchStatusScreen({ batchId }: { batchId: string }) {
  const batch = useBatchStatus(batchId);

  const isFirstLoad = batch.isPending && batch.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  const data = batch.data;
  const settled = data ? isSettledBatchStatus(data.status) : false;

  return (
    <section className="space-y-6" aria-labelledby="batch-heading">
      <header className="space-y-1">
        {/* Way back up: a batch is opened from the hub (or from a link in a
            support thread) and had no exit but the browser's Back button. */}
        <Link
          href="/posts?tab=log"
          className="text-muted-foreground hover:text-foreground inline-block text-sm"
        >
          <span aria-hidden="true">← </span>Bài đăng
        </Link>
        <h1 id="batch-heading" className="text-2xl font-semibold tracking-tight">
          Theo dõi lô đăng
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Mỗi kênh là một bài riêng: một kênh lỗi không làm dừng kênh khác. Trang này đọc trạng thái
          từ hệ thống, bạn có thể đóng tab — lô vẫn chạy tiếp.
        </p>
      </header>

      {/* Live region: a screen reader hears the outcome without re-reading the page. */}
      <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
        {batch.isError
          ? "Không đọc được trạng thái lô."
          : !data
            ? "Đang tải trạng thái lô…"
            : settled
              ? "Lô đã kết thúc — trang dừng tự cập nhật."
              : batch.isFetching
                ? "Đang cập nhật…"
                : "Trang tự cập nhật vài giây một lần khi còn bài đang chạy."}
      </p>

      {isFirstLoad ? showSkeleton ? <BatchStatusSkeleton /> : null : null}

      {batch.isError && !data ? (
        <ApiErrorNotice
          error={batch.error}
          onRetry={() => void batch.refetch()}
          extraAction={
            <Button asChild variant="outline">
              <Link href="/posts?tab=log">Mở nhật ký đăng bài</Link>
            </Button>
          }
        />
      ) : null}

      {data ? (
        <>
          {/* A stale-but-visible error: keep the last known table, say it is old. */}
          {batch.isError ? (
            <p
              role="status"
              className="border-warning/40 bg-warning/10 text-warning-foreground rounded-lg border px-3 py-2 text-sm"
            >
              Lần cập nhật gần nhất thất bại — bảng bên dưới là dữ liệu cũ. Bấm “Tải lại” để thử
              lại.
            </p>
          ) : null}

          <BatchSummaryCard batch={data} />

          {data.channels.length === 0 ? (
            <EmptyState
              kind="no-result"
              title="Lô này không có kênh nào"
              description="Không có bài nào được tạo cho lô này. Hãy soạn lại bài và chọn ít nhất một kênh trước khi tạo lô."
              action={
                <Button asChild variant="outline">
                  <Link href="/compose">Về màn soạn bài</Link>
                </Button>
              }
            />
          ) : (
            <BatchChannelTable channels={data.channels} progressSteps={data.progressSteps} />
          )}

          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={() => void batch.refetch()}>
              Tải lại
            </Button>
            <Button asChild variant="ghost">
              <Link href={`/posts?tab=log&batchId=${encodeURIComponent(data.batchId)}`}>
                Xem nhật ký của lô này
              </Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/compose">Soạn bài khác</Link>
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
