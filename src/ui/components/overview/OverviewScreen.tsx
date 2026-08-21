"use client";

import { Collapsible, Heading, Layout, LayoutContent, LayoutHeader, Text } from "@astryxdesign/core";
import { ArrowRight, Clock3, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";

import { cn } from "@/shared/utils";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import {
  ATTENTION_LIMIT,
  RUNNING_BATCH_LIMIT,
  channelLabel,
  failureReason,
  pickAttentionItems,
  pickRunningBatches,
  statValue,
  type AttentionItem,
  type RunningBatch,
  type StatValue,
} from "@/ui/components/overview/overview-model";
import { TenantHealthPanel } from "@/ui/components/tenant/TenantHealthPanel";
import { Button } from "@/ui/components/ui/button";
import { Eyebrow } from "@/ui/components/ui/eyebrow";
import { useChannels } from "@/ui/hooks/useChannels";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useNowMs } from "@/ui/hooks/useNowMs";
import { usePostJobLog } from "@/ui/hooks/usePostJobs";
import { useScheduledJobs } from "@/ui/hooks/useScheduledJobs";
import type { JobLogFilter } from "@/ui/schemas/post-batch.schema";
import {
  formatCountdown,
  formatScheduledAt,
  timeZoneLabel,
  type ScheduledFilter,
} from "@/ui/schemas/scheduled.schema";

/**
 * "Tổng quan" — the first screen of the day (spec §3.2, wave-1 IA).
 *
 * It answers three questions in one viewport and then gets out of the way:
 * how much is waiting, what is broken, and where the work starts. Everything on
 * it is a LINK into a screen that owns the subject — the overview stores no
 * state, writes nothing, and deliberately has no numbers of its own: both
 * counts come from the FIRST cursor page of a list the operator can open, and
 * say "25+" rather than invent a total (docs/07 §4.1 + business rule 5).
 *
 * Density contract (raise 4 — reflow in declared steps, never freely), measured
 * on the CONTENT box of the column (`@container`), which is the page width minus
 * the shell, the max-width cap and this column's own padding:
 *   < 42rem  the stat tape is one column, one label + one value per row
 *   ≥ 42rem  two columns
 *   ≥ 56rem  four columns, a single woven strip (the widest the column gets is
 *            64rem − 3rem of padding, so a 64rem step would never fire)
 *
 * Motion contract (raise 2 + 3 — one event at a time, settled things stand
 * still): the only authored moments are a count that CHANGED settling into
 * place, and the compose card lifting out of its sleeve under the pointer.
 * Neither loops. The skeletons DO loop — `animate-pulse` is what says "still
 * waiting" — but they are `aria-hidden`, they only exist while a query is in
 * flight, and nothing that has settled keeps moving. Every animation on the
 * screen, skeletons included, is `motion-safe:` only.
 *
 * The four states, per source, on purpose: the two lists are independent
 * queries and a failure of one must not blank the other (core-feedback-states).
 *   loading — skeleton in the value slot / the row list, delayed 300ms
 *   data    — the tape, the attention list
 *   empty   — "Không có gì cần chú ý"
 *   error   — a local ApiErrorNotice naming the source that failed; the other
 *             source keeps rendering its rows
 */

/**
 * Module constants, not inline objects: these are query keys. The scheduled
 * filter matches the default `/posts?tab=scheduled` view and the failed filter
 * matches `/posts?tab=log&status=failed`, so opening either screen from here
 * reuses the page this screen already loaded instead of refetching it.
 */
const ALL_SCHEDULED: ScheduledFilter = { channelId: null, from: null, to: null };
const FAILED_JOBS: JobLogFilter = { status: "failed", batchId: null };

const SCHEDULED_HREF = "/posts?tab=scheduled";
const FAILED_HREF = "/posts?tab=log&status=failed";
/** `published` is a real `PostJobStatus`, so the log opens already filtered. */
const PUBLISHED_HREF = "/posts?tab=log&status=published";
/** `?status=blocked` is what `parseProductFilter` reads — see catalog.schema. */
const BLOCKED_PRODUCTS_HREF = "/products?status=blocked";

