"use client";

import { Button, HStack, Stack, StatusDot, Table, Text, pixel, proportional } from "@astryxdesign/core";
import type { TableColumn } from "@astryxdesign/core";
import { useState } from "react";

import { secretsNotConfiguredReason } from "@/ui/components/channels/channel-secrets";
import {
  CHANNEL_PLATFORM_LABELS,
  CHANNEL_STATUS_LABELS,
  CHANNEL_STATUS_TONES,
  type Channel,
  type ChannelStatus,
} from "@/ui/schemas/channel.schema";
import { formatDateTime } from "@/ui/schemas/post-batch.schema";

/**
 * The connected Pages as rows, not cards (`astryx docs layout`: dense data the
 * operator scans belongs in a table; Card is for standalone widgets).
 *
 * Status is a StatusDot plus its label in text — never colour alone
 * (core-accessibility §5).
 *
 * "Gỡ" asks first, in place: the action cell swaps to a question and two
 * buttons. No `confirm()` — it cannot be styled, blocks the main thread and is
 * announced inconsistently across browsers. That two-step shape mirrors what
 * the "Nhóm kênh" screen already does, so the gesture is the same everywhere.
 */

/** Table's generic needs an index signature; the fields stay Channel's. */
type ChannelRow = Channel & Record<string, unknown>;

function displayName(channel: Channel): string {
  const trimmed = channel.name.trim();
  return trimmed.length > 0 ? trimmed : "(Page chưa có tên)";
}

export function ChannelTable({
  channels,
  busyChannelId,
  areWritesBlocked,
  onSetStatus,
  onRemove,
}: {
  channels: readonly Channel[];
  /** The row with a write in flight — its buttons show progress, not the page. */
  busyChannelId: string | null;
  /** Server cannot seal credentials, so every write here would 400. */
  areWritesBlocked: boolean;
  onSetStatus: (channelId: string, status: ChannelStatus) => void;
  onRemove: (channelId: string) => void;
}) {
  // Which row is asking "gỡ thật chứ?". Pure view state, so it lives here.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  /**
   * Never a bare disabled button: Astryx keeps a control with a tooltip
   * focusable (aria-disabled), so the reason is reachable by keyboard too. A
   * dead control with no explanation is the thing this fix exists to avoid.
   */
  const blockedReason = areWritesBlocked ? secretsNotConfiguredReason() : undefined;

  const columns: TableColumn<ChannelRow>[] = [
    {
      key: "status",
      header: "Trạng thái",
      width: pixel(130),
      renderCell: (channel) => (
        <HStack gap={2} align="center">
          <StatusDot
            variant={CHANNEL_STATUS_TONES[channel.status]}
            label={CHANNEL_STATUS_LABELS[channel.status]}
          />
          <Text>{CHANNEL_STATUS_LABELS[channel.status]}</Text>
        </HStack>
      ),
    },
    {
      key: "name",
      header: "Tên Page",
      width: proportional(2),
      renderCell: (channel) =>
        channel.name.trim().length > 0 ? (
          <Text>{channel.name}</Text>
        ) : (
          <Text color="placeholder">(Page chưa có tên)</Text>
        ),
    },
    {
      key: "externalId",
      header: "Page ID",
      width: pixel(190),
      renderCell: (channel) => <Text color="secondary">{channel.externalId}</Text>,
    },
    {
      key: "platform",
      header: "Nền tảng",
      width: pixel(110),
      renderCell: (channel) => <Text color="secondary">{CHANNEL_PLATFORM_LABELS[channel.platform]}</Text>,
    },
    {
      key: "tokenExpiresAt",
      header: "Token hết hạn",
      width: pixel(170),
      renderCell: (channel) =>
        channel.tokenExpiresAt === null ? (
          // Long-lived Page tokens have no expiry — that is not missing data.
          <Text color="secondary">Không hết hạn</Text>
        ) : (
          <Text color="secondary">{formatDateTime(channel.tokenExpiresAt)}</Text>
        ),
    },
    {
      key: "actions",
      header: "Thao tác",
      width: pixel(280),
      renderCell: (channel) => {
        const name = displayName(channel);
        const isBusy = busyChannelId === channel.channelId;

        if (confirmingId === channel.channelId) {
          return (
            <HStack gap={2} align="center" wrap="wrap">
              {/* Announced on mount: a keyboard user must hear the question,
                  not just see the buttons change. */}
              <Text type="supporting" role="alert">
                Gỡ Page này?
              </Text>
              <Button
                size="sm"
                variant="destructive"
                label={`Gỡ hẳn ${name}`}
                isLoading={isBusy}
                isDisabled={isBusy || areWritesBlocked}
                tooltip={blockedReason}
                onClick={() => onRemove(channel.channelId)}
              >
                Gỡ hẳn
              </Button>
              <Button
                size="sm"
                variant="ghost"
                label={`Giữ lại ${name}`}
                isDisabled={isBusy}
                onClick={() => setConfirmingId(null)}
              >
                Giữ lại
              </Button>
            </HStack>
          );
        }

        const nextStatus: ChannelStatus = channel.status === "active" ? "disabled" : "active";
        const toggleLabel = nextStatus === "disabled" ? "Tắt" : "Bật";

        return (
          <HStack gap={2} align="center" wrap="wrap">
            <Button
              size="sm"
              variant="secondary"
              label={`${toggleLabel} kênh ${name}`}
              isLoading={isBusy}
              isDisabled={isBusy || areWritesBlocked}
              tooltip={blockedReason}
              onClick={() => onSetStatus(channel.channelId, nextStatus)}
            >
              {toggleLabel}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              label={`Gỡ kênh ${name}`}
              isDisabled={isBusy || areWritesBlocked}
              tooltip={blockedReason}
              onClick={() => setConfirmingId(channel.channelId)}
            >
              Gỡ
            </Button>
          </HStack>
        );
      },
    },
  ];

  return (
    <Stack direction="vertical" isScrollable height="100%">
      <Table
        data={channels as ChannelRow[]}
        columns={columns}
        idKey="channelId"
        density="compact"
        hasHover
        textOverflow="truncate"
        rowCount={channels.length}
      />
    </Stack>
  );
}
