"use client";

import Link from "next/link";
import { ArrowLeft, RefreshCw, CheckCircle2, History, PenSquare, Copy, Check } from "lucide-react";

import { BatchChannelTable } from "@/ui/components/batch/BatchChannelTable";
import { BatchStatusSkeleton } from "@/ui/components/batch/BatchStatusSkeleton";
import { BatchSummaryCard } from "@/ui/components/batch/BatchSummaryCard";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { Button } from "@/ui/components/ui/button";
import { copyStatusMessage, useCopyToClipboard } from "@/ui/hooks/useCopyToClipboard";
import { useBatchStatus } from "@/ui/hooks/usePostBatch";
import { useChannels } from "@/ui/hooks/useChannels";
import { useActiveTenant } from "@/ui/hooks/useMe";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { isSettledBatchStatus } from "@/ui/schemas/post-batch.schema";

export function BatchStatusScreen({ batchId }: { batchId: string }) {
  const batch = useBatchStatus(batchId);
  const channels = useChannels();
  const { tenantId } = useActiveTenant();
  const clipboard = useCopyToClipboard("batch", { tenant_id: tenantId, batch_id: batchId });

  const isFirstLoad = batch.isPending && batch.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  const data = batch.data;
  const settled = data ? isSettledBatchStatus(data.status) : false;

  return (
    <section className="flex flex-col gap-6" aria-labelledby="batch-heading">
      {/* Header & Breadcrumbs */}
      <header className="flex flex-col gap-2 border-b border-border/60 pb-5">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/posts?tab=log"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-3.5" />
            <span>Quay lại Nhật ký bài đăng</span>
          </Link>

          {/* Live indicator chip */}
          {data && (
            <div className="flex items-center gap-2">
              {settled ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-leaf/15 px-2.5 py-0.5 font-mono text-[11px] font-medium text-leaf-deep">
                  <CheckCircle2 className="size-3" />
                  Lô đã hoàn thành
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-0.5 font-mono text-[11px] font-medium text-primary">
                  <span className="relative flex size-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex size-2 rounded-full bg-primary" />
                  </span>
                  Tự động cập nhật
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex flex-col gap-1">
            <h1 id="batch-heading" className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
              Theo dõi tiến độ lô đăng
            </h1>
            <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Mỗi kênh là một tác vụ độc lập — lỗi tại một kênh sẽ không ảnh hưởng tới các kênh khác. Bạn có thể đóng tab hoặc chia sẻ link này cho thành viên khác, lô vẫn tiếp tục chạy trên máy chủ.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void clipboard.copy(window.location.href)}
              className="gap-1.5 text-xs"
            >
              {clipboard.state === "copied" ? (
                <Check className="size-3.5 text-leaf-deep" />
              ) : (
                <Copy className="size-3.5" />
              )}
              <span>{clipboard.state === "copied" ? "Đã chép link" : "Sao chép link"}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={batch.isFetching}
              onClick={() => void batch.refetch()}
              className="gap-1.5 text-xs"
            >
              <RefreshCw className={`size-3.5 ${batch.isFetching ? "animate-spin" : ""}`} />
              <span>Làm mới</span>
              <span className="sr-only"> trạng thái lô</span>
            </Button>
          </div>
        </div>

        {/* The copy outcome keeps its own region: sharing one with the batch
            state meant a failed copy hid the state, or the next poll wiped the
            failure before it was read. */}
        <p role="status" aria-live="polite" className="text-muted-foreground text-xs">
          {copyStatusMessage(clipboard.state, "link theo dõi")}
        </p>
      </header>

      {/* Live region: a screen reader hears the outcome without re-reading the
          page — this screen polls, so a change has no other way to be heard.
          What it must NOT announce is the poll itself: `isFetching` flips every
          3–8s (usePostBatch), and reading a sentence out loud that often makes
          the screen unusable. Only states that CHANGE something are here; the
          spinner on the refresh button covers "đang tải". */}
      <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
        {batch.isError
          ? "Không đọc được trạng thái lô."
          : !data
            ? "Đang tải trạng thái lô…"
            : settled
              ? "Lô đã kết thúc — trang dừng tự cập nhật."
              : "Trang tự cập nhật vài giây một lần khi còn bài đang chạy."}
      </p>

      {/* Loading Skeleton */}
      {isFirstLoad ? (showSkeleton ? <BatchStatusSkeleton /> : null) : null}

      {/* Error state */}
      {batch.isError && !data ? (
        <ApiErrorNotice
          error={batch.error}
          onRetry={() => void batch.refetch()}
          extraAction={
            <Button asChild variant="outline">
              <Link href="/posts?tab=log">Mở nhật ký bài đăng</Link>
            </Button>
          }
        />
      ) : null}

      {data ? (
        <div className="flex flex-col gap-6">
          {/* Stale data alert */}
          {batch.isError && (
            <div
              role="status"
              className="rounded-lg border border-turmeric/50 bg-turmeric/10 p-3 text-xs text-turmeric-deep"
            >
              Lần cập nhật gần nhất thất bại — bảng bên dưới đang hiển thị dữ liệu đã lưu trước đó. Vui lòng bấm “Làm mới” để thử lại.
            </div>
          )}

          {/* Summary Card with Stat Tape */}
          <BatchSummaryCard batch={data} />

          {/* Channels Table */}
          {data.channels.length === 0 ? (
            <EmptyState
              kind="no-result"
              title="Lô này không có kênh nào"
              description="Không tìm thấy bài đăng nào được tạo cho lô này. Vui lòng kiểm tra lại cấu hình."
              action={
                <Button asChild variant="outline">
                  <Link href="/compose">Về màn Soạn bài</Link>
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-4">
              {channels.isError && (
                <p className="text-xs text-muted-foreground">
                  * Không tải được danh sách tên Page nên cột Kênh đang hiển thị mã kênh. Kết quả đăng bài của từng kênh vẫn chính xác.
                </p>
              )}
              <BatchChannelTable
                channels={data.channels}
                progressSteps={data.progressSteps}
                tenantChannels={channels.data?.channels}
              />
            </div>
          )}

          {/* Bottom Navigation Actions */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/80 pt-5">
            <div className="flex items-center gap-2">
              <Button asChild variant="outline" size="sm" className="gap-1.5 text-xs">
                <Link href={`/posts?tab=log&batchId=${encodeURIComponent(data.batchId)}`}>
                  <History className="size-3.5" />
                  <span>Xem trong Nhật ký</span>
                </Link>
              </Button>
              <Button asChild variant="ghost" size="sm" className="gap-1.5 text-xs">
                <Link href="/compose">
                  <PenSquare className="size-3.5" />
                  <span>Soạn bài mới</span>
                </Link>
              </Button>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={batch.isFetching}
              onClick={() => void batch.refetch()}
              className="gap-1.5 text-xs"
            >
              <RefreshCw className={`size-3.5 ${batch.isFetching ? "animate-spin" : ""}`} />
              <span>{batch.isFetching ? "Đang tải…" : "Làm mới kết quả"}</span>
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