export function OverviewScreen() {
  const attentionHeadingId = useId();
  const composeHeadingId = useId();
  const runningHeadingId = useId();
  const nowMs = useNowMs();

  const scheduled = useScheduledJobs(ALL_SCHEDULED);
  const failed = usePostJobLog(FAILED_JOBS);
  // Names only: a row that cannot be named falls back to the raw channel id
  // rather than waiting for this query (see `channelLabel`).
  const channels = useChannels();

  /**
   * "Still on its way here", derived from DATA, not from `isPending`.
   *
   * The regression this exists for: a query that fails and then retries goes
   * back to pending for a few seconds, and a screen keyed on `isPending` reads
   * that as "first load" — the tape printed a confident `0` for a list it had
   * never managed to read, and the attention block blanked itself every retry
   * cycle even though the OTHER source had rows on screen. No page, no number.
   */
  const scheduledWaiting = scheduled.data === undefined && !scheduled.isError;
  const failedWaiting = failed.data === undefined && !failed.isError;
  const showSkeleton = useDelayedFlag(scheduledWaiting || failedWaiting);

  const scheduledItems = useMemo(
    () => scheduled.data?.pages.flatMap((page) => page.items) ?? [],
    [scheduled.data],
  );
  const failedItems = useMemo(
    () => failed.data?.pages.flatMap((page) => page.items) ?? [],
    [failed.data],
  );

  const attention = useMemo(
    () =>
      pickAttentionItems({
        failedJobs: failedItems.map((job) => ({
          id: job.postJobId,
          code: job.productCode,
          color: job.color,
          channelName: channelLabel(job.channelId, channels.data?.channels),
          reason: failureReason(job),
        })),
        upcoming: scheduledItems.map((job) => ({
          id: job.postJobId,
          code: job.productCode,
          color: job.color,
          channelName: channelLabel(job.channelId, channels.data?.channels),
          scheduledAt: job.scheduledAt,
        })),
      }),
    [failedItems, scheduledItems, channels.data],
  );

  /**
   * The lots with work in flight, DERIVED from the job pages this screen has
   * already loaded — no query of its own (docs/07 §4.1: the overview reads,
   * never fetches for a second reason).
   *
   * KNOWN LIMIT, stated here because the section looks broken otherwise: the
   * only job-log query on this screen is filtered to `status=failed`, so a
   * running job cannot appear in it today and the section stays hidden. The day
   * this screen loads an unfiltered page — or the log filter grows a
   * "đang chạy" value — the cards light up with no further change here.
   */
  const runningBatches = useMemo(
    () =>
      pickRunningBatches(
        failedItems.map((job) => ({
          batchId: job.batchId,
          status: job.status,
          code: job.productCode,
          scheduledAt: job.scheduledAt,
        })),
      ),
    [failedItems],
  );

  const isRefreshing = scheduled.isFetching || failed.isFetching;
  /**
   * Only a refresh the OPERATOR asked for. The live region below is keyed on
   * this, not on `isRefreshing`: both lists poll on their own, and announcing
   * every poll made a screen reader say "Đang tải số liệu tổng quan" once a
   * minute, forever, over whatever the person was actually reading
   * (core-feedback-states: chỉ thông báo thứ người dùng vừa gây ra).
   */
  const [isUserRefreshing, setIsUserRefreshing] = useState(false);

  /** Both lists are stale at the same moment, so one button refreshes both. */
  function refreshAll() {
    setIsUserRefreshing(true);
    // `allSettled`, so a failing source still clears the flag — and the
    // failure itself is already on screen in that source's own notice.
    void Promise.allSettled([
      scheduled.refetch(),
      failed.refetch(),
      channels.isError ? channels.refetch() : Promise.resolve(),
    ]).then(() => setIsUserRefreshing(false));
  }

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider>
          <div className="flex flex-wrap items-start justify-between gap-4 p-4">
            <div className="max-w-prose space-y-1">
              <Heading level={1}>Tổng quan</Heading>
              <Text type="supporting">
                Hôm nay có gì cần làm: bài đang chờ tới giờ, bài lỗi cần xử lý, và lối vào soạn bài
                mới. Giờ hiển thị theo múi giờ máy bạn ({timeZoneLabel()}).
              </Text>
            </div>
            <Button type="button" variant="outline" size="lg" onClick={refreshAll} disabled={isRefreshing}>
              {isRefreshing ? "Đang tải…" : "Tải lại"}
            </Button>
          </div>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <div className="@container mx-auto w-full max-w-5xl space-y-10 px-6 py-8">
            <p className="sr-only" role="status" aria-live="polite">
              {isUserRefreshing ? "Đang tải số liệu tổng quan" : ""}
            </p>

            <StatTape
              scheduled={statValue({
                hasData: scheduled.data !== undefined,
                isError: scheduled.isError,
                loaded: scheduledItems.length,
                hasNextPage: scheduled.hasNextPage,
              })}
              failed={statValue({
                hasData: failed.data !== undefined,
                isError: failed.isError,
                loaded: failedItems.length,
                hasNextPage: failed.hasNextPage,
              })}
              showSkeleton={showSkeleton}
            />

            {/* Per-source errors. The source is IN the notice's own title —
                a kicker above a notice is a label doing the heading's job
                (craft floor), and the notice already has a heading. */}
            {scheduled.isError ? (
              <ApiErrorNotice
                className="mx-0 max-w-none"
                source="Bài đã hẹn"
                error={scheduled.error}
                onRetry={() => void scheduled.refetch()}
                // One of two sources on a screen that still works: the tape
                // and the other list are on screen and readable. Both
                // notices grabbing focus would also mean the second one wins
                // and the first is never seen.
                shouldFocus={false}
              />
            ) : null}

            {failed.isError ? (
              <ApiErrorNotice
                className="mx-0 max-w-none"
                source="Nhật ký đăng"
                error={failed.error}
                onRetry={() => void failed.refetch()}
                shouldFocus={false}
              />
            ) : null}

            {/* Two columns from @4xl, one before that (density contract above).
                The action column is FIRST in the DOM at every width: stacked on
                a phone it must not sit under six rows of to-do, and reading
                "what this screen is for" before "what is broken" is the same
                order in both layouts — no re-ordering between breakpoints, so
                the tab order never disagrees with the page. */}
            <div className="grid grid-cols-1 gap-x-8 gap-y-10 @4xl:grid-cols-[minmax(0,1fr)_21rem]">
              <div className="space-y-8 @4xl:col-start-2 @4xl:row-start-1">
                <ComposeCard headingId={composeHeadingId} />
                <RunningBatches
                  headingId={runningHeadingId}
                  lots={runningBatches}
                  // A cursor page still outstanding means there may be more
                  // lots than we can see: "3+ lô", never a flat "3".
                  hasMore={failed.hasNextPage === true}
                />
              </div>

              <AttentionBlock
                className="@4xl:col-start-1 @4xl:row-start-1"
                headingId={attentionHeadingId}
                items={attention}
                nowMs={nowMs}
                // Rows the moment ANY source has them: a list that already has
                // work on it must not go back to a skeleton because the other
                // query is still trying.
                isLoading={attention.length === 0 && (scheduledWaiting || failedWaiting)}
                showSkeleton={showSkeleton}
                hasBrokenSource={scheduled.isError || failed.isError}
                hasUnnamedChannels={channels.isError}
              />
            </div>

            <HealthDisclosure />
          </div>
        </LayoutContent>
      }
    />
  );
}

