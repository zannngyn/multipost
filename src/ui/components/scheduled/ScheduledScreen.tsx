"use client";

import {
  Banner,
  Button,
  DateInput,
  HStack,
  Heading,
  Layout,
  LayoutContent,
  LayoutHeader,
  Link,
  SegmentedControl,
  SegmentedControlItem,
  Selector,
  Stack,
  StackItem,
  Text,
  type ISODateString,
} from "@astryxdesign/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { ApiErrorNotice } from "@/ui/components/feedback/ApiErrorNotice";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import { resolveMonthKey } from "@/ui/components/scheduled/calendar-grid";
import { CancelDialog } from "@/ui/components/scheduled/CancelDialog";
import { RescheduleDialog } from "@/ui/components/scheduled/RescheduleDialog";
import { ScheduledCalendar } from "@/ui/components/scheduled/ScheduledCalendar";
import { ScheduledJobTable } from "@/ui/components/scheduled/ScheduledJobTable";
import {
  ScheduledCalendarSkeleton,
  ScheduledSkeleton,
} from "@/ui/components/scheduled/ScheduledSkeleton";
import { useChannelGroups } from "@/ui/hooks/useChannelGroups";
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
  type ScheduledJobEntry,
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
 * Frame (`astryx docs layout`, tracker archetype): the header carries the mode
 * switch and the filters, the content region carries the timeline edge-to-edge.
 * The page used to be a padded 5xl column, which squeezed a five-column table
 * and a seven-column month grid into half a desktop.
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

/** "Tất cả kênh" is a real option, not an empty placeholder. */
const ALL_CHANNELS = "";

