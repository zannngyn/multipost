import { CALENDAR_COLUMNS, CALENDAR_ROWS } from "@/ui/components/scheduled/calendar-grid";

/**
 * Skeleton with the SAME day heading + five columns and row height as the real
 * list (web-data-table rule 1: a mismatched skeleton is a layout shift).
 */
export function ScheduledSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-6 motion-safe:animate-pulse">
      {[0, 1].map((group) => (
        <div key={group} className="space-y-2">
          <div className="bg-muted h-5 w-56 rounded" />
          <div className="overflow-hidden rounded-xl border">
            <div className="bg-muted/50 h-9" />
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex h-20 items-center gap-3 border-t px-3">
                <div className="bg-muted h-4 w-[14%] rounded" />
                <div className="bg-muted h-4 w-[15%] rounded" />
                <div className="bg-muted h-4 w-[13%] rounded" />
                <div className="bg-muted h-4 flex-1 rounded" />
                <div className="bg-muted h-7 w-20 rounded-lg" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The calendar's own skeleton: the same six rows of seven cells at the same
 * height as the real grid, so switching from skeleton to data does not move a
 * single pixel (web-feedback-states rule 1 — a mismatched skeleton IS the CLS).
 *
 * `aria-hidden`: a screen reader has nothing to gain from 42 grey boxes.
 */
export function ScheduledCalendarSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse">
      <div className="flex flex-wrap items-center gap-2">
        <div className="bg-muted h-8 w-28 rounded-lg" />
        <div className="bg-muted h-6 w-40 rounded" />
        <div className="bg-muted h-8 w-24 rounded-lg" />
      </div>
      <div className="bg-muted h-4 w-72 rounded" />
      <div className="space-y-1">
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: CALENDAR_COLUMNS }, (_unused, column) => (
            <div key={column} className="bg-muted mx-auto h-4 w-6 rounded" />
          ))}
        </div>
        {Array.from({ length: CALENDAR_ROWS }, (_unused, row) => (
          <div key={row} className="grid grid-cols-7 gap-1">
            {Array.from({ length: CALENDAR_COLUMNS }, (_unusedCell, column) => (
              <div key={column} className="bg-muted/60 min-h-28 rounded-xl border" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
