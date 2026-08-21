"use client";

import {
  Banner,
  Button,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Selector,
  Stack,
  StackItem,
  Text,
  Token,
} from "@astryxdesign/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { JobLogSkeleton } from "@/ui/components/jobs/JobLogSkeleton";
import { JobLogTable } from "@/ui/components/jobs/JobLogTable";
import { WorkerHealthBanner } from "@/ui/components/jobs/WorkerHealthBanner";
import { presentWorkerHealth } from "@/ui/components/jobs/present-worker-health";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import { usePostJobLog, useRetryPostJob } from "@/ui/hooks/usePostJobs";
import { useWorkerHealth } from "@/ui/hooks/useWorkerHealth";
import {
  POST_JOB_STATUSES,
  POST_JOB_STATUS_LABELS,
  jobLogSearchParams,
  parseJobLogFilter,
  type PostJobLogEntry,
  type PostJobStatus,
} from "@/ui/schemas/post-batch.schema";

/**
 * "Nhật ký đăng bài" (E11.1): component -> hook -> service -> internal API.
 *
 * Frame (`astryx docs layout`, console archetype): the header carries the title
 * and the filter bar, the content region carries the rows edge-to-edge. The
 * page used to be a padded 5xl column, which wasted a third of a desktop on a
 * table whose whole job is to show eight columns at once.
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

/** "Tất cả trạng thái" is a real option, not an empty placeholder. */
const ALL_STATUSES = "";

export function JobLogScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filter = useMemo(
    () => parseJobLogFilter(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const log = usePostJobLog(filter);
  const retry = useRetryPostJob();
  // Support mode is read-only (M3.3): re-queueing a job posts to the customer's
  // Page. The table shows the button disabled with this sentence on it.
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

  const statusOptions = useMemo(
    () => [
      { value: ALL_STATUSES, label: "Tất cả trạng thái" },
      ...POST_JOB_STATUSES.map((status) => ({
        value: status,
        label: POST_JOB_STATUS_LABELS[status],
      })),
    ],
    [],
  );

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
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={1}>
              <Heading level={1}>Nhật ký đăng bài</Heading>
              <Text type="supporting">
                Mỗi dòng là một bài trên một kênh. Bài lỗi hoặc bị chặn có thể chạy lại — tồn kho
                vẫn được kiểm tra lại ngay trước khi đăng. Bài ở trạng thái “Facebook giữ lịch” đã
                nằm trên Facebook và Facebook sẽ tự đăng vào giờ đã hẹn, hệ thống chỉ theo dõi và
                cập nhật lại kết quả.
              </Text>
            </Stack>

            <HStack gap={3} align="end" wrap="wrap">
              <Selector
                label="Lọc theo trạng thái"
                size="sm"
                width={240}
                options={statusOptions}
                value={filter.status ?? ALL_STATUSES}
                onChange={applyStatus}
              />

              {/* The batch condition is shown as a chip so it is visible without
                  opening anything — a filter hiding in the URL is the reason an
                  operator blames the data (core-data-list-query §chip). It links
                  to the lô it names, so the chip is also the way out. */}
              {filter.batchId ? (
                <Token
                  label={`Lô ${filter.batchId}`}
                  href={`/batches/${encodeURIComponent(filter.batchId)}`}
                  description="Đang lọc theo lô này. Bấm để mở lô."
                />
              ) : null}

              {hasFilter ? (
                <Button variant="ghost" size="sm" label="Bỏ bộ lọc" onClick={clearFilters} />
              ) : null}

              <Button
                variant="secondary"
                size="sm"
                label={log.isFetching ? "Đang tải…" : "Tải lại"}
                isLoading={log.isFetching}
                isDisabled={log.isFetching}
                onClick={() => {
                  // One button, both readings: an operator who just restarted the
                  // publish worker expects "Tải lại" to clear the banner too.
                  void log.refetch();
                  void workerHealth.refetch();
                }}
              />
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <Stack direction="vertical" height="100%">
            {/* Above the rows on purpose: "vì sao chưa có bài nào lên" is
                answered here, before the operator starts reading statuses. */}
            {healthNotice ? (
              <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                <WorkerHealthBanner
                  notice={healthNotice}
                  onRecheck={() => void workerHealth.refetch()}
                  isChecking={workerHealth.isFetching}
                />
              </Stack>
            ) : null}

            {retryNotice ? (
              <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                <Banner
                  status="success"
                  role="status"
                  isDismissable
                  onDismiss={() => setRetryNotice(null)}
                  title={retryNotice}
                />
              </Stack>
            ) : null}

            {retry.isError ? (
              <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                <ApiErrorNotice error={retry.error} onRetry={() => void log.refetch()} />
              </Stack>
            ) : null}

            <StackItem size="fill">
              <JobLogBody
                isFirstLoad={isFirstLoad}
                showSkeleton={showSkeleton}
                log={log}
                items={items}
                hasFilter={hasFilter}
                readOnlyReason={readOnlyReason}
                onRetryJob={handleRetry}
                retryingJobId={retry.isPending ? (retry.variables?.postJobId ?? null) : null}
                onClearFilters={clearFilters}
              />
            </StackItem>

            {items.length > 0 ? (
              <Stack direction="horizontal" gap={3} padding={3} align="center" justify="center">
                <Text type="supporting" role="status" aria-live="polite">
                  Đang hiển thị {items.length.toLocaleString("vi-VN")} bài
                  {log.hasNextPage ? " (còn nữa)" : ". Đã hết danh sách."}
                </Text>
                {log.hasNextPage ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    label={log.isFetchingNextPage ? "Đang tải…" : "Tải thêm"}
                    isLoading={log.isFetchingNextPage}
                    isDisabled={log.isFetchingNextPage}
                    onClick={() => void log.fetchNextPage()}
                  />
                ) : null}
              </Stack>
            ) : null}
          </Stack>
        </LayoutContent>
      }
    />
  );
}