export function ScheduledScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
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

  /** Channel ids the tenant actually uses, from the preset groups (E7.6). */
  const channelOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const group of groups.data?.groups ?? []) {
      for (const channelId of group.channelIds) ids.add(channelId);
    }
    // Keep the active filter selectable even when its group was deleted, or the
    // select would silently jump back to "Tất cả kênh" while the URL says else.
    if (filter.channelId) ids.add(filter.channelId);
    return [
      { value: ALL_CHANNELS, label: "Tất cả kênh" },
      ...[...ids]
        .sort((a, b) => a.localeCompare(b, "vi"))
        .map((channelId) => ({ value: channelId, label: channelId })),
    ];
  }, [groups.data, filter.channelId]);

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
    const query = scheduledSearchParams(nextFilter, nextView).toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function hrefForDialog(action: "reschedule" | "cancel", postJobId: string): string {
    const params = scheduledSearchParams(filter, view);
    params.set(SCHEDULED_DIALOG_PARAMS[action], postJobId);
    return `${pathname}?${params.toString()}`;
  }

  /** Closing a dialog only drops its parameter — filter and month must survive. */
  function closeDialogs() {
    reschedule.reset();
    cancel.reset();
    const query = scheduledSearchParams(filter, view).toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function clearFilters() {
    pushUrl({ channelId: null, from: null, to: null }, view);
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
    <>
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider>
            <Stack direction="vertical" gap={3} padding={4}>
              <Stack direction="vertical" gap={1} maxWidth={760}>
                <Heading level={1}>Bài đã hẹn</Heading>
                <Text type="supporting">
                  Những bài đang chờ tới giờ đăng. Chế độ Danh sách xếp bài sớm nhất lên trên; chế độ
                  Lịch tháng cho thấy công việc rải ra trong tháng — bấm vào một ngày để mở chi tiết.
                  Giờ hiển thị theo múi giờ máy bạn ({timeZoneLabel()}).
                </Text>
                <Text type="supporting" color="secondary">
                  Đổi giờ hoặc huỷ chỉ được trước khi tới giờ — tồn kho vẫn được kiểm tra lại ngay
                  trước khi đăng. Bài mang nhãn “Facebook giữ lịch” đã nằm sẵn trên Facebook và
                  Facebook sẽ tự đăng: bài đó không đổi giờ được nữa, muốn đổi thì bấm Huỷ rồi soạn
                  lại.
                </Text>
              </Stack>

              <HStack gap={3} align="end" wrap="wrap">
                <SegmentedControl
                  label="Chế độ xem bài đã hẹn"
                  value={view.view}
                  size="sm"
                  // The mode is view state, so it rides in the URL but stays out
                  // of the query key — switching draws the same rows a second
                  // way, never refetches them. Turning the calendar on PINS the
                  // month it resolved to, so the link is already shareable
                  // before the operator touches anything; going back to the list
                  // drops both month and open day.
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

                <Selector
                  label="Lọc theo kênh"
                  size="sm"
                  width={220}
                  options={channelOptions}
                  value={filter.channelId ?? ALL_CHANNELS}
                  onChange={(next) =>
                    pushUrl({ ...filter, channelId: next || null }, view)
                  }
                />

                {/* Pure dates, kept as "YYYY-MM-DD" strings from the field to the
                    URL to the request builder — never through `new Date()`,
                    which is the one cause of the off-by-one-day
                    (core-form-inputs). `max`/`min` state the window BEFORE a
                    choice is made; `parseScheduledFilter` re-checks it. */}
                <DateInput
                  label="Từ ngày"
                  size="sm"
                  width={170}
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
                  width={170}
                  hasClear
                  weekStartsOn="mon"
                  placeholder="dd/mm/yyyy"
                  format={formatDayInput}
                  value={(filter.to ?? undefined) as ISODateString | undefined}
                  min={(filter.from ?? undefined) as ISODateString | undefined}
                  onChange={(value) => pushUrl({ ...filter, to: normalizeDay(value) }, view)}
                />

                {filtered ? (
                  <Button variant="ghost" size="sm" label="Bỏ bộ lọc" onClick={clearFilters} />
                ) : null}

                <Button
                  variant="secondary"
                  size="sm"
                  label={list.isFetching ? "Đang tải…" : "Tải lại"}
                  isLoading={list.isFetching}
                  isDisabled={list.isFetching}
                  onClick={() => void list.refetch()}
                />
              </HStack>
            </Stack>
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={0} isScrollable>
            <Stack direction="vertical" height="100%">
              {groups.isError ? (
                <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                  <Text type="supporting">
                    Không tải được danh sách nhóm kênh nên ô lọc kênh đang trống. Bộ lọc ngày vẫn
                    dùng được.
                  </Text>
                </Stack>
              ) : null}

              {notice ? (
                <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                  <Banner
                    status="success"
                    role="status"
                    isDismissable
                    onDismiss={() => setNotice(null)}
                    title={notice}
                  />
                </Stack>
              ) : null}

              {warning ? (
                <Stack direction="vertical" paddingInline={4} paddingBlock={3}>
                  <Banner
                    status="warning"
                    role="alert"
                    title="Đã lưu, nhưng hàng đợi chưa sạch"
                    description={warning}
                    endContent={
                      <Link href="/jobs" isStandalone>
                        Mở nhật ký đăng bài
                      </Link>
                    }
                  />
                </Stack>
              ) : null}

              <StackItem size="fill">
                <ScheduledBody
                  isCalendar={isCalendar}
                  isFirstLoad={isFirstLoad}
                  showSkeleton={showSkeleton}
                  isFatalError={isFatalError}
                  list={list}
                  items={items}
                  dayGroups={dayGroups}
                  filtered={filtered}
                  monthKey={monthKey}
                  view={view}
                  filter={filter}
                  nowMs={nowMs}
                  busyJobId={busyJobId}
                  readOnlyReason={readOnlyReason}
                  hrefForDialog={hrefForDialog}
                  onClearFilters={clearFilters}
                  onPushUrl={pushUrl}
                />
              </StackItem>

              {/* --- How much is on screen, and whether that is all of it -----
                  Shared by both modes. In the calendar this is the honest answer
                  to "is this month complete?": a cursor page still outstanding
                  means the grid may be missing cells, and saying so beats
                  drawing a quiet month that is only quiet because the rest has
                  not arrived. */}
              {!isFirstLoad && !isFatalError && items.length > 0 ? (
                <Stack direction="horizontal" gap={3} padding={3} align="center" justify="center">
                  <Text type="supporting" role="status" aria-live="polite">
                    Đang hiển thị {items.length.toLocaleString("vi-VN")} bài đã hẹn
                    {list.hasNextPage
                      ? isCalendar
                        ? " — chưa tải hết, lịch tháng có thể còn thiếu bài. Bấm “Tải thêm”."
                        : " (còn nữa)"
                      : ". Đã hết danh sách."}
                  </Text>
                  {list.hasNextPage ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      label={list.isFetchingNextPage ? "Đang tải…" : "Tải thêm"}
                      isLoading={list.isFetchingNextPage}
                      isDisabled={list.isFetchingNextPage}
                      onClick={() => void list.fetchNextPage()}
                    />
                  ) : null}
                </Stack>
              ) : null}
            </Stack>
          </LayoutContent>
        }
      />

      {rescheduleId.length > 0 ? (
        <RescheduleDialog
          // Remounts per row: the field must start from THAT job's hour, and a
          // stale error from the previous row must not survive.
          key={rescheduleId}
          job={rescheduleJob}
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
          open
          onOpenChange={(open) => {
            if (!open) closeDialogs();
          }}
          onSubmit={handleCancel}
          isPending={cancel.isPending}
          error={cancel.isError ? cancel.error : null}
        />
      ) : null}
    </>
  );
}

