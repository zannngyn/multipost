"use client";

import Link from "next/link";

import { JobStatusBadge } from "@/ui/components/post/PostStatusBadge";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import {
  formatCountdown,
  formatScheduledTime,
  rescheduleBlockedReason,
  timeZoneLabel,
  type ScheduledJobEntry,
} from "@/ui/schemas/scheduled.schema";

/**
 * One day of the "Bài đã hẹn" timeline (E8.4).
 *
 * Presentational: it opens no dialog and calls no API — the action links only
 * add a query parameter, and the screen above turns that into a dialog. That is
 * what makes "Đổi giờ" survive F5 and be shareable (web-crud-inline-edit r.1).
 *
 * `canReschedule` / `canCancel` are decided by the SERVER. A row past its hour
 * shows the "Quá giờ" badge and NO action: a worker may already be publishing
 * it, so a button here could only ever produce a 409.
 *
 * Every row also shows WHO is holding the post (E8.6): "Chờ đăng" = our queue,
 * "Facebook giữ lịch" = the post already sits on Facebook and Facebook will
 * publish it. The second one cannot be rescheduled — the row keeps a disabled
 * "Đổi giờ" with the reason next to it rather than letting the operator find out
 * through an error dialog.
 *
 * Business rule 2: the caption preview is the only content shown. No stock, no
 * price, no note — those never travel with a post job.
 */
export function ScheduledJobTable({
  items,
  headingId,
  nowMs,
  hrefFor,
  busyJobId,
}: {
  items: readonly ScheduledJobEntry[];
  /** The day heading this table belongs to (`aria-labelledby`). */
  headingId: string;
  /** 0 until the browser clock is known — then countdowns become live. */
  nowMs: number;
  hrefFor: (action: "reschedule" | "cancel", postJobId: string) => string;
  /** Job currently being changed — its actions are disabled while it runs. */
  busyJobId: string | null;
}) {
  const zone = timeZoneLabel();

  return (
    <div
      className="overflow-x-auto rounded-xl border"
      tabIndex={0}
      role="region"
      aria-labelledby={headingId}
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Bài đã hẹn trong ngày: giờ đăng, mã sản phẩm, màu, kênh, caption, số ảnh và thao tác
        </caption>
        <colgroup>
          <col className="w-[16%]" />
          <col className="w-[16%]" />
          <col className="w-[14%]" />
          <col className="w-[34%]" />
          <col className="w-[20%]" />
        </colgroup>
        <thead className="bg-muted/50">
          <tr className="text-left">
            <th scope="col" className="px-3 py-2 font-medium">
              Giờ đăng ({zone})
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Mã SP / màu
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Kênh
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Caption · ảnh
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Thao tác
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((job) => {
            // Countdown against the ABSOLUTE instant, never a decremented
            // counter; before the browser clock is known we show the value the
            // server computed at read time.
            const deltaMs =
              nowMs > 0 ? new Date(job.scheduledAt).getTime() - nowMs : job.startsInMs;
            const isBusy = busyJobId === job.postJobId;
            const blockedReason = rescheduleBlockedReason(job);
            const reasonId = `reschedule-blocked-${job.postJobId}`;

            return (
              <tr key={job.postJobId} className="border-t align-top">
                <th scope="row" className="px-3 py-2 text-left font-medium tabular-nums">
                  {formatScheduledTime(job.scheduledAt)}
                  <span className="text-muted-foreground block text-xs font-normal">
                    {formatCountdown(deltaMs)}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1 font-normal">
                    <JobStatusBadge status={job.status} />
                    {job.overdue ? <Badge tone="warning">Quá giờ</Badge> : null}
                  </span>
                </th>
                <td className="px-3 py-2 break-all">
                  {job.productCode}
                  <span className="text-muted-foreground block text-xs">
                    {job.color.trim().length > 0 ? job.color : "mọi màu"}
                  </span>
                </td>
                <td className="px-3 py-2 break-all">{job.channelId}</td>
                <td className="px-3 py-2">
                  <p className="text-muted-foreground line-clamp-3">
                    {job.captionPreview.trim().length > 0
                      ? job.captionPreview
                      : "(chưa có caption)"}
                  </p>
                  <p className="text-muted-foreground/80 mt-1 text-xs">
                    {job.mediaCount} ảnh ·{" "}
                    <Link
                      href={`/batches/${encodeURIComponent(job.batchId)}`}
                      className="underline underline-offset-4"
                    >
                      Xem lô
                    </Link>
                  </p>
                  {job.overdue ? (
                    <p className="text-warning-foreground mt-1 text-xs">
                      {job.userMessage}{" "}
                      <Link
                        href={`/jobs?batchId=${encodeURIComponent(job.batchId)}`}
                        className="underline underline-offset-4"
                      >
                        Xem nhật ký
                      </Link>
                    </p>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  {job.canReschedule || job.canCancel ? (
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap gap-2">
                        {job.canReschedule ? (
                          <Button asChild size="sm" variant="outline" disabled={isBusy}>
                            <Link href={hrefFor("reschedule", job.postJobId)} scroll={false}>
                              Đổi giờ
                              <span className="sr-only">
                                {" "}
                                bài {job.productCode} trên kênh {job.channelId}
                              </span>
                            </Link>
                          </Button>
                        ) : blockedReason ? (
                          // Shown and disabled WITH the reason, not hidden: the
                          // operator asks "vì sao không đổi giờ được?" and the
                          // answer must be on the row, not behind a click that
                          // 409s (core-auth-session decision tree).
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled
                            aria-describedby={reasonId}
                          >
                            Đổi giờ
                            <span className="sr-only">
                              {" "}
                              bài {job.productCode} trên kênh {job.channelId}
                            </span>
                          </Button>
                        ) : null}
                        {job.canCancel ? (
                          <Button asChild size="sm" variant="destructive" disabled={isBusy}>
                            <Link href={hrefFor("cancel", job.postJobId)} scroll={false}>
                              Huỷ
                              <span className="sr-only">
                                {" "}
                                bài {job.productCode} trên kênh {job.channelId}
                              </span>
                            </Link>
                          </Button>
                        ) : null}
                      </div>
                      {blockedReason ? (
                        <p id={reasonId} className="text-muted-foreground text-xs">
                          {blockedReason}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    // No disabled buttons: an action that can only 409 should
                    // not be on screen at all (core-feedback-states).
                    <span className="text-muted-foreground text-xs">
                      Đã tới giờ — không sửa được nữa
                    </span>
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
