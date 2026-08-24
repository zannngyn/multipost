"use client";

import {
  Badge,
  Button,
  ClickableCard,
  HStack,
  Heading,
  Stack,
  StackItem,
  Text,
  Token,
  VStack,
} from "@astryxdesign/core";
import { useGridFocus } from "@astryxdesign/core/hooks";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { GroupChannelLabel } from "@/ui/components/channels/channel-group-labels";
import { channelSentenceName } from "@/ui/components/channels/channel-option-labels";
import { EmptyState } from "@/ui/components/feedback/EmptyState";
import {
  CALENDAR_COLUMNS,
  CALENDAR_WEEKDAYS,
  buildCalendarMonth,
  edgeNavigationDayKey,
  formatMonthHeading,
  monthKeyOfDayKey,
  monthKeyOfMs,
  sameDayInMonth,
  shiftMonthKey,
  todayKeyOfMs,
  type CalendarDayCell,
  type CalendarMonth,
} from "@/ui/components/scheduled/calendar-grid";
import {
  formatDayHeading,
  formatScheduledTime,
  timeZoneLabel,
  type ScheduledJobEntry,
} from "@/ui/schemas/scheduled.schema";

/**
 * The month grid of "Bài đã hẹn" (E8/E10).
 *
 * It DRAWS; it does not fetch and it does not mutate. The screen above owns the
 * query and hands the loaded rows in; the day panel's body comes back from
 * `renderDayDetail`, which is where the existing "Đổi giờ" / "Huỷ" table plugs
 * in unchanged. That is deliberate: one implementation of those two actions, and
 * therefore one place where read-only mode (M3.3) is honoured.
 *
 * All the arithmetic lives in `calendar-grid.ts`; this file is layout, keyboard
 * and copy.
 *
 * Keyboard (web-calendar-view rule 2, via Astryx `useGridFocus`): the grid is
 * ONE tab stop, arrows walk cells, arrows off an edge and PageUp/PageDown walk
 * months, Enter opens the day. A cell's accessible name is the full date plus
 * how many posts sit on it — "12" on its own tells a screen-reader user nothing.
 *
 * The four states are split with the screen: it owns loading, transport error
 * and "nothing loaded at all"; this component owns "nothing in THIS month",
 * which is a different sentence with a different way out.
 */

/** One shared empty map, so the default prop keeps a stable identity. */
const EMPTY_CHANNEL_LABELS: ReadonlyMap<string, GroupChannelLabel> = new Map();

