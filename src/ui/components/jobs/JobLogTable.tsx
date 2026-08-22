"use client";

import Link from "next/link";

import {
  channelLabelIndex,
  channelSentenceName,
} from "@/ui/components/channels/channel-option-labels";
import { ChannelNameCell } from "@/ui/components/channels/ChannelNameCell";
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
 *
 * WRAPPING (wave 1.5): the columns an operator SCANS never break mid-word any
 * more. `break-all` on a product code turned "MGKVX6310" into two lines at the
 * width the eight columns actually get, and a broken code is a code that can no
 * longer be compared down the column. The table now carries a `min-w` and lets
 * the region scroll instead — the row it protects is the one being read, and
 * `overflow-x-auto` with `tabIndex={0}` already makes that reachable by
 * keyboard. Channel ids truncate in the MIDDLE (`shortenId`), because the tail
 * of a Page id is what distinguishes two ids that share a prefix; the full
 * value stays in `title` and in the accessible name.
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
  // ONE call for the whole list, indexed by id, instead of one call per row:
  // the rule rebuilds a Map of every channel each time it is asked, so calling
  // it inside the map made naming a 200-row log O(rows × channels).
  const channelLabels = channelLabelIndex(
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
      {/* `min-w-4xl` (56rem), measured rather than guessed: the content column
          of this screen is ~975px at 1440, so a 64rem floor put the "Thao tác"
          column past the edge on the everyday desktop — a horizontal scrollbar
          that never had to exist. 56rem still holds a code, a Page name and a
          wrapped failure sentence, and below it the region scrolls. */}
      <table className="w-full min-w-4xl border-collapse text-sm">
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
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Cập nhật lúc
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Mã SP
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Màu
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Kênh
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Trạng thái
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Lần thử
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Lý do / kết quả
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Thao tác
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((job) => {
            const link =
              job.publishedUrl ??
              (job.publishedPostId ? facebookPostUrl(job.publishedPostId) : null);
            const isRetrying = retryingJobId === job.postJobId;
            // Same rule the channel-group cards use: a Page that left the list
            // is "đã gỡ" there and must not be something else here.
            const channelName = channelSentenceName(job.channelId, channelLabels);

            return (
              <tr key={job.postJobId} className="border-t align-top">
                <td className="px-3 py-2 tabular-nums">{formatDateTime(job.updatedAt)}</td>
                {/* The Mono Ledger Rule + no break: a product code is compared
                    down the column, and a code split over two lines cannot be. */}
                <th
                  scope="row"
                  className="px-3 py-2 text-left font-medium whitespace-nowrap"
                >
                  {job.productCode}
                </th>
                <td className="px-3 py-2 whitespace-nowrap">
                  {job.color.trim().length > 0 ? job.color : "—"}
                </td>
                <td className="px-3 py-2">
                  {/* The Page NAME is what an operator recognises; the id is
                      what they quote to support. Name on top, id underneath in
                      the ledger mono — never the id alone when a name exists. */}
                  <ChannelNameCell
                    channelId={job.channelId}
                    label={channelLabels.get(job.channelId)}
                  />
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
                          bài {job.productCode} trên kênh {channelName}
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
                        bài {job.productCode} trên kênh {channelName}
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