/**
 * The woven label strip: four destinations, hairline-stitched together.
 *
 * NOT four KPI cards — the tape is one surface, and the hierarchy inside it is
 * type SIZE on a shared baseline (raise 1): a counted cell sets its number in
 * the ledger mono at display size, a cell with no source yet sets a sentence at
 * body size. That difference is the honest one: two of these four have a number
 * behind them and two do not, and no colour is asked to say so.
 */
function StatTape({
  scheduled,
  failed,
  showSkeleton,
}: {
  scheduled: StatValue;
  failed: StatValue;
  showSkeleton: boolean;
}) {
  return (
    <nav aria-label="Số liệu nhanh">
      {/* gap-px over the border colour draws every stitch line once, at any
          column count — no per-cell borders to double up when it reflows. */}
      <ul className="bg-border border-border grid grid-cols-1 gap-px overflow-hidden rounded-md border @2xl:grid-cols-2 @4xl:grid-cols-4">
        <StatCell
          label="Đang chờ giờ"
          href={SCHEDULED_HREF}
          source={scheduled}
          showSkeleton={showSkeleton}
          unit="bài đã hẹn"
          destination="Mở danh sách bài đã hẹn"
        />
        <StatCell
          label="Lỗi cần xử lý"
          href={FAILED_HREF}
          source={failed}
          showSkeleton={showSkeleton}
          unit="bài lỗi"
          destination="Mở nhật ký lọc theo lỗi"
        />
        {/* "Bài đã đăng", not "Bài lên hôm nay": nothing on this screen counts
            a day, and the log behind it is the whole history. A label that
            promised "hôm nay" and opened an unfiltered list was the tape's one
            dishonest cell. */}
        <StatCell
          label="Bài đã đăng"
          href={PUBLISHED_HREF}
          action="Mở nhật ký"
          hint="Chưa có số liệu đếm sẵn"
        />
        <StatCell
          label="Mã bị chặn"
          href={BLOCKED_PRODUCTS_HREF}
          action="Mở danh sách mã"
          hint="Chưa có số liệu đếm sẵn"
        />
      </ul>
    </nav>
  );
}

