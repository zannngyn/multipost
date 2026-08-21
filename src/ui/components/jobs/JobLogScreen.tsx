"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { JobLogSkeleton } from "@/ui/components/jobs/JobLogSkeleton";
import { JobLogTable } from "@/ui/components/jobs/JobLogTable";
import { POSTS_TAB_PARAM, withTabParam } from "@/ui/components/posts/posts-tabs";
import { WorkerHealthBanner } from "@/ui/components/jobs/WorkerHealthBanner";
import { presentWorkerHealth } from "@/ui/components/jobs/present-worker-health";
import { Button } from "@/ui/components/ui/button";
import { Select } from "@/ui/components/ui/select";
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

/**
 * "Nhật ký đăng bài" (E11.1): component -> hook -> service -> internal API.
 *
 * The filter lives in the URL, not in `useState` (core-data-list-query rule 1):
 * `/jobs?status=blocked` is shareable, survives F5 and makes Back behave. One
 * builder (`jobLogSearchParams`) writes it, one parser reads it, and the query
 * key is derived from the same object — no second source of truth.
 *
 * The four mandatory states:
 *   loading — skeleton with the real 8 columns, delayed 300ms
 *   data    — table + "Tải thêm" (cursor, so no page numbers)
 *   empty   — told apart: "chưa có bài nào" (first run) vs "không có bài nào ở
 *             trạng thái này" (a filter is on) — the same box for both would
 *             make an operator think the data was lost
 *   error   — 4xx (sửa bộ lọc) vs 5xx (thử lại), via `presentApiError`
 *
 * On top of those sits a fifth thing the log cannot express by itself: a job
 * that is `queued` with no attempt and no error looks identical whether a
 * worker is about to take it or no worker exists at all. `WorkerHealthBanner`
 * answers that from a SEPARATE query, so a dead queue changes nothing about
 * the four states above — it only adds a sentence on top of them.
 */
