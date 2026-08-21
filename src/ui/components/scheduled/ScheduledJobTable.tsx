"use client";

import { HStack, Link, Stack, StatusDot, Table, Text, VStack, pixel, proportional } from "@astryxdesign/core";
import type { TableColumn } from "@astryxdesign/core";
import NextLink from "next/link";
import type { ComponentProps } from "react";

import {
  POST_JOB_STATUS_LABELS,
  POST_JOB_STATUS_TONES,
  type StatusTone,
} from "@/ui/schemas/post-batch.schema";
import {
  formatCountdown,
  formatScheduledTime,
  rescheduleBlockedReason,
  timeZoneLabel,
  type ScheduledJobEntry,
} from "@/ui/schemas/scheduled.schema";

/**
 * One day of the "Bài đã hẹn" timeline (E8.4), as rows rather than cards
 * (`astryx docs layout`: dense data an operator scans belongs in a Table).
 *
 * Presentational: it opens no dialog and calls no API — the action links only
 * add a query parameter, and the screen above turns that into a dialog. That is
 * what makes "Đổi giờ" survive F5 and be shareable (web-crud-inline-edit r.1),
 * and it is why they are real links: Ctrl+Click and the browser's Back button
 * both keep working.
 *
 * `canReschedule` / `canCancel` are decided by the SERVER. A row past its hour
 * shows no action at all: a worker may already be publishing it, so a control
 * here could only ever produce a 409. When an action is missing, the REASON
 * takes its place in the cell — never an empty box the operator has to guess at.
 *
 * Every row also shows WHO is holding the post (E8.6): "Chờ đăng" = our queue,
 * "Facebook giữ lịch" = the post already sits on Facebook and Facebook will
 * publish it. The second one cannot be rescheduled, and the row says so.
 *
 * Business rule 2: the caption preview is the only content shown. No stock, no
 * price, no note — those never travel with a post job.
 */

/** Table's generic needs an index signature; the fields stay the entry's. */
type ScheduledRow = ScheduledJobEntry & Record<string, unknown>;

/**
 * Schema tone -> Astryx StatusDot variant. Astryx names the two extremes
 * `accent` and `error`; the schema calls them `info` and `danger`.
 *
 * [dup-2/3] Same map in `jobs/JobLogTable.tsx`. The third copy should be the
 * trigger to move it next to the labels, in `post/PostStatusBadge.tsx`.
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

/**
 * `next/link` with `scroll={false}` baked in. Opening a dialog only adds a query
 * parameter; without this Next would scroll the timeline back to the top and
 * throw the operator out of the day they were reading.
 */
function DialogLink(props: ComponentProps<typeof NextLink>) {
  return <NextLink {...props} scroll={false} />;
}