/**
 * One cell of the tape. Either it counts something (`source`) or it is a plain
 * doorway (`action`) — a doorway never shows a number, because there is no
 * endpoint behind it yet and a made-up figure on this screen would be believed.
 */
function StatCell({
  label,
  href,
  source,
  showSkeleton,
  unit,
  destination,
  action,
  hint,
}: {
  label: string;
  href: string;
  /** Absent = this cell is a doorway, not a count (see `action`). */
  source?: StatValue;
  showSkeleton?: boolean;
  unit?: string;
  destination?: string;
  action?: string;
  hint?: string;
}) {
  return (
    <li className="bg-card">
      <Link
        href={href}
        className="hover:bg-accent/40 focus-visible:ring-ring/50 flex h-full flex-col gap-3 px-5 py-4 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-inset"
      >
        <Eyebrow>{label}</Eyebrow>

        {source ? (
          <span className="flex min-h-9 items-baseline gap-2">
            {source.kind === "loading" ? (
              showSkeleton ? (
                <span
                  aria-hidden="true"
                  className="bg-muted h-8 w-16 self-center rounded motion-safe:animate-pulse"
                />
              ) : null
            ) : source.kind === "unavailable" ? (
              <span className="text-muted-foreground text-base">Không tải được</span>
            ) : (
              <>
                {/* Keyed by the value: a count that CHANGED is the one thing on
                    this screen allowed to move (raise 2). Same value, same key,
                    no animation — a poll that changes nothing looks like
                    nothing.

                    It SETTLES rather than fades: the digit is at full ink for
                    every frame it exists (craft floor — animate from an
                    already-visible default), so a dropped frame or a throttled
                    tab can never leave a washed-out number on screen. */}
                <span
                  key={source.text}
                  className="font-mono text-4xl leading-none font-semibold tabular-nums motion-safe:animate-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-500 motion-safe:ease-out"
                >
                  {source.text}
                </span>
                <span className="text-muted-foreground text-sm">{unit}</span>
              </>
            )}
          </span>
        ) : (
          <span className="flex min-h-9 items-center">
            <span className="text-base font-medium">{action}</span>
          </span>
        )}

        <span className="text-muted-foreground text-xs">{hint ?? destination}</span>
      </Link>
    </li>
  );
}