function ScheduledBody({
  isCalendar,
  isFirstLoad,
  showSkeleton,
  isFatalError,
  list,
  items,
  dayGroups,
  filtered,
  monthKey,
  view,
  filter,
  nowMs,
  busyJobId,
  readOnlyReason,
  hrefForDialog,
  onClearFilters,
  onPushUrl,
}: {
  isCalendar: boolean;
  isFirstLoad: boolean;
  showSkeleton: boolean;
  isFatalError: boolean;
  list: ReturnType<typeof useScheduledJobs>;
  items: readonly ScheduledJobEntry[];
  dayGroups: ReturnType<typeof groupScheduledByDay>;
  filtered: boolean;
  monthKey: string | null;
  view: ScheduledViewState;
  filter: ScheduledFilter;
  nowMs: number;
  busyJobId: string | null;
  readOnlyReason: string | null;
  hrefForDialog: (action: "reschedule" | "cancel", postJobId: string) => string;
  onClearFilters: () => void;
  onPushUrl: (filter: ScheduledFilter, view: ScheduledViewState) => void;
}) {
  // --- Loading: each mode keeps its OWN shape, so nothing jumps -------------
  if (isFirstLoad) {
    if (!showSkeleton) return null;
    return isCalendar ? <ScheduledCalendarSkeleton /> : <ScheduledSkeleton />;
  }

  // --- Error, with nothing to fall back on ---------------------------------
  if (isFatalError) {
    return (
      <Stack direction="vertical" padding={4}>
        <ApiErrorNotice error={list.error} onRetry={() => void list.refetch()} />
      </Stack>
    );
  }

  // --- Data, calendar mode --------------------------------------------------
  // The grid is drawn even with nothing in it: an operator who lands on a quiet
  // month still needs the month navigation to get out of it. `monthKey` is null
  // only while the browser clock is unknown (server render + first frame) —
  // guessing a month there would make it jump.
  if (isCalendar) {
    if (monthKey === null) return <ScheduledCalendarSkeleton />;

    return (
      <Stack direction="vertical" padding={4}>
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
            onPushUrl(filter, { view: "calendar", month: nextMonth, day: null })
          }
          onDaySelect={(dayKey) =>
            onPushUrl(filter, { view: "calendar", month: monthKey, day: dayKey })
          }
          onClearFilters={onClearFilters}
          renderDayDetail={(_dayKey, jobs) => (
            <ScheduledJobTable
              items={jobs}
              headingId="scheduled-day-panel"
              nowMs={nowMs}
              hrefFor={hrefForDialog}
              busyJobId={busyJobId}
              readOnlyReason={readOnlyReason}
            />
          )}
        />
      </Stack>
    );
  }

  // --- Empty, list mode only: the calendar tells its own three apart --------
  if (items.length === 0) {
    return (
      <Stack direction="vertical" padding={4}>
        {filtered ? (
          <EmptyState
            kind="no-result"
            title="Không có bài hẹn nào khớp bộ lọc"
            description="Không có bài nào được hẹn trong khoảng thời gian hoặc trên kênh đang chọn. Dữ liệu vẫn còn nguyên — bỏ bộ lọc để xem toàn bộ."
            action={<Button variant="secondary" label="Bỏ bộ lọc" onClick={onClearFilters} />}
          />
        ) : (
          <EmptyState
            kind="first-run"
            title="Chưa có bài nào được hẹn giờ"
            description="Khi soạn bài hoặc chạy hàng loạt, chọn “Hẹn giờ đăng” thay vì “Đăng ngay” — những bài đang chờ tới giờ sẽ hiện ở đây."
            action={
              // A real link, not a click handler: this is navigation, so
              // Ctrl/Cmd+click, middle-click and "mở tab mới" all have to work,
              // and a screen reader has to hear "liên kết", not "nút".
              <Button variant="primary" label="Soạn bài" href="/compose" />
            }
          />
        )}
      </Stack>
    );
  }

  // --- Data, list mode ------------------------------------------------------
  return (
    <Stack direction="vertical" gap={6} paddingBlock={4}>
      {dayGroups.map((group) => {
        const headingId = `scheduled-day-${group.dayKey}`;
        return (
          <Stack as="section" key={group.dayKey} direction="vertical" gap={2}>
            <HStack gap={2} paddingInline={4} align="center" wrap="wrap">
              <Heading level={2} id={headingId}>
                {/* nowMs is 0 only on the server: the heading then shows the
                    full date, never a wrong "Hôm nay". */}
                {formatDayHeading(group.dayKey, nowMs)}
              </Heading>
              <Text type="supporting">{group.items.length} bài</Text>
            </HStack>
            <ScheduledJobTable
              items={group.items}
              headingId={headingId}
              nowMs={nowMs}
              hrefFor={hrefForDialog}
              busyJobId={busyJobId}
              readOnlyReason={readOnlyReason}
            />
          </Stack>
        );
      })}
    </Stack>
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
