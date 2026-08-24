"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

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
 * FOLDED ROWS (wave 2, spec §3.2): one post going to five Pages is five
 * post_jobs, and five rows that repeat the same code, the same colour and the
 * same failure sentence are what makes this log unreadable at 30 mã/sáng. Rows
 * whose every VISIBLE value matches fold into "MGKVX6310 × 5 kênh"; the channel
 * cell becomes the disclosure that lists them, each with its own hour, its own
 * permalink and its own "Chạy lại". Two jobs that failed differently never fold
 * — see `jobLogFoldKey` for what counts as "the same".
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
  const channelLabels = useMemo(
    () => channelLabelIndex(items.map((job) => job.channelId), channels),
    [items, channels],
  );

  const groups = useMemo(() => groupJobRows(items, jobLogFoldKey), [items]);

  /**
   * Which folded rows are open. Local state, not the URL: it is a reading aid
   * on a list that is already filtered by the URL, and putting eight ids in the
   * address bar would make "share this filter" unreadable.
   */
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
      {/* `min-w-4xl` (56rem), measured rather than guessed: the content column
          of this screen is ~975px at 1440, so a 64rem floor put the "Thao tác"
          column past the edge on the everyday desktop — a horizontal scrollbar
          that never had to exist. 56rem still holds a code, a Page name and a
          wrapped failure sentence, and below it the region scrolls. */}
      <table className="w-full min-w-4xl border-collapse text-sm">
        <caption className="sr-only">
          Nhật ký đăng: thời gian, mã sản phẩm, màu, kênh, trạng thái, số lần thử và lý do lỗi. Bài
          đăng cùng lúc lên nhiều kênh gộp thành một dòng mở được.
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