/**
 * "Việc cần chú ý" — rows, not cards (Astryx layout doctrine: anything scanned
 * is a row). Failed first; six at most, because this is a to-do list read
 * standing up and the job log itself is one click from every row.
 */
function AttentionBlock({
  headingId,
  items,
  nowMs,
  isLoading,
  showSkeleton,
  hasBrokenSource,
  hasUnnamedChannels,
  className,
}: {
  headingId: string;
  items: readonly AttentionItem[];
  nowMs: number;
  isLoading: boolean;
  showSkeleton: boolean;
  hasBrokenSource: boolean;
  hasUnnamedChannels: boolean;
  /** Grid placement from the caller — the block never picks its own column. */
  className?: string;
}) {
  return (
    <section aria-labelledby={headingId} className={cn("space-y-3", className)}>
      <div className="space-y-1">
        <h2 id={headingId} className="text-xl font-semibold tracking-tight">
          Việc cần chú ý
        </h2>
        <p className="text-muted-foreground max-w-prose text-sm">
          Bài lỗi đứng trước, rồi tới những bài sắp tới giờ — tối đa {ATTENTION_LIMIT} việc. Bấm một
          dòng để mở đúng danh sách xử lý.
        </p>
      </div>

      {hasUnnamedChannels ? (
        <p className="text-muted-foreground text-sm">
          Không tải được danh sách Page nên các dòng dưới đây đang hiện mã kênh thay vì tên Page.
        </p>
      ) : null}

      {isLoading ? (
        showSkeleton ? (
          <ul aria-hidden="true" className="divide-border bg-card divide-y rounded-md border">
            {[0, 1, 2].map((row) => (
              <li key={row} className="space-y-2 px-4 py-3 motion-safe:animate-pulse">
                <div className="bg-muted h-4 w-52 rounded" />
                <div className="bg-muted h-3 w-full max-w-md rounded" />
              </li>
            ))}
          </ul>
        ) : null
      ) : items.length > 0 ? (
        <ul className="divide-border bg-card divide-y rounded-md border">
          {items.map((item) => (
            <AttentionRow key={item.id} item={item} nowMs={nowMs} />
          ))}
        </ul>
      ) : hasBrokenSource ? (
        // Not "mọi bài đang đúng lịch": with a query down, an empty list is a
        // gap in what we know, and saying otherwise would be a false all-clear.
        <p className="text-muted-foreground text-sm">
          Chưa dựng được danh sách việc cần chú ý vì một nguồn dữ liệu đang lỗi — xem thông báo phía
          trên.
        </p>
      ) : (
        <EmptyState
          kind="done"
          title="Không có gì cần chú ý — mọi bài đang đúng lịch."
          description="Khi có bài đăng lỗi hoặc bài sắp tới giờ, việc cần làm sẽ hiện ở đây."
        />
      )}
    </section>
  );
}

