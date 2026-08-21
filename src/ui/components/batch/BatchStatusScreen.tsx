"use client";

import {
  Banner,
  Button,
  EmptyState,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Stack,
  Text,
} from "@astryxdesign/core";

import { BatchChannelTable } from "@/ui/components/batch/BatchChannelTable";
import { BatchStatusSkeleton } from "@/ui/components/batch/BatchStatusSkeleton";
import { BatchSummaryCard } from "@/ui/components/batch/BatchSummaryCard";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { useBatchStatus } from "@/ui/hooks/usePostBatch";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { isSettledBatchStatus } from "@/ui/schemas/post-batch.schema";

/**
 * "Theo dõi lô đăng" (E7.5): component -> hook -> service -> internal API
 * (docs/07 §4.1). The browser never talks to Graph API; it polls the DB read
 * model through our own endpoint (business rule: no long-held connection).
 *
 * Frame (`astryx docs layout`, console archetype): the header carries the title
 * and the two controls an operator uses while watching a batch (tải lại, mở
 * nhật ký); the content region carries the summary and then the per-channel
 * rows edge-to-edge.
 *
 * The four mandatory states (core-feedback-states):
 *   loading — skeleton of the real layout, delayed 300ms
 *   data    — summary block + per-channel table, refreshed while jobs move
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

  const liveMessage = batch.isError
    ? "Không đọc được trạng thái lô."
    : !data
      ? "Đang tải trạng thái lô…"
      : settled
        ? "Lô đã kết thúc — trang dừng tự cập nhật."
        : batch.isFetching
          ? "Đang cập nhật…"
          : "Trang tự cập nhật vài giây một lần khi còn bài đang chạy.";

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <Stack direction="vertical" gap={3} padding={4}>
            <Stack direction="vertical" gap={1}>
              <Heading level={1}>Theo dõi lô đăng</Heading>
              <Text type="supporting">
                Mỗi kênh là một bài riêng: một kênh lỗi không làm dừng kênh khác. Trang này đọc
                trạng thái từ hệ thống, bạn có thể đóng tab — lô vẫn chạy tiếp.
              </Text>
            </Stack>

            <HStack gap={3} align="center" wrap="wrap">
              <Button
                variant="secondary"
                size="sm"
                label={batch.isFetching ? "Đang tải…" : "Tải lại"}
                isDisabled={batch.isFetching}
                onClick={() => void batch.refetch()}
              />
              <Button
                variant="ghost"
                size="sm"
                label="Nhật ký của lô này"
                href={data ? `/jobs?batchId=${encodeURIComponent(data.batchId)}` : "/jobs"}
              />
              <Button variant="ghost" size="sm" label="Soạn bài khác" href="/compose" />

              {/* Live region: a screen reader hears the outcome without
                  re-reading the page. */}
              <Text type="supporting" role="status" aria-live="polite">
                {liveMessage}
              </Text>
            </HStack>
          </Stack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <Stack direction="vertical" gap={6} paddingBlock={4}>
            {isFirstLoad ? (
              showSkeleton ? (
                <Stack direction="vertical" paddingInline={4}>
                  <BatchStatusSkeleton />
                </Stack>
              ) : null
            ) : null}

            {batch.isError && !data ? (
              <Stack direction="vertical" paddingInline={4}>
                <ApiErrorNotice
                  error={batch.error}
                  onRetry={() => void batch.refetch()}
                  extraAction={
                    <Button variant="secondary" label="Mở nhật ký đăng bài" href="/jobs" />
                  }
                />
              </Stack>
            ) : null}

            {data ? (
              <>
                {/* A stale-but-visible error: keep the last known table, say it
                    is old. */}
                {batch.isError ? (
                  <Stack direction="vertical" paddingInline={4}>
                    <Banner
                      role="status"
                      status="warning"
                      title="Bảng bên dưới là dữ liệu cũ"
                      description="Lần cập nhật gần nhất thất bại, nên những gì đang hiện là kết quả của lần đọc trước."
                      endContent={
                        <Button
                          variant="secondary"
                          size="sm"
                          label="Thử lại"
                          onClick={() => void batch.refetch()}
                        />
                      }
                    />
                  </Stack>
                ) : null}

                <Stack direction="vertical" paddingInline={4}>
                  <BatchSummaryCard batch={data} />
                </Stack>

                {data.channels.length === 0 ? (
                  <Stack direction="vertical" paddingInline={4}>
                    <EmptyState
                      headingLevel={2}
                      title="Lô này không có kênh nào"
                      description="Không có bài nào được tạo cho lô này. Hãy soạn lại bài và chọn ít nhất một kênh trước khi tạo lô."
                      actions={
                        <Button variant="secondary" label="Về màn soạn bài" href="/compose" />
                      }
                    />
                  </Stack>
                ) : (
                  <Stack direction="vertical" paddingInline={4}>
                    <BatchChannelTable
                      channels={data.channels}
                      progressSteps={data.progressSteps}
                    />
                  </Stack>
                )}
              </>
            ) : null}
          </Stack>
        </LayoutContent>
      }
    />
  );
}
