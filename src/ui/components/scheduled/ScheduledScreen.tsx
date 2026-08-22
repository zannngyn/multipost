"use client";

import {
  DateInput,
  SegmentedControl,
  SegmentedControlItem,
  type ISODateString,
} from "@astryxdesign/core";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useMemo, useState } from "react";

import {
  channelFilterOptions,
  channelLabelIndex,
  channelSentenceName,
} from "@/ui/components/channels/channel-option-labels";
import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { POSTS_TAB_PARAM, withTabParam } from "@/ui/components/posts/posts-tabs";
import { resolveMonthKey } from "@/ui/components/scheduled/calendar-grid";
import { CancelDialog } from "@/ui/components/scheduled/CancelDialog";
import { RescheduleDialog } from "@/ui/components/scheduled/RescheduleDialog";
import { ScheduledCalendar } from "@/ui/components/scheduled/ScheduledCalendar";
import { ScheduledJobTable } from "@/ui/components/scheduled/ScheduledJobTable";
import {
  ScheduledCalendarSkeleton,
  ScheduledSkeleton,
} from "@/ui/components/scheduled/ScheduledSkeleton";
import { Button } from "@/ui/components/ui/button";
import { Select } from "@/ui/components/ui/select";
import { useChannelGroups } from "@/ui/hooks/useChannelGroups";
import { useChannels } from "@/ui/hooks/useChannels";
import { useDelayedFlag } from "@/ui/hooks/useDelayedFlag";
import { useReadOnlyReason } from "@/ui/hooks/useReadOnlyReason";
import { useNowMs } from "@/ui/hooks/useNowMs";
import {
  SCHEDULED_DIALOG_PARAMS,
  formatDayHeading,
  formatDayInput,
  groupScheduledByDay,
  hasScheduledFilter,
  isDateOnly,
  parseScheduledFilter,
  parseScheduledView,
  scheduledSearchParams,
  timeZoneLabel,
  type ScheduledFilter,
  type ScheduledViewState,
} from "@/ui/schemas/scheduled.schema";
import {
  useCancelScheduledJob,
  useReschedulePostJob,
  useScheduledJobs,
} from "@/ui/hooks/useScheduledJobs";

/**
 * "Bài đã hẹn" (E8.4): component -> hook -> service -> internal API.
 *
 * Soonest first, grouped by day: the screen answers "cái gì sắp lên?", so the
 * next event is at the top and the operator reads a timeline, not a table dump.
 *
 * Two modes over ONE query: the list (a timeline of what is next) and the month
 * calendar (where the work sits across the month). The calendar reuses the same
 * loaded rows and the same day table, so "Đổi giờ"/"Huỷ" exist once.
 *
 * The filter, the mode, the anchored month, the open day AND the two dialogs all
 * live in the URL (core-data-list-query rule 1 + web-calendar-view rule 1 +
 * web-crud-inline-edit rule 1): `/scheduled?channelId=fbpage-a&che-do=lich&
 * thang=2026-08&ngay=2026-08-13` is shareable, survives F5 and makes Back
 * behave. `useState` for any of them would lose all three.
 *
 * WHY THE MODE DOES NOT REFETCH: only the filter is in the query key. The
 * schedule horizon is 30 days (MAX_SCHEDULE_AHEAD_DAYS), so what the list has
 * loaded is what any reachable month can contain — the calendar buckets the very
 * same rows client-side. Switching mode or walking months is free, and there is
 * no second fetch policy to keep in sync. When a page is still outstanding the
 * calendar says so rather than drawing a month it cannot vouch for.
 *
 * The four mandatory states, in both modes:
 *   loading — skeleton with the real shape (day groups / 6×7 grid), delayed 300ms
 *   data    — day groups or the month grid + "Tải thêm" (cursor, no page numbers)
 *   empty   — told apart: "chưa có bài nào được hẹn giờ" (nothing scheduled) vs
 *             "không có bài nào khớp bộ lọc" (a filter is on); the calendar adds
 *             a third, "trống ở tháng này nhưng có bài ở tháng khác"
 *   error   — 4xx (sửa bộ lọc) vs 5xx (thử lại), via `presentApiError`
 */