function AttentionRow({ item, nowMs }: { item: AttentionItem; nowMs: number }) {
  const isFailed = item.kind === "failed";
  const href = isFailed ? FAILED_HREF : SCHEDULED_HREF;

  return (
    <li>
      <Link
        href={href}
        className="hover:bg-accent/40 focus-visible:ring-ring/50 flex items-start gap-3 px-4 py-3 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-inset"
      >
        {isFailed ? (
          <TriangleAlert aria-hidden="true" className="text-destructive mt-0.5 size-4 shrink-0" />
        ) : (
          <Clock3 aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        )}

        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2">
            {/* The Mono Ledger Rule: a product code is data an operator reads
                out loud and compares column-wise, never prose. */}
            <span className="font-mono text-sm font-semibold">{item.code}</span>
            {item.color ? <span className="text-sm">{item.color}</span> : null}
            <span className="text-muted-foreground text-sm">· {item.channelName}</span>
          </span>

          {/* No `block` next to `line-clamp-2`: the clamp needs
              `display:-webkit-box`, and a display utility beside it silently
              turns the clamp off — three-line reasons in a six-row list. */}
          <span className="text-muted-foreground line-clamp-2 text-sm">
            {isFailed ? item.reason : upcomingLine(item.scheduledAt, nowMs)}
          </span>
        </span>

        <span className="sr-only">
          {isFailed ? "— mở nhật ký bài lỗi" : "— mở danh sách bài đã hẹn"}
        </span>
      </Link>
    </li>
  );
}

/**
 * "Lên lúc 21/08/2026 15:30 · còn 2 giờ".
 *
 * `nowMs === 0` means the browser clock is not known yet (server render, first
 * frame): the hour is still shown, the countdown is not — a countdown computed
 * against a zero clock would read "quá giờ 56 năm".
 */
function upcomingLine(scheduledAt: string, nowMs: number): string {
  const at = formatScheduledAt(scheduledAt);
  const instant = Date.parse(scheduledAt);
  if (nowMs === 0 || Number.isNaN(instant)) return `Lên lúc ${at}`;
  return `Lên lúc ${at} · ${formatCountdown(instant - nowMs)}`;
}

/**
 * The one primary action, drawn as the swatch card it is: pulled half out of
 * its sleeve, tab showing, ready to be taken. Under the pointer it comes out
 * a little further — the single hover moment on the page.
 */
function ComposeCard({ headingId }: { headingId: string }) {
  return (
    <section aria-labelledby={headingId} className="relative pb-4">
      {/* The sleeve the card sits in. Decorative: the link below carries the
          whole meaning, so this is hidden from the accessibility tree. */}
      <span
        aria-hidden="true"
        className="border-border bg-secondary absolute inset-x-6 bottom-0 h-14 rounded-md border"
      />

      <Link
        href="/compose"
        className="group border-primary bg-primary text-primary-foreground focus-visible:ring-ring/50 relative flex items-center justify-between gap-6 rounded-md border px-6 py-6 shadow-sm transition duration-300 ease-out outline-none hover:shadow-md focus-visible:ring-3 motion-safe:hover:-translate-y-1.5 motion-safe:focus-visible:-translate-y-1.5"
      >
        {/* The stepped tabs that identify a swatch card in this world: the card
            in hand, and the next one in the fan behind it. */}
        <span
          aria-hidden="true"
          className="bg-accent absolute -top-3.5 left-26 h-3.5 w-14 rounded-t-sm"
        />
        <span
          aria-hidden="true"
          className="bg-primary absolute -top-2.5 left-8 h-2.5 w-20 rounded-t-sm"
        />

        <span className="space-y-1">
          <span id={headingId} className="block text-xl font-semibold tracking-tight">
            Soạn bài mới
          </span>
          <span className="text-primary-foreground/85 block text-sm">
            Chọn mã và màu, duyệt caption từng kênh, rồi đăng.
          </span>
        </span>

        {/* Static: the card lifting under the pointer is this page's one motion
            moment, and an arrow sliding beside it would make two. */}
        <ArrowRight aria-hidden="true" className="size-5 shrink-0" />
      </Link>
    </section>
  );
}

/**
 * "Lô đang chạy" — the batches with work in flight, as swatch cards.
 *
 * Same stepped-tab geometry as the compose card (the signature shape of this
 * world) at a smaller size and on the plain card surface, so it reads as
 * another card from the same fan without competing with the one primary action
 * sitting above it.
 *
 * NO empty state on purpose: "không có lô nào đang chạy" is the normal state of
 * a quiet morning, and a placeholder saying so every day would be a permanent
 * empty box next to the action. Nothing running, nothing drawn.
 */
