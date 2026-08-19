/**
 * Loading placeholders for the sync screen. Sizes mirror the real blocks — the
 * three funnel rows and the grouped issue table in the main column, the run
 * facts in the rail — so nothing jumps when the data lands (web-feedback-states
 * rule 1: CLS = 0).
 *
 * `aria-hidden`: a screen reader gains nothing from grey boxes — the live region
 * in the screen announces "đang tải".
 */

export function SyncStatusSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-5 motion-safe:animate-pulse">
      {/* Funnel: heading + three stage rows in one card. */}
      <div className="space-y-2.5">
        <div className="bg-muted h-5 w-56 rounded" />
        <div className="bg-card border-border overflow-hidden rounded-xl border">
          {[0, 1, 2].map((stage) => (
            <div key={stage} className="border-border flex gap-4 border-b p-4 last:border-b-0">
              <div className="w-36 shrink-0 space-y-2">
                <div className="bg-muted h-3 w-6 rounded" />
                <div className="bg-muted h-4 w-28 rounded" />
                <div className="bg-muted h-3 w-20 rounded" />
              </div>
              <div className="min-w-0 flex-1 space-y-2.5">
                <div className="bg-muted h-8 w-48 rounded" />
                <div className="bg-muted h-2.5 w-full rounded-full" />
                <div className="bg-muted h-4 w-2/3 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Issue table: heading + head row + four grouped rows. */}
      <div className="space-y-2.5">
        <div className="bg-muted h-5 w-40 rounded" />
        <div className="border-border overflow-hidden rounded-xl border">
          <div className="bg-muted/50 h-9" />
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="border-border flex items-center gap-4 border-t px-4 py-3">
              <div className="bg-muted h-4 w-44 shrink-0 rounded" />
              <div className="bg-muted h-4 flex-1 rounded" />
              <div className="bg-muted h-1.5 w-28 shrink-0 rounded-full" />
              <div className="bg-muted h-4 w-14 shrink-0 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Same block heights as `SyncRunRail`, so the rail does not resize on load. */
export function SyncRailSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-4 motion-safe:animate-pulse">
      <div className="flex items-center justify-between gap-2">
        <div className="bg-muted h-3 w-32 rounded" />
        <div className="bg-muted h-5 w-24 rounded-full" />
      </div>
      <div className="bg-muted h-4 w-full rounded" />
      <div className="space-y-2">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-2">
            <div className="bg-muted h-3 w-28 shrink-0 rounded" />
            <div className="bg-muted h-3 flex-1 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