export function ScheduledScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const channelFilterId = useId();
  const nowMs = useNowMs();

  const filter = useMemo(
    () => parseScheduledFilter(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const view = useMemo(
    () => parseScheduledView(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const list = useScheduledJobs(filter);
  const groups = useChannelGroups();
  // Names for the ids the schedule speaks in. A separate query on purpose: it
  // is cached across the whole app (30s staleTime), and a failure here must
  // only cost the NAMES — the schedule itself still loads and still works.
  const channels = useChannels();
  const reschedule = useReschedulePostJob();
  const cancel = useCancelScheduledJob();
  // Support mode is read-only (M3.3): a customer's schedule may be read, never
  // moved or cancelled. The table folds this into its own per-row reason slot.
  const readOnlyReason = useReadOnlyReason();
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const isFirstLoad = list.isPending && list.fetchStatus === "fetching";
  const showSkeleton = useDelayedFlag(isFirstLoad);

  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const dayGroups = useMemo(() => groupScheduledByDay(items), [items]);
  const filtered = hasScheduledFilter(filter);

  const isCalendar = view.view === "calendar";
  /** null only while the browser clock is unknown — the screen then waits. */
  const monthKey = resolveMonthKey(view.month, view.day, nowMs);
  /** A failure with nothing to fall back on. With rows on screen we keep them. */
  const isFatalError = list.isError && items.length === 0;
  /** The row being changed right now — its actions are disabled while it runs. */
  const busyJobId = reschedule.isPending
    ? (reschedule.variables?.postJobId ?? null)
    : cancel.isPending
      ? (cancel.variables?.postJobId ?? null)
      : null;

  /**
   * The "Lọc theo kênh" options: ids the tenant actually uses (from the preset
   * groups, E7.6), each carrying the PAGE NAME the operator knows. The value
   * stays the id — that is what the URL and the API speak — but nothing on
   * screen is a bare `fb-1121597217877301` any more (spec §3.1).
   */
  const channelOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const group of groups.data?.groups ?? []) {
      for (const channelId of group.channelIds) ids.add(channelId);
    }
    // Keep the active filter selectable even when its group was deleted, or the
    // select would silently jump back to "Tất cả kênh" while the URL says else.
    if (filter.channelId) ids.add(filter.channelId);
    return channelFilterOptions([...ids], channels.data?.channels);
  }, [groups.data, filter.channelId, channels.data]);

  /**
   * One resolve for every row on screen, shared by the table, the calendar and
   * the two dialogs — the rule rebuilds a Map of all channels per call, so
   * resolving per row would be O(rows × channels) (wave 1, M-1).
   */
  const channelLabels = useMemo(
    () => channelLabelIndex(items.map((item) => item.channelId), channels.data?.channels),
    [items, channels.data],
  );

  const rescheduleId = searchParams.get(SCHEDULED_DIALOG_PARAMS.reschedule)?.trim() ?? "";
  const cancelId = searchParams.get(SCHEDULED_DIALOG_PARAMS.cancel)?.trim() ?? "";
  const rescheduleJob = items.find((item) => item.postJobId === rescheduleId) ?? null;
  const cancelJob = items.find((item) => item.postJobId === cancelId) ?? null;

  /**
   * THE single writer of this screen's URL — filter and view state travel
   * together, so changing one can never silently drop the other.
   *
   * `replace`: neither a filter nor a month is a navigation step worth walking
   * back through one at a time.
   */
  function pushUrl(nextFilter: ScheduledFilter, nextView: ScheduledViewState) {
    setNotice(null);
    setWarning(null);
    // The hub's `?tab=` rides along on every rewrite: this screen replaces the
    // WHOLE query, and dropping the tab would bounce the operator to the other
    // tab on the next server render.
    const query = withTabParam(
      scheduledSearchParams(nextFilter, nextView).toString(),
      searchParams.get(POSTS_TAB_PARAM),
    );
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function hrefForDialog(action: "reschedule" | "cancel", postJobId: string): string {
    const params = scheduledSearchParams(filter, view);
    params.set(SCHEDULED_DIALOG_PARAMS[action], postJobId);
    return `${pathname}?${withTabParam(params.toString(), searchParams.get(POSTS_TAB_PARAM))}`;
  }

  /** Closing a dialog only drops its parameter — filter, month and tab survive. */
  function closeDialogs() {
    reschedule.reset();
    cancel.reset();
    const query = withTabParam(
      scheduledSearchParams(filter, view).toString(),
      searchParams.get(POSTS_TAB_PARAM),
    );
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function handleReschedule(params: { postJobId: string; scheduledAt: string }) {
    setNotice(null);
    setWarning(null);
    reschedule.mutate(params, {
      onSuccess: (result) => {
        setNotice(result.userMessage);
        // A leftover delayed entry can still fire at the OLD hour: publish-post
        // only guards on status, so an early post is possible. Say it.
        if (!result.previousQueueEntryRemoved) {
          setWarning(
            "Đã lưu giờ mới, nhưng không xoá được lịch cũ trong hàng đợi — bài vẫn có thể lên vào giờ cũ. Hãy theo dõi ở Nhật ký đăng bài.",
          );
        }
        closeDialogs();
      },
      // The error stays inside the dialog so the chosen time is not lost.
    });
  }

  function handleCancel(params: { postJobId: string; note?: string }) {
    setNotice(null);
    setWarning(null);
    cancel.mutate(params, {
      onSuccess: (result) => {
        setNotice(result.userMessage);
        // A post FACEBOOK was holding owns no queue entry (the handoff cleared
        // it), so `queueEntryRemoved` is false by design there — warning about a
        // leftover entry that never existed would be a false alarm.
        if (!result.queueEntryRemoved && !result.platformPostDeleted) {
          setWarning(
            "Đã huỷ trong hệ thống, nhưng không xoá được lịch cũ trong hàng đợi. Bài vẫn sẽ KHÔNG lên (trạng thái đã là “Bị chặn”), chỉ là hàng đợi còn một mục thừa.",
          );
        }
        closeDialogs();
      },
    });
  }

  return (
    <section className="space-y-6" aria-labelledby="scheduled-heading">
      <header className="space-y-1">
        {/* h2: since the wave-1 IA this screen is a TAB inside /posts, and the
            hub above it owns the page's h1 (core-accessibility §1). */}
        <h2 id="scheduled-heading" className="text-2xl font-semibold tracking-tight">
          Bài đã hẹn
        </h2>
        <p className="text-muted-foreground max-w-prose text-sm">
          Những bài đang chờ tới giờ đăng. Chế độ Danh sách xếp bài sớm nhất lên trên; chế độ Lịch
          tháng cho thấy công việc rải ra trong tháng — bấm vào một ngày để mở chi tiết. Giờ hiển
          thị theo múi giờ máy bạn ({timeZoneLabel()}). Đổi giờ hoặc huỷ chỉ được trước khi tới giờ
          — tồn kho vẫn được kiểm tra lại ngay trước khi đăng. Bài mang nhãn “Facebook giữ lịch” đã
          nằm sẵn trên Facebook và Facebook sẽ tự đăng: bài đó không đổi giờ được nữa, muốn đổi thì
          bấm Huỷ rồi soạn lại.
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <SegmentedControl
          label="Chế độ xem bài đã hẹn"
          value={view.view}
          size="sm"
          // The mode is view state, so it rides in the URL but stays out of the
          // query key — switching draws the same rows a second way, never
          // refetches them. Turning the calendar on PINS the month it resolved
          // to, so the link is already shareable before the operator touches
          // anything; going back to the list drops both month and open day.
          onChange={(next) =>
            pushUrl(
              filter,
              next === "calendar"
                ? { view: "calendar", month: monthKey, day: null }
                : { ...view, view: "list" },
            )
          }
        >
          <SegmentedControlItem label="Danh sách" value="list" />
          <SegmentedControlItem label="Lịch tháng" value="calendar" />
        </SegmentedControl>

        <div className="min-w-0 basis-64 space-y-1.5">
          <label htmlFor={channelFilterId} className="text-sm font-medium">
            Lọc theo kênh
          </label>
          <Select
            id={channelFilterId}
            value={filter.channelId ?? ""}
            onChange={(event) =>
              pushUrl({ ...filter, channelId: event.target.value || null }, view)
            }
          >
            <option value="">Tất cả kênh</option>
            {channelOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        {/* Pure dates, kept as "YYYY-MM-DD" strings from the field to the URL to
            the request builder — never through `new Date()`, which is the one
            cause of the off-by-one-day (core-form-inputs). `max`/`min` state the
            window BEFORE a choice is made; `parseScheduledFilter` re-checks it. */}
        <DateInput
          label="Từ ngày"
          size="sm"
          width={180}
          hasClear
          weekStartsOn="mon"
          placeholder="dd/mm/yyyy"
          format={formatDayInput}
          value={(filter.from ?? undefined) as ISODateString | undefined}
          max={(filter.to ?? undefined) as ISODateString | undefined}
          onChange={(value) => pushUrl({ ...filter, from: normalizeDay(value) }, view)}
        />

        <DateInput
          label="Đến hết ngày"
          size="sm"
          width={180}
          hasClear
          weekStartsOn="mon"
          placeholder="dd/mm/yyyy"
          format={formatDayInput}
          value={(filter.to ?? undefined) as ISODateString | undefined}
          min={(filter.from ?? undefined) as ISODateString | undefined}
          onChange={(value) => pushUrl({ ...filter, to: normalizeDay(value) }, view)}
        />

        {filtered ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => pushUrl({ channelId: null, from: null, to: null }, view)}
          >
            Bỏ bộ lọc
          </Button>
        ) : null}

        <Button
          type="button"
          variant="outline"
          onClick={() => void list.refetch()}
          disabled={list.isFetching}
        >
          {list.isFetching ? "Đang tải…" : "Tải lại"}
        </Button>
      </div>

      {groups.isError ? (
        <p className="text-muted-foreground text-sm">
          Không tải được danh sách nhóm kênh nên ô lọc kênh đang trống. Bộ lọc ngày vẫn dùng được.
        </p>
      ) : null}

      {/* Said out loud rather than left as a silent fallback: without it the
          rows quietly go back to showing mã kênh and nobody knows why. */}
      {channels.isError ? (
        <p className="text-muted-foreground text-sm">
          Không tải được tên Page nên danh sách đang hiện mã kênh. Lịch và các thao tác vẫn dùng
          được bình thường.
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className="border-success/30 bg-success/10 text-success-foreground rounded-lg border px-3 py-2 text-sm"
        >
          {notice}
        </p>
      ) : null}

      {warning ? (
        <p
          role="alert"
          className="border-warning/40 bg-warning/10 text-warning-foreground rounded-lg border px-3 py-2 text-sm"
        >
          {warning}{" "}
          <Link href="/posts?tab=log" className="underline underline-offset-4">
            Mở nhật ký đăng bài
          </Link>
          .
        </p>
      ) : null}

      {/* --- Loading: each mode keeps its OWN shape, so nothing jumps ------- */}
      {isFirstLoad ? (
        showSkeleton ? (
          isCalendar ? (
            <ScheduledCalendarSkeleton />
          ) : (
            <ScheduledSkeleton />
          )
        ) : null
      ) : null}

      {/* --- Error --------------------------------------------------------- */}
      {isFatalError ? (
        <ApiErrorNotice error={list.error} onRetry={() => void list.refetch()} />
      ) : null}

      {/* --- Empty, list mode only: the calendar tells its own three apart --- */}
      {!isCalendar && !isFirstLoad && !list.isError && items.length === 0 ? (
        filtered ? (
          <EmptyState
            kind="no-result"
            title="Không có bài hẹn nào khớp bộ lọc"
            description="Không có bài nào được hẹn trong khoảng thời gian hoặc trên kênh đang chọn. Dữ liệu vẫn còn nguyên — bỏ bộ lọc để xem toàn bộ."
            action={
              <Button
                type="button"
                variant="outline"
                onClick={() => pushUrl({ channelId: null, from: null, to: null }, view)}
              >
                Bỏ bộ lọc
              </Button>
            }
          />
        ) : (
          <EmptyState
            kind="first-run"
            title="Chưa có bài nào được hẹn giờ"
            description="Khi soạn bài hoặc chạy hàng loạt, chọn “Hẹn giờ đăng” thay vì “Đăng ngay” — những bài đang chờ tới giờ sẽ hiện ở đây."
            action={
              <Button asChild>
                <Link href="/compose">Soạn bài</Link>
              </Button>
            }
          />
        )
      ) : null}

      {/* --- Data, calendar mode -------------------------------------------
          The grid is drawn even with nothing in it: an operator who lands on a
          quiet month still needs the month navigation to get out of it.
          `monthKey` is null only while the browser clock is unknown (server
          render + first frame) — guessing a month there would make it jump. */}
      {isCalendar && !isFirstLoad && !isFatalError ? (
        monthKey === null ? (
          <ScheduledCalendarSkeleton />
        ) : (
          <ScheduledCalendar
            monthKey={monthKey}
            selectedDayKey={view.day}
            items={items}
            nowMs={nowMs}
            hasFilter={filtered}
            loadMore={{
              hasMore: list.hasNextPage,
              isPending: list.isFetchingNextPage,
              onLoadMore: () => void list.fetchNextPage(),
            }}
            onMonthChange={(nextMonth) =>
              // The open day belongs to the month we are leaving, so it goes too.
              pushUrl(filter, { view: "calendar", month: nextMonth, day: null })
            }
            onDaySelect={(dayKey) =>
              pushUrl(filter, { view: "calendar", month: monthKey, day: dayKey })
            }
            onClearFilters={() => pushUrl({ channelId: null, from: null, to: null }, view)}
            channelLabels={channelLabels}
            renderDayDetail={(dayKey, jobs) => (
              <ScheduledJobTable
                items={jobs}
                headingId="scheduled-day-panel"
                nowMs={nowMs}
                hrefFor={hrefForDialog}
                busyJobId={busyJobId}
                readOnlyReason={readOnlyReason}
                channelLabels={channelLabels}
              />
            )}
          />
        )
      ) : null}

      {/* --- Data, list mode ------------------------------------------------ */}
      {!isCalendar && items.length > 0 ? (
        <div className="space-y-6">
          {dayGroups.map((group) => {
            const headingId = `scheduled-day-${group.dayKey}`;
            return (
              <section key={group.dayKey} className="space-y-2">
                {/* h3, not h2: this screen is a TAB inside /posts, so the hub
                    owns the h1, the screen title above owns the h2, and a day
                    group sits one level under it. Two h2s would have read as
                    two sibling screens (core-accessibility §1). */}
                <h3 id={headingId} className="text-base font-semibold">
                  {/* nowMs is 0 only on the server: the heading then shows the
                      full date, never a wrong "Hôm nay". */}
                  {formatDayHeading(group.dayKey, nowMs)}
                  <span className="text-muted-foreground ml-2 text-sm font-normal">
                    {group.items.length} bài
                  </span>
                </h3>
                <ScheduledJobTable
                  items={group.items}
                  headingId={headingId}
                  nowMs={nowMs}
                  hrefFor={hrefForDialog}
                  busyJobId={busyJobId}
                  readOnlyReason={readOnlyReason}
                  channelLabels={channelLabels}
                />
              </section>
            );
          })}
        </div>
      ) : null}

      {/* --- How much is on screen, and whether that is all of it -----------
          Shared by both modes. In the calendar this is the honest answer to
          "is this month complete?": a cursor page still outstanding means the
          grid may be missing cells, and saying so beats drawing a quiet month
          that is only quiet because the rest has not arrived. */}
      {!isFirstLoad && !isFatalError && items.length > 0 ? (
        <div className="flex flex-col items-center gap-2">
          <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
            Đang hiển thị {items.length.toLocaleString("vi-VN")} bài đã hẹn
            {list.hasNextPage
              ? isCalendar
                ? " — chưa tải hết, lịch tháng có thể còn thiếu bài. Bấm “Tải thêm”."
                : " (còn nữa)"
              : "."}
          </p>
          {list.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
            >
              {list.isFetchingNextPage ? "Đang tải…" : "Tải thêm"}
            </Button>
          ) : (
            <p className="text-muted-foreground text-sm">Đã hết danh sách.</p>
          )}
        </div>
      ) : null}

      {rescheduleId.length > 0 ? (
        <RescheduleDialog
          // Remounts per row: the field must start from THAT job's hour, and a
          // stale error from the previous row must not survive.
          key={rescheduleId}
          job={rescheduleJob}
          // The dialog asks "đổi giờ bài này trên kênh nào?" — it must answer
          // with the Page name, not with an id nobody can place.
          channelName={
            rescheduleJob ? channelSentenceName(rescheduleJob.channelId, channelLabels) : null
          }
          open
          onOpenChange={(open) => {
            if (!open) closeDialogs();
          }}
          onSubmit={handleReschedule}
          isPending={reschedule.isPending}
          error={reschedule.isError ? reschedule.error : null}
        />
      ) : null}

      {cancelId.length > 0 ? (
        <CancelDialog
          key={cancelId}
          job={cancelJob}
          channelName={cancelJob ? channelSentenceName(cancelJob.channelId, channelLabels) : null}
          open
          onOpenChange={(open) => {
            if (!open) closeDialogs();
          }}
          onSubmit={handleCancel}
          isPending={cancel.isPending}
          error={cancel.isError ? cancel.error : null}
        />
      ) : null}
    </section>
  );
}

/**
 * What the date field hands back, turned into what the URL stores.
 *
 * `undefined` (cleared) and anything that is not a real calendar day both become
 * "no bound" — never a half-parsed string the request builder would then have to
 * guess about. `parseScheduledFilter` applies the same rule when reading back,
 * so the field and the URL cannot disagree.
 */
function normalizeDay(value: string | undefined): string | null {
  return isDateOnly(value) ? value : null;
}