export function JobLogScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const statusFilterId = useId();

  const filter = useMemo(
    () => parseJobLogFilter(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const log = usePostJobLog(filter);
  const retry = useRetryPostJob();
  /**
   * Names for the "Kênh" column. A THIRD independent query: if it fails, the
   * log still renders — the column falls back to the raw ids, which is exactly
   * what it showed before this query existed (core-feedback-states §Partial).
   */
  const channels = useChannels();
  // Support mode is read-only (M3.3): re-queueing a job posts to the customer's
  // Page. The table shows the button disabled with this sentence beside it.
  const readOnlyReason = useReadOnlyReason();

  // Separate query, separate failure: a job log that renders must not depend on
  // the health probe, and a dead queue must not blank the log (Partial state,
  // core-feedback-states §6).
  const workerHealth = useWorkerHealth();
  const healthNotice = presentWorkerHealth({
    health: workerHealth.data,
    hasError: workerHealth.isError,
  });
  const [retryNotice, setRetryNotice] = useState<string | null>(null);

  const isFirstLoad = log.isPending && log.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  const items = useMemo(() => log.data?.pages.flatMap((page) => page.items) ?? [], [log.data]);
  const hasFilter = filter.status !== null || filter.batchId !== null;

  function applyStatus(next: string) {
    const status = POST_JOB_STATUSES.includes(next as PostJobStatus)
      ? (next as PostJobStatus)
      : null;
    const params = jobLogSearchParams({ ...filter, status });
    // This screen rewrites the WHOLE query, so it has to carry the hub's
    // `?tab=` across — without it, changing a filter drops the tab and the next
    // server render sends the operator back to "Bài đã hẹn" mid-filter.
    const query = withTabParam(params.toString(), searchParams.get(POSTS_TAB_PARAM));
    // `replace`: changing a filter is not a navigation step to walk back to.
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function clearFilters() {
    // Clearing drops the filter, not the tab.
    const query = withTabParam("", searchParams.get(POSTS_TAB_PARAM));
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function handleRetry(postJobId: string) {
    setRetryNotice(null);
    retry.mutate(
      { postJobId },
      {
        onSuccess: (result) => setRetryNotice(result.userMessage),
        // The error itself is rendered by <ApiErrorNotice> below; this only
        // makes sure a stale success message never survives a failure.
        onError: () => setRetryNotice(null),
      },
    );
  }

  return (
    <section className="space-y-6" aria-labelledby="jobs-heading">
      <header className="space-y-1">
        {/* h2: since the wave-1 IA this screen is a TAB inside /posts, and the
            hub above it owns the page's h1 (core-accessibility §1). */}
        <h2 id="jobs-heading" className="text-2xl font-semibold tracking-tight">
          Nhật ký đăng bài
        </h2>
        <p className="text-muted-foreground max-w-prose text-sm">
          Mỗi dòng là một bài trên một kênh. Bài lỗi hoặc bị chặn có thể chạy lại — tồn kho vẫn được
          kiểm tra lại ngay trước khi đăng. Bài ở trạng thái “Facebook giữ lịch” đã nằm trên Facebook
          và Facebook sẽ tự đăng vào giờ đã hẹn, hệ thống chỉ theo dõi và cập nhật lại kết quả.
        </p>
      </header>

      <WorkerHealthBanner
        notice={healthNotice}
        onRecheck={() => void workerHealth.refetch()}
        isChecking={workerHealth.isFetching}
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 basis-64 space-y-1.5">
          <label htmlFor={statusFilterId} className="text-sm font-medium">
            Lọc theo trạng thái
          </label>
          <Select
            id={statusFilterId}
            value={filter.status ?? ""}
            onChange={(event) => applyStatus(event.target.value)}
          >
            <option value="">Tất cả trạng thái</option>
            {POST_JOB_STATUSES.map((status) => (
              <option key={status} value={status}>
                {POST_JOB_STATUS_LABELS[status]}
              </option>
            ))}
          </Select>
        </div>

        {filter.batchId ? (
          <p className="text-muted-foreground basis-full text-sm">
            Đang lọc theo lô{" "}
            <span className="font-mono text-xs break-all">{filter.batchId}</span>{" "}
            <Link
              href={`/batches/${encodeURIComponent(filter.batchId)}`}
              className="text-primary underline underline-offset-4"
            >
              (mở lô)
            </Link>
          </p>
        ) : null}

        {hasFilter ? (
          <Button type="button" variant="ghost" onClick={clearFilters}>
            Bỏ bộ lọc
          </Button>
        ) : null}

        <Button
          type="button"
          variant="outline"
          onClick={() => {
            // One button, both readings: an operator who just restarted the
            // publish worker expects "Tải lại" to clear the banner too.
            void log.refetch();
            void workerHealth.refetch();
          }}
          disabled={log.isFetching}
        >
          {log.isFetching ? "Đang tải…" : "Tải lại"}
        </Button>
      </div>

      {retryNotice ? (
        <p
          role="status"
          className="border-success/30 bg-success/10 text-success-foreground rounded-lg border px-3 py-2 text-sm"
        >
          {retryNotice}
        </p>
      ) : null}

      {retry.isError ? (
        <ApiErrorNotice error={retry.error} onRetry={() => void log.refetch()} />
      ) : null}

      {isFirstLoad ? showSkeleton ? <JobLogSkeleton /> : null : null}

      {log.isError && items.length === 0 ? (
        <ApiErrorNotice error={log.error} onRetry={() => void log.refetch()} />
      ) : null}

      {!isFirstLoad && !log.isError && items.length === 0 ? (
        hasFilter ? (
          <EmptyState
            kind="no-result"
            title="Không có bài nào khớp bộ lọc"
            description="Không có bài đăng nào ở trạng thái đang chọn. Dữ liệu vẫn còn nguyên — hãy bỏ bộ lọc để xem toàn bộ nhật ký."
            action={
              <Button type="button" variant="outline" onClick={clearFilters}>
                Bỏ bộ lọc
              </Button>
            }
          />
        ) : (
          <EmptyState
            kind="first-run"
            title="Chưa có bài đăng nào"
            description="Chưa có lô đăng nào được tạo cho đơn vị này. Soạn một bài, chọn kênh rồi bấm “Tạo lô đăng” — mọi bài sẽ xuất hiện ở đây."
            action={
              <Button asChild>
                <Link href="/compose">Soạn bài</Link>
              </Button>
            }
          />
        )
      ) : null}

      {items.length > 0 ? (
        <>
          <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
            Đang hiển thị {items.length.toLocaleString("vi-VN")} bài
            {log.hasNextPage ? " (còn nữa)" : ""}.
          </p>

          {/* Said once, above the table, instead of eight identical ids
              explaining themselves row by row. */}
          {channels.isError ? (
            <p className="text-muted-foreground text-sm">
              Không tải được danh sách Page nên cột “Kênh” đang hiện mã kênh thay vì tên Page.
            </p>
          ) : null}

          <JobLogTable
            items={items}
            onRetry={handleRetry}
            retryingJobId={retry.isPending ? (retry.variables?.postJobId ?? null) : null}
            channels={channels.data?.channels}
            readOnlyReason={readOnlyReason}
          />

          {log.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                onClick={() => void log.fetchNextPage()}
                disabled={log.isFetchingNextPage}
              >
                {log.isFetchingNextPage ? "Đang tải…" : "Tải thêm"}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-center text-sm">Đã hết danh sách.</p>
          )}
        </>
      ) : null}
    </section>
  );
}
