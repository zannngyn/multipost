"use client";

import Link from "next/link";

import { resolveGroupChannelLabels } from "@/ui/components/channels/channel-group-labels";
import { JobStatusBadge } from "@/ui/components/post/PostStatusBadge";
import { Button } from "@/ui/components/ui/button";
import type { Channel } from "@/ui/schemas/channel.schema";
import {
  facebookPostUrl,
  formatDateTime,
  type PostJobLogEntry,
} from "@/ui/schemas/post-batch.schema";

/**
 * The job log table (E11.1) — the screen that answers "vì sao bài này không
 * lên?" without opening a log file (business rule 5).
 *
 * `canRetry` is decided by the SERVER (failed/blocked only). The UI never
 * derives it from the status itself: the day the state machine changes, a
 * client-side guess would offer a button that always 409s.
 *
 * Presentational: the retry call itself is handed up through `onRetry`.
 */
export function JobLogTable({
  items,
  onRetry,
  retryingJobId,
  channels,
  readOnlyReason = null,
}: {
  items: readonly PostJobLogEntry[];
  onRetry: (postJobId: string) => void;
  /** Job currently being re-queued — its button shows progress and is disabled. */
  retryingJobId: string | null;
  /**
   * The tenant's channels, for naming the "Kênh" column. `undefined` means the
   * list is NOT KNOWN yet (loading, or the request failed) — the rows then show
   * the bare id and accuse nothing (see `resolveGroupChannelLabels`). Handed in
   * rather than fetched here: this table stays presentational, and the screen
   * already owns every query on the page.
   */
  channels?: readonly Channel[];
  /**
   * Set while the whole app is read-only (support mode, M3.3). "Chạy lại"
   * publishes to the customer's Page, so it goes off — with the reason on the
   * row, next to the button it explains.
   */
  readOnlyReason?: string | null;
}) {
  // ONE call for the whole list, indexed by row, instead of one call per row:
  // the rule rebuilds a Map of every channel each time it is asked, so calling
  // it inside the map made naming a 200-row log O(rows × channels).
  const channelLabels = resolveGroupChannelLabels(
    items.map((job) => job.channelId),
    channels,
  );

  return (
    <div
      className="overflow-x-auto rounded-xl border"
      tabIndex={0}
      role="region"
      aria-label="Bảng nhật ký đăng bài, cuộn ngang được"
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Nhật ký đăng bài: thời gian, mã sản phẩm, màu, kênh, trạng thái, số lần thử và lý do lỗi
        </caption>
        <colgroup>
          <col className="w-[13%]" />
          <col className="w-[12%]" />
          <col className="w-[9%]" />
          <col className="w-[14%]" />
          <col className="w-[11%]" />
          <col className="w-[7%]" />
          <col className="w-[24%]" />
          <col className="w-[10%]" />
        </colgroup>
        <thead className="bg-muted/50">
          <tr className="text-left">
            <th scope="col" className="px-3 py-2 font-medium">
              Cập nhật lúc
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Mã SP
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Màu
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Kênh
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Trạng thái
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Lần thử
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Lý do / kết quả
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Thao tác
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((job, index) => {
            const link =
              job.publishedUrl ??
              (job.publishedPostId ? facebookPostUrl(job.publishedPostId) : null);
            const isRetrying = retryingJobId === job.postJobId;
            // Same rule the channel-group cards use: a Page that left the list
            // is "đã gỡ" there and must not be something else here. The rule
            // returns one label per input id, in order, so the row index IS the
            // label index.
            const channel = channelLabels[index];

            return (
              <tr key={job.postJobId} className="border-t align-top">
                <td className="px-3 py-2 tabular-nums">{formatDateTime(job.updatedAt)}</td>
                <th scope="row" className="px-3 py-2 text-left font-medium break-all">
                  {job.productCode}
                </th>
                <td className="px-3 py-2 break-all">
                  {job.color.trim().length > 0 ? job.color : "—"}
                </td>
                <td className="px-3 py-2">
                  {/* The Page NAME is what an operator recognises; the id is
                      what they quote to support. Name on top, id underneath in
                      the ledger mono — never the id alone when a name exists. */}
                  {channel.name !== null ? (
                    <>
                      <span className="block break-words">{channel.name}</span>
                      <span className="text-muted-foreground mt-0.5 block font-mono text-xs break-all">
                        {job.channelId}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="block font-mono text-xs break-all">{job.channelId}</span>
                      {/* Only when the list IS known and this id is not in it.
                          While it is loading, `note` is "none" and this says
                          nothing — a log that accuses a Page of being removed
                          because a query is slow sends someone hunting. */}
                      {channel.note === "removed" ? (
                        <span className="text-muted-foreground mt-0.5 block text-xs">(đã gỡ)</span>
                      ) : null}
                    </>
                  )}
                </td>
                <td className="px-3 py-2">
                  <JobStatusBadge status={job.status} />
                </td>
                <td className="px-3 py-2 tabular-nums">{job.attemptCount}</td>
                <td className="px-3 py-2">
                  <p className={job.status === "published" ? "" : "text-muted-foreground"}>
                    {job.userMessage}
                  </p>
                  {link ? (
                    <p className="mt-1">
                      <a
                        href={link}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-primary underline underline-offset-4"
                      >
                        Mở bài trên Facebook
                      </a>
                      <span className="sr-only"> (mở tab mới)</span>
                    </p>
                  ) : null}
                  {job.lastErrorCode ? (
                    <p className="text-muted-foreground/80 mt-1 font-mono text-xs">
                      {job.lastErrorCode}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs">
                    <Link
                      href={`/batches/${encodeURIComponent(job.batchId)}`}
                      className="text-muted-foreground underline underline-offset-4"
                    >
                      Xem lô
                    </Link>
                  </p>
                </td>
                <td className="px-3 py-2">
                  {job.canRetry && readOnlyReason ? (
                    // Shown and disabled WITH the reason rather than hidden:
                    // this row IS retryable, and hiding the button would look
                    // like the job was never eligible.
                    <div className="space-y-1.5">
                      <Button type="button" size="sm" variant="outline" disabled>
                        Chạy lại
                        <span className="sr-only">
                          {" "}
                          bài {job.productCode} trên kênh {channel.name ?? job.channelId}
                        </span>
                      </Button>
                      <p className="text-muted-foreground text-xs">{readOnlyReason}</p>
                    </div>
                  ) : job.canRetry ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isRetrying}
                      onClick={() => onRetry(job.postJobId)}
                    >
                      {isRetrying ? "Đang xếp hàng…" : "Chạy lại"}
                      <span className="sr-only">
                        {" "}
                        bài {job.productCode} trên kênh {channel.name ?? job.channelId}
                      </span>
                    </Button>
                  ) : (
                    // No disabled button for a published/queued job: an action
                    // that can never succeed should not be on screen at all.
                    <span className="text-muted-foreground text-xs">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
