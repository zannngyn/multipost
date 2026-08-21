"use client";

import {
  HStack,
  Heading,
  Link,
  Stack,
  StatusDot,
  Table,
  Text,
  pixel,
  proportional,
} from "@astryxdesign/core";
import type { TableColumn } from "@astryxdesign/core";

import { ChannelProgress } from "@/ui/components/batch/ChannelProgress";
import {
  POST_JOB_STATUS_LABELS,
  POST_JOB_STATUS_TONES,
  facebookPostUrl,
  formatDateTime,
  type BatchChannelStatus,
  type StatusTone,
} from "@/ui/schemas/post-batch.schema";

/**
 * Per-channel result table of one batch (E7.5, brief §6).
 *
 * Business rule 6 made visible: every channel is its own row with its own
 * status and its own reason — one Page failing says nothing about the others.
 * `userMessage` comes from the server already in Vietnamese; the UI never
 * invents a reason, and never hides one.
 *
 * Presentational only: no fetching, no retry logic (that lives on /jobs).
 *
 * A row that is still moving also carries its live progress block (design
 * §5.9). `progressSteps` comes down with the payload rather than being imported:
 * `ui/` may not reach into `core/` (docs/07 §2), and a second copy of the labels
 * would be the thing that drifts the day a stage is added.
 */

/**
 * [dup-3/3] Third copy of the tone -> dot map (see `BulkProgressTable`,
 * `BatchSummaryCard`). Extract it into a shared status primitive the next time
 * a screen needs it; the shared component that would own it today
 * (`post/PostStatusBadge`) still renders the old pill and is out of scope here.
 */
const DOT_VARIANT: Record<StatusTone, "success" | "warning" | "error" | "accent" | "neutral"> = {
  neutral: "neutral",
  info: "accent",
  success: "success",
  warning: "warning",
  danger: "error",
};

/**
 * Table's generic needs an index signature; the fields stay the schema's.
 *
 * `Table` declares `data?: T[]`, i.e. a MUTABLE array, so the caller's
 * `readonly` list is copied rather than cast away — a cast would have quietly
 * handed the design system permission to write into the query cache's array.
 */
type ChannelRow = BatchChannelStatus & Record<string, unknown>;

export function BatchChannelTable({
  channels,
  progressSteps,
}: {
  channels: readonly BatchChannelStatus[];
  progressSteps: readonly string[];
}) {
  const rows: ChannelRow[] = [...channels];

  const columns: TableColumn<ChannelRow>[] = [
    {
      key: "channelId",
      header: "Kênh",
      width: pixel(220),
      renderCell: (channel) => (
        <Text weight="medium" maxLines={2} wordBreak="break-all">
          {channel.channelId}
        </Text>
      ),
    },
    {
      key: "status",
      header: "Trạng thái",
      width: pixel(180),
      renderCell: (channel) => {
        const label = POST_JOB_STATUS_LABELS[channel.status];
        return (
          <HStack gap={2} align="center">
            <StatusDot
              variant={DOT_VARIANT[POST_JOB_STATUS_TONES[channel.status]]}
              label={label}
              isPulsing={channel.status === "publishing"}
            />
            <Text>{label}</Text>
          </HStack>
        );
      },
    },
    {
      key: "attemptCount",
      header: "Số lần thử",
      width: pixel(104),
      align: "end",
      renderCell: (channel) => <Text hasTabularNumbers>{channel.attemptCount}</Text>,
    },
    {
      key: "userMessage",
      header: "Kết quả",
      width: proportional(3),
      renderCell: (channel) => {
        const link =
          channel.publishedUrl ??
          (channel.publishedPostId ? facebookPostUrl(channel.publishedPostId) : null);

        return (
          <Stack direction="vertical" gap={1}>
            <Text color={channel.status === "published" ? "primary" : "secondary"}>
              {channel.userMessage}
            </Text>

            {link ? (
              <Link href={link} isExternalLink newTabLabel="(mở tab mới)">
                Mở bài đã đăng trên Facebook
              </Link>
            ) : null}

            {channel.publishedAt ? (
              <Text type="supporting" size="2xs" hasTabularNumbers>
                Đăng lúc {formatDateTime(channel.publishedAt)}
              </Text>
            ) : null}

            {channel.lastErrorCode ? (
              <Text type="code" size="2xs" color="secondary">
                Mã lỗi: {channel.lastErrorCode}
              </Text>
            ) : null}

            {/* Present only while the job is queued/publishing — the server
                drops it for every other status (law 3.1), so this row never has
                to decide. */}
            {channel.progress ? (
              <ChannelProgress
                progress={channel.progress}
                steps={progressSteps}
                channelId={channel.channelId}
                statusMessage={channel.userMessage}
              />
            ) : null}
          </Stack>
        );
      },
    },
  ];

  return (
    <Stack as="section" direction="vertical" gap={3} aria-labelledby="batch-channels-heading">
      <Heading level={2} id="batch-channels-heading">
        Kết quả theo từng kênh
      </Heading>

      <Table
        data={rows}
        columns={columns}
        idKey="postJobId"
        density="compact"
        // Reasons are sentences and a running row carries a progress block, so
        // rows grow rather than clip: the reason is the point of the row.
        textOverflow="wrap"
        verticalAlign="top"
        hasHover
        rowCount={rows.length}
      />
    </Stack>
  );
}
