"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ExternalLink, RotateCcw } from "lucide-react";

import {
  channelLabelIndex,
  channelSentenceName,
} from "@/ui/components/channels/channel-option-labels";
import { ChannelNameCell } from "@/ui/components/channels/ChannelNameCell";
import { JobStatusBadge } from "@/ui/components/post/PostStatusBadge";
import { ColorChip } from "@/ui/components/posts/ColorChip";
import { FoldToggle } from "@/ui/components/posts/FoldToggle";
import {
  foldCountLabel,
  groupJobRows,
  isFoldUniform,
  jobLogFoldKey,
  type JobRowGroup,
} from "@/ui/components/posts/job-row-grouping";
import { TableScrollRegion } from "@/ui/components/posts/TableScrollRegion";
import { Button } from "@/ui/components/ui/button";
import type { GroupChannelLabel } from "@/ui/components/channels/channel-group-labels";
import type { Channel } from "@/ui/schemas/channel.schema";
import { MANUAL_PRODUCT_BADGE } from "@/ui/schemas/product-origin.schema";
import {
  facebookPostUrl,
  formatDateTime,
  type PostJobLogEntry,
} from "@/ui/schemas/post-batch.schema";

export function JobLogTable({
  items,
  onRetry,
  retryingJobId,
  channels,
  readOnlyReason = null,
}: {
  items: readonly PostJobLogEntry[];
  onRetry: (postJobId: string) => void;
  retryingJobId: string | null;
  channels?: readonly Channel[];
  readOnlyReason?: string | null;
}) {
  const channelLabels = useMemo(
    () => channelLabelIndex(items.map((job) => job.channelId), channels),
    [items, channels],
  );

  const groups = useMemo(() => groupJobRows(items, jobLogFoldKey), [items]);
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());

  function toggle(key: string): void {
    setOpenKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  return (
    <TableScrollRegion aria-label="Bảng nhật ký đăng, cuộn ngang được">
      <table className="w-full min-w-4xl border-collapse text-sm">
        <caption className="sr-only">
          Nhật ký đăng: thời gian, mã sản phẩm, màu, kênh, trạng thái, số lần thử và lý do lỗi. Bài
          đăng cùng lúc lên nhiều kênh gộp thành một dòng mở được.
        </caption>
        <thead className="border-b border-border/80 bg-muted/40 text-xs text-muted-foreground">
          <tr className="text-left">
            <th scope="col" className="px-4 py-3 font-semibold w-36 whitespace-nowrap">
              Cập nhật lúc
            </th>
            <th scope="col" className="px-4 py-3 font-semibold w-40 whitespace-nowrap">
              Sản phẩm
            </th>
            <th scope="col" className="px-4 py-3 font-semibold w-28 whitespace-nowrap">
              Màu
            </th>
            <th scope="col" className="px-4 py-3 font-semibold w-44 whitespace-nowrap">
              Kênh
            </th>
            <th scope="col" className="px-4 py-3 font-semibold w-32 whitespace-nowrap">
              Trạng thái
            </th>
            <th scope="col" className="px-4 py-3 font-semibold w-20 text-center whitespace-nowrap">
              Lần thử
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Kết quả & Thao tác
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {groups.map((group) => (
            <JobLogRows
              key={group.key}
              group={group}
              channelLabels={channelLabels}
              isOpen={openKeys.has(group.key)}
              onToggle={() => toggle(group.key)}
              onRetry={onRetry}
              retryingJobId={retryingJobId}
              readOnlyReason={readOnlyReason}
            />
          ))}
        </tbody>
      </table>
    </TableScrollRegion>
  );
}