function JobLogBody({
  isFirstLoad,
  showSkeleton,
  log,
  items,
  hasFilter,
  readOnlyReason,
  onRetryJob,
  retryingJobId,
  onClearFilters,
}: {
  isFirstLoad: boolean;
  showSkeleton: boolean;
  log: ReturnType<typeof usePostJobLog>;
  items: readonly PostJobLogEntry[];
  hasFilter: boolean;
  readOnlyReason: string | null;
  onRetryJob: (postJobId: string) => void;
  retryingJobId: string | null;
  onClearFilters: () => void;
}) {
  // --- Loading (delayed so a fast answer does not flash) -------------------
  if (isFirstLoad) return showSkeleton ? <JobLogSkeleton /> : null;

  // --- Error, with nothing to fall back on ---------------------------------
  if (log.isError && items.length === 0) {
    return (
      <Stack direction="vertical" padding={4}>
        <ApiErrorNotice error={log.error} onRetry={() => void log.refetch()} />
      </Stack>
    );
  }

  // --- Empty: the two cases are told apart on purpose -----------------------
  if (items.length === 0) {
    return (
      <Stack direction="vertical" padding={4}>
        {hasFilter ? (
          <EmptyState
            kind="no-result"
            title="Không có bài nào khớp bộ lọc"
            description="Không có bài đăng nào ở trạng thái đang chọn. Dữ liệu vẫn còn nguyên — hãy bỏ bộ lọc để xem toàn bộ nhật ký."
            action={<Button variant="secondary" label="Bỏ bộ lọc" onClick={onClearFilters} />}
          />
        ) : (
          <EmptyState
            kind="first-run"
            title="Chưa có bài đăng nào"
            description="Chưa có lô đăng nào được tạo cho đơn vị này. Soạn một bài, chọn kênh rồi bấm “Tạo lô đăng” — mọi bài sẽ xuất hiện ở đây."
            action={
              // A real link, not a click handler: this is navigation, so
              // Ctrl/Cmd+click, middle-click and "mở tab mới" all have to work,
              // and a screen reader has to hear "liên kết", not "nút".
              <Button variant="primary" label="Soạn bài" href="/compose" />
            }
          />
        )}
      </Stack>
    );
  }

  // --- Data, possibly STALE -------------------------------------------------
  // A refetch that failed while rows from an earlier answer are still on screen
  // is said out loud rather than hidden: acting on a stale log is exactly how a
  // job gets re-queued twice (business rule 5 at the UI layer).
  return (
    <Stack direction="vertical" height="100%">
      {log.isError ? (
        <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
          <ApiErrorNotice error={log.error} onRetry={() => void log.refetch()} />
        </Stack>
      ) : null}

      <StackItem size="fill">
        <JobLogTable
          items={items}
          onRetry={onRetryJob}
          retryingJobId={retryingJobId}
          readOnlyReason={readOnlyReason}
        />
      </StackItem>
    </Stack>
  );
}
