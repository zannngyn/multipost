import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ScheduledCalendar } from "../ScheduledCalendar";
import {
  CALENDAR_COLUMNS,
  CALENDAR_ROWS,
} from "@/ui/components/scheduled/calendar-grid";
import type { ScheduledJobEntry } from "@/ui/schemas/scheduled.schema";

/**
 * The grid's ARIA shape, asserted on real markup.
 *
 * WHY `renderToStaticMarkup` AND NOT A DOM TEST: `vitest.config.ts` runs
 * `environment: "node"` and the repo has no jsdom or testing-library — adding
 * either is a dependency decision this ticket does not authorise. Server
 * rendering needs neither, and it still catches the regression that matters
 * here: the grid losing its rows or its cells, which silently turns a WAI-ARIA
 * grid into 42 unrelated buttons for a screen-reader user.
 *
 * Behaviour that only exists after hydration (roving tab stop, PageUp/PageDown)
 * is covered by `useGridFocus` inside Astryx and by the pure tests next door;
 * this file covers the structure those depend on.
 */

const NOW = new Date(2026, 7, 13, 10, 0).getTime();

function entry(overrides: Partial<ScheduledJobEntry> = {}): ScheduledJobEntry {
  return {
    postJobId: "job-1",
    batchId: "batch-1",
    productCode: "MGKVX6310",
    color: "Tím",
    channelId: "fbpage-a",
    format: "image_post",
    status: "queued",
    scheduledAt: new Date(2026, 7, 13, 9, 0).toISOString(),
    startsInMs: 3_600_000,
    overdue: false,
    captionPreview: "Váy hoa mùa hè…",
    mediaCount: 3,
    userMessage: "Chờ tới giờ đăng.",
    canReschedule: true,
    canCancel: true,
    createdAt: new Date(2026, 7, 12, 9, 0).toISOString(),
    ...overrides,
  };
}

function render(
  items: ScheduledJobEntry[],
  selectedDayKey: string | null = null,
  hasMore = false,
): string {
  return renderToStaticMarkup(
    <ScheduledCalendar
      monthKey="2026-08"
      selectedDayKey={selectedDayKey}
      items={items}
      nowMs={NOW}
      hasFilter={false}
      loadMore={{ hasMore, isPending: false, onLoadMore: () => {} }}
      onMonthChange={() => {}}
      onDaySelect={() => {}}
      onClearFilters={() => {}}
      renderDayDetail={(dayKey, jobs) => (
        <p>{`chi tiết ${dayKey}: ${jobs.length} bài`}</p>
      )}
    />,
  );
}

