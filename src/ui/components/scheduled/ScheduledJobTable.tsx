"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import type { GroupChannelLabel } from "@/ui/components/channels/channel-group-labels";
import { channelSentenceName } from "@/ui/components/channels/channel-option-labels";
import { ChannelNameCell } from "@/ui/components/channels/ChannelNameCell";
import { JobStatusBadge } from "@/ui/components/post/PostStatusBadge";
import { ColorChip } from "@/ui/components/posts/ColorChip";
import { FoldToggle } from "@/ui/components/posts/FoldToggle";
import {
  foldCountLabel,
  groupJobRows,
  isFoldUniform,
  scheduledFoldKey,
  type JobRowGroup,
} from "@/ui/components/posts/job-row-grouping";
import { TableScrollRegion } from "@/ui/components/posts/TableScrollRegion";
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
 *
 * FOLDED ROWS (wave 2, spec §3.2): one post hẹn giờ on five Pages is five
 * post_jobs with the same code, the same colour and the same caption. They fold
 * into "MGKVX6310 × 5 kênh" and the channel cell becomes the disclosure that
 * lists them, each with its own hour and its own "Đổi giờ"/"Huỷ" — publish
 * spacing staggers the hours, so the folded row shows the SOONEST and says so.
 * Rows that differ in anything the folded row still displays never fold; see
 * `scheduledFoldKey`.
 *
 * WRAPPING (wave 1.5): the scanned columns — the hour, the product code, the
 * channel id under the Page name — never break mid-word. A code split over two lines cannot be
 * compared down the column, which is the entire job of that column. The table
 * carries a `min-w` and the region scrolls instead; it already has
 * `overflow-x-auto` and `tabIndex={0}`, so that scroll is reachable by keyboard.
 * The caption preview is prose and still wraps.
 */

/**
 * Shared so the default prop is one object, not a new Map on every render —
 * a fresh identity here would defeat memoisation in every caller.
 */
const EMPTY_LABELS: ReadonlyMap<string, GroupChannelLabel> = new Map();

export function ScheduledJobTable({
  items,
  headingId,
  nowMs,
  hrefFor,
  busyJobId,
  readOnlyReason = null,
  channelLabels = EMPTY_LABELS,
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
  /**
   * Page names for the "Kênh" column, resolved ONCE by the screen above
   * (`channelLabelIndex`) and shared by every day group on it. An id missing
   * from the map — or an empty map, which is what an unknown channel list looks
   * like — falls back to the bare id and accuses nothing.
   */
  channelLabels?: ReadonlyMap<string, GroupChannelLabel>;
}) {
  const zone = timeZoneLabel();
  const groups = useMemo(() => groupJobRows(items, scheduledFoldKey), [items]);

  /** Which folded rows are open — a reading aid, so local state, not the URL. */
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());

  function toggle(key: string): void {
    setOpenKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  return (
    <TableScrollRegion aria-labelledby={headingId}>
      {/* `min-w-4xl` (56rem): under that the five columns start breaking the
          product code and the countdown mid-word. */}
      <table className="w-full min-w-4xl border-collapse text-sm">
        <caption className="sr-only">
          Bài đã hẹn trong ngày: giờ đăng, mã sản phẩm, màu, kênh, caption, số ảnh và thao tác. Bài
          hẹn cùng lúc lên nhiều kênh gộp thành một dòng mở được.
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
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Giờ đăng ({zone})
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Mã SP / màu
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Kênh
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Caption · ảnh
            </th>
            <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">
              Thao tác
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <ScheduledRows
              key={group.key}
              group={group}
              nowMs={nowMs}
              hrefFor={hrefFor}
              busyJobId={busyJobId}
              readOnlyReason={readOnlyReason}
              channelLabels={channelLabels}
              isOpen={openKeys.has(group.key)}
              onToggle={() => toggle(group.key)}
            />
          ))}
        </tbody>
      </table>
    </TableScrollRegion>
  );
}

/**
 * One scheduled row — or one folded row plus the panel listing the channels it
 * stands for. Real `<tr>`s either way, so the column headers keep applying.
 */
