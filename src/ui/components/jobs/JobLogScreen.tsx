"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { RefreshCw, Search, CheckCircle2, X } from "lucide-react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { JobLogSkeleton } from "@/ui/components/jobs/JobLogSkeleton";
import { filterJobsBySearch } from "@/ui/components/jobs/job-log-search";
import { JobLogTable } from "@/ui/components/jobs/JobLogTable";
import { POSTS_TAB_PARAM, withTabParam } from "@/ui/components/posts/posts-tabs";
import { RulesDisclosure } from "@/ui/components/posts/RulesDisclosure";
import { WorkerHealthBanner } from "@/ui/components/jobs/WorkerHealthBanner";
import { presentWorkerHealth } from "@/ui/components/jobs/present-worker-health";
import { Button } from "@/ui/components/ui/button";
import { useChannels } from "@/ui/hooks/useChannels";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import { usePostJobLog, useRetryPostJob } from "@/ui/hooks/usePostJobs";
import { useWorkerHealth } from "@/ui/hooks/useWorkerHealth";
import {
  POST_JOB_STATUSES,
  POST_JOB_STATUS_LABELS,
  jobLogSearchParams,
  parseJobLogFilter,
  type PostJobStatus,
} from "@/ui/schemas/post-batch.schema";

export function JobLogScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchId = useId();
  /**
   * Deliberately NOT in the URL, unlike the status filter beside it: this box
   * searches the pages ALREADY LOADED, so a shared link carrying it would
   * reopen on a different set of pages and show a different answer. The line
   * under the box says so out loud — see `searchScopeNote` below.
   */
  const [localSearch, setLocalSearch] = useState("");

  const filter = useMemo(
    () => parseJobLogFilter(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const log = usePostJobLog(filter);
  const retry = useRetryPostJob();
  const channels = useChannels();
  const readOnlyReason = useReadOnlyReason();

  const workerHealth = useWorkerHealth();
  const healthNotice = presentWorkerHealth({
    health: workerHealth.data,
    hasError: workerHealth.isError,
  });
  const [retryNotice, setRetryNotice] = useState<string | null>(null);

  const isFirstLoad = log.isPending && log.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  const rawItems = useMemo(() => log.data?.pages.flatMap((page) => page.items) ?? [], [log.data]);
  const hasFilter = filter.status !== null || filter.batchId !== null;

  // Over the loaded pages only — see `job-log-search.ts` for why that is said
  // out loud on screen instead of being hidden behind a plausible empty state.
  const items = useMemo(() => filterJobsBySearch(rawItems, localSearch), [rawItems, localSearch]);

  function applyStatus(status: PostJobStatus | null) {
    const params = jobLogSearchParams({ ...filter, status });
    const query = withTabParam(params.toString(), searchParams.get(POSTS_TAB_PARAM));
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function clearBatchFilter() {
    const params = jobLogSearchParams({ ...filter, batchId: null });
    const query = withTabParam(params.toString(), searchParams.get(POSTS_TAB_PARAM));
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function clearFilters() {
    setLocalSearch("");
    const query = withTabParam("", searchParams.get(POSTS_TAB_PARAM));
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function handleRetry(postJobId: string) {
    setRetryNotice(null);
    retry.mutate(
      { postJobId },
      {
        onSuccess: (result) => setRetryNotice(result.userMessage),
        onError: () => setRetryNotice(null),
      },
    );
  }

  return (
    <section className="flex flex-col gap-6" aria-labelledby="jobs-heading">
      {/* Header */}
      <header className="flex flex-col gap-1.5 border-b border-border/60 pb-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="jobs-heading" className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">
            Nhật ký đăng bài
          </h2>
          {/* "đã tải", not "đã ghi nhận": this is the number of rows fetched so
              far, not the tenant's total — the list is paged. */}
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {rawItems.length} bài đã tải
          </span>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed max-w-3xl">
          Theo dõi lịch sử từng bài đăng trên từng kênh Facebook. Bạn có thể mở bài đã đăng, xem lý do bài lỗi và chạy lại riêng từng kênh.
        </p>
      </header>

      {/* Rules Disclosure */}
      <RulesDisclosure>
        <p>
          Tồn kho được kiểm tra lại ngay trước khi đăng, kể cả khi chạy lại — một mã vừa hết hàng sẽ bị chặn thay vì lên bài.
        </p>
        <p>
          Bài ở trạng thái “Facebook giữ lịch” đã nằm trên Facebook và Facebook sẽ tự đăng vào giờ đã hẹn; hệ thống chỉ theo dõi và cập nhật lại kết quả.
        </p>
        <p>
          Một bài đăng lên nhiều kênh với cùng kết quả được gộp thành một dòng “× N kênh”. Mở dòng đó để xem từng kênh, mở bài trên Facebook hoặc chạy lại riêng.
        </p>
      </RulesDisclosure>

      {/* Worker Health Banner */}
      <WorkerHealthBanner
        notice={healthNotice}
        onRecheck={() => void workerHealth.refetch()}
        isChecking={workerHealth.isFetching}
      />

      {/* Filter & Search Bar */}
      <div className="flex flex-col gap-3 rounded-xl border border-border/80 bg-card p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Status Filter Buttons */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground mr-1">
              Trạng thái:
            </span>
            <button
              type="button"
              onClick={() => applyStatus(null)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                filter.status === null
                  ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                  : "bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              Tất cả
            </button>
            {POST_JOB_STATUSES.map((status) => {
              const isSelected = filter.status === status;
              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => applyStatus(status)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    isSelected
                      ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                      : "bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                >
                  {POST_JOB_STATUS_LABELS[status]}
                </button>
              );
            })}
          </div>

          {/* Search Box & Refresh */}
          <div className="flex items-center gap-2">
            <div className="relative">
              <label htmlFor={searchId} className="sr-only">
                Tìm trong {rawItems.length} bài đã tải
              </label>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                id={searchId}
                type="text"
                value={localSearch}
                onChange={(e) => setLocalSearch(e.target.value)}
                placeholder="Tìm mã SP, kênh, lỗi..."
                className="h-8 w-44 rounded-lg border border-border/80 bg-card pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary md:w-56"
              />
              {localSearch && (
                <button
                  type="button"
                  onClick={() => setLocalSearch("")}
                  title="Xoá từ khoá tìm kiếm"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                  <span className="sr-only">Xoá từ khoá tìm kiếm</span>
                </button>
              )}
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void log.refetch();
                void workerHealth.refetch();
              }}
              disabled={log.isFetching}
              className="gap-1.5 text-xs h-8"
            >
              <RefreshCw className={`size-3.5 ${log.isFetching ? "animate-spin" : ""}`} />
              <span>{log.isFetching ? "Đang tải…" : "Làm mới"}</span>
            </Button>
          </div>
        </div>

        {/* Active Filter Tags */}
        {(filter.batchId || hasFilter || localSearch) && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
            <span className="text-xs text-muted-foreground">Đang lọc:</span>

            {filter.batchId && (
              <span className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-accent/30 px-2.5 py-0.5 font-mono text-xs text-primary">
                <span>Lô: {filter.batchId}</span>
                <Link
                  href={`/batches/${encodeURIComponent(filter.batchId)}`}
                  className="ml-1 text-primary underline underline-offset-2 hover:opacity-80"
                  title="Mở chi tiết lô này"
                >
                  (chi tiết)
                </Link>
                <button
                  type="button"
                  onClick={clearBatchFilter}
                  className="ml-1 hover:text-madder"
                  title="Bỏ lọc theo lô"
                >
                  <X className="size-3" />
                </button>
              </span>
            )}

            {filter.status && (
              <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-2 py-0.5 text-xs text-foreground">
                <span>Trạng thái: {POST_JOB_STATUS_LABELS[filter.status]}</span>
                <button
                  type="button"
                  onClick={() => applyStatus(null)}
                  className="hover:text-madder"
                >
                  <X className="size-3" />
                </button>
              </span>
            )}

            {localSearch && (
              <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-2 py-0.5 text-xs text-foreground">
                <span>Từ khóa: “{localSearch}”</span>
                <button
                  type="button"
                  onClick={() => setLocalSearch("")}
                  className="hover:text-madder"
                >
                  <X className="size-3" />
                </button>
              </span>
            )}

            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 ml-1"
            >
              Xóa tất cả bộ lọc
            </button>
          </div>
        )}
      </div>

      {/* Success Notification after Retry */}
      {retryNotice && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-lg border border-leaf/40 bg-leaf/10 p-3 text-xs font-medium text-leaf-deep"
        >
          <CheckCircle2 className="size-4 shrink-0" />
          <span>{retryNotice}</span>
        </div>
      )}

      {retry.isError && (
        <ApiErrorNotice error={retry.error} onRetry={() => void log.refetch()} />
      )}

      {/* Loading Skeleton */}
      {isFirstLoad ? (showSkeleton ? <JobLogSkeleton /> : null) : null}

      {/* Query Error */}
      {log.isError && items.length === 0 ? (
        <ApiErrorNotice error={log.error} onRetry={() => void log.refetch()} />
      ) : null}

      {/* A failed page fetch WITH rows already on screen used to show nothing at
          all: the spinner stopped and the screen went on claiming the list was
          complete — including inside the "chưa thấy … trong N bài đã tải" empty
          state, which then tells the operator to load more that cannot load.
          Same answer the batch screen gives: keep what is on screen, say it is
          incomplete. */}
      {log.isError && items.length > 0 ? (
        <p
          role="status"
          className="rounded-lg border border-turmeric/50 bg-turmeric/10 p-3 text-xs text-turmeric-deep"
        >
          Lần tải gần nhất thất bại — danh sách bên dưới có thể còn thiếu bài cũ hơn. Bấm “Làm
          mới” để thử lại.
        </p>
      ) : null}

      {/* Empty States */}
      {!isFirstLoad && !log.isError && items.length === 0 ? (
        hasFilter || localSearch ? (
          <EmptyState
            kind="no-result"
            title={
              localSearch && log.hasNextPage
                ? `Chưa thấy “${localSearch.trim()}” trong ${rawItems.length} bài đã tải`
                : "Không có bài đăng nào khớp bộ lọc"
            }
            description={
              // The search only sees the pages already fetched. Saying "không có
              // bài nào khớp" over a paged list is a false negative: the code may
              // sit in a page nobody has asked for yet, and this screen is the one
              // that must answer "vì sao bài này không lên".
              localSearch && log.hasNextPage
                ? "Ô tìm kiếm chỉ tìm trong các bài đã tải về. Bấm “Tải thêm các bài cũ hơn” rồi tìm lại, hoặc xoá bộ lọc để xem toàn bộ."
                : "Không tìm thấy bài nào ở trạng thái hoặc từ khóa đang chọn. Dữ liệu vẫn còn nguyên — bấm bên dưới để hiển thị toàn bộ."
            }
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {localSearch && log.hasNextPage ? (
                  <Button
                    type="button"
                    onClick={() => void log.fetchNextPage()}
                    disabled={log.isFetchingNextPage}
                  >
                    {log.isFetchingNextPage ? "Đang tải thêm…" : "Tải thêm các bài cũ hơn"}
                  </Button>
                ) : null}
                <Button type="button" variant="outline" onClick={clearFilters}>
                  Xóa bộ lọc
                </Button>
              </div>
            }
          />
        ) : (
          <EmptyState
            kind="first-run"
            title="Chưa có bài đăng nào"
            description="Chưa có lô đăng nào được tạo cho đơn vị này. Soạn một bài, chọn kênh rồi bấm “Tạo lô đăng” — mọi bài sẽ xuất hiện ở đây."
            action={
              <Button asChild>
                <Link href="/compose">Soạn bài mới</Link>
              </Button>
            }
          />
        )
      ) : null}

      {/* Log Data Table */}
      {items.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
              Đang hiển thị{" "}
              <strong className="font-mono text-foreground font-semibold">
                {items.length.toLocaleString("vi-VN")}
              </strong>{" "}
              bài
              {log.hasNextPage ? " (còn dữ liệu cũ hơn)" : ""}
              {localSearch
                ? ` — tìm “${localSearch.trim()}” trong ${rawItems.length} bài đã tải`
                : ""}
              .
            </p>
            {channels.isError && (
              <span className="text-xs text-turmeric-deep">
                * Đang hiển thị mã kênh thay cho tên Page do không tải được danh mục kênh.
              </span>
            )}
          </div>

          <JobLogTable
            items={items}
            onRetry={handleRetry}
            retryingJobId={retry.isPending ? (retry.variables?.postJobId ?? null) : null}
            channels={channels.data?.channels}
            readOnlyReason={readOnlyReason}
          />

          {/* Pagination */}
          {log.hasNextPage ? (
            <div className="flex justify-center pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void log.fetchNextPage()}
                disabled={log.isFetchingNextPage}
                className="gap-2"
              >
                {log.isFetchingNextPage ? (
                  <>
                    <RefreshCw className="size-3.5 animate-spin" />
                    <span>Đang tải thêm...</span>
                  </>
                ) : (
                  <span>Tải thêm các bài cũ hơn</span>
                )}
              </Button>
            </div>
          ) : (
            <p className="text-center text-xs text-muted-foreground py-2 font-mono">
              — Đã tải toàn bộ danh sách —
            </p>
          )}
        </div>
      )}
    </section>
  );
}
