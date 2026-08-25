import type { GroupChannelLabel } from "@/ui/components/channels/channel-group-labels";
import type { BatchChannelStatus } from "@/ui/schemas/post-batch.schema";

/**
 * The pills and the search box over the batch's channel table.
 *
 * Pure, because two of the decisions here are easy to get wrong in a way no
 * screenshot shows: which statuses "Đang chạy" covers, and whether a pill may
 * disappear while it is the ACTIVE filter. This screen polls, so a retry that
 * succeeds while "Lỗi/Chặn" is selected drops that bucket to zero — hiding the
 * pill then leaves an empty table and no control to undo the filter.
 */

export const CHANNEL_STATUS_FILTERS = ["all", "published", "active", "issues"] as const;
export type ChannelStatusFilter = (typeof CHANNEL_STATUS_FILTERS)[number];

export interface ChannelCounts {
  readonly all: number;
  readonly published: number;
  readonly active: number;
  readonly issues: number;
}

export function countChannelStatuses(
  channels: readonly BatchChannelStatus[],
): ChannelCounts {
  let published = 0;
  let active = 0;
  let issues = 0;

  for (const channel of channels) {
    if (channel.status === "published") published += 1;
    else if (channel.status === "queued" || channel.status === "publishing") active += 1;
    else if (channel.status === "failed" || channel.status === "blocked") issues += 1;
  }

  return { all: channels.length, published, active, issues };
}

export function matchesChannelStatus(
  channel: BatchChannelStatus,
  filter: ChannelStatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "published") return channel.status === "published";
  if (filter === "active") return channel.status === "queued" || channel.status === "publishing";
  return channel.status === "failed" || channel.status === "blocked";
}

export function matchesChannelSearch(
  channel: BatchChannelStatus,
  label: GroupChannelLabel | undefined,
  rawQuery: string,
): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) return true;

  // The channel id is searchable on purpose: when the Page directory fails to
  // load the table shows ids, and that is exactly when somebody pastes one in.
  const haystacks = [label?.name ?? "", channel.channelId, channel.userMessage];
  return haystacks.some((value) => value.toLowerCase().includes(query));
}

export function filterBatchChannels(
  channels: readonly BatchChannelStatus[],
  filter: ChannelStatusFilter,
  rawQuery: string,
  labels: ReadonlyMap<string, GroupChannelLabel>,
): readonly BatchChannelStatus[] {
  return channels.filter(
    (channel) =>
      matchesChannelStatus(channel, filter) &&
      matchesChannelSearch(channel, labels.get(channel.channelId), rawQuery),
  );
}

/**
 * Whether a pill is drawn. Zero is normally reason enough to hide one — until
 * it is the filter currently in force, and hiding it would strand the operator.
 */
export function showsStatusPill(
  count: number,
  pill: ChannelStatusFilter,
  active: ChannelStatusFilter,
): boolean {
  return count > 0 || pill === active;
}