function ScheduledRows({
  group,
  nowMs,
  hrefFor,
  busyJobId,
  readOnlyReason,
  channelLabels,
  isOpen,
  onToggle,
}: {
  group: JobRowGroup<ScheduledJobEntry>;
  nowMs: number;
  hrefFor: (action: "reschedule" | "cancel", postJobId: string) => string;
  busyJobId: string | null;
  readOnlyReason: string | null;
  channelLabels: ReadonlyMap<string, GroupChannelLabel>;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const job = group.head;
  const isFolded = group.count > 1;
  const detailId = `scheduled-fold-${job.postJobId}`;
  // The soonest hour of the group — the list arrives soonest-first. Publish
  // spacing means the others are minutes behind, so the row says "sớm nhất"
  // instead of passing one channel's minute off as all five.
  //
  // Compared on the FORMATTED hour, not the raw ISO instant: the cell shows
  // "20:00", so five jobs stamped 20:00:00.000 / 20:00:00.041 are the same hour
  // as far as this screen is concerned, and "sớm nhất" on a group that reads
  // identically down to the minute is a caveat with nothing behind it.
  //
  // It is only sound because THIS TABLE IS ONE DAY: `formatScheduledTime` drops
  // the date, so 20:00 today and 20:00 tomorrow compare equal and the caveat
  // would go missing (the fold key deliberately ignores `scheduledAt`). Every
  // caller renders per day — the list maps `groupScheduledByDay`, the calendar
  // opens one day's detail — and that is the constraint keeping this honest.
  const sameHour = isFoldUniform(group, (member) => formatScheduledTime(member.scheduledAt));

  return (
    <>
      <tr className="border-t align-top">
        <th
          scope="row"
          className="px-3 py-2 text-left font-medium whitespace-nowrap tabular-nums"
        >
          <ScheduledTime job={job} nowMs={nowMs} />
          {isFolded && !sameHour ? (
            <span className="text-muted-foreground block text-xs font-normal">sớm nhất</span>
          ) : null}
          <span className="mt-1 flex flex-wrap gap-1 font-normal">
            <JobStatusBadge status={job.status} />
            {job.overdue ? <Badge tone="warning">Quá giờ</Badge> : null}
          </span>
        </th>
        {/* The Mono Ledger Rule: a code an operator compares down the column
            cannot be allowed to break in half. */}
        <td className="px-3 py-2">
          <span className="block whitespace-nowrap">{job.productCode}</span>
          {isFolded ? (
            <span className="text-muted-foreground block text-xs">{foldCountLabel(group)}</span>
          ) : null}
          {/* `flex`, not the chip's default `inline-flex`: the colour is the
              second LINE of this cell, never a word glued to the code. */}
          <ColorChip
            color={job.color}
            emptyLabel="mọi màu"
            className="text-muted-foreground mt-0.5 flex text-xs"
          />
        </td>
        {/* Name first, id underneath — the same cell the job log uses. An
            operator recognises "Lady Fashion", not "fb-1121597217877301", and a
            schedule they cannot read is a schedule they cannot check before the
            hour comes. */}
        <td className="px-3 py-2 text-sm">
          {isFolded ? (
            <FoldToggle
              isOpen={isOpen}
              onToggle={onToggle}
              controls={detailId}
              label={`${group.channelCount} kênh`}
              srSuffix={` của bài ${job.productCode}`}
            />
          ) : (
            <ChannelNameCell channelId={job.channelId} label={channelLabels.get(job.channelId)} />
          )}
        </td>
        <td className="px-3 py-2">
          <p className="text-muted-foreground line-clamp-3">
            {job.captionPreview.trim().length > 0 ? job.captionPreview : "(chưa có caption)"}
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
                href={`/posts?tab=log&batchId=${encodeURIComponent(job.batchId)}`}
                className="underline underline-offset-4"
              >
                Xem nhật ký
              </Link>
            </p>
          ) : null}
        </td>
        <td className="px-3 py-2">
          {isFolded ? (
            <FoldedActionsNote group={group} readOnlyReason={readOnlyReason} />
          ) : (
            <RowActions
              job={job}
              busyJobId={busyJobId}
              hrefFor={hrefFor}
              readOnlyReason={readOnlyReason}
              channelLabels={channelLabels}
            />
          )}
        </td>
      </tr>

      {/* Rendered even while closed, with `hidden`: `aria-controls` must point
          at something that exists, and these rows were on screen anyway before
          the fold. */}
      {isFolded ? (
        <tr className="bg-muted/30 border-t" hidden={!isOpen}>
          <td id={detailId} colSpan={5} className="px-3 py-2">
            <ul className="space-y-2">
              {group.members.map((member) => (
                <li key={member.postJobId} className="flex flex-wrap items-start gap-x-3 gap-y-1">
                  <span className="min-w-48">
                    <ChannelNameCell
                      channelId={member.channelId}
                      label={channelLabels.get(member.channelId)}
                    />
                  </span>
                  <span className="text-muted-foreground tabular-nums whitespace-nowrap">
                    <ScheduledTime job={member} nowMs={nowMs} inline />
                  </span>
                  <RowActions
                    job={member}
                    busyJobId={busyJobId}
                    hrefFor={hrefFor}
                    readOnlyReason={readOnlyReason}
                    channelLabels={channelLabels}
                  />
                </li>
              ))}
            </ul>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * The "Thao tác" cell of a FOLDED row.
 *
 * Đổi giờ and Huỷ act on ONE post_job each — a single button here would have to
 * pick one of five silently — so the folded row carries no button and says where
 * the buttons are instead. It may only promise what the panel actually holds:
 * pointing a group that is entirely past its hour at "Mở danh sách kênh để đổi
 * giờ" sends the operator hunting for a control that is not there, which is the
 * same lie `RowActions` refuses to tell one row at a time (The Named Status
 * Rule — a summary that cannot be checked is decoration).
 *
 * Read-only wins over the per-row rule, exactly as in `RowActions`: while
 * nothing may be written at all, "bài đã tới giờ" is not the answer to give.
 */
function FoldedActionsNote({
  group,
  readOnlyReason,
}: {
  group: JobRowGroup<ScheduledJobEntry>;
  readOnlyReason: string | null;
}) {
  if (readOnlyReason !== null) {
    return <span className="text-muted-foreground text-xs">{readOnlyReason}</span>;
  }

  // `scheduledFoldKey` already keeps both permissions in the fold key, so the
  // members agree — asked over the group anyway, because the cell must follow
  // the panel, not a rule stated in another file. That the rule HOLDS is now
  // locked where the key lives ("lets the folded actions cell ask `.some()` and
  // get the head's answer", job-row-grouping.test.ts): if either permission
  // left the key, `.some()` here would quietly become a claim about one member
  // of a group that no longer agrees with itself.
  const anyReschedule = group.members.some((member) => member.canReschedule);
  const anyCancel = group.members.some((member) => member.canCancel);

  if (!anyReschedule && !anyCancel) {
    return <span className="text-muted-foreground text-xs">Đã tới giờ — không sửa được nữa</span>;
  }

  const what = anyReschedule && anyCancel ? "đổi giờ hoặc huỷ" : anyReschedule ? "đổi giờ" : "huỷ";
  return (
    <span className="text-muted-foreground text-xs">Mở danh sách kênh để {what} từng kênh</span>
  );
}

/** The hour a row waits for, plus how long that is from now. */
function ScheduledTime({
  job,
  nowMs,
  inline = false,
}: {
  job: ScheduledJobEntry;
  nowMs: number;
  inline?: boolean;
}) {
  // Countdown against the ABSOLUTE instant, never a decremented counter; before
  // the browser clock is known we show the value the server computed at read
  // time.
  const deltaMs = nowMs > 0 ? new Date(job.scheduledAt).getTime() - nowMs : job.startsInMs;
  const at = formatScheduledTime(job.scheduledAt);
  const countdown = formatCountdown(deltaMs);

  if (inline) {
    return (
      <>
        {at} · {countdown}
      </>
    );
  }

  return (
    <>
      {at}
      <span className="text-muted-foreground block text-xs font-normal">{countdown}</span>
    </>
  );
}

/** "Đổi giờ" / "Huỷ" for ONE post_job, with the reason whenever one is off. */
function RowActions({
  job,
  busyJobId,
  hrefFor,
  readOnlyReason,
  channelLabels,
}: {
  job: ScheduledJobEntry;
  busyJobId: string | null;
  hrefFor: (action: "reschedule" | "cancel", postJobId: string) => string;
  readOnlyReason: string | null;
  channelLabels: ReadonlyMap<string, GroupChannelLabel>;
}) {
  const isBusy = busyJobId === job.postJobId;
  // Read-only wins over the per-row rule: when nothing may be written at all,
  // "bài đã tới giờ" is not the answer to give.
  const blockedReason = readOnlyReason ?? rescheduleBlockedReason(job);
  const canReschedule = job.canReschedule && readOnlyReason === null;
  const canCancel = job.canCancel && readOnlyReason === null;
  const reasonId = `reschedule-blocked-${job.postJobId}`;
  // What a button SAYS it acts on: the Page name an operator knows, never the
  // id they would have to decode.
  const channelName = channelSentenceName(job.channelId, channelLabels);

  if (!canReschedule && !canCancel && !blockedReason) {
    // No disabled buttons: an action that can only 409 should not be on screen
    // at all (core-feedback-states).
    return <span className="text-muted-foreground text-xs">Đã tới giờ — không sửa được nữa</span>;
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-2">
        {canReschedule ? (
          <Button asChild size="sm" variant="outline" disabled={isBusy}>
            <Link href={hrefFor("reschedule", job.postJobId)} scroll={false}>
              Đổi giờ
              <span className="sr-only">
                {" "}
                bài {job.productCode} trên kênh {channelName}
              </span>
            </Link>
          </Button>
        ) : blockedReason ? (
          // Shown and disabled WITH the reason, not hidden: the operator asks
          // "vì sao không đổi giờ được?" and the answer must be on the row, not
          // behind a click that 409s (core-auth-session decision tree).
          <Button type="button" size="sm" variant="outline" disabled aria-describedby={reasonId}>
            Đổi giờ
            <span className="sr-only">
              {" "}
              bài {job.productCode} trên kênh {channelName}
            </span>
          </Button>
        ) : null}
        {canCancel ? (
          <Button asChild size="sm" variant="destructive" disabled={isBusy}>
            <Link href={hrefFor("cancel", job.postJobId)} scroll={false}>
              Huỷ
              <span className="sr-only">
                {" "}
                bài {job.productCode} trên kênh {channelName}
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
  );
}