function RunningBatches({
  headingId,
  lots,
  hasMore,
}: {
  headingId: string;
  lots: readonly RunningBatch[];
  /** A cursor page is still outstanding, so this list may be partial. */
  hasMore: boolean;
}) {
  if (lots.length === 0) return null;

  const shown = lots.slice(0, RUNNING_BATCH_LIMIT);
  const overflow = lots.length - shown.length;

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-xl font-semibold tracking-tight">
          Lô đang chạy
        </h2>
        {/* "3+" whenever a page is outstanding: this count is what the client
            has read, never a server total (business rule 5). */}
        <span className="text-muted-foreground text-sm tabular-nums">
          {lots.length}
          {hasMore ? "+" : ""} lô
        </span>
      </div>

      <ul className="space-y-4">
        {shown.map((lot) => (
          <RunningBatchCard key={lot.batchId} lot={lot} />
        ))}
      </ul>

      {overflow > 0 ? (
        <p className="text-muted-foreground text-sm">
          Và {overflow} lô nữa — mở nhật ký để xem hết.
        </p>
      ) : null}
    </section>
  );
}

function RunningBatchCard({ lot }: { lot: RunningBatch }) {
  return (
    <li className="relative pt-2.5">
      <Link
        href={`/batches/${encodeURIComponent(lot.batchId)}`}
        className="group border-border bg-card hover:bg-accent/40 focus-visible:ring-ring/50 relative flex items-center justify-between gap-4 rounded-md border px-4 py-3.5 transition-colors outline-none focus-visible:ring-3"
      >
        {/* The one stepped tab of a card still in the fan. Decorative — the
            link carries the meaning. */}
        <span
          aria-hidden="true"
          className="bg-accent absolute -top-2.5 left-6 h-2.5 w-12 rounded-t-sm"
        />

        <span className="min-w-0 space-y-0.5">
          {/* Mono ledger rule: a product code, or the lot id when the running
              jobs of the lot do not agree on one. */}
          <span className="block truncate font-mono text-sm font-semibold">
            {lot.code ?? shortBatchId(lot.batchId)}
          </span>
          <span className="text-muted-foreground block text-sm">
            {lot.jobCount} bài đang chạy
          </span>
        </span>

        <ArrowRight aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
        <span className="sr-only">— mở tiến độ lô</span>
      </Link>
    </li>
  );
}

/**
 * A lot id an operator can read out loud. The full UUID is in the URL of the
 * link, so nothing is lost — a 36-character id in a 21rem column is not.
 */
function shortBatchId(batchId: string): string {
  return `Lô ${batchId.slice(0, 8)}`;
}

/**
 * The health check, folded away. It used to BE this page; it is now the last
 * line of it, and its query only runs once somebody opens the panel — a check
 * nobody asked for must not fire on every visit to the home screen.
 */
function HealthDisclosure() {
  const [isOpen, setIsOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  return (
    // Named by `aria-label`, not by a visually hidden heading: the trigger
    // below already carries the words, and a heading with the same text made a
    // screen reader say "Sức khoẻ hệ thống" twice in a row.
    <section
      aria-label="Sức khoẻ hệ thống"
      className="border-border bg-card rounded-md border px-2"
    >
      <Collapsible
        trigger={<span className="text-sm font-medium">Sức khoẻ hệ thống</span>}
        isOpen={isOpen}
        onOpenChange={(open: boolean) => {
          setIsOpen(open);
          if (open) setHasOpened(true);
        }}
      >
        {/* Mounted on first open and kept mounted afterwards: unmounting on
            every close would re-run the check each time it is reopened. */}
        <div className="px-2 pb-3">{hasOpened ? <TenantHealthPanel /> : null}</div>
      </Collapsible>
    </section>
  );
}
