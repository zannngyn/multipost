"use client";

import {
  Button,
  HStack,
  Link,
  Stack,
  StatusDot,
  Table,
  Text,
  VStack,
  pixel,
  proportional,
} from "@astryxdesign/core";
import type { TableColumn } from "@astryxdesign/core";

import {
  POST_JOB_STATUS_LABELS,
  POST_JOB_STATUS_TONES,
  facebookPostUrl,
  formatDateTime,
  type PostJobLogEntry,
  type StatusTone,
} from "@/ui/schemas/post-batch.schema";

/**
 * The job log as rows, not cards (`astryx docs layout`: dense data an operator
 * scans belongs in a Table; Card is for standalone widgets).
 *
 * It is the screen that answers "vì sao bài này không lên?" without opening a
 * log file (business rule 5), so the "Lý do / kết quả" column is the widest one
 * and the table WRAPS rather than truncates: a reason clipped to an ellipsis
 * answers nothing. Everything else is fixed-width and truncates, which keeps the
 * columns lining up from page to page (web-data-table rule 1).
 *
 * Status is a StatusDot plus its label in text — never colour alone
 * (core-accessibility §5), and the same shape ChannelTable and ProductTable use.
 *
 * `canRetry` is decided by the SERVER (failed/blocked only). The UI never
 * derives it from the status itself: the day the state machine changes, a
 * client-side guess would offer a button that always 409s.
 *
 * Presentational: the retry call itself is handed up through `onRetry`.
 */

/** Table's generic needs an index signature; the fields stay the entry's. */
type JobRow = PostJobLogEntry & Record<string, unknown>;

/**
 * Schema tone -> Astryx StatusDot variant. Astryx names the two extremes
 * `accent` and `error`; the schema calls them `info` and `danger`. The MEANING
 * still comes from one place (`POST_JOB_STATUS_TONES`), this only translates it.
 *
 * [dup-2/3] Same map in `scheduled/ScheduledJobTable.tsx`. The third copy should
 * be the trigger to move it next to the labels, in `post/PostStatusBadge.tsx`.
 */
const STATUS_DOT_VARIANT: Record<
  StatusTone,
  "success" | "warning" | "error" | "accent" | "neutral"
> = {
  neutral: "neutral",
  info: "accent",
  success: "success",
  warning: "warning",
  danger: "error",
};

export function JobLogTable({
  items,
  onRetry,
  retryingJobId,
  readOnlyReason = null,
}: {
  items: readonly PostJobLogEntry[];
  onRetry: (postJobId: string) => void;
  /** Job currently being re-queued — its button shows progress and is disabled. */
  retryingJobId: string | null;
  /**
   * Set while the whole app is read-only (support mode, M3.3). "Chạy lại"
   * publishes to the customer's Page, so it goes off — never bare: Astryx keeps
   * a control with a tooltip focusable (aria-disabled), so the reason is
   * reachable by keyboard too.
   */
  readOnlyReason?: string | null;
}) {
  const columns: TableColumn<JobRow>[] = [
    {
      key: "status",
      header: "Trạng thái",
      width: pixel(170),
      renderCell: (job) => (
        <HStack gap={2} align="center">
          <StatusDot
            variant={STATUS_DOT_VARIANT[POST_JOB_STATUS_TONES[job.status]]}
            label={POST_JOB_STATUS_LABELS[job.status]}
          />
          <Text>{POST_JOB_STATUS_LABELS[job.status]}</Text>
        </HStack>
      ),
    },
    {
      key: "updatedAt",
      header: "Cập nhật lúc",
      width: pixel(150),
      renderCell: (job) => (
        <Text color="secondary" hasTabularNumbers>
          {formatDateTime(job.updatedAt)}
        </Text>
      ),
    },
    {
      key: "productCode",
      header: "Mã SP",
      width: pixel(140),
      renderCell: (job) => <Text weight="medium">{job.productCode}</Text>,
    },
    {
      key: "color",
      header: "Màu",
      width: pixel(110),
      renderCell: (job) =>
        job.color.trim().length > 0 ? (
          <Text>{job.color}</Text>
        ) : (
          // An empty colour is "mọi màu", not missing data — say so instead of
          // leaving a blank cell the operator has to interpret.
          <Text color="placeholder">mọi màu</Text>
        ),
    },
    {
      key: "channelId",
      header: "Kênh",
      width: pixel(150),
      renderCell: (job) => <Text color="secondary">{job.channelId}</Text>,
    },
    {
      key: "attemptCount",
      header: "Lần thử",
      width: pixel(90),
      align: "end",
      renderCell: (job) => <Text hasTabularNumbers>{job.attemptCount}</Text>,
    },
    {
      key: "userMessage",
      header: "Lý do / kết quả",
      width: proportional(2),
      renderCell: (job) => {
        const link =
          job.publishedUrl ?? (job.publishedPostId ? facebookPostUrl(job.publishedPostId) : null);

        return (
          <VStack gap={1}>
            <Text color={job.status === "published" ? "primary" : "secondary"}>
              {job.userMessage}
            </Text>

            <HStack gap={3} wrap="wrap" align="center">
              {link ? (
                <Link href={link} isExternalLink newTabLabel="(mở tab mới)">
                  Mở bài trên Facebook
                </Link>
              ) : null}
              <Link href={`/batches/${encodeURIComponent(job.batchId)}`}>Xem lô</Link>
            </HStack>

            {/* For support, not for the operator: small, last, and never the
                sentence they are meant to act on. */}
            {job.lastErrorCode ? (
              <Text type="supporting" size="2xs" color="secondary">
                Mã lỗi: {job.lastErrorCode}
              </Text>
            ) : null}
          </VStack>
        );
      },
    },
    {
      key: "actions",
      header: "Thao tác",
      width: pixel(170),
      renderCell: (job) => {
        if (!job.canRetry) {
          // No disabled button for a published/queued job: an action that can
          // never succeed should not be on screen at all.
          return <Text color="placeholder">—</Text>;
        }

        const isRetrying = retryingJobId === job.postJobId;

        return (
          <Button
            size="sm"
            variant="secondary"
            // The accessible name says WHICH row, so a screen-reader user
            // walking the column hears more than "Chạy lại" eight times.
            label={`Chạy lại bài ${job.productCode} trên kênh ${job.channelId}`}
            isLoading={isRetrying}
            // Shown and disabled WITH the reason rather than hidden: this row IS
            // retryable, and hiding the button would look like it never was.
            isDisabled={isRetrying || readOnlyReason !== null}
            tooltip={readOnlyReason ?? undefined}
            onClick={() => onRetry(job.postJobId)}
          >
            {isRetrying ? "Đang xếp hàng…" : "Chạy lại"}
          </Button>
        );
      },
    },
  ];

  return (
    <Stack
      direction="vertical"
      isScrollable
      height="100%"
      role="region"
      aria-label="Bảng nhật ký đăng bài, cuộn ngang được"
      tabIndex={0}
    >
      <Table
        data={items as JobRow[]}
        columns={columns}
        idKey="postJobId"
        density="compact"
        hasHover
        // The reason column is the point of this screen — it wraps. Fixed-width
        // columns still clip, so the grid keeps its alignment.
        textOverflow="wrap"
        verticalAlign="top"
        rowCount={items.length}
      />
    </Stack>
  );
}