export function ScheduledCalendar({
  monthKey,
  selectedDayKey,
  items,
  nowMs,
  hasFilter,
  loadMore,
  onMonthChange,
  onDaySelect,
  onClearFilters,
  renderDayDetail,
  channelLabels = EMPTY_CHANNEL_LABELS,
}: {
  /** "YYYY-MM" — already resolved by the screen, never null here. */
  monthKey: string;
  /** "YYYY-MM-DD" of the open day panel, or null when none is open. */
  selectedDayKey: string | null;
  /** Everything loaded so far, soonest first. */
  items: readonly ScheduledJobEntry[];
  /** 0 while the browser clock is unknown — nothing is then "hôm nay". */
  nowMs: number;
  hasFilter: boolean;
  /**
   * The cursor's state. A month grid drawn from a half-loaded list must not
   * claim "chưa có bài nào" as a fact — the missing rows might be exactly the
   * ones this month wanted. Grouped into one prop so the component keeps a
   * readable arity (core-component-reuse: 10 props then composition).
   */
  loadMore: { hasMore: boolean; isPending: boolean; onLoadMore: () => void };
  onMonthChange: (monthKey: string) => void;
  onDaySelect: (dayKey: string | null) => void;
  onClearFilters: () => void;
  /** The day panel's body — the screen passes its existing actions table in. */
  renderDayDetail: (dayKey: string, jobs: readonly ScheduledJobEntry[]) => ReactNode;
  /**
   * Page names for the second line of each post in a cell, resolved ONCE by the
   * screen (`channelLabelIndex`). Missing or empty means the channel list is not
   * known — the cell then shows the shortened id, which is what it always did.
   */
  channelLabels?: ReadonlyMap<string, GroupChannelLabel>;
}) {
  const month = useMemo(
    () => buildCalendarMonth({ monthKey, items, nowMs }),
    [monthKey, items, nowMs],
  );
  const zone = timeZoneLabel();
  const todayKey = todayKeyOfMs(nowMs);
  const currentMonthKey = monthKeyOfMs(nowMs);

  /** A day we asked the browser to focus once its month has rendered. */
  const [pendingFocusDayKey, setPendingFocusDayKey] = useState<string | null>(null);
  /** Last cell the caret was on — the anchor PageUp/PageDown keep their place by. */
  const lastFocusedDayKey = useRef<string | null>(null);
  const dayPanelHeading = useRef<HTMLHeadingElement | null>(null);

  /** Moves to the month holding `dayKey` and puts the caret back on that day. */
  const goToDay = useCallback(
    (dayKey: string) => {
      const nextMonth = monthKeyOfDayKey(dayKey);
      // Guard clause: a day we cannot place must never blank the grid.
      if (nextMonth === null) return;
      setPendingFocusDayKey(dayKey);
      if (nextMonth !== monthKey) onMonthChange(nextMonth);
    },
    [monthKey, onMonthChange],
  );

  const stepMonth = useCallback(
    (delta: number) => {
      const nextMonth = shiftMonthKey(monthKey, delta);
      if (nextMonth === monthKey) return;
      // Keep the caret on the same day number where the new month has one.
      const anchor = lastFocusedDayKey.current;
      if (anchor) setPendingFocusDayKey(sameDayInMonth(anchor, nextMonth));
      onMonthChange(nextMonth);
    },
    [monthKey, onMonthChange],
  );

  const { gridRef, handleKeyDown, handleFocus } = useGridFocus<HTMLElement>({
    columns: CALENDAR_COLUMNS,
    cellSelector: '[role="gridcell"]',
    isCellFocusable: (cell) => cell.querySelector("button:not([disabled])") !== null,
    getFocusTarget: (cell) => cell.querySelector("button"),
    hasRovingTabIndex: true,
    // Running off an edge is not "nothing happens": it is the neighbouring day,
    // which may live in another month. Which day that is depends on WHICH edge
    // and WHICH column — vertical keeps the caret in its own column, horizontal
    // steps off the corner — so the arithmetic lives in one tested pure
    // function rather than being guessed at here.
    onNavigateBefore: (column, offset) => {
      const target = edgeNavigationDayKey(monthKey, "before", column, offset);
      if (target) goToDay(target);
    },
    onNavigateAfter: (column, offset) => {
      const target = edgeNavigationDayKey(monthKey, "after", column, offset);
      if (target) goToDay(target);
    },
    onPageUp: () => stepMonth(-1),
    onPageDown: () => stepMonth(1),
  });

  /** Wraps the hook's handler to remember which day the caret is on. */
  function trackFocus(event: React.FocusEvent) {
    handleFocus(event);
    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-day]");
    if (cell?.dataset.day) lastFocusedDayKey.current = cell.dataset.day;
  }

  // Focus the requested day once the month it belongs to has actually rendered.
  // Bailing out while the cell is missing means the next render retries, instead
  // of stealing focus to whichever cell happens to be first.
  useEffect(() => {
    if (pendingFocusDayKey === null) return;
    const target = gridRef.current?.querySelector<HTMLElement>(
      `[data-day="${pendingFocusDayKey}"] button`,
    );
    if (!target) return;
    target.focus();
    setPendingFocusDayKey(null);
  }, [pendingFocusDayKey, monthKey, gridRef]);

  // Opening a day moves the reading position into the panel; without this a
  // keyboard user presses Enter and nothing appears to have happened.
  useEffect(() => {
    if (selectedDayKey === null) return;
    dayPanelHeading.current?.focus();
  }, [selectedDayKey]);

  const selectedCell = selectedDayKey
    ? (month.weeks.flatMap((week) => week.days).find((day) => day.dayKey === selectedDayKey) ?? null)
    : null;

  function closeDayPanel() {
    const from = selectedDayKey;
    onDaySelect(null);
    // Overlay rule: the caret goes back to what opened the panel.
    if (from) setPendingFocusDayKey(from);
  }

  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Button variant="secondary" size="sm" label="Tháng trước" onClick={() => stepMonth(-1)} />
        <Heading level={2}>{formatMonthHeading(monthKey)}</Heading>
        <Button variant="secondary" size="sm" label="Tháng sau" onClick={() => stepMonth(1)} />
        <Button
          variant="ghost"
          size="sm"
          label="Hôm nay"
          isDisabled={currentMonthKey === null || currentMonthKey === monthKey}
          // Disabled ALWAYS comes with the reason (core-auth-session): with a
          // tooltip set, Astryx keeps the button focusable via aria-disabled, so
          // a keyboard user can reach the explanation too.
          tooltip={
            currentMonthKey === null
              ? "Chưa đọc được giờ của máy bạn."
              : currentMonthKey === monthKey
                ? "Bạn đang ở tháng này rồi."
                : undefined
          }
          onClick={() => {
            if (currentMonthKey === null) return;
            if (currentMonthKey !== monthKey) onMonthChange(currentMonthKey);
            if (todayKey) setPendingFocusDayKey(todayKey);
          }}
        />
      </HStack>

      {/* Changing month rewrites this line, so a screen reader is told where the
          grid went (web-calendar-view rule 2). */}
      <Text type="supporting" role="status" aria-live="polite">
        {formatMonthHeading(monthKey)} · {month.totalInMonth.toLocaleString("vi-VN")} bài đã hẹn
        trong tháng này{loadMore.hasMore ? " (trong số đã tải)" : ""}. Giờ theo múi giờ máy bạn (
        {zone}).
      </Text>

      {/* Said next to the GRID, not only in the footer: an operator reads the
          month here and would otherwise walk away with a wrong conclusion long
          before scrolling to the bottom of the page. */}
      {loadMore.hasMore ? (
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Text type="supporting" role="status" aria-live="polite" color="accent">
            Chưa tải hết danh sách — lịch tháng này có thể còn thiếu bài.
          </Text>
          <Button
            variant="secondary"
            size="sm"
            label={loadMore.isPending ? "Đang tải…" : "Tải thêm"}
            isDisabled={loadMore.isPending}
            onClick={loadMore.onLoadMore}
          />
        </HStack>
      ) : null}

      {month.skipped.length > 0 ? (
        // Business rule 5: a row we could not place is said out loud, never
        // quietly missing from the grid.
        <Text type="supporting" role="alert" color="accent">
          {month.skipped.length} bài không xếp được vào lịch vì giờ hẹn không đọc được (
          {month.skipped.map((row) => row.postJobId).join(", ")}). Xem chúng ở chế độ Danh sách,
          hoặc báo quản trị viên.
        </Text>
      ) : null}

      {month.totalInMonth === 0 ? (
        <EmptyMonthNotice
          month={month}
          hasFilter={hasFilter}
          hasMore={loadMore.hasMore}
          onClearFilters={onClearFilters}
          onMonthChange={onMonthChange}
        />
      ) : null}

      <VStack
        gap={1}
        ref={gridRef}
        role="grid"
        aria-label={`Lịch ${formatMonthHeading(monthKey)}`}
        onKeyDown={handleKeyDown}
        onFocus={trackFocus}
      >
        <HStack role="row" gap={1}>
          {CALENDAR_WEEKDAYS.map((weekday) => (
            // `basis-0` makes the seven columns exactly equal. `size="fill"`
            // alone only shares the LEFTOVER space, so a busy day would widen
            // its own column and the grid would stop lining up.
            <StackItem
              key={weekday.short}
              size="fill"
              role="columnheader"
              aria-label={weekday.full}
              className="basis-0 text-center"
            >
              <Text type="label" color="secondary">
                {weekday.short}
              </Text>
            </StackItem>
          ))}
        </HStack>

        {month.weeks.map((week) => (
          <HStack role="row" gap={1} key={week.key}>
            {week.days.map((day) => (
              <StackItem
                key={day.dayKey}
                size="fill"
                role="gridcell"
                data-day={day.dayKey}
                aria-selected={day.dayKey === selectedDayKey}
                className="basis-0"
              >
                <DayCell
                  day={day}
                  nowMs={nowMs}
                  isSelected={day.dayKey === selectedDayKey}
                  onSelect={() => onDaySelect(day.dayKey)}
                  channelLabels={channelLabels}
                />
              </StackItem>
            ))}
          </HStack>
        ))}
      </VStack>

      {selectedDayKey ? (
        <Stack as="section" direction="vertical" gap={2} aria-labelledby="scheduled-day-panel">
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={3} id="scheduled-day-panel" ref={dayPanelHeading} tabIndex={-1}>
              {formatDayHeading(selectedDayKey, nowMs)}
            </Heading>
            <Text type="supporting">
              {(selectedCell?.jobs.length ?? 0).toLocaleString("vi-VN")} bài
            </Text>
            <Button variant="ghost" size="sm" label="Đóng ngày" onClick={closeDayPanel} />
          </HStack>

          {selectedCell && selectedCell.jobs.length > 0 ? (
            renderDayDetail(selectedDayKey, selectedCell.jobs)
          ) : (
            <EmptyState
              kind="idle"
              title="Ngày này chưa có bài nào được hẹn"
              description="Chọn một ô khác trong lưới, hoặc soạn bài mới và chọn “Hẹn giờ đăng” cho đúng ngày này."
            />
          )}
        </Stack>
      ) : (
        <Text type="supporting">
          Bấm vào một ngày trong lưới để xem chi tiết và đổi giờ hoặc huỷ từng bài.
        </Text>
      )}
    </VStack>
  );
}