export function ScheduledJobTable({
  items,
  headingId,
  nowMs,
  hrefFor,
  busyJobId,
  readOnlyReason = null,
}: {
  items: readonly ScheduledJobEntry[];
  /** The day heading this table belongs to (`aria-labelledby`). */
  headingId: string;
  /** 0 until the browser clock is known — then countdowns become live. */
  nowMs: number;
  hrefFor: (action: "reschedule" | "cancel", postJobId: string) => string;
  /** Job currently being changed — its actions are disabled while it runs. */
  busyJobId: string | null;
  /**
   * Set while the whole app is read-only (support mode, M3.3). It folds into
   * the row's EXISTING "vì sao không đổi giờ được" slot rather than adding a
   * second mechanism: one reason line per row, whatever produced it.
   */
  readOnlyReason?: string | null;
}) {
  const zone = timeZoneLabel();

  const columns: TableColumn<ScheduledRow>[] = [
    {
      key: "scheduledAt",
      header: `Giờ đăng (${zone})`,
      width: pixel(200),
      renderCell: (job) => {
        // Countdown against the ABSOLUTE instant, never a decremented counter;
        // before the browser clock is known we show the value the server
        // computed at read time.
        const deltaMs =
          nowMs > 0 ? new Date(job.scheduledAt).getTime() - nowMs : job.startsInMs;

        return (
          <VStack gap={1}>
            <Text weight="medium" hasTabularNumbers>
              {formatScheduledTime(job.scheduledAt)}
            </Text>
            <Text type="supporting" size="2xs">
              {formatCountdown(deltaMs)}
            </Text>
            <HStack gap={2} align="center" wrap="wrap">
              <StatusDot
                variant={STATUS_DOT_VARIANT[POST_JOB_STATUS_TONES[job.status]]}
                label={POST_JOB_STATUS_LABELS[job.status]}
              />
              <Text type="supporting" size="2xs">
                {POST_JOB_STATUS_LABELS[job.status]}
              </Text>
              {/* Never colour alone: the word is the signal, the tone only
                  makes it findable in a long day (core-accessibility §5). */}
              {job.overdue ? (
                <Text type="supporting" size="2xs" color="accent" weight="semibold">
                  Quá giờ
                </Text>
              ) : null}
            </HStack>
          </VStack>
        );
      },
    },
    {
      key: "productCode",
      header: "Mã SP / màu",
      width: pixel(170),
      renderCell: (job) => (
        <VStack gap={0.5}>
          <Text weight="medium">{job.productCode}</Text>
          <Text type="supporting" size="2xs">
            {job.color.trim().length > 0 ? job.color : "mọi màu"}
          </Text>
        </VStack>
      ),
    },
    {
      key: "channelId",
      header: "Kênh",
      width: pixel(150),
      renderCell: (job) => <Text color="secondary">{job.channelId}</Text>,
    },
    {
      key: "captionPreview",
      header: "Caption · ảnh",
      width: proportional(2),
      renderCell: (job) => (
        <VStack gap={1}>
          <Text color="secondary" maxLines={3}>
            {job.captionPreview.trim().length > 0 ? job.captionPreview : "(chưa có caption)"}
          </Text>

          <HStack gap={3} align="center" wrap="wrap">
            <Text type="supporting" size="2xs">
              {job.mediaCount} ảnh
            </Text>
            <Link href={`/batches/${encodeURIComponent(job.batchId)}`}>Xem lô</Link>
          </HStack>

          {job.overdue ? (
            <HStack gap={2} align="center" wrap="wrap">
              <Text type="supporting" size="2xs" color="accent">
                {job.userMessage}
              </Text>
              <Link href={`/jobs?batchId=${encodeURIComponent(job.batchId)}`}>Xem nhật ký</Link>
            </HStack>
          ) : null}
        </VStack>
      ),
    },
    {
      key: "actions",
      header: "Thao tác",
      width: pixel(210),
      renderCell: (job) => {
        const isBusy = busyJobId === job.postJobId;
        // Read-only wins over the per-row rule: when nothing may be written at
        // all, "bài đã tới giờ" is not the answer to give.
        const blockedReason = readOnlyReason ?? rescheduleBlockedReason(job);
        const canReschedule = job.canReschedule && readOnlyReason === null;
        const canCancel = job.canCancel && readOnlyReason === null;

        if (!canReschedule && !canCancel && !blockedReason) {
          // No dead controls: an action that can only 409 should not be on
          // screen at all (core-feedback-states).
          return <Text type="supporting">Đã tới giờ — không sửa được nữa</Text>;
        }

        return (
          <VStack gap={1}>
            <HStack gap={3} align="center" wrap="wrap">
              {canReschedule ? (
                <Link
                  as={DialogLink}
                  href={hrefFor("reschedule", job.postJobId)}
                  isDisabled={isBusy}
                  label={`Đổi giờ bài ${job.productCode} trên kênh ${job.channelId}`}
                >
                  Đổi giờ
                </Link>
              ) : null}
              {canCancel ? (
                <Link
                  as={DialogLink}
                  href={hrefFor("cancel", job.postJobId)}
                  isDisabled={isBusy}
                  label={`Huỷ bài ${job.productCode} trên kênh ${job.channelId}`}
                >
                  Huỷ
                </Link>
              ) : null}
            </HStack>

            {/* The reason takes the place of the missing control instead of
                sitting behind a click that 409s (core-auth-session tree). */}
            {blockedReason ? (
              <Text type="supporting" size="2xs">
                {blockedReason}
              </Text>
            ) : null}
          </VStack>
        );
      },
    },
  ];

  return (
    <Stack
      direction="vertical"
      isScrollable
      role="region"
      aria-labelledby={headingId}
      tabIndex={0}
    >
      <Table
        data={items as ScheduledRow[]}
        columns={columns}
        idKey="postJobId"
        density="compact"
        hasHover
        // The caption and the reason are the point of the row — they wrap.
        // Fixed-width columns still clip, so the grid keeps its alignment.
        textOverflow="wrap"
        verticalAlign="top"
        rowCount={items.length}
      />
    </Stack>
  );
}