function count(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

describe("ScheduledCalendar markup", () => {
  it("is a WAI-ARIA grid: one grid, a header row plus six week rows, 42 cells", () => {
    const html = render([]);

    expect(count(html, /role="grid"/g)).toBe(1);
    expect(count(html, /role="row"/g)).toBe(CALENDAR_ROWS + 1);
    expect(count(html, /role="columnheader"/g)).toBe(CALENDAR_COLUMNS);
    expect(count(html, /role="gridcell"/g)).toBe(CALENDAR_ROWS * CALENDAR_COLUMNS);
  });

  it("gives every cell a focusable button, so the grid is reachable by keyboard", () => {
    const html = render([]);
    // One activation target per cell — `useGridFocus` moves focus onto these.
    expect(count(html, /data-day="\d{4}-\d{2}-\d{2}"/g)).toBe(CALENDAR_ROWS * CALENDAR_COLUMNS);
    expect(count(html, /<button/g)).toBeGreaterThanOrEqual(CALENDAR_ROWS * CALENDAR_COLUMNS);
  });

  it("names a cell by its full date and its count, not by the bare day number", () => {
    const html = render([entry({ scheduledAt: new Date(2026, 7, 13, 9, 0).toISOString() })]);

    expect(html).toContain("Thứ Năm, 13/08/2026 — 1 bài đã hẹn");
    expect(html).toContain("không có bài nào");
    // Monday first, and the weekday headers carry their full name for a reader.
    expect(html).toContain('aria-label="Thứ Hai"');
  });

  it("marks today and the days from the neighbouring months without relying on colour", () => {
    const html = render([]);

    expect(html).toContain("Hôm nay");
    // 2026-08-01 is a Saturday, so the first row borrows from July and says so.
    expect(html).toContain("(tháng khác)");
    expect(html).toContain("27/7");
  });

  it("caps a busy day at three lines and says how many are hidden", () => {
    const html = render(
      [1, 2, 3, 4, 5].map((index) =>
        entry({
          postJobId: `job-${index}`,
          scheduledAt: new Date(2026, 7, 20, 8 + index, 0).toISOString(),
        }),
      ),
    );

    expect(html).toContain("+2 bài nữa");
    expect(html).toContain("5 bài đã hẹn");
  });

  it("announces the month and the count in a live region", () => {
    const html = render([entry()]);
    expect(html).toContain('role="status"');
    expect(html).toContain("Tháng 8 năm 2026 · 1 bài đã hẹn trong tháng này");
  });

  it("hands an open day to the caller's detail renderer", () => {
    const html = render([entry()], "2026-08-13");
    expect(html).toContain("chi tiết 2026-08-13: 1 bài");
    expect(html).toContain('aria-selected="true"');
  });

  it("says an open day with nothing on it is empty instead of rendering a bare table", () => {
    const html = render([entry()], "2026-08-21");
    expect(html).toContain("Ngày này chưa có bài nào được hẹn");
  });

  it("tells an empty month apart from an empty schedule", () => {
    const withPostsElsewhere = render([
      entry({ scheduledAt: new Date(2026, 8, 4, 9, 0).toISOString() }),
    ]);
    expect(withPostsElsewhere).toContain("Tháng này chưa có bài nào được hẹn");
    expect(withPostsElsewhere).toContain("Tới Tháng 9 năm 2026");

    const nothingAnywhere = render([]);
    expect(nothingAnywhere).toContain("Chưa có bài nào được hẹn giờ");
  });

  it("reports a post it could not place instead of dropping it from the grid", () => {
    const html = render([entry({ postJobId: "broken", scheduledAt: "không phải giờ" })]);
    expect(html).toContain("không xếp được vào lịch");
    expect(html).toContain("broken");

    // It has to be HEARD, not just seen: a row that silently vanished from the
    // grid is exactly the failure business rule 5 forbids, and a screen-reader
    // user gets no other signal that a post is missing. Assert the message sits
    // INSIDE the alert element, not merely that both strings exist somewhere.
    const alertStart = html.indexOf('role="alert"');
    expect(alertStart, 'the skipped-jobs notice has no role="alert"').toBeGreaterThan(-1);
    const alertElement = html.slice(alertStart, html.indexOf("</span>", alertStart));
    expect(alertElement).toContain("không xếp được vào lịch");
    expect(alertElement).toContain("broken");

    // A clean month must not leave a live alert sitting on the page.
    expect(render([entry()])).not.toContain('role="alert"');
  });

  it("never states an empty month as fact while a page is still outstanding", () => {
    // The strongest claim on the screen must not be made on partial data.
    const partial = render([], null, true);
    expect(partial).not.toContain("Chưa có bài nào được hẹn giờ");
    expect(partial).toContain("Chưa tải xong nên chưa biết tháng này có bài hay không");
    // …and it is said next to the grid, not only in the page footer.
    expect(partial).toContain("lịch tháng này có thể còn thiếu bài");
    expect(partial).toContain("(trong số đã tải)");

    // Fully loaded: the same situation is now a fact, and reads like one.
    const complete = render([], null, false);
    expect(complete).toContain("Chưa có bài nào được hẹn giờ");
    expect(complete).not.toContain("lịch tháng này có thể còn thiếu bài");
  });

  it("softens the other-month count too while a page is outstanding", () => {
    const partial = render([entry({ scheduledAt: new Date(2026, 8, 4, 9, 0).toISOString() })], null, true);
    expect(partial).toContain("Trong số đã tải, tháng này chưa có bài nào");
    expect(partial).toContain("bấm “Tải thêm” trước khi kết luận");
  });
});