/**
 * One day of the grid.
 *
 * `ClickableCard`, not `Button`: the cell holds a date, a count chip and up to
 * three post lines, and ClickableCard is the primitive for "a rich surface that
 * is one activation target" — its hidden button is what `useGridFocus` moves
 * focus to and what carries the accessible name.
 */
function DayCell({
  day,
  nowMs,
  isSelected,
  onSelect,
  channelLabels,
}: {
  day: CalendarDayCell;
  nowMs: number;
  isSelected: boolean;
  onSelect: () => void;
  channelLabels: ReadonlyMap<string, GroupChannelLabel>;
}) {
  const count = day.jobs.length;
  // What a screen reader announces when an arrow key lands here: the full date
  // and how many posts are on it (web-calendar-view rule 2).
  const label = `${formatDayHeading(day.dayKey, nowMs)}${day.inMonth ? "" : " (tháng khác)"} — ${
    count > 0 ? `${count} bài đã hẹn` : "không có bài nào"
  }${isSelected ? ", đang mở" : ""}`;

  return (
    <ClickableCard
      label={label}
      onClick={onSelect}
      padding={1.5}
      // Told apart by tone AND by wording, never by colour alone: an out-of-month
      // cell also prints its month, and today carries a "Hôm nay" chip.
      variant={!day.inMonth ? "transparent" : day.isPast ? "muted" : "default"}
      elevation={isSelected ? "low" : "none"}
      className="h-full min-h-28"
    >
      <VStack gap={1}>
        <HStack gap={1} vAlign="center" wrap="wrap">
          <Text
            type="label"
            weight={day.isToday ? "bold" : "medium"}
            color={day.inMonth ? "primary" : "disabled"}
            hasTabularNumbers
          >
            {day.inMonth ? day.dayOfMonth : `${day.dayOfMonth}/${Number(day.dayKey.slice(5, 7))}`}
          </Text>
          {day.isToday ? <Token size="sm" color="blue" label="Hôm nay" /> : null}
          {count > 0 ? <Badge variant="neutral" label={`${count} bài`} /> : null}
        </HStack>

        {/* Two lines per post, not one: a month column is ~130px wide, and
            "20:00 · MGKVX6310 · Lady Fashion" on one line truncates to
            "20:00 · MG…", which answers nothing. Hour + mã is what an operator
            scans for; the PAGE NAME sits under it — a cell too narrow for a
            19-character id is exactly where a raw id was worth least — and the
            day panel has the full row. */}
        {day.visibleJobs.map((job) => (
          <VStack key={job.postJobId} gap={0}>
            <Text type="supporting" size="2xs" display="block" maxLines={1} hasTabularNumbers>
              {formatScheduledTime(job.scheduledAt)} · {job.productCode}
            </Text>
            <Text
              type="supporting"
              size="2xs"
              color="secondary"
              display="block"
              maxLines={1}
            >
              {channelSentenceName(job.channelId, channelLabels)}
            </Text>
          </VStack>
        ))}

        {day.overflowCount > 0 ? (
          <Text type="supporting" size="2xs" display="block" weight="medium">
            +{day.overflowCount} bài nữa
          </Text>
        ) : null}
      </VStack>
    </ClickableCard>
  );
}