/**
 * One row of the log — or one folded row plus, when it is open, the panel that
 * lists the channels it stands for.
 *
 * A fragment of `<tr>`s rather than a component per row so the detail stays a
 * real table row (`colSpan`), which is what keeps the header association and
 * the column alignment intact for a screen reader.
 */
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
  // Same rule the channel-group cards use: a Page that left the list is "đã gỡ"
  // there and must not be something else here.
  const channelName = channelSentenceName(job.channelId, channelLabels);
  // The fold keeps the head's hour, which is the most recent of the group (the
  // log arrives newest first). Said out loud when the members disagree, rather
  // than passing one channel's minute off as all five.
  //
  // Compared on the FORMATTED stamp, not the raw ISO instant: the cell prints
  // to the second, so five rows written 41 ms apart show the identical string,
  // and "mới nhất" next to it would flag a disagreement the operator cannot see.
  const sameHour = isFoldUniform(group, (member) => formatDateTime(member.updatedAt));

  return (
    <>
      <tr className="border-t align-top">
        {/* No `whitespace-nowrap`: "20:04:37 20/8/26" is 16 characters, and
            pinning it pushed the eight columns past the content width — the
            date may wrap, the CODE may not (wave 1.5). */}
        <td className="px-3 py-2 tabular-nums">
          {formatDateTime(job.updatedAt)}
          {isFolded && !sameHour ? (
            <span className="text-muted-foreground block text-xs">mới nhất</span>
          ) : null}
        </td>
        {/* The Mono Ledger Rule + no break: a product code is compared down the
            column, and a code split over two lines cannot be. */}
        <th scope="row" className="px-3 py-2 text-left font-medium">
          <span className="whitespace-nowrap">{job.productCode}</span>
          {/*
            Onboarding phase 3 — provenance, on the row where "vì sao bài này
            không lên" gets asked. Read from the stamp the job carries, never
            joined from `product`: by the time somebody reads this log, that row
            may have been swept by a sync.

            Under the code rather than beside it: the code column is compared
            straight down and a badge on the same line would break that scan. And
            nothing at all for a synced job — that is nearly every row.
          */}
          {job.productOrigin === "manual" ? (
            <span className="text-warning-foreground block text-xs font-normal">
              {MANUAL_PRODUCT_BADGE}
            </span>
          ) : null}
          {isFolded ? (
            <span className="text-muted-foreground block text-xs font-normal">
              {foldCountLabel(group)}
            </span>
          ) : null}
        </th>
        <td className="px-3 py-2">
          <ColorChip color={job.color} emptyLabel="—" />
        </td>
        <td className="px-3 py-2">
          {isFolded ? (
            <FoldToggle
              isOpen={isOpen}
              onToggle={onToggle}
              controls={detailId}
              label={`${group.channelCount} kênh`}
              srSuffix={` của bài ${job.productCode}`}
            />
          ) : (
            /* The Page NAME is what an operator recognises; the id is what they
               quote to support. Name on top, id underneath in the ledger mono —
               never the id alone when a name exists. */
            <ChannelNameCell channelId={job.channelId} label={channelLabels.get(job.channelId)} />
          )}
        </td>
        <td className="px-3 py-2">
          <JobStatusBadge status={job.status} />
        </td>
        <td className="px-3 py-2 tabular-nums">{job.attemptCount}</td>
        <td className="px-3 py-2">
          {/* `wrap-anywhere`: this sentence carries Facebook's own post ids
              ("1121597217877301_1373618648258365"), one 33-character word that
              set the MIN-CONTENT width of the widest column and pushed the
              table past the page. It is prose — it may break; the product code
              two columns left may not. */}
          <p
            className={`wrap-anywhere ${job.status === "published" ? "" : "text-muted-foreground"}`}
          >
            {job.userMessage}
          </p>
          {/* One permalink per channel, so a folded row does not offer the
              head's link as if it were everybody's — the panel below carries
              one per row instead. */}
          {!isFolded ? <PublishedLink job={job} /> : null}
          {job.lastErrorCode ? (
            <p className="text-muted-foreground/80 mt-1 font-mono text-xs">{job.lastErrorCode}</p>
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
          {isFolded ? (
            // No single button can act on five jobs here: re-queueing is one
            // call per post_job, and a "Chạy lại" that silently picked one of
            // them would be the worst of both. The sentence says where the
            // buttons are (The Named Status Rule).
            <span className="text-muted-foreground text-xs">
              {job.canRetry ? "Mở danh sách kênh để chạy lại" : "—"}
            </span>
          ) : (
            <RetryAction
              job={job}
              channelName={channelName}
              isRetrying={retryingJobId === job.postJobId}
              onRetry={onRetry}
              readOnlyReason={readOnlyReason}
            />
          )}
        </td>
      </tr>

      {/* Rendered even while closed, with `hidden`: `aria-controls` above must
          point at something that exists, and the members were on screen anyway
          before the fold — keeping them mounted costs no more than the
          un-folded table did. */}
      {isFolded ? (
        <tr className="bg-muted/30 border-t" hidden={!isOpen}>
          <td id={detailId} colSpan={8} className="px-3 py-2">
            <ul className="space-y-1.5">
              {group.members.map((member) => (
                <li
                  key={member.postJobId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1"
                >
                  <span className="min-w-48">
                    <ChannelNameCell
                      channelId={member.channelId}
                      label={channelLabels.get(member.channelId)}
                    />
                  </span>
                  <span className="text-muted-foreground tabular-nums whitespace-nowrap">
                    {formatDateTime(member.updatedAt)}
                  </span>
                  <PublishedLink job={member} inline />
                  {/* `canRetry` is part of the fold key, so the whole group
                      agrees on it: when nobody can be re-queued, the summary
                      row already says so and three em-dashes down the panel
                      would be noise. */}
                  {member.canRetry ? (
                    <RetryAction
                      job={member}
                      channelName={channelSentenceName(member.channelId, channelLabels)}
                      isRetrying={retryingJobId === member.postJobId}
                      onRetry={onRetry}
                      readOnlyReason={readOnlyReason}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** The permalink of a published job, or nothing when there is no post to open. */
function PublishedLink({ job, inline = false }: { job: PostJobLogEntry; inline?: boolean }) {
  const link = job.publishedUrl ?? (job.publishedPostId ? facebookPostUrl(job.publishedPostId) : null);
  if (!link) return null;

  const anchor = (
    <>
      <a
        href={link}
        target="_blank"
        rel="noreferrer noopener"
        className="text-primary underline underline-offset-4"
      >
        Mở bài trên Facebook
      </a>
      <span className="sr-only"> (mở tab mới)</span>
    </>
  );

  return inline ? <span className="whitespace-nowrap">{anchor}</span> : <p className="mt-1">{anchor}</p>;
}

/** "Chạy lại" for ONE post_job, with whatever is currently blocking it said. */
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
    // Shown and disabled WITH the reason rather than hidden: this row IS
    // retryable, and hiding the button would look like the job was never
    // eligible.
    return (
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
      >
        {isRetrying ? "Đang xếp hàng…" : "Chạy lại"}
        <span className="sr-only">
          {" "}
          bài {job.productCode} trên kênh {channelName}
        </span>
      </Button>
    );
  }

  // No disabled button for a published/queued job: an action that can never
  // succeed should not be on screen at all.
  return <span className="text-muted-foreground text-xs">—</span>;
}