function JobLogRows({
  group,
  channelLabels,
  isOpen,
  onToggle,
  onRetry,
  retryingJobId,
  readOnlyReason,
}: {
  group: JobRowGroup<PostJobLogEntry>;
  channelLabels: ReadonlyMap<string, GroupChannelLabel>;
  isOpen: boolean;
  onToggle: () => void;
  onRetry: (postJobId: string) => void;
  retryingJobId: string | null;
  readOnlyReason: string | null;
}) {
  const job = group.head;
  const isFolded = group.count > 1;
  const detailId = `job-fold-${group.head.postJobId}`;
  const channelName = channelSentenceName(job.channelId, channelLabels);
  const sameHour = isFoldUniform(group, (member) => formatDateTime(member.updatedAt));

  return (
    <>
      <tr data-row="job" className="align-top transition-colors hover:bg-accent/20">
        {/* Timestamp */}
        <td className="px-4 py-3.5 font-mono text-xs text-muted-foreground tabular-nums whitespace-nowrap">
          <div>{formatDateTime(job.updatedAt)}</div>
          {isFolded && !sameHour && (
            <span className="text-[10px] text-muted-foreground/70 block">
              (mới nhất)
            </span>
          )}
        </td>

        {/* Product Code — the row's header: without `scope="row"` a status cell
            read on its own does not say which post it belongs to. */}
        <th scope="row" className="px-4 py-3.5 text-left">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-xs font-bold text-foreground">
              {job.productCode}
            </span>
            {job.productOrigin === "manual" && (
              <span className="inline-block font-mono text-[10px] text-turmeric-deep">
                {MANUAL_PRODUCT_BADGE}
              </span>
            )}
            {isFolded && (
              <span className="text-[11px] text-muted-foreground">
                {foldCountLabel(group)}
              </span>
            )}
          </div>
        </th>

        {/* Color */}
        <td className="px-4 py-3.5">
          <ColorChip color={job.color} emptyLabel="—" />
        </td>

        {/* Channel / Fold Toggle */}
        <td className="px-4 py-3.5">
          {isFolded ? (
            <FoldToggle
              isOpen={isOpen}
              onToggle={onToggle}
              controls={detailId}
              label={`${group.channelCount} kênh`}
              srSuffix={` của bài ${job.productCode}`}
            />
          ) : (
            <div className="font-medium text-foreground">
              <ChannelNameCell channelId={job.channelId} label={channelLabels.get(job.channelId)} />
            </div>
          )}
        </td>

        {/* Status Badge */}
        <td className="px-4 py-3.5">
          <JobStatusBadge status={job.status} />
        </td>

        {/* Attempt count */}
        <td className="px-4 py-3.5 text-center font-mono text-xs tabular-nums text-muted-foreground">
          {job.attemptCount}
        </td>

        {/* Result & Actions */}
        <td className="px-4 py-3.5">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p
                className={`text-xs leading-relaxed max-w-xl ${
                  job.status === "published"
                    ? "font-medium text-foreground"
                    : job.status === "failed" || job.status === "blocked"
                      ? "text-madder"
                      : "text-muted-foreground"
                }`}
              >
                {job.userMessage}
              </p>

              {/* Retry acts on ONE post_job. A folded row stands for several,
                  so it carries no button and says where the buttons are —
                  same rule as `FoldedActionsNote` on the scheduled table. */}
              {isFolded ? (
                <FoldedRetryNote group={group} readOnlyReason={readOnlyReason} />
              ) : (
                <RetryAction
                  job={job}
                  channelName={channelName}
                  isRetrying={retryingJobId === job.postJobId}
                  onRetry={onRetry}
                  readOnlyReason={readOnlyReason}
                />
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {/* Direct Facebook Link */}
              {!isFolded && <PublishedLink job={job} />}

              {/* Batch link */}
              <Link
                href={`/batches/${encodeURIComponent(job.batchId)}`}
                className="inline-flex items-center gap-1 rounded-md border border-border/80 bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Mở chi tiết lô đăng"
              >
                <span>Xem lô</span>
              </Link>

              {/* The error code is what an operator reads out to support, so it
                  keeps the body text size and the full-strength muted ink rather
                  than the 10px/80% it was shrunk to. */}
              {job.lastErrorCode && (
                <span className="font-mono text-xs text-muted-foreground">
                  Mã lỗi: {job.lastErrorCode}
                </span>
              )}
            </div>
          </div>
        </td>
      </tr>

      {/* Expanded Folded Members */}
      {isFolded && (
        <tr className="bg-muted/20 border-t" hidden={!isOpen}>
          <td id={detailId} colSpan={7} className="px-6 py-3">
            <div className="flex flex-col gap-2.5 rounded-lg border border-border/80 bg-card p-3.5 shadow-xs">
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Danh sách chi tiết {group.channelCount} kênh của bài này:
              </span>
              <ul className="divide-y divide-border/40">
                {group.members.map((member) => (
                  <li
                    key={member.postJobId}
                    className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-1 last:pb-1"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="min-w-44 font-medium text-xs text-foreground">
                        <ChannelNameCell
                          channelId={member.channelId}
                          label={channelLabels.get(member.channelId)}
                        />
                      </div>
                      <span className="font-mono text-xs text-muted-foreground tabular-nums">
                        {formatDateTime(member.updatedAt)}
                      </span>
                      <PublishedLink job={member} />
                    </div>

                    {member.canRetry && (
                      <RetryAction
                        job={member}
                        channelName={channelSentenceName(member.channelId, channelLabels)}
                        isRetrying={retryingJobId === member.postJobId}
                        onRetry={onRetry}
                        readOnlyReason={readOnlyReason}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function PublishedLink({ job }: { job: PostJobLogEntry }) {
  const link = job.publishedUrl ?? (job.publishedPostId ? facebookPostUrl(job.publishedPostId) : null);
  if (!link) return null;

  return (
    <a
      href={link}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
    >
      <span>Mở trên Facebook</span>
      <ExternalLink className="size-3" />
    </a>
  );
}

/**
 * The action cell of a FOLDED row.
 *
 * It may only promise what the panel actually holds: a group where nothing can
 * be retried must NOT point at "Mở danh sách kênh để chạy lại", or the operator
 * opens it hunting for a button that is not there. Read-only wins over both,
 * exactly as in `RetryAction`.
 */
function FoldedRetryNote({
  group,
  readOnlyReason,
}: {
  group: JobRowGroup<PostJobLogEntry>;
  readOnlyReason: string | null;
}) {
  const anyRetry = group.members.some((member) => member.canRetry);
  if (!anyRetry) return null;
  if (readOnlyReason !== null) {
    return <span className="text-muted-foreground text-xs">{readOnlyReason}</span>;
  }
  return <span className="text-muted-foreground text-xs">Mở danh sách kênh để chạy lại</span>;
}

function RetryAction({
  job,
  channelName,
  isRetrying,
  onRetry,
  readOnlyReason,
}: {
  job: PostJobLogEntry;
  channelName: string;
  isRetrying: boolean;
  onRetry: (postJobId: string) => void;
  readOnlyReason: string | null;
}) {
  if (job.canRetry && readOnlyReason) {
    return (
      <div className="flex items-center gap-1.5">
        <Button type="button" size="sm" variant="outline" disabled className="text-xs h-7">
          Chạy lại
          <span className="sr-only">
            {" "}
            bài {job.productCode} trên kênh {channelName}
          </span>
        </Button>
        <span className="text-xs text-muted-foreground">{readOnlyReason}</span>
      </div>
    );
  }

  if (job.canRetry) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isRetrying}
        onClick={() => onRetry(job.postJobId)}
        className="gap-1 text-xs h-7"
      >
        <RotateCcw className={`size-3 ${isRetrying ? "animate-spin" : ""}`} />
        <span>{isRetrying ? "Đang xếp hàng…" : "Chạy lại"}</span>
        <span className="sr-only"> bài {job.productCode} trên kênh {channelName}</span>
      </Button>
    );
  }

  return null;
}