/**
 * "Trống" is three different sentences (core-calendar-view rule 6): the filter
 * hides everything, this month is quiet but another one is not, or nothing has
 * ever been scheduled. The grid stays on screen under all three — dropping it
 * would take the month navigation away exactly when it is needed.
 */
function EmptyMonthNotice({
  month,
  hasFilter,
  hasMore,
  onClearFilters,
  onMonthChange,
}: {
  month: CalendarMonth;
  hasFilter: boolean;
  /** A cursor page is still outstanding, so none of this is the final word. */
  hasMore: boolean;
  onClearFilters: () => void;
  onMonthChange: (monthKey: string) => void;
}) {
  // Every sentence below describes the LOADED rows. While a page is missing,
  // say so instead of turning "chưa tải xong" into "không có".
  const caveat = hasMore
    ? " Danh sách chưa tải hết, nên tháng này có thể còn bài chưa hiện — bấm “Tải thêm” trước khi kết luận."
    : "";

  if (hasFilter) {
    return (
      <EmptyState
        kind="no-result"
        title="Không có bài hẹn nào khớp bộ lọc trong tháng này"
        description={`Dữ liệu vẫn còn nguyên — chỉ là không có bài nào khớp kênh hoặc khoảng ngày đang chọn. Bỏ bộ lọc, hoặc chuyển sang tháng khác.${caveat}`}
        action={<Button variant="secondary" size="sm" label="Bỏ bộ lọc" onClick={onClearFilters} />}
      />
    );
  }

  const nearestMonthKey = monthKeyOfDayKey(month.nearestDayKeyOutsideMonth);
  if (nearestMonthKey) {
    return (
      <EmptyState
        kind="idle"
        title={hasMore ? "Trong số đã tải, tháng này chưa có bài nào" : "Tháng này chưa có bài nào được hẹn"}
        description={`${hasMore ? "Trong số đã tải còn" : "Còn"} ${month.totalOutsideMonth.toLocaleString("vi-VN")} bài đã hẹn ở tháng khác — bài sớm nhất nằm ở ${formatMonthHeading(nearestMonthKey)}.${caveat}`}
        action={
          <Button
            variant="secondary"
            size="sm"
            label={`Tới ${formatMonthHeading(nearestMonthKey)}`}
            onClick={() => onMonthChange(nearestMonthKey)}
          />
        }
      />
    );
  }

  // The strongest claim on the screen, so it is the one that must not be made
  // on partial data: with a page outstanding this is "chưa biết", not "chưa có".
  if (hasMore) {
    return (
      <EmptyState
        kind="idle"
        title="Chưa tải xong nên chưa biết tháng này có bài hay không"
        description="Danh sách còn trang chưa tải. Bấm “Tải thêm” để hệ thống đọc nốt rồi hãy kết luận."
      />
    );
  }

  return (
    <EmptyState
      kind="first-run"
      title="Chưa có bài nào được hẹn giờ"
      description="Khi soạn bài hoặc chạy hàng loạt, chọn “Hẹn giờ đăng” thay vì “Đăng ngay” — những bài đang chờ tới giờ sẽ hiện ở đây."
    />
  );
}
