"use client";

import Link from "next/link";

import { JobStatusBadge } from "@/ui/components/post/PostStatusBadge";
import { Button } from "@/ui/components/ui/button";
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
  readOnlyReason = null,
}: {
  items: readonly PostJobLogEntry[];
  onRetry: (postJobId: string) => void;
  /** Job currently being re-queued — its button shows progress and is disabled. */
  retryingJobId: string | null;
  /**
   * Set while the whole app is read-only (support mode, M3.3). "Chạy lại"
   * publishes to the customer's Page, so it goes off — with the reason on the
   * row, next to the button it explains.
   */
  readOnlyReason?: string | null;
}) {
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
          {items.map((job) => {
            const link =
              job.publishedUrl ??
              (job.publishedPostId ? facebookPostUrl(job.publishedPostId) : null);
            const isRetrying = retryingJobId === job.postJobId;

            return (
              <tr key={job.postJobId} className="border-t align-top">
                <td className="px-3 py-2 tabular-nums">{formatDateTime(job.updatedAt)}</td>
                <th scope="row" className="px-3 py-2 text-left font-medium break-all">
                  {job.productCode}
                </th>
                <td className="px-3 py-2 break-all">
                  {job.color.trim().length > 0 ? job.color : "—"}
                </td>
                <td className="px-3 py-2 break-all">{job.channelId}</td>
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
                          bài {job.productCode} trên kênh {job.channelId}
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
                        bài {job.productCode} trên kênh {job.channelId}
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
