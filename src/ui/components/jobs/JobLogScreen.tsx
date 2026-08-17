"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { JobLogSkeleton } from "@/ui/components/jobs/JobLogSkeleton";
import { JobLogTable } from "@/ui/components/jobs/JobLogTable";
import { Button } from "@/ui/components/ui/button";
import { Select } from "@/ui/components/ui/select";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { usePostJobLog, useRetryPostJob } from "@/ui/hooks/usePostJobs";
import {
  POST_JOB_STATUSES,
  POST_JOB_STATUS_LABELS,
  jobLogSearchParams,
  parseJobLogFilter,
  type PostJobStatus,
} from "@/ui/schemas/post-batch.schema";
import { DEMO_TENANT_ID } from "@/ui/schemas/tenant-health.schema";

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
 */
export function JobLogScreen() {
  // Phase 1 is single-tenant in the UI; E10.4 will read it from the session.
  const tenantId = DEMO_TENANT_ID;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const statusFilterId = useId();

  const filter = useMemo(
    () => parseJobLogFilter(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const log = usePostJobLog(tenantId, filter);
  const retry = useRetryPostJob(tenantId);
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
    const query = params.toString();
    // `replace`: changing a filter is not a navigation step to walk back to.
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function clearFilters() {
    router.replace(pathname, { scroll: false });
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
        <h1 id="jobs-heading" className="text-2xl font-semibold tracking-tight">
          Nhật ký đăng bài
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Mỗi dòng là một bài trên một kênh. Bài lỗi hoặc bị chặn có thể chạy lại — tồn kho vẫn được
          kiểm tra lại ngay trước khi đăng. Bài ở trạng thái “Facebook giữ lịch” đã nằm trên Facebook
          và Facebook sẽ tự đăng vào giờ đã hẹn, hệ thống chỉ theo dõi và cập nhật lại kết quả.
        </p>
      </header>

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
          onClick={() => void log.refetch()}
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

          <JobLogTable
            items={items}
            onRetry={handleRetry}
            retryingJobId={retry.isPending ? (retry.variables?.postJobId ?? null) : null}
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
